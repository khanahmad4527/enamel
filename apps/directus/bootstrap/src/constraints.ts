import { Client } from "pg";
import { DB_HOST, DB_PORT, DB_DATABASE, DB_USER, DB_PASSWORD } from "./env.js";
import { log } from "./log.js";

/**
 * Rules the database enforces, because the API cannot.
 *
 * Everything else in this bootstrap goes through Directus: collections,
 * fields, relations, policies, flows. This file does not, because the
 * rules here are not expressible through `/fields`. An appointment that
 * must not overlap another appointment is a constraint across *rows*,
 * and Directus validation only ever sees the row in front of it.
 *
 * That distinction matters more than it sounds. A rule enforced in a
 * flow, a service or an admin form holds for the clients that go through
 * that code. A rule enforced by Postgres holds for every client there
 * will ever be — the core service, a flow, the admin, a static
 * token somebody minted last year and forgot. Double-booking a dentist
 * is the kind of thing a practice notices immediately and forgives
 * never, so it belongs in the one place nothing routes around.
 *
 * Every statement here is idempotent. Postgres has no
 * `ADD CONSTRAINT IF NOT EXISTS`, so each is guarded on `pg_constraint`.
 */

/** Ranges are half-open: an appointment ending at 10:00 does not overlap one starting at 10:00. */
const RANGE = "tstzrange(starts_at, ends_at, '[)')";

/** A slot is only held by an appointment that is still going to happen. */
const HOLDS_A_SLOT = "status IN ('scheduled', 'confirmed')";

type Constraint = {
  name: string;
  table: string;
  /** The `ADD CONSTRAINT` body — everything after the constraint name. */
  definition: string;
  /** Why it exists, in one line, for the provisioning log. */
  because: string;
  /**
   * Finds rows that would make `ADD CONSTRAINT` fail, so the run can say
   * which ones rather than relaying a Postgres error about an index.
   */
  offenders: string;
};

