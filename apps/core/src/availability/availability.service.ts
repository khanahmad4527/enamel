import { Injectable, NotFoundException } from "@nestjs/common";
import { DbService } from "../db/db.service";
import {
  clockOf,
  datesBetween,
  instantAt,
  localDate,
  localMinutes,
  minutesOf,
  weekdayOf,
} from "@enamel/time";

type ClinicRow = { id: string; name: string; timezone: string | null };
type HoursRow = { weekday: string; closed: boolean; opens_at: string | null; closes_at: string | null };
type SessionRow = {
  practitioner: string;
  weekday: string;
  starts_at: string;
  ends_at: string;
  room: string | null;
  first_name: string | null;
  last_name: string | null;
};
type BusyRow = { practitioner: string | null; room: string | null; starts_at: Date; ends_at: Date };
type BlockRow = { practitioner: string | null; starts_at: Date; ends_at: Date; kind: string };
type ClosureRow = { room: string; starts_at: Date; ends_at: Date; reason: string };
type RoomRow = { id: string; name: string; chair_number: number | null };

export type Slot = {
  date: string;
  starts_at: string;
  ends_at: string;
  local_start: string;
  local_end: string;
  practitioner: string;
  practitioner_name: string;
  room: string;
  room_name: string;
};

export type SlotQuery = {
  from: string;
  to: string;
  durationMinutes: number;
  stepMinutes: number;
  practitioner?: string | undefined;
  room?: string | undefined;
  limit: number;
};

export type DaySheet = {
  practice: { id: string; name: string; timezone: string };
  date: string;
  weekday: string;
  open: boolean;
  opens_at: string | null;
  closes_at: string | null;
  rooms: Array<{ id: string; name: string; chair_number: number | null; closed: boolean; closed_reason: string | null }>;
  appointments: Array<{
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
    start_minute: number;
    end_minute: number;
  }>;
  away: Array<{ practitioner: string | null; practitioner_name: string; kind: string; starts_at: string; ends_at: string }>;
};

