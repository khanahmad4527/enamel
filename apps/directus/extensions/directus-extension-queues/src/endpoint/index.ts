import { defineEndpoint } from "@directus/extensions-sdk";

/**
 * The server-side half of getting into the queue board.
 *
 * It exists because the admin's Directus token lives in an httpOnly
 * cookie: the Vue app in the browser cannot read it, and therefore cannot
 * present it to the core service itself. Directus hands *this* handler
 * the caller's own token, so the request that asks for a way in is made
 * as the person at the keyboard — and the core service decides whether
 * that person may open the board.
 *
 * Nothing here decides anything. It forwards a token and relays an
 * answer; the rule about who may look lives in one place, next to the
 * board it protects.
 */
const CORE_URL = process.env["CORE_INTERNAL_URL"] || "http://core:8057";

export default defineEndpoint((router) => {
  /**
   * Is the board switched on, and may *this* person open it.
   *
   * The token is forwarded so the answer is about the caller rather than
   * about the deployment alone. A practice owner is then told the rule up
   * front instead of being shown a button that refuses them when pressed.
   */
  router.get("/status", async (req: any, res: any) => {
    try {
      const upstream = await fetch(`${CORE_URL}/api/queues/board`, {
        headers: req.token ? { authorization: `Bearer ${req.token}` } : {},
      });
      res.status(upstream.status).json(await upstream.json().catch(() => ({})));
    } catch (e) {
      res.status(503).json({
        errors: [{
          message: `The core service is not answering at ${CORE_URL}. Check \`docker compose ps core\`.`,
          detail: e instanceof Error ? e.message : String(e),
        }],
      });
    }
  });

  /**
   * A one-time link.
   *
   * POST, because it creates something: a ticket that is good for one
   * visit and about a minute. A GET here would be prefetched by a browser
   * trying to be helpful and would leave a spent ticket in history.
   */
  router.post("/open", async (req: any, res: any) => {
    if (!req.token) {
      res.status(401).json({ errors: [{ message: "Sign in first." }] });
      return;
    }
    try {
      const upstream = await fetch(`${CORE_URL}/api/queues/ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${req.token}` },
      });
      const body = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
      // Nest answers `{ statusCode, message }`; the admin reads Directus's
      // `{ errors: [{ message }] }` and finds nothing in the other shape.
      if (!upstream.ok && !body["errors"] && typeof body["message"] === "string") {
        res.status(upstream.status).json({ errors: [{ message: body["message"] }] });
        return;
      }
      res.status(upstream.status).json(body);
    } catch (e) {
      res.status(503).json({
        errors: [{
          message: `The core service is not answering at ${CORE_URL}. Check \`docker compose ps core\`.`,
          detail: e instanceof Error ? e.message : String(e),
        }],
      });
    }
  });
});