const CONSTRAINTS: Constraint[] = [
  {
    name: "appointments_end_after_start",
    table: "appointments",
    definition: `CHECK (ends_at > starts_at)`,
    because: "an appointment cannot end before it starts",
    offenders: `
      SELECT id::text AS id,
             starts_at::text || ' → ' || ends_at::text AS detail
        FROM appointments
       WHERE ends_at <= starts_at`,
  },
  {
    // The headline rule. Without it nothing stops two patients being
    // booked with the same dentist at the same moment, and the demo
    // data had four such pairs sitting in it — identical start, identical
    // end, two different patients — created by nothing more exotic than
    // seeding twice on different days.
    name: "appointments_no_practitioner_overlap",
    table: "appointments",
    definition: `EXCLUDE USING gist (
      practitioner WITH =,
      ${RANGE} WITH &&
    ) WHERE (${HOLDS_A_SLOT})`,
    because: "one dentist cannot be in two places at once",
    offenders: `
      SELECT a.id::text AS id,
             u.email || ' ' || a.starts_at::text || ' → ' || a.ends_at::text AS detail
        FROM appointments a
        JOIN appointments b
          ON a.id <> b.id
         AND a.practitioner = b.practitioner
         AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
         AND b.status IN ('scheduled', 'confirmed')
        LEFT JOIN directus_users u ON u.id = a.practitioner
       WHERE a.status IN ('scheduled', 'confirmed')`,
  },
  {
    // Same rule, different resource. A practice runs out of chairs long
    // before it runs out of dentists, and a chair booked twice is a
    // patient sitting in the waiting room watching someone else in it.
    name: "appointments_no_room_overlap",
    table: "appointments",
    definition: `EXCLUDE USING gist (
      room WITH =,
      ${RANGE} WITH &&
    ) WHERE (${HOLDS_A_SLOT})`,
    because: "one chair cannot hold two patients at once",
    offenders: `
      SELECT a.id::text AS id,
             r.name || ' ' || a.starts_at::text || ' → ' || a.ends_at::text AS detail
        FROM appointments a
        JOIN appointments b
          ON a.id <> b.id
         AND a.room = b.room
         AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
         AND b.status IN ('scheduled', 'confirmed')
        LEFT JOIN rooms r ON r.id = a.room
       WHERE a.status IN ('scheduled', 'confirmed')`,
  },
  {
    name: "absences_end_after_start",
    table: "absences",
    definition: `CHECK (ends_at > starts_at)`,
    because: "leave cannot end before it begins",
    offenders: `SELECT id::text AS id, starts_at::text || ' → ' || ends_at::text AS detail
                  FROM absences WHERE ends_at <= starts_at`,
  },
  {
    name: "room_closures_end_after_start",
    table: "room_closures",
    definition: `CHECK (ends_at > starts_at)`,
    because: "a chair closure cannot end before it begins",
    offenders: `SELECT id::text AS id, starts_at::text || ' → ' || ends_at::text AS detail
                  FROM room_closures WHERE ends_at <= starts_at`,
  },
  {
    // Two overlapping closures on one chair are not wrong so much as
    // unanswerable: "when does this chair come back" has two answers.
    name: "room_closures_no_overlap",
    table: "room_closures",
    definition: `EXCLUDE USING gist (
      room WITH =,
      tstzrange(starts_at, ends_at, '[)') WITH &&
    )`,
    because: "a chair is closed once, not twice over",
    offenders: `
      SELECT a.id::text AS id, a.starts_at::text || ' → ' || a.ends_at::text AS detail
        FROM room_closures a JOIN room_closures b
          ON a.id <> b.id AND a.room = b.room
         AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')`,
  },
  {
    name: "clinic_hours_close_after_open",
    table: "clinic_hours",
    definition: `CHECK (closed OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND closes_at > opens_at))`,
    because: "an open day needs an opening and a closing time, in that order",
    offenders: `SELECT id::text AS id, weekday || ' ' || coalesce(opens_at::text,'—') || ' → ' || coalesce(closes_at::text,'—') AS detail
                  FROM clinic_hours
                 WHERE NOT closed AND (opens_at IS NULL OR closes_at IS NULL OR closes_at <= opens_at)`,
  },
  {
    // One row per weekday. Two Tuesdays is a rota with two
    // answers, and whichever the query happens to read first wins.
    name: "clinic_hours_one_row_per_weekday",
    table: "clinic_hours",
    definition: `UNIQUE (weekday)`,
    because: "a practice has one Tuesday",
    offenders: `SELECT min(id::text) AS id, weekday || ' ×' || count(*)::text AS detail
                  FROM clinic_hours GROUP BY weekday HAVING count(*) > 1`,
  },
  {
    name: "practitioner_hours_end_after_start",
    table: "practitioner_hours",
    definition: `CHECK (ends_at > starts_at)`,
    because: "a session cannot end before it starts",
    offenders: `SELECT id::text AS id, weekday || ' ' || starts_at::text || ' → ' || ends_at::text AS detail
                  FROM practitioner_hours WHERE ends_at <= starts_at`,
  },
  {
    // Sessions are wall-clock `time`, so the overlap test is on minutes
    // from midnight rather than on a timestamp range. Same idea as the
    // appointment constraint, different unit — and the same reason:
    // a morning session that runs into an afternoon one means two
    // different answers to "is she free at one o'clock".
    name: "practitioner_hours_no_overlap",
    table: "practitioner_hours",
    definition: `EXCLUDE USING gist (
      practitioner WITH =,
      weekday WITH =,
      int4range(
        (EXTRACT(HOUR FROM starts_at) * 60 + EXTRACT(MINUTE FROM starts_at))::int,
        (EXTRACT(HOUR FROM ends_at)   * 60 + EXTRACT(MINUTE FROM ends_at))::int
      ) WITH &&
    )`,
    because: "one clinician cannot work two sessions at the same hour",
    offenders: `
      SELECT a.id::text AS id, a.weekday || ' ' || a.starts_at::text || ' → ' || a.ends_at::text AS detail
        FROM practitioner_hours a JOIN practitioner_hours b
          ON a.id <> b.id AND a.practitioner = b.practitioner AND a.weekday = b.weekday
         AND int4range((EXTRACT(HOUR FROM a.starts_at)*60 + EXTRACT(MINUTE FROM a.starts_at))::int,
                       (EXTRACT(HOUR FROM a.ends_at)*60   + EXTRACT(MINUTE FROM a.ends_at))::int)
          && int4range((EXTRACT(HOUR FROM b.starts_at)*60 + EXTRACT(MINUTE FROM b.starts_at))::int,
                       (EXTRACT(HOUR FROM b.ends_at)*60   + EXTRACT(MINUTE FROM b.ends_at))::int)`,
  },
];

