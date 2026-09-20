import type { Route } from "./+types/site.page";
import type { Env } from "~/lib/api.server";
import { site } from "~/lib/site.server";
import { pageMeta, absolute } from "~/lib/seo";
import { Markdown } from "~/lib/markdown";
import { useSite } from "./site";

/**
 * A page the practice wrote, at /pages/:slug.
 *
 * The one route on this site with no opinion about its own content —
 * which is the point. Everything else here knows what it is for: the
 * home page reads the opening hours and says whether the practice is
 * open right now, the services page knows a service has a price. This
 * one knows a page has a title and a body, and that is the whole of it.
 *
 * A missing page is a 404 and not a redirect to the front page. A
 * practice that mistypes a link wants to find out.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const slug = String(params.slug ?? "");
  const [found] = await site.page(env, slug);
  if (!found) {
    throw new Response("No such page.", { status: 404 });
  }
  return { page: found, url: absolute(request, `/pages/${found.slug}`) };
}

export function meta({ data }: Route.MetaArgs) {
  if (!data) return pageMeta({ title: "Page not found", description: "", url: "/" });
  const p = data.page;
  return pageMeta({
    title: p.title,
    // The summary if the practice wrote one, otherwise the opening of
    // the page itself — a description nobody wrote is worse than one
    // taken from the words that are already there.
    description: p.summary ?? (p.body ?? "").replace(/[#*_>`]/g, "").slice(0, 155),
    url: data.url,
  });
}

export default function SitePage({ loaderData }: Route.ComponentProps) {
  const { page, } = loaderData;
  const { clinic } = useSite();

  return (
    <main className="wrap wrap--page wrap--read" id="main">
      <article className="stack">
        <header className="stack stack--tight">
          <p className="eyebrow">{clinic?.name}</p>
          <h1>{page.title}</h1>
          {page.summary ? <p className="lede">{page.summary}</p> : null}
        </header>
        <div className="prose"><Markdown source={page.body} /></div>
      </article>
    </main>
  );
}
