import type { Route } from "./+types/robots";
import { originOf } from "~/lib/seo";

/**
 * What a crawler is asked not to touch.
 *
 * The patient area is the whole of it. Those pages require a session and
 * would answer a crawler with a redirect to the sign-in, so nothing could
 * leak — but a search result reading "Sign in · Enamel patient area" under
 * a practice's name is a bad result, and an indexed `/logout` is a link
 * that signs people out when they click it from a search page.
 *
 * `Disallow` is a request, not a control. The control is that every one
 * of those routes checks the session server-side; this is the sign on the
 * door, not the lock.
 */
export function loader({ request }: Route.LoaderArgs) {
  const origin = originOf(request);
  const body = [
    "User-agent: *",
    "Disallow: /portal",
    "Disallow: /login",
    "Disallow: /register",
    "Disallow: /logout",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
