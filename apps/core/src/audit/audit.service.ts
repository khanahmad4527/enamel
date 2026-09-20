import { Injectable, Logger } from "@nestjs/common";
import { DbService } from "../db/db.service";

export type ReadEvent = {
  user: string;
  /** The collection read. Absent for an export, which is all of them. */
  collection?: string;
  itemCount: number;
  patient?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * This service's own entries in the audit log.
 *
 * The Directus hook records reads that go through Directus. This one does
 * not: it reads Postgres directly, because a slot search through the items
 * API is dozens of round trips. That is a deliberate performance choice
 * and it punches a hole straight through the audit trail — a day sheet
 * showing twelve patients' names would have left no trace at all.
 *
 * So the hole is closed here rather than documented away. Same table, same
 * append-only trigger, written through the same pool.
 *
 * Only reads that actually return patient-identifiable data are recorded.
 * `/availability/slots` returns free times and nothing else — no names, no
 * reasons, no ids — so logging it would add rows that make the log longer
 * without making it more answerable. The day sheet returns names, and is
 * logged.
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(private readonly db: DbService) {}

  /**
   * A subject access export, which is a read of the whole record.
   *
   * Its own action rather than another `read` row: "somebody exported
   * this patient's entire file" is the event a practice most wants to be
   * able to find, and burying it among the day's ordinary reads is how it
   * becomes unfindable. `export` is already one of the log's actions.
   */
  async recordExport(event: ReadEvent): Promise<void> {
    return this.record("export", event);
  }

  async recordRead(event: ReadEvent): Promise<void> {
    return this.record("read", event);
  }

  private async record(action: "read" | "export", event: ReadEvent): Promise<void> {
    try {
      await this.db.rows(
        `INSERT INTO access_log
           (id, action, "user", collection, item, patient, item_count, ip, user_agent, date_created)
         VALUES (gen_random_uuid(), $7, $1, $2, NULL, $3, $4, $5, $6, now())`,
        [
          event.user,
          event.collection ?? "subject_access",
          event.patient ?? null,
          event.itemCount,
          event.ip ?? null,
          event.userAgent ?? null,
          action,
        ],
      );
    } catch (e) {
      // Never fails the request it is describing. The read has already
      // happened by the time this runs, so throwing would turn a
      // successful answer into an error the caller cannot act on — and
      // would tell them nothing about the patient data they already have.
      // Logged loudly instead, so a broken audit trail is noisy rather
      // than invisible.
      this.log.error(
        `could not record a ${action} of ${event.collection ?? "the record"} by ${event.user}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
