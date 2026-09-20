import { defineHook } from "@directus/extensions-sdk";
import { InvalidPayloadError } from "@directus/errors";

/**
 * The governance hook: what Directus does not record, and what it cannot
 * refuse.
 *
 * Two jobs. The first and larger one is the access log — see below. The
 * second is at the bottom of this file: the rules behind the breach and
 * disposal registers, raised as sentences a practice manager can act on.
 *
 * Those rules are also Postgres triggers, and the duplication is the same
 * arrangement the scheduling rules use. The trigger is the one that
 * cannot be routed around — a flow, a direct connection or a future
 * endpoint all meet it. The hook is the one that produces a readable
 * refusal, because a plpgsql exception surfaces through Directus as HTTP
 * 500 "An unexpected error occurred", which tells somebody filling in a
 * breach form precisely nothing.
 *
 * ---
 *
 * The two things Directus does not record.
 *
 * `directus_activity` is good and is left alone: creates, updates,
 * deletes, successful logins and flow runs, each with an IP, a user agent
 * and an origin. Permission changes are in there too — editing a policy is
 * a write to `directus_permissions` like any other write. None of that is
 * duplicated here.
 *
 * What is missing is reads and failed sign-ins, and in a clinical system
 * those are the two an information-governance review actually asks about:
 * *who opened this patient's record*, and *who has been trying passwords*.
 * Directus records zero reads by design — for most applications the volume
 * would be absurd and nobody would ever look at them. A dental practice is
 * not most applications.
 *
 * Three things this deliberately does NOT do:
 *
 *   It does not log every read. Only collections that carry patient-
 *   identifiable data. Logging every look at the treatment price list
 *   would bury the row that matters under a hundred that do not.
 *
 *   It does not log internal reads. Directus services called with
 *   `accountability: null` are this codebase talking to itself — the
 *   scheduling hook checking for a clash, the day sheet resolving a room.
 *   Recording those as "unknown user read patients" is noise that makes
 *   the log less trustworthy, not more.
 *
 *   It does not block the request when the log write fails. `items.read`
 *   is an action hook and fires after the read has already happened, so
 *   there is nothing left to refuse. A stricter system would use a filter
 *   hook and fail closed — refuse the read if it cannot be recorded. That
 *   is the right design for a system under a regulator, and it is a
 *   deliberate trade rather than an oversight: the failure is logged at
 *   error level so it cannot pass silently.
 */

/**
 * Collections whose rows are about a person.
 *
 * The test is "would a patient object to someone reading this without a
 * reason", not "is this clinical". An appointment is not a clinical
 * record and is still nobody else's business.
 */
const PATIENT_DATA = new Set([
  "patients",
  "appointments",
  "treatment_records",
  "tooth_conditions",
  "dentition",
  "clinical_notes",
  "medical_histories",
  "patient_findings",
  "consents",
  "documents",
  "perio_screenings",
  "perio_sextants",
  "perio_exams",
  "perio_teeth",
  "perio_sites",
  "treatment_plans",
  "treatment_plan_items",
  "recalls",
  "payment_plans",
  "payment_plan_charges",
  "invoices",
  "invoice_lines",
  "waiting_list",
  "lab_cases",
  "absences",
]);

type Row = Record<string, unknown>;

