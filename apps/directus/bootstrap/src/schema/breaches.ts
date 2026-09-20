import type { Collection } from "../types.js";
import { pk, timestamps, divider } from "./_helpers.js";

/**
 * The breach register — GDPR Articles 33 and 34.
 *
 * Most systems that have one record the breaches that were *reported*.
 * Article 33(5) asks for something larger and it is the half that gets
 * missed:
 *
 *   "The controller shall document **any** personal data breaches,
 *   comprising the facts relating to the personal data breach, its
 *   effects and the remedial action taken."
 *
 * Any. Including the ones a practice decided not to report, which is most
 * of them — and for those the register has to show the *reasoning*,
 * because that is what a supervisory authority asks to see. A register
 * containing only the reported ones is evidence that the reporting
 * decision was never documented.
 *
 * ## The clock
 *
 * Seventy-two hours, and three things about it are wrong in nearly every
 * implementation:
 *
 *   It runs from **awareness**, not from when the breach happened. A
 *   laptop taken in March and noticed in June starts the clock in June —
 *   so `discovered_at` is the required field and `occurred_at` is the
 *   optional one, which is the opposite of how it is usually modelled.
 *
 *   It is **72 hours**, not three working days. A Friday afternoon
 *   discovery is due on Monday afternoon.
 *
 *   Late is allowed, and is not free: Article 33(1) says a notification
 *   after 72 hours "shall be accompanied by reasons for the delay". So
 *   the register has somewhere to put them.
 *
 * The due time is computed by a database trigger rather than by a form,
 * for the same reason the scheduling rules are: a deadline that depends
 * on whoever typed it is not a deadline.
 */
