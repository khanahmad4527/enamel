/** What the core service's `/availability/day` returns, as the grid reads it. */

export type Room = {
  id: string;
  name: string;
  chair_number: number | null;
  closed: boolean;
  closed_reason: string | null;
};

export type Appointment = {
  id: string;
  room: string | null;
  practitioner: string | null;
  practitioner_name: string;
  patient_name: string;
  reason: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  local_start: string;
  local_end: string;
  /**
   * Minutes from local midnight, computed server-side.
   *
   * The grid places every block from these two numbers. They come from the
   * service rather than being derived here on purpose: a second
   * implementation of the timezone arithmetic is a second implementation
   * to disagree with the first, and the disagreement would show up as
   * appointments drawn an hour out rather than as an error.
   */
  start_minute: number;
  end_minute: number;
};

export type Away = {
  practitioner: string | null;
  practitioner_name: string;
  kind: string;
  starts_at: string;
  ends_at: string;
};

export type Sheet = {
  practice: { id: string; name: string; timezone: string };
  date: string;
  weekday: string;
  open: boolean;
  opens_at: string | null;
  closes_at: string | null;
  rooms: Room[];
  appointments: Appointment[];
  away: Away[];
};

/** Only these can be moved. The rest are history, not plans. */
export const MOVABLE = ["scheduled", "confirmed"];

export const isMovable = (a: Appointment): boolean => MOVABLE.includes(a.status);

/**
 * The one place an error message is pulled out of a response.
 *
 * Three conventions reach this screen. Directus answers `{ errors: [{
 * message }] }`, Nest answers `{ statusCode, message }`, and axios has its
 * own `message` when the request never arrived. The proxy translates the
 * middle one, and this reads all three anyway — the scheduling hook's
 * sentence survived four hops once and died on the fifth in exactly this
 * shape mismatch, arriving as "Request failed with status code 400".
 */
export function messageFrom(e: any, fallback: string): string {
  const raw: string =
    e?.response?.data?.errors?.[0]?.message ??
    e?.response?.data?.message ??
    e?.message ??
    fallback;

  /*
   * Directus renders an `InvalidPayloadError` as "Invalid payload. <the
   * reason>", and the scheduling hook raises one deliberately because a
   * refused booking *is* a 400. But the sentence after it was written for
   * a receptionist — "Sam Okonkwo is already booked Sat 19 Sept,
   * 09:45–10:30" — and the wrapper in front of it is the platform talking
   * to a developer. Only the leading clause goes; the rest is untouched,
   * and a message that never had the prefix is returned as it came.
   */
  return raw.replace(/^(Invalid payload|Validation failed for field "[^"]*")\.\s*/, "").trim() || raw;
}
