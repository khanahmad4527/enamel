import type { Collection } from "../types.js";
import { pk, timestamps, divider } from "./_helpers.js";

/**
 * A disposal somebody authorised, with their name on it.
 *
 * The missing third of records management. ISO 15489 separates three
 * things that systems routinely collapse into one cron job:
 *
 *   the **schedule** — how long each kind of record is kept. That is
 *   `retention_rules`, and it is data because two practices in this
 *   repository are subject to genuinely different periods.
 *
 *   the **review** — what has passed its period. That is
 *   `GET /api/retention/due`, which lists and destroys nothing.
 *
 *   the **authorisation** — a person deciding that these particular
 *   records may now go, and signing for it. That is this collection, and
 *   it did not exist.
 *
 * Collapsing them into "delete anything older than N years" is wrong
 * twice over. A retention period is a **minimum to keep**, not a deadline
 * to destroy: a record under a complaint, a claim or a safeguarding
 * matter is kept past its period precisely because the period elapsed,
 * and a timer cannot know that. And destruction is irreversible and
 * unattributable when it is automatic — nobody decided, so nobody can be
 * asked.
 *
 * ## This records the decision. It does not carry it out.
 *
 * Nothing in this system deletes a clinical record, and that is not an
 * unfinished half. What a practice needs first is the ability to say
 * *what was authorised, by whom, on what grounds, and what actually
 * happened to it* — because that is the document an authority, an
 * insurer or a patient's solicitor asks for, and it is the one nobody has
 * when the deletion was a scheduled task.
 *
 * A deployment that wants the destruction to follow can hang it off an
 * authorised row. The ordering is the point: the signature exists before
 * the shredder, not after.
 */
export const disposals: Collection = {
  collection: "disposals",
  meta: {
    icon: "inventory_2",
    note: "$t:enamel_note_disposals",
    display_template: "{{reference}} — {{record_type}}",
    sort: 4,
    group: "governance",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "reference",
      type: "string",
      meta: { interface: "input", required: true, width: "half", note: "$t:enamel_note_disposal_ref" },
      schema: { is_nullable: false, is_unique: true },
    },
    {
      field: "status",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half", display: "labels",
        options: {
          choices: [
            { text: "$t:enamel_ds_proposed", value: "proposed", color: "#8196B1" },
            { text: "$t:enamel_ds_authorised", value: "authorised", color: "#FFA439" },
            { text: "$t:enamel_ds_carried_out", value: "carried_out", color: "#2ECDA7" },
            { text: "$t:enamel_ds_withheld", value: "withheld", color: "#E35169" },
          ],
        },
      },
      schema: { default_value: "proposed", is_nullable: false },
    },
    {
      /**
       * Which rule this was reviewed against.
       *
       * A link rather than a copied number, so a disposal can always be
       * read back against the schedule it was judged by — and so that
       * changing a period does not silently rewrite the history of what
       * was authorised under the old one. `SET NULL`, because a rule may
       * be retired and the disposal still happened.
       */
      field: "rule",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        options: { template: "{{record_type}} — {{years}} years" },
        note: "$t:enamel_note_disposal_rule",
      },
      schema: {},
    },
    {
      field: "record_type",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        options: {
          choices: [
            { text: "$t:enamel_rt_clinical", value: "clinical_record" },
            { text: "$t:enamel_rt_imaging", value: "imaging" },
            { text: "$t:enamel_rt_consent", value: "consent" },
            { text: "$t:enamel_rt_financial", value: "financial" },
            { text: "$t:enamel_rt_correspondence", value: "correspondence" },
            { text: "$t:enamel_rt_audit", value: "audit_log" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    divider("$t:enamel_div_disposal_scope", "divider_disposal_scope", "inventory"),
    {
      field: "covering",
      type: "text",
      meta: { interface: "input-multiline", required: true, note: "$t:enamel_note_disposal_covering" },
      schema: { is_nullable: false },
    },
    {
      field: "records_counted",
      type: "integer",
      meta: { interface: "input", width: "half", note: "$t:enamel_note_disposal_count" },
      schema: {},
    },
    {
      // The review's own cut-off, so the row can be reproduced later. "As
      // at today" is not a scope anybody can check afterwards.
      field: "reviewed_as_at",
      type: "timestamp",
      meta: { interface: "datetime", required: true, width: "half", note: "$t:enamel_note_disposal_asat" },
      schema: { is_nullable: false },
    },
    divider("$t:enamel_div_disposal_decision", "divider_disposal_decision", "how_to_reg"),
    {
      /**
       * The signature.
       *
       * A user reference rather than a typed name: a disposal authorised
       * by "the practice manager" is a disposal authorised by nobody, and
       * the whole reason this collection exists is that somebody can be
       * asked afterwards.
       */
      field: "authorised_by",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        options: { template: "{{first_name}} {{last_name}}" },
        note: "$t:enamel_note_disposal_by",
      },
      schema: {},
    },
    {
      field: "authorised_on",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_disposal_on" },
      schema: {},
    },
    {
      field: "grounds",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_disposal_grounds" },
      schema: {},
    },
    {
      /**
       * Why a record past its period is being kept anyway.
       *
       * The field that makes this a review rather than a queue. A record
       * under a complaint, a claim, a safeguarding matter or a coroner's
       * request is held past its period *because* the period elapsed and
       * somebody looked. Without somewhere to say so, the only way to
       * express "not this one" is to do nothing, which is
       * indistinguishable from not having looked.
       */
      field: "withheld_reason",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_disposal_withheld" },
      schema: {},
    },
    divider("$t:enamel_div_disposal_done", "divider_disposal_done", "task_alt"),
    {
      field: "method",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half", note: "$t:enamel_note_disposal_method",
        options: {
          choices: [
            { text: "$t:enamel_dm_deleted", value: "deleted" },
            { text: "$t:enamel_dm_anonymised", value: "anonymised" },
            { text: "$t:enamel_dm_transferred", value: "transferred" },
            { text: "$t:enamel_dm_shredded", value: "shredded" },
          ],
        },
      },
      schema: {},
    },
    {
      field: "carried_out_on",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_disposal_done_on" },
      schema: {},
    },
    {
      field: "carried_out_by",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        options: { template: "{{first_name}} {{last_name}}" },
        note: "$t:enamel_note_disposal_done_by",
      },
      schema: {},
    },
    {
      field: "note",
      type: "text",
      meta: { interface: "input-multiline" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    {
      collection: "disposals", field: "rule", related_collection: "retention_rules",
      meta: {}, schema: { on_delete: "SET NULL" },
    },
    {
      collection: "disposals", field: "authorised_by", related_collection: "directus_users",
      meta: {}, schema: { on_delete: "SET NULL" },
    },
    {
      collection: "disposals", field: "carried_out_by", related_collection: "directus_users",
      meta: {}, schema: { on_delete: "SET NULL" },
    },
  ],
};

export const disposalCollections = [disposals];
