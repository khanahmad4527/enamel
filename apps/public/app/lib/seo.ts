/**
 * What a search engine, a link preview and a screen reader are each told.
 *
 * A practice website is found three ways — somebody searches the name,
 * somebody searches "dentist near me", or somebody is sent the link in a
 * message — and all three are handled here so no page has to remember.
 *
 * The structured data is `Dentist`, not `LocalBusiness`. Both would
 * validate; `Dentist` is a subtype of `MedicalBusiness` and is the type
 * search engines actually use to decide that a result belongs in the
 * "dentists near you" answer rather than in the general business one.
 * The opening hours come from `clinic_hours` — the same rows the booking
 * engine refuses appointments against — so the hours a search engine
 * publishes cannot disagree with the diary.
 */

import { DAY_NAME, hhmm, type SiteClinic, type SiteHours, week } from "./hours";

/** The address this page actually answers on, for canonicals and OG tags. */
export function originOf(request: Request): string {
  const url = new URL(request.url);
  // Behind a proxy the scheme the visitor used is not the scheme this
  // process was called on. `x-forwarded-proto` is the only thing that
  // knows, and locally there is nothing in front, so the URL is right.
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}

export function absolute(request: Request, path: string): string {
  return `${originOf(request)}${path.startsWith("/") ? path : `/${path}`}`;
}

type MetaDescriptor = Record<string, unknown>;

/**
 * One page's head.
 *
 * `og:` and `twitter:` are not decoration on a health site: the preview
 * card is what somebody sees when a friend sends them "this is the
 * practice I go to", and a blank one reads as a dead link.
 */
export function pageMeta(opts: {
  title: string;
  description: string;
  url: string;
  siteName?: string;
  type?: "website" | "article";
}): MetaDescriptor[] {
  const { title, description, url, siteName, type = "website" } = opts;
  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:type", content: type },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    ...(siteName ? [{ property: "og:site_name", content: siteName }] : []),
    { property: "og:locale", content: "en_GB" },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
  ];
}

/** Keep the patient area out of an index, wherever this site is deployed. */
export const NOINDEX: MetaDescriptor = { name: "robots", content: "noindex, nofollow" };

const COUNTRY: Record<string, string> = { NL: "NL", AE: "AE", GB: "GB", DE: "DE" };

/**
 * The practice as `Dentist` structured data.
 *
 * Emitted as a JSON string for a `<script type="application/ld+json">`.
 * `JSON.stringify` is what makes that safe to inject: the only character
 * that could close the script element early is `<`, and it is escaped
 * below rather than trusted not to appear in a practice's own name.
 */
export function dentistJsonLd(
  clinic: SiteClinic,
  hours: SiteHours[],
  url: string,
): string {
  const openingHoursSpecification = week(hours)
    .filter(({ row }) => row && !row.closed && row.opens_at && row.closes_at)
    .map(({ day, row }) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: `https://schema.org/${DAY_NAME[day]}`,
      opens: hhmm(row!.opens_at),
      closes: hhmm(row!.closes_at),
    }));

  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Dentist",
    name: clinic.name,
    url,
    ...(clinic.strapline ? { slogan: clinic.strapline } : {}),
    ...(clinic.intro ? { description: clinic.intro } : {}),
    ...(clinic.phone ? { telephone: clinic.phone } : {}),
    ...(clinic.email ? { email: clinic.email } : {}),
    ...(clinic.address || clinic.city
      ? {
          address: {
            "@type": "PostalAddress",
            ...(clinic.address ? { streetAddress: clinic.address } : {}),
            ...(clinic.city ? { addressLocality: clinic.city } : {}),
            ...(clinic.country ? { addressCountry: COUNTRY[clinic.country] ?? clinic.country } : {}),
          },
        }
      : {}),
    ...(openingHoursSpecification.length ? { openingHoursSpecification } : {}),
    ...(clinic.currency ? { currenciesAccepted: clinic.currency } : {}),
  };

  return JSON.stringify(node).replace(/</g, "\\u003c");
}

/** The same escaping, for the other structured-data blocks. */
export function ldJson(node: unknown): string {
  return JSON.stringify(node).replace(/</g, "\\u003c");
}
