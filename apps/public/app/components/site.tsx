import { Link } from "react-router";
import { DAY_NAME, hhmm, type OpenState, type SiteHours, type Weekday, week } from "~/lib/hours";

/**
 * The most useful sentence on a dental practice's front page.
 *
 * Most practice websites make a patient work this out from a table:
 * find today, read across, compare with the clock, remember whether it
 * is a bank holiday. The answer is one line, and the practice's own
 * timezone is what it is computed in — so somebody reading the Dubai
 * practice's page from Amsterdam is told whether Dubai is open, not
 * whether it would be open here.
 *
 * The colour is the semantic green or amber, never the practice's brand
 * colour. "Are you open" is not a branding question, and a practice
 * whose colour happens to be green must not look permanently open.
 */
export function OpenNow({ state, phone }: { state: OpenState; phone: string | null }) {
  if (state.open) {
    return (
      <p className="status status--open">
        <span className="status__dot" aria-hidden="true" />
        <span>
          <strong>Open now</strong> — until {state.until} today
        </span>
      </p>
    );
  }
  const next = state.next;
  return (
    <p className="status status--shut">
      <span className="status__dot" aria-hidden="true" />
      <span>
        <strong>Closed now</strong>
        {next
          ? next.today
            ? ` — opens at ${next.time} this morning`
            : ` — opens ${DAY_NAME[next.day]} at ${next.time}`
          : null}
        {phone ? (
          <>
            {". "}
            In pain? Ring <a href={`tel:${phone.replace(/\s+/g, "")}`}>{phone}</a>.
          </>
        ) : null}
      </span>
    </p>
  );
}

/**
 * The week, as seven rows including the shut ones.
 *
 * A closed day is a row in `clinic_hours` rather than a missing one,
 * which is what lets this be a seven-row week instead of a list with
 * gaps a reader has to interpret. Today is marked, because the question
 * behind reading this table is almost always about today.
 */
export function Week({ hours, today }: { hours: SiteHours[]; today: Weekday | null }) {
  return (
    <table className="hours">
      <caption className="hours__caption">Opening hours</caption>
      <tbody>
        {week(hours).map(({ day, row }) => {
          const shut = !row || row.closed || !row.opens_at || !row.closes_at;
          return (
            <tr key={day} className={day === today ? "is-today" : undefined}>
              <th scope="row">
                {DAY_NAME[day]}
                {day === today ? <span className="hours__today"> today</span> : null}
              </th>
              <td className={shut ? "hours__shut" : undefined}>
                {shut ? "Closed" : `${hhmm(row!.opens_at)} – ${hhmm(row!.closes_at)}`}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * A treatment, priced or not.
 *
 * "From" is doing real work: a crown has a price and orthodontics does
 * not, because it depends on the mouth. A practice that prints a single
 * number for the second is a practice that will have an argument about
 * it later, so the absence is rendered as an absence rather than as
 * "Price on application", which is the same thing said less honestly.
 */
export function ServiceRow({
  service,
  to,
  currency,
}: {
  service: { name: string; summary: string; price_from: string | null; image?: string | null };
  to: string;
  currency: string;
}) {
  return (
    <li className="card">
      {/*
        The picture is decoration and is marked as such. A treatment is
        identified by its name and its price; an abstract image of it
        carries nothing a screen reader should stop for. The whole card
        is the link, through the heading — so the accessible name stays
        the treatment's name and never becomes "learn more".
      */}
      {service.image ? (
        <img
          className="card__image"
          src={`/brand/${service.image}`}
          alt=""
          aria-hidden="true"
          width={800}
          height={600}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="card__image" aria-hidden="true" />
      )}
      <div className="card__body">
        <h3 className="card__name">
          <Link to={to}>{service.name}</Link>
        </h3>
        <p className="card__summary">{service.summary}</p>
        <p className="card__price">
          {service.price_from ? (
            <>
              <span className="card__from">from</span>
              {formatPrice(service.price_from, currency)}
            </>
          ) : (
            <span className="card__quoted">Quoted after an examination</span>
          )}
        </p>
      </div>
    </li>
  );
}

function formatPrice(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${Math.round(n)}`;
  }
}

/** Structured data, escaped where it is built. See `seo.ts`. */
export function Ld({ json }: { json: string }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
