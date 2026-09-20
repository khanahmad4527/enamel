import { Link } from "react-router";
import type { Route } from "./+types/site.services";
import type { Env } from "~/lib/api.server";
import { practice, site } from "~/lib/site.server";
import { absolute, pageMeta } from "~/lib/seo";
import { ServiceRow } from "~/components/site";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const clinic = await practice(env);
  const base = "";
  return {
    clinic,
    base,
    services: await site.services(env),
    url: absolute(request, `${base}/services`),
  };
}

export function meta({ data }: Route.MetaArgs) {
  if (!data) return [{ title: "Treatments" }];
  return pageMeta({
    title: `Treatments and prices — ${data.clinic.name}`,
    description:
      `What ${data.clinic.name} treats, and what it costs. Nothing is started ` +
      `before you have seen the price in writing.`,
    url: data.url,
    siteName: data.clinic.name,
  });
}

export default function Services({ loaderData }: Route.ComponentProps) {
  const { clinic, base, services } = loaderData;

  return (
    <main className="wrap wrap--page" id="main">
      <header className="pagehead">
        <p className="eyebrow">{clinic.name}</p>
        <h1 className="h1">Treatments and prices</h1>
        <p className="lede">
          A price that says “from” is the starting figure for the simplest version of
          that treatment. You will be told what yours costs, in writing, before
          anything is started.
        </p>
      </header>

      {services.length ? (
        <ul className="cards">
          {services.map((s) => (
            <ServiceRow
              key={s.id}
              service={s}
              to={`${base}/services/${s.slug}`}
              currency={clinic.currency}
            />
          ))}
        </ul>
      ) : (
        <p className="empty">This practice has not published its treatments yet.</p>
      )}

      <div className="panel">
        <p className="small muted">
          Prices are in {clinic.currency} and include everything the appointment needs
          unless we say otherwise. If you are not sure which of these you want,{" "}
          <Link to={`${base}/contact`}>ring the practice</Link> and describe it — the
          front desk books this all day.
        </p>
      </div>
    </main>
  );
}
