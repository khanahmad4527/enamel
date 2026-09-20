import { Link } from "react-router";
import type { Route } from "./+types/site.home";
import type { Env } from "~/lib/api.server";
import { practice, site } from "~/lib/site.server";
import { hhmm, nowAt, openState } from "~/lib/hours";
import { absolute, dentistJsonLd, pageMeta } from "~/lib/seo";
import { paragraphs, personName } from "~/lib/format";
import { Ld, OpenNow, ServiceRow, Week } from "~/components/site";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  // `/` is the practice's front page. It used to be a chooser — a list
  // of practices on a shared host — which is why this site appeared to
  // have no home page at all.
  const clinic = await practice(env);
  const base = "";
  // Four requests the practice's own content, fired together rather than
  // in sequence — this is a front page, and four round trips one after
  // another is the difference between fast and merely working.
  const [services, faqs, team, hours] = await Promise.all([
    site.services(env),
    site.faqs(env),
    site.team(env),
    site.hours(env),
  ]);

  return {
    clinic,
    base,
    services,
    faqs,
    team,
    hours,
    open: openState(hours, clinic.timezone),
    today: nowAt(clinic.timezone).day,
    url: absolute(request, base || "/"),
    jsonLd: dentistJsonLd(clinic, hours, absolute(request, base || "/")),
  };
}

export function meta({ data }: Route.MetaArgs) {
  if (!data) {
    return pageMeta({ title: "Enamel", description: "A dental practice.", url: "/" });
  }
  const c = data.clinic;
  return pageMeta({
    title: `${c.name} — dentist in ${c.city ?? "your area"}`,
    description: c.strapline ?? c.intro?.slice(0, 155) ?? `${c.name}, a dental practice.`,
    url: data.url,
    siteName: c.name,
  });
}

