/**
 * Times, drawn where the appointment actually is.
 *
 * Every timestamp from the API is an instant in UTC, and a patient who
 * books at Marina Smile Clinic and reads the page from a hotel in Lisbon
 * must still see the time they will turn up: 09:30 in Dubai. So nothing
 * here formats in the browser's zone — the clinic's `timezone` column is
 * passed in and `Intl` does the work.
 *
 * This is the one piece of date handling the site owns. Everything that
 * decides *whether* a time is bookable happens in Postgres and in the
 * core service, against the same clinic timezone, and the page never
 * does arithmetic it could get wrong.
 */

export function timeIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function dateIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

export function longDateIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}

/** "Tuesday, 14 October" from a plain YYYY-MM-DD, with no zone shifting. */
export function dayLabel(isoDate: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

export function money(amount: string | number, currency: string): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
  } catch {
    // An unknown currency code should not take the invoice list down.
    return `${currency} ${n.toFixed(2)}`;
  }
}

export function personName(
  p: { first_name: string | null; last_name: string | null } | null,
  fallback = "the practice",
): string {
  if (!p) return fallback;
  const name = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return name || fallback;
}

/** Today, in the clinic's zone, as YYYY-MM-DD — the first day worth offering. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const TONE: Record<string, string> = {
  scheduled: "pill--good",
  confirmed: "pill--good",
  completed: "",
  cancelled: "pill--stop",
  no_show: "pill--stop",
  paid: "pill--good",
  sent: "pill--warn",
  overdue: "pill--stop",
  draft: "",
  pending: "pill--warn",
  active: "pill--good",
};

export function tone(status: string): string {
  return TONE[status] ?? "";
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * A practice's own prose, broken into paragraphs and nothing more.
 *
 * The `body` field on a service is stored as markdown, and the obvious
 * thing to do with it is render the markdown. That means either a parser
 * in the bundle or `dangerouslySetInnerHTML`, and the second one turns
 * every receptionist with edit rights into somebody who can put a script
 * tag on the practice's front page. For text a patient reads, blank-line
 * paragraphs are the whole of what is needed, and they cannot inject
 * anything because React escapes them.
 */
export function paragraphs(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
