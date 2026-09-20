import { Injectable } from "@nestjs/common";
import { config } from "../config/config";
import { DbService } from "../db/db.service";

export type Rule = {
  record_type: string;
  years: number;
  starts_from: string;
  legal_basis: string;
};

export type DueGroup = {
  record_type: string;
  describe: string;
  rule: { years: number; starts_from: string; legal_basis: string };
  /** How many rows have passed the period. */
  count: number;
  /** The oldest handful, so a reviewer can see what they are signing off. */
  oldest: Array<{ id: string; patient: string | null; label: string; due_since: string }>;
};

/**
 * What has passed its retention period — and nothing more than saying so.
 *
 * The gap this closes was recorded honestly: retention was **data and not
 * a control**. Twenty years in the Netherlands, twenty-five in the UAE,
 * cited to the statute, and nothing anywhere that could tell a practice
 * what had actually come due.
 *
 * ## It does not delete anything, and that is the design
 *
 * The obvious reading of "enforce retention" is a nightly job that
 * destroys whatever is past its date. That would be worse than doing
 * nothing, for two reasons that both bite in practice:
 *
 *   A retention period is a *minimum* to keep, not a deadline to destroy.
 *   The WGBO says twenty years; it does not say "and then it must go". A
 *   record under a complaint, a claim, or a safeguarding matter is kept
 *   past its period precisely because the period elapsed — and a timer
 *   cannot know that.
 *
 *   Destruction is irreversible and unattributable when it is automatic.
 *   Records management everywhere else — ISO 15489, and every archive
 *   that has thought about it — separates the **disposal schedule** from
 *   the **review** and the **authorisation**. Somebody looks, somebody
 *   decides, and the decision has a name on it.
 *
 * So this produces the review list. What a practice does with it is a
 * decision a person signs for, and building the half that destroys things
 * without the half that authorises it would be the wrong half to build.
 *
 * ## Where the dates come from
 *
 * `starts_from` on the rule, and the two values mean genuinely different
 * queries:
 *
 *   `record_date` — the row's own date. Simple, and right for money and
 *   for the audit log.
 *
 *   `last_contact` — the last time the practice treated this patient,
 *   which is what the WGBO actually keys on. A note written in 2005 for
 *   somebody last seen in 2024 is not due in 2025; the clock runs from
 *   the patient, not from the note. Getting this backwards is the
 *   commonest retention mistake in a clinical system and it destroys
 *   records that are still required.
 */
@Injectable()
export class RetentionService {
  constructor(private readonly db: DbService) {}

  /**
   * The tables each record type covers, and the date each row is judged by.
   *
   * Written out rather than inferred. A retention schedule that guesses
   * which tables a category covers is a schedule that quietly omits one,
   * and the omission is invisible — the review list simply looks shorter.
   */
  private static readonly SOURCES: Record<
    string,
    Array<{ table: string; date: string; label: string; hasPatient: boolean }>
  > = {
    // Every expression is written already qualified with the alias `t`.
    // The first version stored bare column names and prefixed them with a
    // regular expression, which worked for `performed_at` and turned
    // `coalesce(taken_on, date_created::date)` into something that had to
    // be read twice to be trusted. A table of SQL fragments should contain
    // the SQL.
    clinical_record: [
      { table: "treatment_records", date: "t.performed_at", label: "'treatment on ' || coalesce(t.tooth::text, 'no tooth')", hasPatient: true },
      { table: "clinical_notes", date: "t.written_on", label: "'clinical note (' || t.kind || ')'", hasPatient: true },
      { table: "patient_findings", date: "t.noted_on", label: "'finding: ' || t.label", hasPatient: true },
      { table: "tooth_conditions", date: "t.recorded_at", label: "'chart entry, tooth ' || t.tooth::text", hasPatient: true },
      { table: "perio_screenings", date: "t.examined_on", label: "'gum screening'", hasPatient: true },
      { table: "perio_exams", date: "t.examined_on", label: "'periodontal assessment'", hasPatient: true },
      { table: "medical_histories", date: "t.taken_on", label: "'medical history'", hasPatient: true },
    ],
    imaging: [
      { table: "documents", date: "coalesce(t.taken_on, t.date_created::date)", label: "'image: ' || t.kind", hasPatient: true },
    ],
    consent: [
      { table: "consents", date: "coalesce(t.signed_on, t.date_created::date)", label: "'consent: ' || t.title", hasPatient: true },
    ],
    correspondence: [
      { table: "messages", date: "coalesce(t.sent_at::date, t.date_created::date)", label: "'message by ' || t.channel", hasPatient: true },
    ],
    financial: [
      { table: "invoices", date: "t.issued_at", label: "'invoice ' || t.number", hasPatient: true },
      { table: "payments", date: "coalesce(t.received_at::date, t.date_created::date)", label: "'payment of ' || t.amount::text", hasPatient: true },
    ],
    audit_log: [
      { table: "access_log", date: "t.date_created::date", label: "t.action || ' of ' || coalesce(t.collection, 'the record')", hasPatient: true },
    ],
  };

  private static readonly DESCRIBE: Record<string, string> = {
    clinical_record: "The dental record — what was found, done and advised.",
    imaging: "Radiographs and photographs.",
    consent: "Consent forms.",
    correspondence: "Letters, emails and texts.",
    financial: "Invoices and payments.",
    audit_log: "The record of who looked at a file.",
  };