export default function SiteHome({ loaderData }: Route.ComponentProps) {
  const { clinic, base, services, faqs, team, hours, open, today, jsonLd } = loaderData;
  const shown = services.slice(0, 6);
  const todayRow = today ? hours.find((h) => h.weekday === today) : undefined;
  const todayLine = !todayRow || todayRow.closed || !todayRow.opens_at || !todayRow.closes_at
    ? "Closed today"
    : `${hhmm(todayRow.opens_at)} – ${hhmm(todayRow.closes_at)}`;

  return (
    <main id="main">
      <Ld json={jsonLd} />

      {/*
        The order of this page is the order a person in pain reads it in:
        who are you and are you open (hero), how do I reach you (facts),
        what do you do and what does it cost (treatments), who will I see
        (people), where are you (find us), and the questions people ring
        up to ask. It follows what the practices patients actually choose
        do — phone and Book always visible, a headline that says what the
        practice is rather than what it is called, pictures for the
        treatments, faces for the people, the address near the foot.
      */}
      <section className="wrap hero" aria-labelledby="hero-h">
        <div className="hero__say">
          <p className="eyebrow">
            {clinic.name}{clinic.city ? ` · ${clinic.city}` : ""}
          </p>
          {/*
            The strapline is the headline. The name is already in the
            masthead, the tab and the footer; a page that shouts it a
            fourth time at 62px has used its largest type to say nothing.
            A practice with no strapline gets its name, which is still
            better than an empty h1.
          */}
          <h1 id="hero-h" className="hero__title">{clinic.strapline ?? clinic.name}</h1>
          {clinic.intro ? <p className="hero__lede">{firstSentence(clinic.intro)}</p> : null}

          <OpenNow state={open} phone={clinic.phone} />

          <div className="hero__actions">
            <Link className="btn btn--primary" to="/login">
              Book an appointment
            </Link>
            <Link className="btn" to="/register">
              New patient? Register
            </Link>
          </div>
        </div>

        {/*
          The picture, in the arch. `aria-hidden` and an empty alt: it
          carries no information a screen reader needs, and describing it
          would interrupt the three facts this block exists to deliver.
          Without an image the arch is the practice's colour washed pale,
          and the page still looks finished — which is the condition on
          the day a practice launches.
        */}
        <div className={`hero__panel${clinic.hero_image ? "" : " hero__panel--empty"}`}>
          {clinic.hero_image ? (
            <img
              src={`/brand/${clinic.hero_image}`}
              alt=""
              aria-hidden="true"
              width={960}
              height={1200}
              loading="eager"
              decoding="async"
            />
          ) : null}
        </div>
      </section>

      {/*
        Three facts, not three claims. Today's hours, the telephone and
        the address are what a person checks before ringing; "gentle",
        "award-winning" and "family" are what a practice says about
        itself, and they go somewhere a reader can weigh them.
      */}
      <section className="facts" aria-label="Today, at a glance">
        <div className="wrap facts__inner">
          <div className="fact">
            <span className="fact__label">Today</span>
            <span className="fact__value">
              {todayLine}
              {open.open && open.until ? <small>Open now, until {open.until}</small> : null}
            </span>
          </div>
          {clinic.phone ? (
            <div className="fact">
              <span className="fact__label">Telephone</span>
              <span className="fact__value">
                <a href={`tel:${clinic.phone.replace(/\s+/g, "")}`}>{clinic.phone}</a>
                {/* The practice's own words, or none — this was a hardcoded
                    promise about same-day pain appointments, which is not
                    something a React file should be making on their behalf. */}
                {clinic.phone_note ? <small>{clinic.phone_note}</small> : null}
              </span>
            </div>
          ) : null}
          {clinic.address || clinic.city ? (
            <div className="fact">
              <span className="fact__label">Where</span>
              <span className="fact__value">
                {clinic.address ?? clinic.city}
                {clinic.address && clinic.city ? <small>{clinic.city}</small> : null}
              </span>
            </div>
          ) : null}
        </div>
      </section>

      {clinic.intro ? (
        <section className="wrap intro" aria-labelledby="about-h">
          <p className="eyebrow" id="about-h">The practice</p>
          {paragraphs(clinic.intro).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </section>
      ) : null}

      {shown.length ? (
        <section className="wrap band" aria-labelledby="tx-h">
          <div className="band__head">
            <div>
              <p className="eyebrow">What we do</p>
              <h2 id="tx-h" className="h2">Treatments, with the price before you sit down</h2>
            </div>
            <Link to={`${base}/services`}>All treatments and prices</Link>
          </div>
          <ul className="cards">
            {shown.map((s) => (
              <ServiceRow
                key={s.id}
                service={s}
                to={`${base}/services/${s.slug}`}
                currency={clinic.currency}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {team.length ? (
        <section className="wrap band" aria-labelledby="team-h">
          <div className="band__head">
            <div>
              <p className="eyebrow">Who you will see</p>
              <h2 id="team-h" className="h2">The people</h2>
            </div>
            <Link to={`${base}/team`}>About the team</Link>
          </div>
          <ul className="people people--brief">
            {team.map((p) => (
              <li key={p.id}>
                {p.public_photo ? (
                  <img
                    className="people__face"
                    src={`/brand/${p.public_photo}`}
                    alt=""
                    aria-hidden="true"
                    width={136}
                    height={136}
                    loading="lazy"
                    decoding="async"
                  />
                ) : null}
                <p className="people__name">{personName(p, "A clinician")}</p>
                <p className="people__role">{roleLabel(p.job_title)}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="findus" aria-labelledby="find-h">
        <div className="wrap findus__inner">
          <div>
            <p className="eyebrow">Find us</p>
            <h2 id="find-h" className="h2">Where we are</h2>
            <address className="address">
              {clinic.address ? <>{clinic.address}<br /></> : null}
              {[clinic.city, clinic.country].filter(Boolean).join(", ")}
            </address>
            <dl className="reach">
              {clinic.phone ? (
                <>
                  <dt>Telephone</dt>
                  <dd><a href={`tel:${clinic.phone.replace(/\s+/g, "")}`}>{clinic.phone}</a></dd>
                </>
              ) : null}
              {clinic.email ? (
                <>
                  <dt>Email</dt>
                  <dd><a href={`mailto:${clinic.email}`}>{clinic.email}</a></dd>
                </>
              ) : null}
            </dl>
            <p className="hint" style={{ marginTop: 16 }}>
              <Link to={`${base}/contact`}>Directions, and how to reach us</Link>
            </p>
          </div>
          <div>
            <Week hours={hours} today={today} />
          </div>
        </div>
      </section>

      {faqs.length ? (
        <section className="wrap band" aria-labelledby="faq-h">
          <div className="band__head">
            <div>
              <p className="eyebrow">Before you ring</p>
              <h2 id="faq-h" className="h2">Questions people ring up to ask</h2>
            </div>
          </div>
          <div className="qa">
            {faqs.map((f) => (
              <details key={f.id} className="qa__item">
                <summary>{f.question}</summary>
                <p>{f.answer}</p>
              </details>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

/** `principal_dentist` is a database value; "Principal dentist" is English. */
export function roleLabel(job: string | null): string {
  if (!job) return "Clinician";
  return job.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** The first sentence, for a lede. A whole paragraph under a 62px headline is a wall. */
function firstSentence(text: string): string {
  const m = /^[^.!?]+[.!?]/.exec(text.trim());
  return (m ? m[0] : text).trim();
}