/**
 * An appointment has to be possible, not merely well-formed.
 *
 * The exclusion constraints above stop two bookings colliding with each
 * other. They say nothing about whether either should exist: three in the
 * morning on Christmas Day, with a hygienist who is on maternity leave,
 * in a chair that is in pieces, satisfies every one of them.
 *
 * This cannot be a constraint. Postgres CHECK sees one row and no other
 * table, and the answer lives in four — clinic_hours, practitioner_hours,
 * absences, room_closures. So it is a trigger, which is the same bargain
 * as the constraints: it runs inside the transaction, for every writer,
 * with no way around it.
 *
 * One rule governs the whole thing, and it is worth stating plainly
 * because it is a judgement rather than a fact:
 *
 *   A pattern constrains only once somebody has defined it. A practice
 *   with no opening hours on file is not a practice that is shut — it is
 *   one that has not filled the rota in, and refusing every booking until
 *   somebody does would make this feature impossible to adopt. A clinic
 *   that has entered hours is held to them.
 *
 *   A block always blocks. Leave and chair closures are positive
 *   statements somebody made on purpose. There is no reading of an empty
 *   absences table that should let a booking through a recorded one.
 *
 * The messages carry an ENAMEL_ prefix so the hook can turn them into
 * something a receptionist can act on without parsing plpgsql.
 */
const AVAILABILITY_TRIGGER = `
CREATE OR REPLACE FUNCTION enamel_appointment_is_available() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  tz          text;
  local_start timestamp;
  local_end   timestamp;
  dow         text;
  defined     boolean;
  fits        boolean;
  blocker     text;
BEGIN
  -- A cancelled or completed appointment is history. Holding it to
  -- today's rota would make a retired clinician's past un-editable.
  IF NEW.status NOT IN ('scheduled', 'confirmed') THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(c.timezone, 'UTC') INTO tz FROM practice c LIMIT 1;
  tz := coalesce(tz, 'UTC');

  -- Opening hours are wall-clock, so the comparison has to happen in the
  -- practice's own timezone. Comparing a UTC instant against "09:00" is
  -- an hour out for half the year without it.
  local_start := NEW.starts_at AT TIME ZONE tz;
  local_end   := NEW.ends_at   AT TIME ZONE tz;
  dow := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[EXTRACT(DOW FROM local_start)::int + 1];

  SELECT EXISTS (SELECT 1 FROM clinic_hours h) INTO defined;
  IF defined THEN
    SELECT EXISTS (
      SELECT 1 FROM clinic_hours h
       WHERE
             h.weekday = dow
         AND NOT h.closed
         AND local_start::time >= h.opens_at
         AND local_end::time   <= h.closes_at
    ) INTO fits;
    IF NOT fits THEN
      RAISE EXCEPTION 'ENAMEL_CLOSED' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.practitioner IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM practitioner_hours p
       WHERE p.practitioner = NEW.practitioner
    ) INTO defined;
    IF defined THEN
      SELECT EXISTS (
        SELECT 1 FROM practitioner_hours p
         WHERE p.practitioner = NEW.practitioner
           AND p.weekday      = dow
           AND local_start::time >= p.starts_at
           AND local_end::time   <= p.ends_at
           AND (p.effective_from IS NULL OR local_start::date >= p.effective_from)
           AND (p.effective_to   IS NULL OR local_start::date <= p.effective_to)
      ) INTO fits;
      IF NOT fits THEN
        RAISE EXCEPTION 'ENAMEL_OFF_ROTA' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- A practitioner-less absence is the whole practice: a bank holiday is
  -- nobody's leave and everybody's closure.
  SELECT a.kind INTO blocker
    FROM absences a
   WHERE
         a.status <> 'cancelled'
     AND (a.practitioner IS NULL OR a.practitioner = NEW.practitioner)
     AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
   LIMIT 1;
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'ENAMEL_ABSENT:%', blocker USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.room IS NOT NULL AND EXISTS (
    SELECT 1 FROM room_closures rc
     WHERE rc.room = NEW.room
       AND tstzrange(rc.starts_at, rc.ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'ENAMEL_CHAIR_DOWN' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS enamel_appointment_availability ON appointments;
CREATE TRIGGER enamel_appointment_availability
  BEFORE INSERT OR UPDATE OF starts_at, ends_at, practitioner, room, status
  ON appointments
  FOR EACH ROW EXECUTE FUNCTION enamel_appointment_is_available();
`;

