/**
 * Wall-clock arithmetic in a practice's own timezone.
 *
 * A practice opens at nine o'clock. Not at 07:00Z, and not at 08:00Z for
 * half the year — at nine o'clock, in its own town, on both sides of a
 * daylight-saving change. Opening hours and rota sessions are stored as
 * `time` columns for exactly that reason, and only become instants once a
 * clinic's timezone is applied.
 *
 * This lives in a package because it was written three times: once in the
 * provisioning seed, once in the core service, once in the day-sheet
 * extension. Three copies of a calculation whose failure mode is *silent*
 * — every appointment an hour out, nothing throwing — is three chances to
 * fix a bug in one of them and not the others.
 *
 * Everything here is pure and takes the timezone explicitly. There is no
 * ambient "current timezone": the whole point is that the answer depends
 * on which practice is asking, and Kadehuis is in Amsterdam while Marina
 * is in Dubai.
 */

/** Minutes since local midnight, from "HH:MM" or "HH:MM:SS". */
export function minutesOf(clock: string): number {
  const [h, m] = clock.split(":");
  return Number(h) * 60 + Number(m ?? 0);
}

/** Minutes since local midnight, or a fallback when the column is null. */
export function minutesOr(clock: string | null | undefined, fallback: number): number {
  return clock ? minutesOf(clock) : fallback;
}

/** "09:30" from minutes since midnight. */
export function clockOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * How far `tz` is from UTC at a given instant, in milliseconds.
 *
 * Formatting an instant into the zone and reading the result back as
 * though it were UTC gives the offset, daylight saving included. There is
 * no shorter way to do this with the standard library.
 */
function offsetAt(tz: string, instant: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  return (
    Date.UTC(
      Number(parts["year"]),
      Number(parts["month"]) - 1,
      Number(parts["day"]),
      Number(parts["hour"]) % 24,
      Number(parts["minute"]),
      Number(parts["second"]),
    ) - instant
  );
}

/**
 * The instant at which it is `minutes` past midnight on `isoDate` in `tz`.
 *
 * Two passes. The first guesses the offset at the naive instant, which is
 * wrong by an hour for the handful of local times either side of a clock
 * change; the second measures it again at the corrected instant and lands
 * on the right one.
 */
export function instantAt(tz: string, isoDate: string, minutes: number): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  const naive = Date.UTC(y!, m! - 1, d!, Math.floor(minutes / 60), Math.round(minutes) % 60);
  let instant = naive - offsetAt(tz, naive);
  instant = naive - offsetAt(tz, instant);
  return new Date(instant);
}

/**
 * The instant `dayOffset` days from today at `hour:minute`, in `tz`.
 *
 * "Today" is resolved in the clinic's zone too, which is the part that is
 * easy to get wrong: seeding a diary from a laptop in a third timezone
 * otherwise rolls half the appointments onto the wrong date.
 */
export function instantFromToday(
  tz: string,
  dayOffset: number,
  hour: number,
  minute = 0,
): Date {
  const today = localDate(tz, new Date());
  const [y, m, d] = today.split("-").map(Number);
  // Through UTC midday so adding whole days cannot trip over a clock
  // change and land on the previous date.
  const shifted = new Date(Date.UTC(y!, m! - 1, d!, 12));
  shifted.setUTCDate(shifted.getUTCDate() + dayOffset);
  return instantAt(tz, shifted.toISOString().slice(0, 10), hour * 60 + minute);
}

/** The local calendar date in `tz` at a given instant, as YYYY-MM-DD. */
export function localDate(tz: string, instant: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}

/** Minutes since local midnight in `tz` at a given instant. */
export function localMinutes(tz: string, instant: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return (Number(parts["hour"]) % 24) * 60 + Number(parts["minute"]);
}

/** Minutes since local midnight in `tz`, right now. */
export function localMinutesNow(tz: string): number {
  return localMinutes(tz, new Date());
}

/** The rota's weekday key — "mon", "tue" — for a local date in `tz`. */
export function weekdayOf(tz: string, isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
    .format(instantAt(tz, isoDate, 12 * 60))
    .slice(0, 3)
    .toLowerCase();
}

/** The rota's weekday key `dayOffset` days from today, in `tz`. */
export function weekdayFromToday(tz: string, dayOffset: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
    .format(instantFromToday(tz, dayOffset, 12))
    .slice(0, 3)
    .toLowerCase();
}

/** Shifts an ISO date by whole days without tripping over a clock change. */
export function shiftIsoDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every calendar date from `from` to `to` inclusive, capped. */
export function datesBetween(from: string, to: string, cap = 62): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cursor <= end && out.length < cap) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** The rota's short keys are not what a person reading a screen wants. */
const WEEKDAY_NAMES: Record<string, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export function weekdayName(key: string | undefined): string {
  return WEEKDAY_NAMES[key ?? ""] ?? key ?? "";
}
