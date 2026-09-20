/**
 * The practice's public website, and the one credential that reads it.
 *
 * This is the other half of `api.server.ts`, and the split is the whole
 * security story of this site:
 *
 *   `api.server.ts` carries **the patient's own token**. Everything it
 *   can see is something the practice has already decided that patient
 *   may see, so the portal cannot leak somebody else's record even if
 *   this code is wrong.
 *
 *   This file carries **the Website token**, which is a different account
 *   with a different policy: read-only, and scoped to five collections of
 *   public content. It is asserted in the verify suite to be refused on
 *   patients, appointments, invoices, payments, documents, messages,
 *   treatment records, clinical notes and the access log — and to be
 *   unable to write anything at all.
 *
 * A static token is the right shape here and the wrong shape there. The
 * pages below have no visitor attached: somebody reading the opening
 * hours has not signed in and never will, so *something* server-side has
 * to hold a credential. The rule is that the credential can only ever
 * fetch what the practice has published on purpose.
 */

import type { Env } from "./api.server";
import type {
  SiteClinic, SiteFaq, SiteHours, SitePage, SitePerson, SiteRetention, SiteService,
} from "./hours";

/**
 * A shared cache, which is safe here and would not be one line up.
 *
 * Every response below is identical for every visitor *by construction*:
 * the Website policy's filters are fixed (`published`, `active`), none of
 * them reference the caller, and the token is the same one every time. So
 * two visitors cannot be served each other's data, because there is no
 * "each other's data" to serve.
 *
 * That is exactly why nothing on the patient's side of this site is
 * cached, and why the two live in different files. A cache keyed by URL
 * in front of a per-patient token is how a portal shows one person
 * another person's appointments.
 */
const cache = new Map<string, { at: number; body: unknown }>();
const MAX_ENTRIES = 200;

/**
 * How long a published page may lag the practice's own edits.
 *
 * A minute is the right answer for a practice website under load and the
 * wrong one for somebody demonstrating it, who changes an opening time in
 * Directus and refreshes. Configurable rather than argued about; zero
 * turns the cache off entirely, which is what a development stack runs.
 */
const ttlMs = (env: Env) => {
  const seconds = Number(env.WEBSITE_CACHE_SECONDS ?? "60");
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 60_000;
};

async function read<T>(env: Env, path: string): Promise<T> {
  const ttl = ttlMs(env);
  const hit = cache.get(path);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.body as T;

  const res = await fetch(`${env.DIRECTUS_URL}${path}`, {
    headers: { authorization: `Bearer ${env.WEBSITE_TOKEN}` },
  });
  if (!res.ok) {
    // Deliberately not the upstream sentence. Nothing a visitor to a
    // public website can do about a 403 on a service account, and the
    // wording of a permission error is not for them.
    throw new Response("The practice's website is temporarily unavailable.", { status: 503 });
  }
  const body = ((await res.json()) as { data?: T }).data as T;

  if (ttl === 0) return body;
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(path, { at: Date.now(), body });
  return body;
}

const CLINIC_FIELDS =
  "id,slug,name,strapline,intro,city,country,timezone,currency,phone,phone_note,email,address," +
  "theme_primary,theme_logo,hero_image,website_domain";

export const site = {
  practice: (env: Env) =>
    read<SiteClinic>(env, `/items/practice?fields=${CLINIC_FIELDS}`),

  services: (env: Env) =>
    read<SiteService[]>(
      env,
      `/items/services?limit=-1&sort=sort,name&fields=id,name,slug,summary,body,price_from,sort,image`,
    ),

  faqs: (env: Env) =>
    read<SiteFaq[]>(
      env,
      `/items/faqs?limit=-1&sort=sort&fields=id,question,answer,sort`,
    ),

  /**
   * The clinicians who agreed to appear.
   *
   * `public_profile` is not in the field list, and that is not an
   * oversight — it is the filter, not the content, and the policy does
   * not grant reading it. Directus refuses the **whole query** when one
   * requested field is not permitted, which presents as an empty page
   * rather than as a permission error. Cost me an afternoon once already.
   */
  team: (env: Env) =>
    read<SitePerson[]>(
      env,
      `/users?limit=-1&sort=public_sort,first_name&fields=id,first_name,last_name,job_title,` +
        `public_bio,public_sort,public_photo`,
    ),

  hours: (env: Env) =>
    read<SiteHours[]>(
      env,
      `/items/clinic_hours?limit=-1&fields=id,weekday,closed,opens_at,closes_at`,
    ),

  /**
   * The pages the practice wrote itself. Published ones only — and there
   * is no `status` filter here, which is the point worth recording.
   *
   * The first version filtered on it and got a 403: the Website policy
   * does not grant `status` as a *field*, and Directus refuses a query
   * that filters on a field the caller cannot read. The policy restricts
   * the rows to published already, so the filter was asking again for
   * something that had been decided — and asking in a way that could
   * only fail. A draft is not hidden here; it does not exist for this
   * token.
   */
  pages: (env: Env) =>
    read<SitePage[]>(
      env,
      `/items/pages?limit=-1&sort=sort,title&fields=id,title,slug,summary,nav,sort`,
    ),

  page: (env: Env, slug: string) =>
    read<SitePage[]>(
      env,
      `/items/pages?limit=1&fields=id,title,slug,summary,body,date_updated` +
        `&filter[slug][_eq]=${encodeURIComponent(slug)}`,
    ),

  /**
   * What this practice keeps, and for how long.
   *
   * Read by the privacy notice, which is obliged to state it — GDPR
   * Article 13(2)(a). Taken from the same rows the practice maintains
   * for its own retention policy rather than typed into the page, so the
   * notice cannot drift from the rule. The two demo practices genuinely
   * disagree (twenty years in the Netherlands, twenty-five in the UAE)
   * and the published notice says so without anybody editing it.
   */
  retention: (env: Env) =>
    read<SiteRetention[]>(
      env,
      `/items/retention_rules?limit=-1&sort=record_type&fields=id,record_type,years,starts_from,legal_basis`,
    ),
};

/* ------------------------------------------------------------------ *
 * The practice
 * ------------------------------------------------------------------ */

/**
 * There used to be a resolver here, and it was the biggest single idea
 * in this file: a visitor arrived on a host or a path segment, and it
 * worked out which of several practices they had come for. A `Located`
 * was either a practice — with a `base` that prefixed every link on the
 * page — or a *chooser*, the shared host's front page listing them.
 *
 * That chooser is why this site had no home page. `/` was a list of
 * practices rather than a practice, which is the right answer to a
 * question nobody was asking.
 *
 * One practice, so there is nothing to resolve. `base` is gone from the
 * links, every route reads the same record, and `/` is the front door.
 */
export async function practice(env: Env): Promise<SiteClinic> {
  return site.practice(env);
}

/**
 * The practice, or nothing, for a page that must still render without it.
 *
 * The sign-in has to work when the content credential does not: a
 * practice's colour is a nicety, being able to reach your own record is
 * not.
 */
export async function practiceOrNull(env: Env): Promise<SiteClinic | null> {
  try {
    return await site.practice(env);
  } catch {
    return null;
  }
}
