import type { Route } from "./+types/sitemap";
import type { Env } from "~/lib/api.server";
import { site } from "~/lib/site.server";
import { originOf } from "~/lib/seo";

/**
 * The sitemap, built from what is published rather than from a list.
 *
 * A hand-maintained sitemap is a file that is correct on the day it is
 * written. This one walks the same `published` rows the pages do, so a
 * treatment taken off the website leaves the sitemap in the same minute,
 * and a draft never appears in it — which matters more than it sounds,
 * because a URL in a sitemap is an invitation to crawl it.
 *
 * On a practice's own domain it lists that practice. On the shared host
 * it lists every practice under its prefix, so a demonstration instance
 * is still a coherent site rather than one tenant with extras.
 *
 * Nothing behind the sign-in is here, and robots.txt refuses it as well.
 * One of the two would do; both is cheap.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const origin = originOf(request);
  const urls: Array<{ loc: string; priority: string }> = [
    { loc: `${origin}/`, priority: "1.0" },
  ];
  for (const path of ["/services", "/team", "/contact"]) {
    urls.push({ loc: `${origin}${path}`, priority: "0.8" });
  }
  for (const service of await site.services(env)) {
    urls.push({ loc: `${origin}/services/${service.slug}`, priority: "0.6" });
  }
  urls.push({ loc: `${origin}/privacy`, priority: "0.3" });

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url><loc>${escapeXml(u.loc)}</loc><priority>${u.priority}</priority></url>`,
      )
      .join("\n") +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

/** A practice's slug is constrained, but the origin is not. Escape both. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