/**
 * The audit log is append-only, and the database is what says so.
 *
 * An access log an administrator can edit is not evidence of anything. It
 * is the one table in this schema where "the most powerful account can fix
 * a mistake" is the wrong property to have — a row saying who opened a
 * patient's file is worth exactly as much as the difficulty of changing
 * it afterwards.
 *
 * So: UPDATE is refused outright, for everyone, with no exception and no
 * way to route round it short of dropping the trigger. Directus
 * permissions would stop the admin UI; this stops a psql session too.
 *
 * DELETE is the interesting half. Blocking it entirely sounds stronger and
 * is unworkable — a log nobody can prune grows until it is somebody's
 * outage, and an audit trail that takes the practice offline gets deleted
 * by someone in a hurry with the trigger disabled. So deletion is allowed,
 * but only beyond the retention window. Pruning last year's rows works;
 * quietly removing this morning's does not.
 *
 * ENAMEL_LOG_RETENTION_DAYS is deliberately a constant in the function
 * body rather than a setting. A retention period that can be changed at
 * run time by whoever wants to delete something is not a retention period.
 */
const AUDIT_APPEND_ONLY = `
CREATE OR REPLACE FUNCTION enamel_access_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  retention_days constant integer := 400;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Everything the row says about the access is immutable. The three
    -- foreign keys are the exception, and only in one direction: a
    -- non-null pointer may become NULL, because that is what Postgres
    -- itself does when the patient or user a row refers to is
    -- deleted.
    --
    -- Without this the audit table quietly became the thing that decides
    -- whether a clinical record can ever be erased. Every one of those
    -- relations is declared ON DELETE SET NULL, a SET NULL cascade *is*
    -- an UPDATE, and refusing all updates meant any patient who had ever
    -- been read could not be deleted — a 500 reading ENAMEL_LOG_IMMUTABLE
    -- on a request that never mentioned the log. Right-to-erasure is not
    -- a feature to lose to a trigger written for a different reason.
    --
    -- Losing the pointer is the correct outcome and does not weaken the
    -- record: the row still says what was read, when, by which address,
    -- and how many items came back. Append-only means the row survives
    -- what it refers to, not that it pins it in place.
    --
    -- Compared as a whole row with the three keys removed, rather than
    -- column by column: a column added to this table later is immutable
    -- by default, which is the safe direction to be wrong in.
    IF (to_jsonb(NEW) - 'user' - 'patient')
         IS DISTINCT FROM (to_jsonb(OLD) - 'user' - 'patient')
       OR (NEW."user" IS DISTINCT FROM OLD."user" AND NEW."user" IS NOT NULL)
       OR (NEW.patient IS DISTINCT FROM OLD.patient AND NEW.patient IS NOT NULL)
    THEN
      RAISE EXCEPTION 'ENAMEL_LOG_IMMUTABLE'
        USING ERRCODE = 'check_violation',
              HINT = 'An access-log row cannot be changed once written.';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.date_created IS NULL
       OR OLD.date_created > now() - (retention_days || ' days')::interval THEN
      RAISE EXCEPTION 'ENAMEL_LOG_RETAINED'
        USING ERRCODE = 'check_violation',
              HINT = 'Access-log rows can only be pruned once past the retention window.';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS enamel_access_log_guard ON access_log;
CREATE TRIGGER enamel_access_log_guard
  BEFORE UPDATE OR DELETE ON access_log
  FOR EACH ROW EXECUTE FUNCTION enamel_access_log_append_only();
`;

/**
 * A document version chain that cannot lie.
 *
 * A retake is a new row pointing back at the one it replaces, and there
 * are four ways for that to go wrong. Every one of them is a clinical
 * records problem rather than a tidiness problem, which is why none of
 * them is left to the interface:
 *
 *   - A document superseding itself. Reads as a cycle to anything walking
 *     the chain, and renders as a version list that never terminates.
 *
 *   - A document superseding one that belongs to a different patient.
 *     That is the bad one: it moves an image from one person's file into
 *     another's history, and the m2o picker in the admin is not a control
 *     — anything with the API can send any uuid.
 *
 *   - Two documents superseding the same one. The chain stops being a
 *     chain, and "which is current" stops having an answer.
 *
 *   - A supersede with no reason given. "A newer one exists" records
 *     nothing; a retake for positioning and a retake because the first
 *     was of the wrong tooth are different facts, and only one of them is
 *     a complaint waiting to happen.
 *
 * The back-pointer is maintained here too rather than by the caller. A
 * column two clients both have to remember to set is a column that is
 * wrong by the second week.
 */
