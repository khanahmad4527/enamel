import type { Route } from "./+types/site.contact";
import type { Env } from "~/lib/api.server";
import { practice, site } from "~/lib/site.server";
import { nowAt, openState } from "~/lib/hours";
import { absolute, dentistJsonLd, pageMeta } from "~/lib/seo";
import { Ld, OpenNow, Week } from "~/components/site";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const clinic = await practice(env);
  const base = "";
  const hours = await site.hours(env);
  const url = absolute(request, `${base}/contact`);
  return {
    clinic,
    hours,
    open: openState(hours, clinic.timezone),
    today: nowAt(clinic.timezone).day,
    url,
    jsonLd: dentistJsonLd(clinic, hours, url),
  };
}

export function meta({ data }: Route.MetaArgs) {
  if (!data) return [{ title: "Find us" }];
  const c = data.clinic;
  return pageMeta({
    title: `Opening hours and how to find ${c.name}`,
    description: [c.address, c.city].filter(Boolean).join(", ") ||
      `Where ${c.name} is, and when it is open.`,
    url: data.url,
    siteName: c.name,
  });
}

export default function Contact({ loaderData }: Route.ComponentProps) {
  const { clinic, hours, open, today, jsonLd } = loaderData;

  return (
    <main className="wrap wrap--page" id="main">
      <Ld json={jsonLd} />

      <header className="pagehead">
        <p className="eyebrow">{clinic.name}</p>
        <h1 className="h1">Find us</h1>
        <OpenNow state={open} phone={clinic.phone} />
      </header>

      <div className="two">
        <section aria-labelledby="where-h">
          <h2 id="where-h" className="h3">Where</h2>
          <address className="address">
            {clinic.address ? <>{clinic.address}<br /></> : null}
            {[clinic.city, clinic.country].filter(Boolean).join(", ")}
          </address>

          <dl className="reach">
            {clinic.phone ? (
              <>
                <dt>Telephone</dt>
                <dd>
                  <a href={`tel:${clinic.phone.replace(/\s+/g, "")}`}>{clinic.phone}</a>
                </dd>
              </>
            ) : null}
            {clinic.email ? (
              <>
                <dt>Email</dt>
                <dd><a href={`mailto:${clinic.email}`}>{clinic.email}</a></dd>
              </>
            ) : null}
            <dt>Local time</dt>
            <dd>
              {clinic.timezone.replace("_", " ")} — the times on this page are the
              practice's own, wherever you are reading them.
            </dd>
          </dl>

          {/*
            No map embed, and that is a privacy decision rather than an
            oversight. A Google or Mapbox iframe sets a third-party
            cookie and reports the visitor's address before anybody has
            consented to anything — on a page a person in pain reaches
            by searching their symptoms. A practice that wants one adds
            it behind a consent gate; it is not shipped on by default.
          */}
        </section>

        <section aria-labelledby="when-h">
          <h2 id="when-h" className="h3">When</h2>
          <Week hours={hours} today={today} />
          <p className="hint">
            These are the hours the practice's diary is open against. An appointment
            cannot be booked outside them — online or at the desk.
          </p>
        </section>
      </div>

      <section className="cta">
        <h2 className="h3">In pain today?</h2>
        <p className="small muted">
          Ring before ten in the morning and the practice will try to see you the
          same day. If you cannot reach anyone and it is urgent, use the emergency
          dental service for {clinic.city ?? "your area"} — do not wait for a
          reply to an email.
        </p>
      </section>
    </main>
  );
}
