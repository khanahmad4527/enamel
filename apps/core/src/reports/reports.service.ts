import { Injectable, NotFoundException } from "@nestjs/common";
import { DbService } from "../db/db.service";

/**
 * The numbers a practice owner runs the business on.
 *
 * Directus Insights handles a good half of this and is used for that half:
 * invoiced revenue, outstanding balance, patient growth, production over
 * time are all single aggregates with a filter, which is exactly what a
 * panel is for. Those are provisioned as a dashboard, not reimplemented
 * here.
 *
 * What a panel cannot do is divide one aggregate by another. Every rate on
 * this screen — utilisation, no-show, cancellation, acceptance, recall
 * conversion — is a ratio, and a ratio is two queries and a denominator
 * somebody has to decide on. That decision is the interesting part and it
 * is where most dashboards quietly mislead, so each one is written down
 * next to the query that implements it.
 *
 * Everything used to take a clinic id the controller resolved from the
 * caller's token, never from the request. This service reads Postgres
 * directly and has no permission layer underneath it.
 */

export type Range = { from: string; to: string };

const WEEKDAY = "(ARRAY['sun','mon','tue','wed','thu','fri','sat'])";

/**
 * The days in the range, with the practice's open window on each as real
 * instants.
 *
 * Shared by both utilisation figures. `generate_series` over dates rather
 * than timestamps on purpose: the weekday of a *date* is unambiguous,
 * where the weekday of an instant depends on the zone you ask in — and
 * Kadehuis is in Amsterdam while Marina is in Dubai.
 */
const OPEN_DAYS = `
  days AS (
    SELECT d::date AS day
      FROM generate_series($1::date, $2::date, interval '1 day') d
  ),
  open AS (
    SELECT days.day,
           ((days.day + h.opens_at)  AT TIME ZONE c.timezone) AS window_start,
           ((days.day + h.closes_at) AT TIME ZONE c.timezone) AS window_end,
           EXTRACT(EPOCH FROM (h.closes_at - h.opens_at)) / 60 AS minutes
      FROM days
      CROSS JOIN practice c
      JOIN clinic_hours h
        ON h.weekday = ${WEEKDAY}[EXTRACT(DOW FROM days.day)::int + 1]
     WHERE NOT h.closed AND h.opens_at IS NOT NULL AND h.closes_at IS NOT NULL
  )`;

/** Minutes an appointment occupies, for the statuses that consumed a chair. */
const BOOKED_MINUTES = `
  SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 60), 0)::float AS minutes
    FROM appointments a
   WHERE a.starts_at >= ($1::date::timestamp AT TIME ZONE (SELECT timezone FROM practice LIMIT 1))
     AND a.starts_at <  (($2::date + 1)::timestamp AT TIME ZONE (SELECT timezone FROM practice LIMIT 1))`;

export type Summary = Awaited<ReturnType<ReportsService["summary"]>>;

@Injectable()
export class ReportsService {
  constructor(private readonly db: DbService) {}

  private async timezone(): Promise<string> {
    const row = await this.db.one<{ timezone: string | null }>(
      "SELECT timezone FROM practice LIMIT 1",
    );
    if (!row) throw new NotFoundException("No such practice.");
    return row.timezone || "UTC";
  }

  /**
   * Money in, money owed.
   *
   * Invoiced and collected are deliberately separate. A practice that
   * invoiced ninety thousand and collected forty has a very different
   * problem from one that invoiced forty and collected forty, and a single
   * "revenue" figure hides which of the two you are.
   */
  async revenue({ from, to }: Range) {
    const row = await this.db.one<{
      invoiced: string; collected: string; outstanding: string; overdue: string; unpaid_count: string;
    }>(
      `SELECT
         COALESCE(SUM(total) FILTER (WHERE issued_at BETWEEN $1::date AND $2::date), 0)::text AS invoiced,
         COALESCE(SUM(total) FILTER (WHERE status = 'paid' AND paid_at BETWEEN $1::date AND $2::date), 0)::text AS collected,
         -- Outstanding is a balance, not a flow: everything still owed at
         -- this moment, regardless of when it was raised. Filtering it by
         -- the range would report "nothing outstanding" for any range that
         -- happens to exclude the month the invoice was sent.
         COALESCE(SUM(total) FILTER (WHERE status IN ('sent', 'overdue')), 0)::text AS outstanding,
         COALESCE(SUM(total) FILTER (WHERE status = 'overdue'), 0)::text AS overdue,
         COUNT(*) FILTER (WHERE status IN ('sent', 'overdue'))::text AS unpaid_count
       FROM invoices`,
      [from, to],
    );
    return {
      invoiced: Number(row?.invoiced ?? 0),
      collected: Number(row?.collected ?? 0),
      outstanding: Number(row?.outstanding ?? 0),
      overdue: Number(row?.overdue ?? 0),
      unpaidCount: Number(row?.unpaid_count ?? 0),
    };
  }