const DOCUMENT_VERSIONS = `
CREATE OR REPLACE FUNCTION enamel_document_supersedes() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  prior record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Clear the forward pointer so the row can go. Superseding documents
    -- are held by the foreign key itself (NO ACTION), so this only ever
    -- runs for a document nothing points at.
    UPDATE documents SET superseded_by = NULL WHERE superseded_by = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.supersedes IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.supersedes IS NOT NULL THEN
      UPDATE documents SET superseded_by = NULL WHERE id = OLD.supersedes;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.supersedes = NEW.id THEN
    RAISE EXCEPTION 'ENAMEL_DOC_SELF'
      USING ERRCODE = 'check_violation',
            HINT = 'A document cannot replace itself.';
  END IF;

  SELECT id, patient, superseded_by INTO prior
    FROM documents WHERE id = NEW.supersedes;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ENAMEL_DOC_MISSING'
      USING ERRCODE = 'check_violation',
            HINT = 'The document being replaced does not exist.';
  END IF;

  IF prior.patient IS DISTINCT FROM NEW.patient THEN
    RAISE EXCEPTION 'ENAMEL_DOC_OTHER_PATIENT'
      USING ERRCODE = 'check_violation',
            HINT = 'A document can only replace one on the same patient''s file.';
  END IF;

  IF prior.superseded_by IS NOT NULL AND prior.superseded_by <> NEW.id THEN
    RAISE EXCEPTION 'ENAMEL_DOC_ALREADY_REPLACED'
      USING ERRCODE = 'check_violation',
            HINT = 'That document has already been replaced by a newer one.';
  END IF;

  IF NEW.supersede_reason IS NULL OR btrim(NEW.supersede_reason) = '' THEN
    RAISE EXCEPTION 'ENAMEL_DOC_NO_REASON'
      USING ERRCODE = 'check_violation',
            HINT = 'Say why the earlier document was replaced.';
  END IF;

  -- Release the one this row used to replace, then claim the new one.
  IF TG_OP = 'UPDATE' AND OLD.supersedes IS NOT NULL AND OLD.supersedes <> NEW.supersedes THEN
    UPDATE documents SET superseded_by = NULL WHERE id = OLD.supersedes;
  END IF;
  UPDATE documents SET superseded_by = NEW.id WHERE id = NEW.supersedes;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS enamel_document_versions ON documents;
CREATE TRIGGER enamel_document_versions
  AFTER INSERT OR UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION enamel_document_supersedes();
`;

/**
 * An invoice header always equals its lines.
 *
 * This was two Directus flows, and they were wrong in a way that only
 * showed up under load. A flow keys its update on
 * `{{$trigger.payload.invoice}}`, which is a single value when one line is
 * created and an *array* when fifty are — so a batch insert wrote each
 * invoice's total onto some other invoice. Not "failed to update": updated
 * the wrong row, silently, leaving every header plausible and most of them
 * wrong. The suite's "no total is its subtotal plus tax" check is what
 * found it.
 *
 * It cannot be fixed in a flow. Doing it correctly needs a loop over the
 * batch, Directus flows have no loop without the `exec` operation, and
 * `exec` does not run in the `directus/directus:11` image at all — it
 * reports no error and quietly does nothing.
 *
 * So it moves to where the problem is tractable. A row-level trigger fires
 * once per row whether the caller inserted one or five hundred, which
 * makes the batch case identical to the single case rather than a special
 * one somebody has to remember.
 *
 * It also closes a gap the flows could never cover. On delete, Directus
 * hands a flow the deleted keys but not the row, so there was no way to
 * learn which invoice a removed line belonged to and the subtotal simply
 * went stale — which is why `invoice_lines` was hidden from the sidebar
 * and the documented workflow was to void and reissue. `OLD` knows.
 */
const INVOICE_TOTALS = `
CREATE OR REPLACE FUNCTION enamel_invoice_totals() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  target uuid;
BEGIN
  target := COALESCE(NEW.invoice, OLD.invoice);
  IF target IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE invoices i
     SET subtotal = totals.sum,
         total    = round(totals.sum * (1 + COALESCE(i.tax_rate, 0) / 100.0), 2)
    FROM (
      SELECT COALESCE(SUM(amount), 0) AS sum
        FROM invoice_lines WHERE invoice = target
    ) AS totals
   WHERE i.id = target;

  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS enamel_invoice_totals_sync ON invoice_lines;
CREATE TRIGGER enamel_invoice_totals_sync
  AFTER INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION enamel_invoice_totals();
`;

