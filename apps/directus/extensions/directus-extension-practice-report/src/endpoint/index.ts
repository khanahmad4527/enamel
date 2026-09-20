import { defineEndpoint } from "@directus/extensions-sdk";

/**
 * The same server-side door the day sheet uses, for the same reasons: the
 * admin's token stays in its httpOnly cookie, and the core service needs
 * no CORS. Directus hands this handler the caller's own token, so the
 * clinic scoping applies to the person at the keyboard.
 */
const CORE_URL = process.env["CORE_INTERNAL_URL"] || "http://core:8057";

export default defineEndpoint((router) => {
  router.get("/summary", async (req: any, res: any) => {
    if (!req.token) {
      res.status(401).json({ errors: [{ message: "Sign in first." }] });
      return;
    }
    const params = new URLSearchParams();
    for (const key of ["from", "to"]) {
      const v = req.query[key];
      if (typeof v === "string" && v !== "") params.set(key, v);
    }
    try {
      const upstream = await fetch(`${CORE_URL}/api/reports/summary?${params.toString()}`, {
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
