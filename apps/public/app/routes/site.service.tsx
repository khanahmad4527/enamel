import { Link } from "react-router";
import type { Route } from "./+types/site.service";
import type { Env } from "~/lib/api.server";
import { practice, site } from "~/lib/site.server";
import { absolute, ldJson, pageMeta } from "~/lib/seo";
import { paragraphs } from "~/lib/format";
import { Ld } from "~/components/site";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const clinic = await practice(env);
  const base = "";

  // Filtered in this process rather than by a query per slug, because the
  // practice has six of these and the list is already cached. A
  // `filter[slug][_eq]` here would be a second round trip to save nothing.
  const services = await site.services(env);
  const service = services.find((s) => s.slug === params.slug);
  if (!service) throw new Response("No such treatment.", { status: 404 });

  const url = absolute(request, `${base}/services/${service.slug}`);
  return {
    clinic,
    base,
    service,
    others: services.filter((s) => s.id !== service.id).slice(0, 5),
    url,
    jsonLd: ldJson({
      "@context": "https://schema.org",
      // Not `Product` with an `offers` price. A dental treatment is a
      // service a clinician decides you need, and marking it up as retail
      // is both wrong for search and wrong for the reader.
      "@type": "MedicalProcedure",
      name: service.name,
      description: service.summary,
      url,
      provider: { "@type": "Dentist", name: clinic.name },
    }),
  };
}

export function meta({ data }: Route.MetaArgs) {
  if (!data) return [{ title: "Treatment" }];
  return pageMeta({
    title: `${data.service.name} — ${data.clinic.name}`,
    description: data.service.summary.slice(0, 160),
    url: data.url,
    siteName: data.clinic.name,
    type: "article",
  });
}

export default function Service({ loaderData }: Route.ComponentProps) {
  const { clinic, base, service, others, jsonLd } = loaderData;
  const body = paragraphs(service.body);

  return (
    <main className="wrap wrap--page wrap--read" id="main">
      <Ld json={jsonLd} />

      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to={`${base}/services`}>Treatments</Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">{service.name}</span>
      </nav>

      <header className="pagehead">
        <h1 className="h1">{service.name}</h1>
        <p className="lede">{service.summary}</p>
        {service.price_from ? (
          <p className="pricetag">
            <span className="pricetag__from">from</span>{" "}
            <strong>
              {new Intl.NumberFormat("en-GB", {
                style: "currency",
                currency: clinic.currency,
                maximumFractionDigits: 0,
              }).format(Number(service.price_from))}
            </strong>
          </p>
        ) : (
          <p className="pricetag pricetag--none">
            Priced after an examination — it depends on the mouth, and a single
            number here would be a guess.
          </p>
        )}
      </header>

      {body.length ? (
        <section className="prose">
          {body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </section>
      ) : null}

      <section className="cta">
        <h2 className="h3">Book this</h2>
        <p className="small muted">
          Appointments are made in the patient area, against the practice's real
          diary — the same one the front desk is looking at.
        </p>
        <div className="row">
          <Link className="btn btn--primary" to="/login">Sign in to book</Link>
          <Link className="btn" to="/register">Register as a new patient</Link>
        </div>
      </section>

      {others.length ? (
        <section className="band" aria-labelledby="other-h">
          <h2 id="other-h" className="h3">Other treatments</h2>
          <ul className="chips">
            {others.map((s) => (
              <li key={s.id}>
                <Link className="chip" to={`${base}/services/${s.slug}`}>{s.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
