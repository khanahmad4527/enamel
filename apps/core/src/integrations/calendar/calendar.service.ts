import { Injectable, Logger } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { DbService } from "../../db/db.service";
import { buildIcs, type FeedEvent } from "./ics";
import type { AdapterKind } from "../integration";

type Row = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  reason: string | null;
  date_updated: string | null;
  date_created: string;
  room_name: string | null;
  practice_name: string;
  first_name: string | null;
  last_name: string | null;
  reference: string | null;
};

/**
 * A clinician's diary, subscribable from any calendar.
 *
 * The technical part is in `ics.ts`. The part worth arguing about is what
 * goes in the SUMMARY line, and the answer is: **not the patient's name,
 * by default**.
 *
 * A subscribed calendar is not a window onto this system. It is a copy,
 * synchronised to Google or Microsoft, cached on a phone, readable by
 * anything with access to that account and searchable by whoever it is
 * shared with. Putting "Sofie de Vries — root canal 46" in the title
 * exports a patient's clinical history to a third party by default, and
 * it does it every fifteen minutes, quietly, to whichever calendar the
 * clinician happened to add it to.
 *
 * So the default feed says "Patient appointment" and the chair it is in.
 * That is genuinely enough to run a day from a phone: the clinician needs
 * to know *when* they are busy, and the names are in the practice system
 * they are about to walk into.
 *
 * Naming it is available — `?detail=named` — because a single-handed
 * practitioner who is the only person with access to their own calendar
 * has a reasonable case, and refusing it outright would just produce a
 * spreadsheet nobody controls. It has to be asked for, and the choice is
 * recorded in the URL rather than hidden in a setting, so the person who
 * turned it on can see that they did.
 */
@Injectable()
export class CalendarService {
  private readonly log = new Logger(CalendarService.name);
  readonly id = "calendar.ics-feed";
  readonly kind: AdapterKind = "real";
  readonly describe =
    "an iCalendar feed any calendar can subscribe to — no patient names unless explicitly asked for";

  constructor(private readonly db: DbService) {}

  describeAdapter(): { id: string; kind: string; describe: string } {
    return { id: this.id, kind: this.kind, describe: this.describe };
  }

  /**
   * Mint or return a clinician's feed token.
   *
   * A feed URL is a bearer credential — anything holding it reads the
   * diary, forever, with no login. That is inherent to how calendar
   * subscriptions work; no client will do OAuth for an ICS URL. What can
   * be controlled is the blast radius: one token per clinician, revocable
   * on its own, and never the account's API token.
   */
  async tokenFor(user: string, rotate = false): Promise<string> {
    const existing = await this.db.one<{ calendar_token: string | null }>(
      `SELECT calendar_token FROM directus_users WHERE id = $1`,
      [user],
    );
    if (existing?.calendar_token && !rotate) return existing.calendar_token;

    const token = randomBytes(24).toString("base64url");
    await this.db.query(`UPDATE directus_users SET calendar_token = $2 WHERE id = $1`, [user, token]);
    this.log.log(`calendar feed token ${rotate ? "rotated" : "issued"} for ${user}`);
    return token;
  }

  async userForToken(token: string): Promise<{ id: string; name: string } | null> {
    if (!token || token.length < 16) return null;
    return this.db.one<{ id: string; name: string }>(
      `SELECT id,
              trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) AS name
         FROM directus_users WHERE calendar_token = $1`,
      [token],
    );
  }

  /**
   * The feed itself.
   *
   * A window rather than everything: four weeks back and twelve forward.
   * A clinician's whole history is not useful in a phone calendar and a
   * feed that grows without bound eventually stops being fetched at all.
   */
  async feed(
    user: { id: string; name: string },
    detail: "private" | "named",
  ): Promise<string> {
    const rows = await this.db.rows<Row>(
      `SELECT a.id, a.starts_at::text AS starts_at, a.ends_at::text AS ends_at, a.status,
              a.reason, a.date_updated::text AS date_updated, a.date_created::text AS date_created,
              r.name AS room_name, c.name AS practice_name,
              p.first_name, p.last_name, p.reference
         FROM appointments a
         CROSS JOIN practice c
         LEFT JOIN rooms r ON r.id = a.room
         LEFT JOIN patients p ON p.id = a.patient
        WHERE a.practitioner = $1
          AND a.starts_at > now() - interval '4 weeks'
          AND a.starts_at < now() + interval '12 weeks'
        ORDER BY a.starts_at`,
      [user.id],
    );

    const events: FeedEvent[] = rows.map((row) => {
      const named = detail === "named";
      const who = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
      return {
        uid: row.id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        // The line this whole class is about.
        summary: named && who
          ? `${who}${row.reason ? ` — ${row.reason}` : ""}`
          : row.room_name
            ? `Patient appointment (${row.room_name})`
            : "Patient appointment",
        // And the same decision again: a reason like "abscess, lower
        // right" is clinical information, so it is only in the body when
        // the feed was explicitly asked to be identifying.
        description: named
          ? [row.reference ? `Patient ${row.reference}` : null, row.reason]
              .filter(Boolean).join("\n") || null
          : null,
        location: [row.practice_name, row.room_name].filter(Boolean).join(", ") || null,
        cancelled: row.status === "cancelled" || row.status === "no_show",
        // Derived rather than stored: it has to increase when the
        // appointment changes and it does, because `date_updated` does.
        sequence: sequenceFor(row.date_updated ?? row.date_created),
        updatedAt: row.date_updated ?? row.date_created,
      };
    });

    return buildIcs(`${user.name || "Enamel"} — practice diary`, events);
  }
}

/**
 * A monotonic-enough SEQUENCE from a timestamp.
 *
 * Whole minutes since 2020, which fits comfortably in the 32-bit integer
 * some clients assume and cannot go backwards for a row that only ever
 * moves forward. Seconds would overflow that assumption in 2088; minutes
 * will not.
 */
function sequenceFor(iso: string): number {
  const epoch = Date.UTC(2020, 0, 1);
  return Math.max(0, Math.floor((new Date(iso).getTime() - epoch) / 60_000));
}

/** Unused today; kept beside `tokenFor` so a rotation story is obvious. */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