/**
 * The Article 33 clock, and the decision it is attached to.
 *
 * Two rules, both in the database because both have a legal consequence
 * and neither can be left to whoever is filling in the form.
 *
 * **The deadline is computed.** Seventy-two hours from `discovered_at` —
 * from *awareness*, not from when the breach happened, which is the thing
 * people get wrong. It is also 72 hours and not three working days: a
 * Friday afternoon discovery is due on Monday afternoon. A deadline
 * somebody types is a deadline somebody types wrong.
 *
 * **A decision not to report has to say why.** Article 33(5) requires
 * every breach to be documented including the ones that were not
 * notified, and an unexplained `unlikely` is the most dangerous row a
 * register can hold: it looks exactly like a decision and is
 * indistinguishable from an oversight. The same applies to a *late*
 * notification — Article 33(1) says it "shall be accompanied by reasons
 * for the delay", so a row notified after its deadline with no reason is
 * refused too.
 *
 * Refused with a sentence rather than a constraint violation, for the
 * same reason the scheduling rules are: the person reading it is a
 * practice manager, not a DBA.
 */
const BREACH_CLOCK = `
CREATE OR REPLACE FUNCTION enamel_breach_clock() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- Awareness starts it. Always recomputed, so correcting the discovery
  -- time moves the deadline with it.
  NEW.notify_by := NEW.discovered_at + interval '72 hours';

  IF NEW.risk = 'unlikely'
     AND (NEW.why_not_notified IS NULL OR btrim(NEW.why_not_notified) = '') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'A breach recorded as unlikely to result in a risk has to say why — '
                'Article 33(5) requires every breach to be documented, including the '
                'ones you decide not to report.';
  END IF;

  IF NEW.authority_notified_at IS NOT NULL
     AND NEW.authority_notified_at > NEW.notify_by
     AND (NEW.reason_for_delay IS NULL OR btrim(NEW.reason_for_delay) = '') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'This was notified after the 72 hours were up. Article 33(1) requires '
                'the notification to be accompanied by reasons for the delay — put them '
                'in reason_for_delay.';
  END IF;

  -- High risk means the patients as well, not only the authority. The two
  -- duties have different thresholds and collapsing them is how a
  -- practice tells a regulator and not the people it happened to.
  IF NEW.status = 'closed' AND NEW.risk = 'high_risk'
     AND NEW.subjects_notified_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'A high-risk breach cannot be closed until the people it happened to '
                'have been told — Article 34. Record when and how, or lower the risk '
                'assessment and say why.';
  END IF;

  IF NEW.status = 'closed' AND NEW.closed_at IS NULL THEN
    NEW.closed_at := now();
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS enamel_breach_clock ON data_breaches;
CREATE TRIGGER enamel_breach_clock
  BEFORE INSERT OR UPDATE ON data_breaches
  FOR EACH ROW EXECUTE FUNCTION enamel_breach_clock();
`;

/**
 * A disposal cannot be carried out before it was authorised.
 *
 * Four rules, and the last is the one the collection exists for. ISO
 * 15489 separates the schedule, the review and the authorisation; a
 * system that lets the destruction be recorded without the signature —
 * or before it — has collapsed them again with extra steps.
 *
 * In the database rather than only in a form, because the row is
 * evidence. The document an authority or a patient's solicitor asks for
 * is "who authorised this, and when relative to the shredder", and a
 * guarantee that lives in a Vue component is not one.
 */
const DISPOSAL_AUTHORITY = `
CREATE OR REPLACE FUNCTION enamel_disposal_authority() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status IN ('authorised', 'carried_out') THEN
    IF NEW.authorised_by IS NULL OR NEW.authorised_on IS NULL
       OR NEW.grounds IS NULL OR btrim(NEW.grounds) = '' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'An authorised disposal needs a name, a date and the grounds. '
                  'A disposal authorised by nobody is the thing this register exists '
                  'to make impossible.';
    END IF;
  END IF;

  IF NEW.status = 'carried_out' THEN
    IF NEW.method IS NULL OR NEW.carried_out_on IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Say what actually happened to the records and when — deleted, '
                  'anonymised, transferred or shredded.';
    END IF;

    -- The one the collection exists for.
    IF NEW.carried_out_on < NEW.authorised_on THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'This says the records were destroyed before anybody authorised it. '
                  'The signature comes first — that is the whole point of recording '
                  'the two separately.';
    END IF;
  END IF;

  IF NEW.status = 'withheld'
     AND (NEW.withheld_reason IS NULL OR btrim(NEW.withheld_reason) = '') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Say why a record past its period is being kept anyway — a complaint, '
                'a claim, a safeguarding matter. Without a reason, holding it back is '
                'indistinguishable from not having looked.';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS enamel_disposal_authority ON disposals;
CREATE TRIGGER enamel_disposal_authority
  BEFORE INSERT OR UPDATE ON disposals
  FOR EACH ROW EXECUTE FUNCTION enamel_disposal_authority();
`;

