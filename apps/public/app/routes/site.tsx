import { Link, NavLink, Outlet, redirect, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/site";
import type { Env } from "~/lib/api.server";
import { practice, site } from "~/lib/site.server";
import type { SiteClinic, SiteHours, SitePage } from "~/lib/hours";
import { themeFor } from "~/lib/theme";

/**
 * The practice's website.
 *
 * This layout used to carry the biggest decision in the site: an
 * optional `:clinic?` path segment, so `/services` and
 * `/kadehuis/services` were one route with one loader, and each
 * practice could answer on its own domain in production while a laptop
 * with one host and no DNS used the prefix. Every link was built from a
 * `base` that was `""` or `"/kadehuis"`.
 *
 * One practice now. `base` is gone, `/` is the front page rather than a
 * list of practices to choose from, and the theme comes from the one
 * record — which was always the point of resolving it before the
 * sign-in: a brand that only appears after you log in is the wrong way
 * round.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const [clinic, hours, pages] = await Promise.all([practice(env), site.hours(env), site.pages(env)]);
  return { clinic, base: "", hours: hours as SiteHours[], pages };
}

/** The practice and the link prefix, for every page inside this layout. */
export function useSite() {
  const data = useRouteLoaderData<typeof loader>("routes/site");
  if (!data) throw new Error("the site layout did not load");
  return data;
}

export default function SiteLayout({ loaderData }: Route.ComponentProps) {
  const { clinic, base, pages } = loaderData;
  const theme = themeFor(clinic?.theme_primary) as React.CSSProperties;

  return (
    <div style={theme} className="site themed">
      {clinic ? <SiteHeader clinic={clinic} base={base} pages={pages} /> : null}
      <Outlet />
      {clinic ? <SiteFooter clinic={clinic} base={base} pages={pages} /> : null}
    </div>
  );
}

function SiteHeader({ clinic, base, pages }: { clinic: SiteClinic; base: string; pages: SitePage[] }) {
  const tel = clinic.phone ? clinic.phone.replace(/\s+/g, "") : null;
  return (
    <header className="topbar">
      <div className="wrap topbar__inner">
        <Link className="mark" to={base || "/"}>
          {/* Decorative, with the name beside it rather than inside it —
              a practice without a logo still has a masthead, and a screen
              reader hears the name once. */}
          {clinic.theme_logo ? (
            <img
              className="mark__logo"
              src={`/brand/${clinic.theme_logo}`}
              alt=""
              width={44}
              height={44}
            />
          ) : null}
          <span>
            <span className="mark__name">{clinic.name}</span>
            {clinic.city ? <span className="mark__place">{clinic.city}</span> : null}
          </span>
        </Link>

        <nav className="sitenav" aria-label="Practice">
          <NavLink to={`${base}/services`}>Treatments</NavLink>
          <NavLink to={`${base}/team`}>Who we are</NavLink>
          <NavLink to={`${base}/contact`}>Find us</NavLink>
          {pages
            .filter((p) => p.nav === "header" || p.nav === "both")
            .map((p) => (
              <NavLink key={p.id} to={`${base}/pages/${p.slug}`}>{p.title}</NavLink>
            ))}
        </nav>

        {/*
          Phone and Book, together, in the header, on every page. Every
          practice site a patient actually chooses does this, and for the
          same reason: the two things a person in pain wants are to ring
          or to book, and neither should be somewhere they have to scroll
          to find.
        */}
        <div className="topbar__reach">
          {tel ? (
            <a className="topbar__tel" href={`tel:${tel}`}>
              <span className="sr-only">Ring </span>{clinic.phone}
            </a>
          ) : null}
          {/* "Book now", as every reference site labels it: the long form is
              in the hero, and here it pushed the nav onto a second line. */}
          <Link className="btn btn--primary btn--sm" to="/login">
            Book now
          </Link>
        </div>
      </div>
    </header>
  );
}

function SiteFooter({ clinic, base, pages }: { clinic: SiteClinic; base: string; pages: SitePage[] }) {
  const tel = clinic.phone ? clinic.phone.replace(/\s+/g, "") : null;
  const footerPages = pages.filter((p) => p.nav === "footer" || p.nav === "both");
  return (
    <footer className="footer">
      <div className="wrap footer__inner">
        <div className="footer__col">
          <p className="footer__name">{clinic.name}</p>
          <address className="footer__address">
            {clinic.address ? <>{clinic.address}<br /></> : null}
            {[clinic.city, clinic.country].filter(Boolean).join(", ")}
          </address>
          {tel ? <a className="footer__tel" href={`tel:${tel}`}>{clinic.phone}</a> : null}
        </div>

        <nav className="footer__col" aria-labelledby="foot-practice">
          <h2 id="foot-practice">The practice</h2>
          <div className="footer__links">
            <Link to={`${base}/services`}>Treatments and prices</Link>
            <Link to={`${base}/team`}>Who we are</Link>
            <Link to={`${base}/contact`}>Find us and opening hours</Link>
            {footerPages.map((p) => (
              <Link key={p.id} to={`${base}/pages/${p.slug}`}>{p.title}</Link>
            ))}
          </div>
        </nav>

        <nav className="footer__col" aria-labelledby="foot-patients">
          <h2 id="foot-patients">Patients</h2>
          <div className="footer__links">
            <Link to="/login">Patient area</Link>
            <Link to="/register">Register as a new patient</Link>
            <Link to={`${base}/privacy`}>Privacy notice</Link>
          </div>
        </nav>

        <p className="footer__fine">
          Built on Enamel. This is a demonstration practice — the people, the
          appointments and the records behind it are invented.
        </p>
      </div>
    </footer>
  );
}