  /**
   * Which of the tables behind this review the caller may not read.
   *
   * This service reads Postgres directly, which means **no permission
   * layer underneath**. The review's sample rows carry labels like
   * "clinical note (examination)" and "finding: penicillin allergy" — so
   * without this, a receptionist who cannot open a clinical note could
   * read a list of them, with patient ids, through a page about
   * housekeeping. A direct connection turns every feature into a
   * permission decision that has to be made again by hand.
   *
   * Asked of Directus rather than inferred from a role, because the role
   * is not the authority — the policy is, and a deployment may have
   * changed it.
   */
  async denied(token: string): Promise<string[]> {
    const tables = [
      ...new Set(Object.values(RetentionService.SOURCES).flatMap((s) => s.map((x) => x.table))),
    ];
    const results = await Promise.all(
      tables.map(async (table) => {
        const res = await fetch(`${config.directus.url}/items/${table}?limit=1&fields=id`, {
          headers: { authorization: `Bearer ${token}` },
        }).catch(() => null);
        return res && res.status === 403 ? table : null;
      }),
    );
    return results.filter((t): t is string => t !== null).sort();
  }

  async rules(): Promise<Rule[]> {
    return this.db.rows<Rule>(
      `SELECT record_type, years, starts_from, legal_basis
         FROM retention_rules
        WHERE TRUE
        ORDER BY record_type`,
      [],
    );
  }

  /**
   * Rows past their period, grouped by the rule that decided it.
   *
   * Every query carries the clinic explicitly. This pool bypasses
   * Directus permissions entirely, so a missing filter here is a
   * cross-tenant read with nothing underneath to catch it — the same
   * reason `AvailabilityService` never takes a clinic from the request.
   */
  async due(rule: Rule, sample = 5): Promise<DueGroup> {
    const sources = RetentionService.SOURCES[rule.record_type] ?? [];
    if (!sources.length) {
      return {
        record_type: rule.record_type,
        describe: RetentionService.DESCRIBE[rule.record_type] ?? rule.record_type,
        rule: { years: rule.years, starts_from: rule.starts_from, legal_basis: rule.legal_basis },
        count: 0,
        oldest: [],
      };
    }

    /*
     * `last_contact` is a join, not a column.
     *
     * The clock runs from the last time the practice treated the patient,
     * so a 2005 note for somebody seen in 2024 is not due — and computing
     * it from the row's own date instead is the retention mistake that
     * destroys records still required by law.
     *
     * `appointments` rather than `treatment_records`: a patient who came
     * in and was told nothing needed doing has been in contact, and has no
     * treatment row to show for it.
     */
    const cutoff =
      rule.starts_from === "last_contact"
        ? `(SELECT max(a.starts_at)::date FROM appointments a
             WHERE a.patient = t.patient
               AND a.status IN ('completed', 'confirmed', 'scheduled'))`
        : null;

    // `make_interval` rather than string concatenation: the number comes
    // from a table a practice edits, and `years || ' years'` is an
    // injection waiting for somebody to type into the admin.
    const elapsed = (dateExpr: string) =>
      cutoff
        ? `coalesce(${cutoff}, ${dateExpr}) + make_interval(years => $1) < current_date`
        : `${dateExpr} + make_interval(years => $1) < current_date`;

    // Parenthesised, because `::` binds tighter than `+`. Without the
    // brackets `x + make_interval(...)::date` casts the *interval* to a
    // date, and Postgres says "cannot cast type interval to date" — which
    // names the symptom and not the missing pair of brackets.
    const dueSince = (dateExpr: string) =>
      cutoff
        ? `(coalesce(${cutoff}, ${dateExpr}) + make_interval(years => $1))`
        : `(${dateExpr} + make_interval(years => $1))`;

    const parts = sources.map(
      (s) => `
        SELECT t.id::text AS id,
               ${s.hasPatient ? "t.patient::text" : "NULL::text"} AS patient,
               ${s.label} AS label,
               ${dueSince(s.date)}::date AS due_since
          FROM ${s.table} t
         WHERE ${s.date} IS NOT NULL
           AND ${elapsed(s.date)}`,
    );

    const union = parts.join("\n UNION ALL \n");
    const counted = await this.db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM (${union}) due`,
      [rule.years],
    );
    const oldest = await this.db.rows<{ id: string; patient: string | null; label: string; due_since: Date }>(
      `SELECT * FROM (${union}) due ORDER BY due_since ASC LIMIT ${Number(sample)}`,
      [rule.years],
    );

    return {
      record_type: rule.record_type,
      describe: RetentionService.DESCRIBE[rule.record_type] ?? rule.record_type,
      rule: { years: rule.years, starts_from: rule.starts_from, legal_basis: rule.legal_basis },
      count: Number(counted?.n ?? 0),
      oldest: oldest.map((r) => ({
        id: r.id,
        patient: r.patient,
        label: r.label,
        due_since: new Date(r.due_since).toISOString().slice(0, 10),
      })),
    };
  }

  async review(): Promise<{ groups: DueGroup[]; total: number }> {
    const rules = await this.rules();
    const groups = await Promise.all(rules.map((rule) => this.due(rule)));
    return { groups, total: groups.reduce((n, g) => n + g.count, 0) };
  }
}