/**
 * A consent log that cannot be rewritten, and cannot claim what it has
 * no evidence for.
 *
 * Three rules, and the first is the one that makes the register worth
 * having at all. Article 7(1) asks a controller to *demonstrate* that
 * consent was given. A log anybody can edit demonstrates only what
 * somebody last decided it should say — so nothing here may be updated
 * or deleted, ever, by anybody, including a database superuser going
 * around Directus. A withdrawal is a new row; that is Article 7(3),
 * which says withdrawal does not affect the lawfulness of processing
 * done beforehand, and an overwritten row has destroyed the evidence
 * that the earlier processing was lawful.
 *
 * The second: consent to a purpose whose lawful basis is not consent is
 * a contradiction. A practice that asks a patient to agree to its
 * clinical record has told them they may withdraw — and cannot honour
 * it, because the WGBO requires the record kept for twenty years.
 * Recording that as consent is worse than not asking.
 *
 * The third: a `given` decision with no wording is not evidence. "They
 * ticked a box" demonstrates nothing without the sentence beside it.
 */
const CONSENT_EVIDENCE = `
CREATE OR REPLACE FUNCTION enamel_consent_evidence() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  basis text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'A consent record is evidence and cannot be edited or removed. '
                'If the patient changed their mind, add a row saying withdrawn — '
                'that is what Article 7(3) describes, and the earlier row is what '
                'shows the processing before it was lawful.';
  END IF;

  SELECT lawful_basis INTO basis FROM processing_purposes WHERE id = NEW.purpose;
  IF basis IS NOT NULL AND basis <> 'consent' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'This purpose does not run on consent, so there is no consent to '
                'record against it. Asking a patient to agree to something they '
                'cannot refuse tells them they may withdraw when they may not.';
  END IF;

  IF NEW.decision = 'given'
     AND (NEW.wording_shown IS NULL OR btrim(NEW.wording_shown) = '') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Record the sentence the patient actually agreed to. Article 7(1) '
                'asks you to demonstrate consent was given, and a tick with no '
                'words beside it demonstrates nothing.';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS enamel_consent_evidence ON consent_records;
CREATE TRIGGER enamel_consent_evidence
  BEFORE INSERT OR UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION enamel_consent_evidence();
`;

/**
 * Columns Directus will not make nullable once it has created them.
 *
 * `PATCH /fields` happily updates a field's interface, note and width, and
 * silently leaves `NOT NULL` exactly as it was — so a column created
 * required stays required no matter what the schema file says afterwards.
 * The symptom is not an error at provisioning time: it is an HTTP 500 from
 * a not-null violation, weeks later, on the one code path that legitimately
 * has nothing to put there.
 *
 * Empty since `messages.clinic` was the only entry and multi-tenancy is
 * gone. Kept rather than deleted because the trap it works around is a
 * property of Directus, not of that column, and the next required field
 * that has to become optional will need exactly this.
 */
const NULLABILITY: Array<{ table: string; column: string; why: string }> = [];

async function connect(): Promise<Client> {
  const client = new Client({
    host: DB_HOST, port: DB_PORT, database: DB_DATABASE,
    user: DB_USER, password: DB_PASSWORD,
  });
  await client.connect();
  return client;
}

async function exists(client: Client, name: string): Promise<boolean> {
  const r = await client.query("SELECT 1 FROM pg_constraint WHERE conname = $1", [name]);
  return r.rowCount !== null && r.rowCount > 0;
}

/**
 * Applies the constraints, and refuses rather than guesses.
 *
 * An `ADD CONSTRAINT` over rows that already break it fails, which is the
 * correct behaviour and a terrible error message: Postgres names an index,
 * not the two appointments. So each constraint is pre-flighted, and rows
 * that would block it are printed. Nothing is deleted to make the DDL
 * pass — quietly discarding somebody's booking to satisfy a migration is
 * how you lose the argument about whether the system can be trusted.
 */
