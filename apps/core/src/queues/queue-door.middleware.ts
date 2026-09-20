import { Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config/config";
import { QueueAccessService } from "./queue-access.service";

export const QUEUE_COOKIE = "enamel_queueboard";

/**
 * One cookie, read by hand.
 *
 * `cookie-parser` would do this, and adding it raises a question with a
 * non-obvious answer: middleware registered with `app.use()` after
 * `NestFactory.create` runs *after* middleware registered by a module's
 * `configure()`, so the parser would not have run by the time this needs
 * it. Four lines here beats a dependency whose correctness depends on
 * initialisation order nobody can see from the call site.
 */
function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

/**
 * The only way into the board.
 *
 * Mounted by `BullBoardModule.forRoot({ middleware })`, which Nest applies
 * ahead of the board's own router — so nothing below this line is reached
 * without a session, including the board's internal API, which is the
 * part that actually returns job payloads. Guarding the HTML alone would
 * protect the wrapper and leave the data.
 *
 * Three states, in order:
 *
 *   a **ticket** in the query string — redeemed once, exchanged for a
 *   cookie, and the visitor is redirected to the same page without it, so
 *   the credential never survives in the address bar or in history;
 *
 *   a **session cookie** — the ordinary case, and every request the board
 *   makes while somebody has it open;
 *
 *   **neither** — a page that says where to go, rather than a blank 401
 *   that reads like the service is broken.
 */
@Injectable()
export class QueueDoorMiddleware implements NestMiddleware {
  private readonly log = new Logger("QueueBoard");

  constructor(private readonly access: QueueAccessService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const ticket = typeof req.query["ticket"] === "string" ? req.query["ticket"] : "";

    if (ticket) {
      const viewer = await this.access.redeemTicket(ticket).catch(() => null);
      if (!viewer) return this.refuse(res, "That link has already been used, or it has expired.");

      const session = await this.access.openSession(viewer);
      res.cookie(QUEUE_COOKIE, session, {
        httpOnly: true,
        sameSite: "lax",
        // Scoped to the board. A cookie on `/` would ride along on every
        // API call this service serves, which is a credential handed to
        // endpoints that have no business seeing one.
        path: config.queues.route,
        secure: config.queues.secureCookie,
        maxAge: config.queues.sessionMinutes * 60_000,
      });
      this.log.log(`${viewer.name} opened the queue board`);

      // Back to the same path with the ticket stripped. `originalUrl`
      // rather than a hard-coded route, so a deep link survives the
      // round trip.
      const clean = req.originalUrl.split("?")[0] ?? config.queues.route;
      res.redirect(302, clean);
      return;
    }

    const cookie = readCookie(req.headers.cookie, QUEUE_COOKIE);
    const viewer = cookie ? await this.access.readSession(cookie).catch(() => null) : null;
    if (viewer) return next();

    this.refuse(res, cookie
      ? "That session has expired. Open the board again from Directus."
      : "The queue board is opened from Directus, which is where you are already signed in.");
  }

  /**
   * A page, not a bare status code.
   *
   * The board's own assets are fetched by the browser, so a visitor who
   * arrives without a session sees this first — and "401" on a white page
   * is how somebody concludes the queue is broken and restarts the
   * service. Served as 401 with `noindex`, because it is still a refusal.
   */
  private refuse(res: Response, reason: string): void {
    res.status(401).type("html").send(`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Queue board — sign in through Directus</title>
<style>
 :root { color-scheme: light dark; }
 body { margin:0; min-height:100vh; display:grid; place-items:center;
        background:#f0f7f9; color:#16303a;
        font:400 16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
 .card { max-width:34rem; padding:32px 34px; background:#fff;
         border:1px solid #c9dfe6; border-radius:14px; }
 h1 { margin:0 0 10px; font-size:21px; }
 p { margin:0 0 12px; color:#45636f; }
 a { color:#0b6a82; }
 code { background:#e2eff3; padding:2px 6px; border-radius:4px; font-size:14px; }
 @media (prefers-color-scheme: dark) {
   body { background:#1d3039; color:#e9f5f8; }
   .card { background:#26424d; border-color:#3a5b67; }
   p { color:#b2ccd4; } a { color:#8fdbec; } code { background:#172730; }
 }
</style></head><body><div class="card">
<h1>Not signed in</h1>
<p>${reason}</p>
<p>Open <strong>Queues</strong> in the Directus sidebar. It hands this
service the token your browser already has, and this service asks Directus
who you are before letting you through.</p>
<p>An administrator gets in, and so does anyone holding the
<strong>Queue operator</strong> policy — which grants nothing else in
Directus and exists so that watching the queues does not require access to
patient records. Job payloads carry patients' names, so it is not open to
every signed-in account.</p>
</div></body></html>`);
  }
}
