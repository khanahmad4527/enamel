import { Link } from "react-router";
import type { Route } from "./+types/site.team";
import type { Env } from "~/lib/api.server";
import { practice, site } from "~/lib/site.server";
import { absolute, pageMeta } from "~/lib/seo";
import { personName } from "~/lib/format";
import { roleLabel } from "./site.home";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const clinic = await practice(env);
  const base = "";
  return {
    clinic,
    base,
    team: await site.team(env),
    url: absolute(request, `${base}/team`),
  };
}

export function meta({ data }: Route.MetaArgs) {
  if (!data) return [{ title: "The team" }];
  return pageMeta({
    title: `The people at ${data.clinic.name}`,
    description: `The dentists and hygienists at ${data.clinic.name}, and what each of them does.`,
    url: data.url,
    siteName: data.clinic.name,
  });
}

/**
 * The team page, with no photographs on it.
 *
 * Not an omission. There are no real photographs of these people because
 * these people are invented, and a stock portrait under an invented name
 * is the kind of detail that makes a demonstration quietly dishonest. A
 * practice deploying this would add them; the shape of the page has room.
 *
 * The list itself comes from `directus_users` rather than a `team`
 * table, which is why nobody on it has left. `public_profile` is opt-in
 * and defaults to false: a clinician's name on a public website is their
 * decision, not their employer's.
 */
export default function Team({ loaderData }: Route.ComponentProps) {
  const { clinic, base, team } = loaderData;

  return (
    <main className="wrap wrap--page" id="main">
      <header className="pagehead">
        <p className="eyebrow">{clinic.name}</p>
        <h1 className="h1">Who you will see</h1>
        <p className="lede">
          Everyone here is registered with the professional body for the country the
          practice is in, and you can ask to see any of them by name when you book.
        </p>
      </header>

      {team.length ? (
        <ul className="people">
          {team.map((p) => (
            <li key={p.id} className="person">
              {/*
                The portrait, or a frame the same size. The frame is not
                decoration: it is what keeps every row's text starting at
                the same x. Without it the first column collapses to the
                width of whatever is in it, and three bios begin in three
                different places — which reads as three separate mistakes
                rather than one list.
              */}
              {p.public_photo ? (
                <img
                  className="person__face"
                  src={`/brand/${p.public_photo}`}
                  alt=""
                  aria-hidden="true"
                  width={128}
                  height={128}
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <div className="person__face" aria-hidden="true" />
              )}
              <div className="person__head">
                <h2 className="person__name">{personName(p, "A clinician")}</h2>
                <p className="person__role">{roleLabel(p.job_title)}</p>
              </div>
              {p.public_bio ? <p className="person__bio">{p.public_bio}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">
          Nobody at this practice has published a profile yet.
        </p>
      )}

      <div className="panel">
        <p className="small muted">
          Not everyone who works here appears on this page. Appearing is each
          person's own choice, and the practice cannot make it for them — so the
          nurses, the receptionists and anyone who would rather not be listed are
          not listed. <Link to={`${base}/contact`}>Ring the practice</Link> and ask
          for anyone by name.
        </p>
      </div>
    </main>
  );
}