export default defineHook(({ action, filter }, { services, getSchema, logger }) => {
  const { ItemsService } = services as {
    ItemsService: new (collection: string, opts: Record<string, unknown>) => {
      createOne(data: Record<string, unknown>): Promise<unknown>;
      readOne(key: string, query?: Record<string, unknown>): Promise<unknown>;
    };
  };

  async function record(entry: Record<string, unknown>, schema: unknown): Promise<void> {
    try {
      // accountability: null on purpose. Nobody has create permission on
      // access_log — not the owner, not the admin — because a row anybody
      // can write is a row anybody can forge. The hook is the only author.
      await new ItemsService("access_log", { schema, accountability: null }).createOne(entry);
    } catch (e) {
      logger.error(
        `audit: could not record ${String(entry["action"])} on ${String(entry["collection"] ?? "-")} — ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Whose record this was, where that can be worked out.
   *
   * Reading `patients` gives the id directly. Every other collection here
   * carries a `patient` column, but only if the caller asked for it — so
   * this is best-effort by construction, and a null means "could not
   * tell" rather than "no patient involved". The count and the collection
   * are still there either way.
   */
  function patientOf(collection: string, rows: Row[]): string | null {
    if (collection === "patients") {
      return rows.length === 1 ? (rows[0]?.["id"] as string) ?? null : null;
    }
    const ids = new Set(
      rows
        .map((r) => {
          const p = r["patient"];
          return typeof p === "string" ? p : (p as Row | null)?.["id"];
        })
        .filter((v): v is string => typeof v === "string"),
    );
    return ids.size === 1 ? [...ids][0]! : null;
  }


  action("items.read", async (meta: any, context: any) => {
    const collection = String(meta?.collection ?? "");

    // Reading the log must not write to the log. Without this, opening the
    // access log in the admin appends a row for having opened it, which
    // appears in the list you are looking at, and the next refresh appends
    // another.
    if (collection === "access_log") return;
    if (!PATIENT_DATA.has(collection)) return;

    const accountability = context?.accountability;
    // Internal service call — this codebase talking to itself.
    if (!accountability || !accountability.user) return;

    const rows: Row[] = Array.isArray(meta?.payload) ? meta.payload : [];

    await record(
      {
        action: "read",
        user: accountability.user,
        collection,
        // One row back is treated as "they looked at this record". A list
        // that happens to return one is the same event from the patient's
        // point of view, which is the point of view that matters here.
        item: rows.length === 1 ? ((rows[0]?.["id"] as string) ?? null) : null,
        patient: patientOf(collection, rows),
        item_count: rows.length,
        ip: accountability.ip ?? null,
        user_agent: accountability.userAgent ?? null,
      },
      context?.schema ?? (await getSchema()),
    );
  });

  /* ------------------------------------------------------------------ *
   * The breach register — GDPR Articles 33 and 34
   * ------------------------------------------------------------------ */

  /**
   * The same three rules the database enforces, said in words.
   *
   * Written against the *merged* row rather than the payload, because an
   * update sends only what changed: a row switched to `closed` says
   * nothing about its risk assessment, and judging the payload alone
   * would let a high-risk breach be closed with nobody told.
   */
  function breachRules(row: Record<string, unknown>): void {
    const blank = (v: unknown) => typeof v !== "string" || v.trim() === "";

    // Article 33(5): every breach is documented, including the ones you
    // decide not to report — and an unexplained "unlikely" looks exactly
    // like an oversight.
    if (row["risk"] === "unlikely" && blank(row["why_not_notified"])) {
      throw new InvalidPayloadError({
        reason:
          "A breach recorded as unlikely to result in a risk has to say why. Article 33(5) " +
          "requires every breach to be documented, including the ones you decide not to report.",
      });
    }

    // Article 33(1): a notification after the 72 hours is allowed, and has
    // to be accompanied by the reasons for the delay.
    const notified = row["authority_notified_at"];
    const due = row["notify_by"];
    if (
      typeof notified === "string" && typeof due === "string" &&
      new Date(notified) > new Date(due) && blank(row["reason_for_delay"])
    ) {
      throw new InvalidPayloadError({
        reason:
          "This was notified after the 72 hours were up. Article 33(1) requires the " +
          "notification to be accompanied by reasons for the delay.",
      });
    }

    // Article 34: high risk means the people it happened to, not only the
    // authority. Two duties, two thresholds — collapsing them is how a
    // practice tells a regulator and not the patients.
    if (row["status"] === "closed" && row["risk"] === "high_risk" && !row["subjects_notified_at"]) {
      throw new InvalidPayloadError({
        reason:
          "A high-risk breach cannot be closed until the people it happened to have been " +
          "told — Article 34. Record when and how, or lower the risk assessment and say why.",
      });
    }
  }

  /** 72 hours from awareness, so the hook judges the same deadline the trigger will set. */
  const dueFrom = (discovered: unknown): string | undefined =>
    typeof discovered === "string"
      ? new Date(new Date(discovered).getTime() + 72 * 3600 * 1000).toISOString()
      : undefined;

  /* ------------------------------------------------------------------ *
   * The disposal register — the signature comes before the shredder
   * ------------------------------------------------------------------ */

  function disposalRules(row: Record<string, unknown>): void {
    const blank = (v: unknown) => typeof v !== "string" || v.trim() === "";
    const status = row["status"];

    if (status === "authorised" || status === "carried_out") {
      if (!row["authorised_by"] || !row["authorised_on"] || blank(row["grounds"])) {
        throw new InvalidPayloadError({
          reason:
            "An authorised disposal needs a name, a date and the grounds. A disposal " +
            "authorised by nobody is the thing this register exists to make impossible.",
        });
      }
    }

    if (status === "carried_out") {
      if (!row["method"] || !row["carried_out_on"]) {
        throw new InvalidPayloadError({
          reason:
            "Say what actually happened to the records and when — deleted, anonymised, " +
            "transferred or shredded.",
        });
      }
      const done = new Date(String(row["carried_out_on"]));
      const signed = new Date(String(row["authorised_on"]));
      if (done < signed) {
        throw new InvalidPayloadError({
          reason:
            "This says the records were destroyed before anybody authorised it. The " +
            "signature comes first — that is the whole point of recording the two " +
            "separately.",
        });
      }
    }

    if (status === "withheld" && blank(row["withheld_reason"])) {
      throw new InvalidPayloadError({
        reason:
          "Say why a record past its period is being kept anyway — a complaint, a claim, " +
          "a safeguarding matter. Without a reason, holding it back is indistinguishable " +
          "from not having looked.",
      });
    }
  }

  /**
   * A consent record says what it can prove, or it is refused.
   *
   * The Postgres trigger is the guarantee — it holds against anybody
   * writing straight to the database. This is the sentence, because a
   * `check_violation` surfacing in the admin as a red toast full of
   * plpgsql is a refusal nobody can act on.
   */
  async function consentRules(row: Record<string, unknown>, ctx: any): Promise<void> {
    const blank = (v: unknown) => typeof v !== "string" || v.trim() === "";

    const purposeId = row["purpose"];
    if (purposeId) {
      const schema = ctx?.schema ?? (await getSchema());
      const purposes = new ItemsService("processing_purposes", { schema, accountability: null });
      const purpose = (await purposes.readOne(String(purposeId)).catch(() => null)) as
        Record<string, unknown> | null;
      const basis = purpose?.["lawful_basis"];
      if (basis && basis !== "consent") {
        throw new InvalidPayloadError({
          reason:
            `"${String(purpose?.["name"] ?? "This purpose")}" does not run on consent — its ` +
            `basis is ${String(basis).replace(/_/g, " ")}. There is no consent to record ` +
            "against it, and asking a patient to agree to something they cannot refuse " +
            "tells them they may withdraw when they may not.",
        });
      }
    }

    if (row["decision"] === "given" && blank(row["wording_shown"])) {
      throw new InvalidPayloadError({
        reason:
          "Record the sentence the patient actually agreed to. Article 7(1) asks you to " +
          "demonstrate consent was given, and a tick with no words beside it demonstrates " +
          "nothing.",
      });
    }
  }

  filter("consent_records.items.create", async (input: any, _meta: any, ctx: any) => {
    await consentRules(input ?? {}, ctx);
    return input;
  });

  // No merge with a stored row, because there is nothing to merge into:
  // the policy grants no update and the trigger refuses one outright.
  // This exists so the refusal is a sentence rather than a 403 from one
  // layer and a check_violation from the other.
  filter("consent_records.items.update", () => {
    throw new InvalidPayloadError({
      reason:
        "A consent record is evidence and cannot be edited. If the patient changed their " +
        "mind, add a row saying withdrawn — the earlier row is what shows the processing " +
        "before it was lawful.",
    });
  });

  filter("consent_records.items.delete", () => {
    throw new InvalidPayloadError({
      reason:
        "A consent record cannot be removed. The row most worth deleting is the one a " +
        "regulator most wants to read.",
    });
  });

  filter("disposals.items.create", (input: any) => {
    disposalRules(input ?? {});
    return input;
  });

  filter("disposals.items.update", async (input: any, meta: any, ctx: any) => {
    const keys: string[] = meta?.keys ?? [];
    if (!keys.length) return input;
    const schema = ctx?.schema ?? (await getSchema());
    const items = new ItemsService("disposals", { schema, accountability: null });
    for (const key of keys) {
      const stored = (await items.readOne(key)) as Record<string, unknown>;
      disposalRules({ ...stored, ...input });
    }
    return input;
  });

  filter("data_breaches.items.create", (input: any) => {
    breachRules({ ...input, notify_by: dueFrom(input?.discovered_at) });
    return input;
  });

  filter("data_breaches.items.update", async (input: any, meta: any, ctx: any) => {
    const keys: string[] = meta?.keys ?? [];
    if (!keys.length) return input;
    const schema = ctx?.schema ?? (await getSchema());
    const breaches = new ItemsService("data_breaches", { schema, accountability: null });
    for (const key of keys) {
      const stored = (await breaches.readOne(key)) as Record<string, unknown>;
      const merged = { ...stored, ...input };
      // Recomputed rather than taken from the stored row: moving
      // `discovered_at` moves the deadline, and the check has to judge
      // the deadline this write will leave behind.
      merged["notify_by"] = dueFrom(merged["discovered_at"]) ?? merged["notify_by"];
      breachRules(merged);
    }
    return input;
  });

  action("auth.login", async (meta: any, context: any) => {
    const failed = meta?.status !== "success";
    const email = meta?.payload?.email;

    // A successful login is already in directus_activity. It is mirrored
    // here anyway so that one table answers "what happened to this
    // account" — a failed attempt and the success that followed it are the
    // same story, and splitting them across two tables is how nobody
    // notices the four attempts before the fifth worked.
    await record(
      {
        action: failed ? "login_failed" : "login",
        user: meta?.user ?? null,
        // Only when there is no user to point at — otherwise this would be
        // a second copy of an address already reachable through the
        // relation, and logs should not store what they can join to.
        attempted_email: meta?.user ? null : typeof email === "string" ? email : null,
        collection: "directus_users",
        item: meta?.user ?? null,
        item_count: failed ? 0 : 1,
        ip: context?.accountability?.ip ?? null,
        user_agent: context?.accountability?.userAgent ?? null,
      },
      context?.schema ?? (await getSchema()),
    );
  });
});
