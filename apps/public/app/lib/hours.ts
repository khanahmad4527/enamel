/**
 * The practice's public content, and the clock it is read against.
 *
 * Isomorphic on purpose: these types and functions are used by loaders,
 * by components, and by `meta()` — which React Router runs on the server
 * for the first paint and in the browser on every navigation after it.
 * The fetching lives next door in `site.server.ts`, which carries a
 * credential and must never reach a browser bundle; nothing here does.
 */

export type SiteClinic = {
  id: string;
  slug: string;
  name: string;
  strapline: string | null;
  intro: string | null;
  city: string | null;
  country: string | null;
  timezone: string;
  currency: string;
  phone: string | null;
  /** One line under the telephone number, or nothing if the practice set none. */
  phone_note: string | null;
  email: string | null;
  address: string | null;
  theme_primary: string | null;
  theme_logo: string | null;
  website_domain: string | null;
  hero_image: string | null;
};

export type SiteService = {
  id: string;
  name: string;
  slug: string;
  summary: string;
  body: string | null;
  price_from: string | null;
  sort: number | null;
  image: string | null;
};

/** A page the practice wrote in Directus, rendered at /pages/:slug. */
export type SitePage = {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  body?: string;
  nav?: "none" | "header" | "footer" | "both" | null;
  sort?: number | null;
  date_updated?: string | null;
};

export type SiteFaq = { id: string; question: string; answer: string; sort: number | null };

export type SitePerson = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  public_bio: string | null;
  public_sort: number | null;
  public_photo: string | null;
};

export type SiteHours = {
  id: string;
  weekday: Weekday;
  closed: boolean;
  opens_at: string | null;
  closes_at: string | null;
};

export type SiteRetention = {
  id: string;
  record_type: string;
  years: number;
  starts_from: string;
  legal_basis: string;
};

/* ------------------------------------------------------------------ *
 * Open now?
 * ------------------------------------------------------------------ */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export const WEEK: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const DAY_NAME: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/** Now, in the practice's own timezone — its weekday and its wall clock. */
export function nowAt(timeZone: string, at = new Date()): { day: Weekday; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday").slice(0, 3).toLowerCase() as Weekday;
  // `en-GB` at midnight gives "24" for the hour, which sorts after every
  // closing time and would report a practice shut all day on the one
  // minute of the day when the answer barely matters. Still wrong.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { day, time: `${hour}:${get("minute")}` };
}

/** `HH:MM` from the `HH:MM:SS` a Postgres `time` column hands back. */
export const hhmm = (t: string | null): string => (t ? t.slice(0, 5) : "");

export type OpenState =
  | { open: true; until: string }
  | { open: false; next: { day: Weekday; time: string; today: boolean } | null };

/**
 * Whether the practice is open at this moment, and when it next is.
 *
 * The single most useful sentence on a dental practice's front page, and
 * the one most practice websites make you work out from a table. Computed
 * in the practice's timezone from the same `clinic_hours` rows the
 * scheduling engine refuses bookings against — so it cannot say "open"
 * on a day the diary will not take an appointment.
 *
 * Times compare as strings because they are zero-padded `HH:MM`, which
 * makes the comparison exact rather than a float of minutes-since-
 * midnight that has to be reconstructed on both sides.
 */
export function openState(hours: SiteHours[], timeZone: string, at = new Date()): OpenState {
  const byDay = new Map<Weekday, SiteHours>();
  for (const h of hours) byDay.set(h.weekday, h);

  const { day, time } = nowAt(timeZone, at);
  const todayIndex = WEEK.indexOf(day);
  if (todayIndex < 0) return { open: false, next: null };

  const today = byDay.get(day);
  if (today && !today.closed && today.opens_at && today.closes_at) {
    const opens = hhmm(today.opens_at);
    const closes = hhmm(today.closes_at);
    if (time >= opens && time < closes) return { open: true, until: closes };
    if (time < opens) return { open: false, next: { day, time: opens, today: true } };
  }

  // Closed now. The next day with an opening time on it, looking a full
  // week ahead — a practice that only opens on Saturdays should still be
  // able to say when.
  for (let step = 1; step <= 7; step++) {
    const d = WEEK[(todayIndex + step) % 7]!;
    const row = byDay.get(d);
    if (row && !row.closed && row.opens_at) {
      return { open: false, next: { day: d, time: hhmm(row.opens_at), today: false } };
    }
  }
  return { open: false, next: null };
}

/** The seven rows in reading order, closed days included as closed days. */
export function week(hours: SiteHours[]): Array<{ day: Weekday; row: SiteHours | null }> {
  const byDay = new Map<Weekday, SiteHours>();
  for (const h of hours) byDay.set(h.weekday, h);
  return WEEK.map((day) => ({ day, row: byDay.get(day) ?? null }));
}