  /** What was actually done, by day. The practice's heartbeat. */
  async production({ from, to }: Range) {
    const tz = await this.timezone();
    const rows = await this.db.rows<{ day: string; value: string; items: string }>(
      `SELECT to_char(r.performed_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(r.price), 0)::text AS value,
              COUNT(*)::text AS items
         FROM treatment_records r
        WHERE r.status = 'completed'
          AND (r.performed_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 1`,
      [from, to, tz],
    );
    const byDay = rows.map((r) => ({ day: r.day, value: Number(r.value), items: Number(r.items) }));
    return { total: byDay.reduce((sum, d) => sum + d.value, 0), byDay };
  }

  /**
   * How the diary actually went.
   *
   * The denominator is the decision. A no-show rate out of *all*
   * appointments in the range counts next Tuesday's booking as a success,
   * which flatters the number and moves with how far ahead you look. Out
   * of appointments whose time has passed, it means what a practice thinks
   * it means: of the slots that came round, this fraction was wasted.
   */
  async attendance({ from, to }: Range) {
    const tz = await this.timezone();
    const row = await this.db.one<{
      settled: string; completed: string; no_show: string; cancelled: string; upcoming: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE starts_at < now() AND status IN ('completed','no_show','cancelled'))::text AS settled,
         COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
         COUNT(*) FILTER (WHERE status = 'no_show')::text AS no_show,
         COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled,
         COUNT(*) FILTER (WHERE starts_at >= now() AND status IN ('scheduled','confirmed'))::text AS upcoming
       FROM appointments
      WHERE (starts_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date`,
      [from, to, tz],
    );
    const settled = Number(row?.settled ?? 0);
    const noShow = Number(row?.no_show ?? 0);
    const cancelled = Number(row?.cancelled ?? 0);
    return {
      settled,
      completed: Number(row?.completed ?? 0),
      noShow,
      cancelled,
      upcoming: Number(row?.upcoming ?? 0),
      // Null rather than zero when nothing has settled. A practice with no
      // finished appointments has no no-show rate; reporting 0% would read
      // as "nobody missed an appointment", which is a different claim.
      noShowRate: settled ? noShow / settled : null,
      cancellationRate: settled ? cancelled / settled : null,
    };
  }

  /**
   * Chair and clinician utilisation.
   *
   * Two figures, because they answer different questions and a practice
   * with one number cannot tell which problem it has. Chairs at 90% with
   * clinicians at 50% means you need another dentist; the reverse means
   * you need another surgery.
   *
   * Capacity subtracts downtime in both cases — a chair that was out of
   * service all week was never capacity, and counting it makes utilisation
   * look worse the more honest the practice is about its broken equipment.
   */
  async utilisation({ from, to }: Range) {
    const chairs = await this.db.one<{ capacity: string; lost: string; rooms: string }>(
      `WITH ${OPEN_DAYS},
       active_rooms AS (SELECT count(*)::float AS n FROM rooms WHERE active),
       lost AS (
         SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                  LEAST(o.window_end, rc.ends_at) - GREATEST(o.window_start, rc.starts_at)
                )) / 60)), 0)::float AS minutes
           FROM open o
           JOIN room_closures rc
             ON rc.starts_at < o.window_end AND rc.ends_at > o.window_start
       )
       SELECT (COALESCE((SELECT SUM(minutes) FROM open), 0) * (SELECT n FROM active_rooms))::text AS capacity,
              (SELECT minutes FROM lost)::text AS lost,
              (SELECT n FROM active_rooms)::text AS rooms`,
      [from, to],
    );

    const booked = await this.db.one<{ minutes: string }>(
      `${BOOKED_MINUTES} AND a.room IS NOT NULL AND a.status IN ('scheduled','confirmed','completed')`,
      [from, to],
    );

    const staff = await this.db.one<{ capacity: string; lost: string }>(
      `WITH ${OPEN_DAYS},
       sessions AS (
         SELECT o.day,
                GREATEST(o.window_start, ((o.day + ph.starts_at) AT TIME ZONE c.timezone)) AS s,
                LEAST(o.window_end,  ((o.day + ph.ends_at)   AT TIME ZONE c.timezone)) AS e,
                ph.practitioner
           FROM open o
           CROSS JOIN practice c
           JOIN practitioner_hours ph
             ON ph.weekday = ${WEEKDAY}[EXTRACT(DOW FROM o.day)::int + 1]
            AND (ph.effective_from IS NULL OR ph.effective_from <= o.day)
            AND (ph.effective_to   IS NULL OR ph.effective_to   >= o.day)
       )
       SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (e - s)) / 60)), 0)::text AS capacity,
              COALESCE((
                SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                         LEAST(sessions.e, ab.ends_at) - GREATEST(sessions.s, ab.starts_at)
                       )) / 60))
                  FROM sessions
                  JOIN absences ab
                    ON ab.status <> 'cancelled'
                   AND (ab.practitioner IS NULL OR ab.practitioner = sessions.practitioner)
                   AND ab.starts_at < sessions.e AND ab.ends_at > sessions.s
              ), 0)::text AS lost
         FROM sessions`,
      [from, to],
    );

    const staffBooked = await this.db.one<{ minutes: string }>(
      `${BOOKED_MINUTES} AND a.practitioner IS NOT NULL AND a.status IN ('scheduled','confirmed','completed')`,
      [from, to],
    );

    const chairCapacity = Number(chairs?.capacity ?? 0) - Number(chairs?.lost ?? 0);
    const staffCapacity = Number(staff?.capacity ?? 0) - Number(staff?.lost ?? 0);

    return {
      chair: {
        bookedMinutes: Number(booked?.minutes ?? 0),
        capacityMinutes: chairCapacity,
        lostToClosures: Number(chairs?.lost ?? 0),
        rooms: Number(chairs?.rooms ?? 0),
        rate: chairCapacity > 0 ? Number(booked?.minutes ?? 0) / chairCapacity : null,
      },
      clinician: {
        bookedMinutes: Number(staffBooked?.minutes ?? 0),
        capacityMinutes: staffCapacity,
        lostToAbsence: Number(staff?.lost ?? 0),
        rate: staffCapacity > 0 ? Number(staffBooked?.minutes ?? 0) / staffCapacity : null,
      },
    };
  }

  /**
   * Case acceptance, by count and by value — and the gap between them.
   *
   * The gap is the whole point, and it is why one acceptance number is
   * worse than none. A practice accepting 80% of items but 40% of value is
   * one where patients say yes to the fillings and no to the crowns: the
   * count says the conversations are going well and the money says they
   * are not. Reporting either alone tells you the wrong story half the time.
   */
  async acceptance({ from, to }: Range) {
    const byValue = await this.db.one<{ presented: string; accepted: string; plans: string; taken: string }>(
      `SELECT COALESCE(SUM(presented_total), 0)::text AS presented,
              COALESCE(SUM(accepted_total) FILTER (WHERE accepted_on IS NOT NULL), 0)::text AS accepted,
              COUNT(*)::text AS plans,
              COUNT(*) FILTER (WHERE accepted_on IS NOT NULL)::text AS taken
         FROM treatment_plans
        WHERE presented_on BETWEEN $1::date AND $2::date`,
      [from, to],
    );

    const byCount = await this.db.one<{ items: string; accepted: string }>(
      `SELECT COUNT(*)::text AS items,
              COUNT(*) FILTER (WHERE i.status = 'accepted')::text AS accepted
         FROM treatment_plan_items i
         JOIN treatment_plans p ON p.id = i.plan
        WHERE p.presented_on BETWEEN $1::date AND $2::date`,
      [from, to],
    );

    const presented = Number(byValue?.presented ?? 0);
    const items = Number(byCount?.items ?? 0);
    return {
      plansPresented: Number(byValue?.plans ?? 0),
      plansAccepted: Number(byValue?.taken ?? 0),
      presentedValue: presented,
      acceptedValue: Number(byValue?.accepted ?? 0),
      itemsPresented: items,
      itemsAccepted: Number(byCount?.accepted ?? 0),
      byValue: presented > 0 ? Number(byValue?.accepted ?? 0) / presented : null,
      byCount: items > 0 ? Number(byCount?.accepted ?? 0) / items : null,
    };
  }

  /** Recalls that came due, and how many turned into a booking. */
  async recall({ from, to }: Range) {
    const row = await this.db.one<{ due: string; scheduled: string }>(
      `SELECT COUNT(*)::text AS due,
              COUNT(*) FILTER (WHERE date_scheduled IS NOT NULL)::text AS scheduled
         FROM recalls
        WHERE NOT is_disabled
          AND date_due BETWEEN $1::date AND $2::date`,
      [from, to],
    );
    const due = Number(row?.due ?? 0);
    return {
      due,
      scheduled: Number(row?.scheduled ?? 0),
      conversion: due > 0 ? Number(row?.scheduled ?? 0) / due : null,
    };
  }

  /**
   * Per clinician.
   *
   * Deliberately not a league table. Production alone rewards whoever does
   * the expensive work, so the hygienist always loses; the columns sit
   * beside each other and the practice owner reads them together.
   */
  async clinicians({ from, to }: Range) {
    const tz = await this.timezone();
    return (
      await this.db.rows<{
        id: string; name: string; appointments: string; completed: string;
        no_show: string; production: string; booked_minutes: string;
      }>(
        `SELECT u.id,
                trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS name,
                COUNT(a.id)::text AS appointments,
                COUNT(a.id) FILTER (WHERE a.status = 'completed')::text AS completed,
                COUNT(a.id) FILTER (WHERE a.status = 'no_show')::text AS no_show,
                COALESCE((
                  SELECT SUM(r.price) FROM treatment_records r
                   WHERE r.practitioner = u.id AND r.status = 'completed'
                     AND (r.performed_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
                ), 0)::text AS production,
                COALESCE(SUM(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 60)
                         FILTER (WHERE a.status IN ('scheduled','confirmed','completed')), 0)::text AS booked_minutes
           FROM directus_users u
           LEFT JOIN appointments a
             ON a.practitioner = u.id
            AND (a.starts_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
          WHERE TRUE
          GROUP BY u.id, u.first_name, u.last_name
         HAVING COUNT(a.id) > 0
                OR EXISTS (SELECT 1 FROM practitioner_hours ph WHERE ph.practitioner = u.id)
          ORDER BY 6 DESC`,
        [from, to, tz],
      )
    ).map((r) => ({
      id: r.id,
      name: r.name,
      appointments: Number(r.appointments),
      completed: Number(r.completed),
      noShow: Number(r.no_show),
      production: Number(r.production),
      bookedMinutes: Number(r.booked_minutes),
    }));
  }

  /** New patients by month — the only figure here that is about growth. */
  async growth(months = 12) {
    return (
      await this.db.rows<{ month: string; joined: string }>(
        `SELECT to_char(date_trunc('month', date_created), 'YYYY-MM') AS month,
                COUNT(*)::text AS joined
           FROM patients
          WHERE date_created >= date_trunc('month', now()) - ($1 || ' months')::interval
          GROUP BY 1 ORDER BY 1`,
        [months],
      )
    ).map((r) => ({ month: r.month, joined: Number(r.joined) }));
  }

  /** Everything at once, which is what the dashboard asks for. */
  async summary(range: Range) {
    const [revenue, production, attendance, utilisation, acceptance, recall, clinicians, growth] =
      await Promise.all([
        this.revenue(range),
        this.production(range),
        this.attendance(range),
        this.utilisation(range),
        this.acceptance(range),
        this.recall(range),
        this.clinicians(range),
        this.growth(),
      ]);
    return {
      range: { from: range.from, to: range.to },
      revenue,
      production,
      attendance,
      utilisation,
      acceptance,
      recall,
      clinicians,
      growth,
    };
  }
}