/**
 * What is actually free, and what is on today.
 *
 * This is the reason the service exists. "Find the next hour with Dr
 * Okafor" is the intersection of five tables — opening hours, the rota,
 * leave, chair downtime and the appointments already in the book — across
 * a date range. Through the API that is dozens of round trips and a lot
 * of client-side date arithmetic; here it is four queries and a walk.
 *
 * Every query used to be scoped by a clinic id from the caller's token
 * and never from the request. The database connection underneath has no
 * permission layer, so that filter is the tenancy boundary rather than a
 * convenience — see `DbService`.
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly db: DbService) {}

  /** The practice. A singleton, so there is nothing to look it up by. */
  private async practice(): Promise<ClinicRow & { timezone: string }> {
    const row = await this.db.one<ClinicRow>(`SELECT id, name, timezone FROM practice LIMIT 1`);
    if (!row) throw new NotFoundException("This instance has no practice record yet.");
    // No timezone is a data problem, not a reason to guess the server's —
    // but UTC at least makes the arithmetic defined.
    return { ...row, timezone: row.timezone || "UTC" };
  }

  /**
   * The gaps.
   *
   * Walks each day's rota session in `step` increments and keeps the
   * starts where the whole appointment fits: the clinician is working,
   * nobody has booked them, and some chair is both free and in service.
   * A slot with no chair is not a slot — it is a clinician standing in a
   * corridor.
   */
  async slots(query: SlotQuery): Promise<{ timezone: string; slots: Slot[] }> {
    const practice = await this.practice();
    const tz = practice.timezone;
    const dates = datesBetween(query.from, query.to);
    if (dates.length === 0) return { timezone: tz, slots: [] };

    // The window the whole search covers, so the overlap queries can be
    // bounded rather than reading the entire history of the practice.
    const windowStart = instantAt(tz, dates[0]!, 0);
    const windowEnd = instantAt(tz, dates[dates.length - 1]!, 24 * 60);

    const [hours, sessions, busy, blocks, closures, rooms] = await Promise.all([
      this.db.rows<HoursRow>(
        `SELECT weekday, closed, opens_at::text, closes_at::text
           FROM clinic_hours WHERE TRUE`,
        [],
      ),
      this.db.rows<SessionRow>(
        `SELECT ph.practitioner, ph.weekday, ph.starts_at::text, ph.ends_at::text, ph.room,
                u.first_name, u.last_name
           FROM practitioner_hours ph
           LEFT JOIN directus_users u ON u.id = ph.practitioner
          WHERE ($1::uuid IS NULL OR ph.practitioner = $1::uuid)
            AND (ph.effective_from IS NULL OR ph.effective_from <= $3::date)
            AND (ph.effective_to   IS NULL OR ph.effective_to   >= $2::date)`,
        [query.practitioner ?? null, dates[0], dates[dates.length - 1]],
      ),
      this.db.rows<BusyRow>(
        `SELECT practitioner, room, starts_at, ends_at
           FROM appointments
          WHERE status IN ('scheduled','confirmed')
            AND starts_at < $2 AND ends_at > $1`,
        [windowStart, windowEnd],
      ),
      this.db.rows<BlockRow>(
        `SELECT practitioner, starts_at, ends_at, kind
           FROM absences
          WHERE status <> 'cancelled'
            AND starts_at < $2 AND ends_at > $1`,
        [windowStart, windowEnd],
      ),
      this.db.rows<ClosureRow>(
        `SELECT room, starts_at, ends_at, reason
           FROM room_closures
          WHERE starts_at < $2 AND ends_at > $1`,
        [windowStart, windowEnd],
      ),
      this.db.rows<RoomRow>(
        `SELECT id, name, chair_number FROM rooms
          WHERE active
            AND ($1::uuid IS NULL OR id = $1::uuid)
          ORDER BY chair_number NULLS LAST, name`,
        [query.room ?? null],
      ),
    ]);

    const openOn = new Map(hours.map((h) => [h.weekday, h]));
    const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean =>
      aStart < bEnd && aEnd > bStart;

    const slots: Slot[] = [];

    for (const date of dates) {
      if (slots.length >= query.limit) break;
      const weekday = weekdayOf(tz, date);

      // No hours on file at all is an unfinished rota, not a closure —
      // the same judgement the database trigger makes. Once a practice
      // has entered its week, it is held to it.
      const today = openOn.get(weekday);
      if (hours.length > 0 && (!today || today.closed || !today.opens_at || !today.closes_at)) continue;

      const practiceOpen = today?.opens_at ? minutesOf(today.opens_at) : 0;
      const practiceShut = today?.closes_at ? minutesOf(today.closes_at) : 24 * 60;

      for (const session of sessions.filter((s) => s.weekday === weekday)) {
        if (slots.length >= query.limit) break;

        const from = Math.max(practiceOpen, minutesOf(session.starts_at));
        const until = Math.min(practiceShut, minutesOf(session.ends_at));

        // Start on the step grid rather than at an awkward 08:30 — a
        // diary offering 08:37 is technically free and nobody books it.
        let minute = Math.ceil(from / query.stepMinutes) * query.stepMinutes;

        for (; minute + query.durationMinutes <= until; minute += query.stepMinutes) {
          if (slots.length >= query.limit) break;

          const startsAt = instantAt(tz, date, minute);
          const endsAt = instantAt(tz, date, minute + query.durationMinutes);

          /*
           * A slot that has already started is not available.
           *
           * Obvious, and it was missing. The search walks the rota from
           * the requested `from` date, and when that date is today it
           * began at the clinic's opening time regardless of the clock —
           * so at 10:23 the diary was offering 10:15.
           *
           * The consequence was worse than an odd-looking list. Nothing
           * in the scheduling constraints refuses a booking in the past,
           * so the appointment was made; and the portal policy only lets
           * a patient cancel an appointment that has not started — so
           * they were left holding a booking they could not call off, on
           * a slot that had already gone. Found because the verify suite
           * happened to run at twenty past ten.
           *
           * `getTime()` rather than a date comparison: these are instants
           * in the clinic's zone and the boundary is a moment, not a day.
           */
          if (startsAt.getTime() <= Date.now()) continue;

          const away = blocks.some(
            (b) =>
              (b.practitioner === null || b.practitioner === session.practitioner) &&
              overlaps(startsAt, endsAt, b.starts_at, b.ends_at),
          );
          if (away) continue;

          const taken = busy.some(
            (b) =>
              b.practitioner === session.practitioner &&
              overlaps(startsAt, endsAt, b.starts_at, b.ends_at),
          );
          if (taken) continue;

          // Their usual chair first. A practice that runs a dentist in
          // the same surgery every Tuesday expects the diary to as well,
          // and the fallback only matters when that one is unavailable.
          const preferred = session.room
            ? rooms.filter((r) => r.id === session.room).concat(rooms.filter((r) => r.id !== session.room))
            : rooms;

          const room = preferred.find((candidate) => {
            const down = closures.some(
              (c) => c.room === candidate.id && overlaps(startsAt, endsAt, c.starts_at, c.ends_at),
            );
            if (down) return false;
            return !busy.some(
              (b) => b.room === candidate.id && overlaps(startsAt, endsAt, b.starts_at, b.ends_at),
            );
          });
          if (!room) continue;

          slots.push({
            date,
            starts_at: startsAt.toISOString(),
            ends_at: endsAt.toISOString(),
            local_start: clockOf(minute),
            local_end: clockOf(minute + query.durationMinutes),
            practitioner: session.practitioner,
            practitioner_name: `${session.first_name ?? ""} ${session.last_name ?? ""}`.trim(),
            room: room.id,
            room_name: room.name,
          });
        }
      }
    }

    // Chronological. The per-session loop emits one clinician's whole day
    // before the next one's, which is the wrong order for "what is the
    // soonest I can be seen" — the question this endpoint exists to answer.
    slots.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

    return { timezone: tz, slots: slots.slice(0, query.limit) };
  }

  /**
   * One day, laid out by chair.
   *
   * The shape a practice actually works from: chairs across the top,
   * time down the side. Directus's calendar layout cannot do this — it
   * has day, week and month by time, with no notion of a resource lane —
   * which is why the day sheet is a custom interface and why it needs
   * this endpoint rather than a filtered item list.
   */
  async daySheet(date: string): Promise<DaySheet> {
    const practice = await this.practice();
    const tz = practice.timezone;
    const weekday = weekdayOf(tz, date);
    const dayStart = instantAt(tz, date, 0);
    const dayEnd = instantAt(tz, date, 24 * 60);

    const [hours, rooms, appointments, closures, away] = await Promise.all([
      this.db.one<HoursRow>(
        `SELECT weekday, closed, opens_at::text, closes_at::text
           FROM clinic_hours WHERE weekday = $1`,
        [weekday],
      ),
      this.db.rows<RoomRow>(
        `SELECT id, name, chair_number FROM rooms
          WHERE active ORDER BY chair_number NULLS LAST, name`,
        [],
      ),
      this.db.rows<{
        id: string; room: string | null; practitioner: string | null; status: string;
        reason: string | null; starts_at: Date; ends_at: Date;
        pr_first: string | null; pr_last: string | null;
        pa_first: string | null; pa_last: string | null;
      }>(
        `SELECT a.id, a.room, a.practitioner, a.status, a.reason, a.starts_at, a.ends_at,
                u.first_name AS pr_first, u.last_name AS pr_last,
                p.first_name AS pa_first, p.last_name AS pa_last
           FROM appointments a
           LEFT JOIN directus_users u ON u.id = a.practitioner
           LEFT JOIN patients p ON p.id = a.patient
          WHERE a.starts_at < $2 AND a.ends_at > $1
          ORDER BY a.starts_at`,
        [dayStart, dayEnd],
      ),
      this.db.rows<ClosureRow>(
        `SELECT room, starts_at, ends_at, reason FROM room_closures
          WHERE starts_at < $2 AND ends_at > $1`,
        [dayStart, dayEnd],
      ),
      this.db.rows<BlockRow & { first_name: string | null; last_name: string | null }>(
        `SELECT ab.practitioner, ab.starts_at, ab.ends_at, ab.kind, u.first_name, u.last_name
           FROM absences ab
           LEFT JOIN directus_users u ON u.id = ab.practitioner
          WHERE ab.status <> 'cancelled'
            AND ab.starts_at < $2 AND ab.ends_at > $1`,
        [dayStart, dayEnd],
      ),
    ]);

    return {
      practice: { id: practice.id, name: practice.name, timezone: tz },
      date,
      weekday,
      open: Boolean(hours && !hours.closed && hours.opens_at && hours.closes_at),
      opens_at: hours?.opens_at ? hours.opens_at.slice(0, 5) : null,
      closes_at: hours?.closes_at ? hours.closes_at.slice(0, 5) : null,
      rooms: rooms.map((r) => {
        const shut = closures.find((c) => c.room === r.id);
        return {
          id: r.id,
          name: r.name,
          chair_number: r.chair_number,
          closed: Boolean(shut),
          closed_reason: shut?.reason ?? null,
        };
      }),
      appointments: appointments.map((a) => ({
        id: a.id,
        room: a.room,
        practitioner: a.practitioner,
        practitioner_name: `${a.pr_first ?? ""} ${a.pr_last ?? ""}`.trim(),
        patient_name: `${a.pa_last ?? ""}, ${a.pa_first ?? ""}`.replace(/^, |, $/, "").trim(),
        reason: a.reason,
        status: a.status,
        starts_at: a.starts_at.toISOString(),
        ends_at: a.ends_at.toISOString(),
        local_start: clockOf(localMinutes(tz, a.starts_at)),
        local_end: clockOf(localMinutes(tz, a.ends_at)),
        // Minutes from local midnight, so the client can place a block
        // without redoing the timezone arithmetic — and without a second
        // implementation of it to disagree with this one.
        start_minute:
          localDate(tz, a.starts_at) === date ? localMinutes(tz, a.starts_at) : 0,
        end_minute:
          localDate(tz, a.ends_at) === date ? localMinutes(tz, a.ends_at) : 24 * 60,
      })),
      away: away.map((b) => ({
        practitioner: b.practitioner,
        practitioner_name: `${b.first_name ?? ""} ${b.last_name ?? ""}`.trim() || "The practice",
        kind: b.kind,
        starts_at: b.starts_at.toISOString(),
        ends_at: b.ends_at.toISOString(),
      })),
    };
  }
}