export const dataBreaches: Collection = {
  collection: "data_breaches",
  meta: {
    icon: "gpp_maybe",
    note: "$t:enamel_note_breaches",
    display_template: "{{reference}} — {{summary}}",
    sort: 3,
    group: "governance",
    /*
     * Deliberately **no archive field**.
     *
     * `status` was the obvious candidate and it was wrong: Directus hides
     * archived rows from the default view, so setting `archive_value:
     * "closed"` made the register show nothing at all — both seeded
     * entries were closed. Which is the whole point of a register.
     * Article 33(5) requires a practice to be able to produce every
     * breach it has ever had; a list that hides the finished ones is a
     * list of open problems, not a record.
     *
     * Found by opening the page. The suite was green: it reads through
     * the API, where the archive filter is a *view* concern and does not
     * apply.
     */
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "reference",
      type: "string",
      meta: {
        interface: "input", required: true, width: "half",
        note: "$t:enamel_note_breach_ref",
      },
      schema: { is_nullable: false, is_unique: true },
    },
    {
      field: "status",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        display: "labels",
        options: {
          choices: [
            { text: "$t:enamel_bs_open", value: "open", color: "#E35169" },
            { text: "$t:enamel_bs_contained", value: "contained", color: "#FFA439" },
            { text: "$t:enamel_bs_closed", value: "closed", color: "#2ECDA7" },
          ],
        },
      },
      schema: { default_value: "open", is_nullable: false },
    },
    {
      /**
       * When somebody here *realised*. The clock starts here and nowhere
       * else — a laptop taken in March and noticed in June is a June
       * breach for the purposes of Article 33.
       */
      field: "discovered_at",
      type: "timestamp",
      meta: {
        interface: "datetime", required: true, width: "half",
        note: "$t:enamel_note_breach_discovered",
      },
      schema: { is_nullable: false },
    },
    {
      field: "occurred_at",
      type: "timestamp",
      meta: {
        interface: "datetime", width: "half",
        note: "$t:enamel_note_breach_occurred",
      },
      schema: {},
    },
    {
      /**
       * Set by a trigger, never by the form.
       *
       * A deadline somebody types is a deadline somebody can get wrong,
       * and this one has a legal consequence. See `constraints.ts`.
       */
      field: "notify_by",
      type: "timestamp",
      meta: {
        interface: "datetime", readonly: true, width: "half",
        note: "$t:enamel_note_breach_notify_by",
      },
      schema: {},
    },
    divider("$t:enamel_div_breach_facts", "divider_breach_facts", "description"),
    {
      field: "summary",
      type: "string",
      meta: { interface: "input", required: true, note: "$t:enamel_note_breach_summary" },
      schema: { is_nullable: false },
    },
    {
      // Article 33(3)(a): the nature of the breach and, where possible,
      // the categories and approximate number of data subjects and
      // records concerned.
      field: "facts",
      type: "text",
      meta: { interface: "input-multiline", required: true, note: "$t:enamel_note_breach_facts" },
      schema: { is_nullable: false },
    },
    {
      field: "data_categories",
      type: "json",
      meta: {
        interface: "select-multiple-checkbox", required: true,
        note: "$t:enamel_note_breach_categories",
        options: {
          choices: [
            { text: "$t:enamel_bc_identity", value: "identity" },
            { text: "$t:enamel_bc_contact", value: "contact" },
            { text: "$t:enamel_bc_clinical", value: "clinical" },
            { text: "$t:enamel_bc_imaging", value: "imaging" },
            { text: "$t:enamel_bc_financial", value: "financial" },
            { text: "$t:enamel_bc_credentials", value: "credentials" },
          ],
        },
      },
      schema: {},
    },
    {
      field: "people_affected",
      type: "integer",
      meta: { interface: "input", width: "half", note: "$t:enamel_note_breach_people" },
      schema: {},
    },
    {
      field: "records_affected",
      type: "integer",
      meta: { interface: "input", width: "half", note: "$t:enamel_note_breach_records" },
      schema: {},
    },
    {
      // Article 33(3)(c).
      field: "likely_consequences",
      type: "text",
      meta: { interface: "input-multiline", required: true, note: "$t:enamel_note_breach_consequences" },
      schema: { is_nullable: false },
    },
    {
      // Article 33(3)(d) — and 33(5)'s "remedial action taken".
      field: "measures_taken",
      type: "text",
      meta: { interface: "input-multiline", required: true, note: "$t:enamel_note_breach_measures" },
      schema: { is_nullable: false },
    },
    divider("$t:enamel_div_breach_decision", "divider_breach_decision", "gavel"),
    {
      /**
       * The assessment the whole of Articles 33 and 34 turns on.
       *
       * `unlikely` means no notification to the authority. `risk` means
       * notify the authority. `high_risk` means notify the authority
       * **and** the patients. Three values rather than a boolean, because
       * the two duties have different thresholds and collapsing them is
       * how a practice tells an authority and not the people.
       */
      field: "risk",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        display: "labels",
        note: "$t:enamel_note_breach_risk",
        options: {
          choices: [
            { text: "$t:enamel_br_unlikely", value: "unlikely", color: "#2ECDA7" },
            { text: "$t:enamel_br_risk", value: "risk", color: "#FFA439" },
            { text: "$t:enamel_br_high", value: "high_risk", color: "#E35169" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Why not, when the answer was not to report.
       *
       * Required by a constraint rather than by the form — see
       * `constraints.ts`. Article 33(1) exempts a breach "unlikely to
       * result in a risk", and 33(5) still requires the documentation. An
       * unexplained `unlikely` is the register's most dangerous row: it
       * looks like a decision and is indistinguishable from an oversight.
       */
      field: "why_not_notified",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_breach_why_not" },
      schema: {},
    },
    divider("$t:enamel_div_breach_notify", "divider_breach_notify", "campaign"),
    {
      field: "authority_notified_at",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_breach_authority_at" },
      schema: {},
    },
    {
      field: "authority_reference",
      type: "string",
      meta: { interface: "input", width: "half", note: "$t:enamel_note_breach_authority_ref" },
      schema: {},
    },
    {
      // Article 33(1): a notification after 72 hours has to say why.
      field: "reason_for_delay",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_breach_delay" },
      schema: {},
    },
    {
      field: "subjects_notified_at",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_breach_subjects_at" },
      schema: {},
    },
    {
      field: "subjects_notified_how",
      type: "string",
      meta: { interface: "input", width: "half", note: "$t:enamel_note_breach_subjects_how" },
      schema: {},
    },
    {
      field: "closed_at",
      type: "timestamp",
      meta: { interface: "datetime", readonly: true, width: "half" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
  ],
};

export const breachCollections = [dataBreaches];
