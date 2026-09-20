import { defineEndpoint } from "@directus/extensions-sdk";

/**
 * A server-side door between the admin and the core service.
 *
 * The day sheet could call the core service from the browser, and doing so
 * would mean two things this avoids. The admin would need the raw access
 * token in JavaScript — Directus deliberately keeps it in an httpOnly
 * cookie for session logins, so getting at it means working around the
 * thing protecting it. And the core service would need CORS open to the
 * admin's origin, which is a second place to get a security decision
 * wrong.
 *
 * Going through Directus instead costs one hop and settles both. The
 * request arrives already authenticated, Directus hands this handler the
 * caller's own token, and it is that token the core service sees — so the
 * core service's clinic scoping applies to the person at the keyboard rather
 * than to a shared service identity.
 *
 * Nothing is decided here. This proxies and forwards errors; every rule
 * lives in the core service or, below it, in Postgres.
 */

const CORE_URL = process.env["CORE_INTERNAL_URL"] || "http://core:8057";

type DirectusRequest = {
  token?: string | null;
  query: Record<string, unknown>;
  body: unknown;
  accountability?: { user?: string | null } | null;
};

export default defineEndpoint((router) => {
  async function forward(
    req: DirectusRequest,
    res: { status: (n: number) => { json: (b: unknown) => void } },
    path: string,
    init: RequestInit = {},
  ): Promise<void> {
    if (!req.token) {
      // A session login puts the token in a cookie and Directus resolves
      // it onto the request; no token here means nobody is logged in.
      res.status(401).json({ errors: [{ message: "Sign in first." }] });
      return;
    }

    try {
      const upstream = await fetch(`${CORE_URL}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${req.token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
      const body = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

      // Two error conventions meet here. Nest renders a rejection as
      // `{ statusCode, message, error }`; the admin reads Directus's
      // `{ errors: [{ message }] }` and finds nothing in the other shape
      // — so the scheduling hook's carefully written sentence arrived as
      // "Request failed with status code 400". Translating once, here,
      // beats teaching every caller both dialects.
      if (!upstream.ok && !body["errors"] && typeof body["message"] === "string") {
        res.status(upstream.status).json({ errors: [{ message: body["message"] }] });
        return;
      }
      res.status(upstream.status).json(body);
    } catch (e) {
      // The core service being down is worth saying plainly. A day sheet
      // that renders empty because a fetch failed looks exactly like a
      // practice with nothing booked.
      res.status(503).json({
        errors: [
          {
            message:
              `The core service is not answering at ${CORE_URL}. ` +
              `It runs as its own service — check \`docker compose ps core\`.`,
            detail: e instanceof Error ? e.message : String(e),
          },
        ],
      });
    }
  }

  router.get("/day", async (req: any, res: any) => {
    const date = typeof req.query.date === "string" ? req.query.date : "";
    await forward(req, res, `/api/availability/day?date=${encodeURIComponent(date)}`);
  });

  router.get("/slots", async (req: any, res: any) => {
    const params = new URLSearchParams();
    for (const key of ["from", "to", "duration", "step", "practitioner", "room", "limit"]) {
      const value = req.query[key];
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
    await forward(req, res, `/api/availability/slots?${params.toString()}`);
  });

  router.post("/move", async (req: any, res: any) => {
    await forward(req, res, "/api/availability/move", {
      method: "POST",
      body: JSON.stringify(req.body ?? {}),
    });
  });

  router.post("/book", async (req: any, res: any) => {
    await forward(req, res, "/api/availability/book", {
      method: "POST",
      body: JSON.stringify(req.body ?? {}),
    });
  });
});
