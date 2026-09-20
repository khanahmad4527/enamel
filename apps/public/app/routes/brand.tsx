import type { Route } from "./+types/brand";
import type { Env } from "~/lib/api.server";

/**
 * A practice's logo, fetched by this server and handed to the browser.
 *
 * `<img src="http://localhost:9056/assets/…">` would be an **anonymous**
 * request: the patient's token lives in an httpOnly cookie for *this*
 * origin, and the browser has no way to present it to Directus. It answers
 * 403, and the masthead shows a broken image — which is exactly what
 * happened the first time and is why `theme_logo` sat unrendered in the
 * schema for so long.
 *
 * So the credential stays here, on the server, like every other one. This
 * route is the only thing in either site that streams bytes it did not
 * compose itself.
 *
 * It uses the **Website** token rather than the visitor's, and that is a
 * decision worth stating. The Website policy grants exactly one thing on
 * `directus_files` — a file the practice marked as a brand asset, for a
 * practice that is active — so this route is incapable of returning
 * anything else even if somebody puts a radiograph's uuid in the URL. A
 * logo is also the same bytes for everybody, which is what makes a shared
 * cache safe here and unsafe one route over.
 *
 * The patient's own token would work too — the Patient policy grants
 * their own practice's brand assets — but it would mean the public pages,
 * which have no patient, needed a second path to the same image.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;

  // A uuid or nothing. Not defence in depth so much as refusing to make a
  // request on behalf of a path segment somebody typed.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id)) {
    throw new Response("Not found", { status: 404 });
  }

  const upstream = await fetch(`${env.DIRECTUS_URL}/assets/${params.id}`, {
    headers: { authorization: `Bearer ${env.WEBSITE_TOKEN}` },
  }).catch(() => null);

  // 404 rather than relaying a 403. The visitor did nothing wrong and
  // there is nothing they can do about it; the distinction between "no
  // such file" and "not a brand asset" is the practice's business, and
  // relaying it turns this into a way to ask whether a uuid exists.
  if (!upstream || !upstream.ok || !upstream.body) {
    throw new Response("Not found", { status: 404 });
  }

  const type = upstream.headers.get("content-type") ?? "application/octet-stream";
  return new Response(upstream.body, {
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=3600",
      // The bytes come from a file a practice uploaded. Served as an SVG
      // that would be a script host in an `<img>`-free context, so the
      // browser is told not to guess at the type and not to run it.
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