export async function applyConstraints(): Promise<void> {
  let client: Client;
  try {
    client = await connect();
  } catch (e) {
    log.fail(
      `cannot reach Postgres at ${DB_HOST}:${DB_PORT} — ${e instanceof Error ? e.message : e}`,
    );
    log.info("the database rules need a direct connection; `docker compose up -d` publishes one on loopback");
    return;
  }

  try {
    // gist indexes compare ranges natively but not scalars; btree_gist
    // teaches them `=` on a uuid, which is what makes "same dentist AND
    // overlapping time" expressible as one constraint.
    await client.query("CREATE EXTENSION IF NOT EXISTS btree_gist");

    for (const c of CONSTRAINTS) {
      if (await exists(client, c.name)) {
        log.skip(c.name);
        continue;
      }

      // A diagnostic that itself throws must not cost the run the other
      // constraints — it is there to explain a failure, not to cause one.
      let blocking: { rowCount: number | null; rows: Array<{ id: string; detail: string }> };
      try {
        blocking = await client.query<{ id: string; detail: string }>(c.offenders);
      } catch (e) {
        log.fail(`${c.name}: could not check for blocking rows — ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (blocking.rowCount) {
        log.fail(`${c.name}: ${blocking.rowCount} existing row(s) already break this rule`);
        for (const row of blocking.rows.slice(0, 8)) log.info(`    ${row.detail}`);
        if (blocking.rowCount > 8) log.info(`    …and ${blocking.rowCount - 8} more`);
        log.info("    nothing was deleted; resolve these and re-run");
        continue;
      }

      try {
        await client.query(`ALTER TABLE ${c.table} ADD CONSTRAINT ${c.name} ${c.definition}`);
        log.made(`${c.name} — ${c.because}`);
      } catch (e) {
        log.fail(`${c.name}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // CREATE OR REPLACE, so this one is re-applied every run rather than
    // guarded. The definition is the source of truth and an instance
    // provisioned last month should pick up a corrected rule.
    try {
      await client.query(AVAILABILITY_TRIGGER);
      log.made("enamel_appointment_availability — an appointment has to be possible, not just well-formed");
    } catch (e) {
      log.fail(`enamel_appointment_availability: ${e instanceof Error ? e.message : e}`);
    }

    try {
      await client.query(AUDIT_APPEND_ONLY);
      log.made("enamel_access_log_guard — the audit log cannot be rewritten, by anyone");
    } catch (e) {
      log.fail(`enamel_access_log_guard: ${e instanceof Error ? e.message : e}`);
    }

    for (const fix of NULLABILITY) {
      const current = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`,
        [fix.table, fix.column],
      );
      if (current.rows[0]?.is_nullable === "NO") {
        try {
          await client.query(`ALTER TABLE ${fix.table} ALTER COLUMN ${fix.column} DROP NOT NULL`);
          log.made(`${fix.table}.${fix.column} is nullable — ${fix.why}`);
        } catch (e) {
          log.fail(`${fix.table}.${fix.column}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    try {
      await client.query(BREACH_CLOCK);
      log.made("enamel_breach_clock — 72 hours from awareness, and a decision not to report has to say why");
    } catch (e) {
      log.fail(`enamel_breach_clock: ${e instanceof Error ? e.message : e}`);
    }

    try {
      await client.query(DISPOSAL_AUTHORITY);
      log.made("enamel_disposal_authority — the signature comes before the shredder");
    } catch (e) {
      log.fail(`enamel_disposal_authority: ${e instanceof Error ? e.message : e}`);
    }

    try {
      await client.query(CONSENT_EVIDENCE);
      log.made("enamel_consent_evidence — a consent log that cannot be rewritten");
    } catch (e) {
      log.fail(`enamel_consent_evidence: ${e instanceof Error ? e.message : e}`);
    }

    try {
      await client.query(INVOICE_TOTALS);
      log.made("enamel_invoice_totals_sync — a header always equals its lines, batch or not");
    } catch (e) {
      log.fail(`enamel_invoice_totals_sync: ${e instanceof Error ? e.message : e}`);
    }

    try {
      await client.query(DOCUMENT_VERSIONS);
      log.made("enamel_document_versions — a retake replaces one document, on one patient, for a reason");
    } catch (e) {
      log.fail(`enamel_document_versions: ${e instanceof Error ? e.message : e}`);
    }
  } finally {
    await client.end();
  }
}
