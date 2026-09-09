import type { Collection } from "../types.js";
import { pk, clinicRef, timestamps, divider, status } from "./_helpers.js";

/**
 * Recall — "recare" in the US, "continuing care" in Dentrix.
 *
 * The module a dentist looks for first and hobby schemas leave out, because
 * it is the commercial heart of a practice: who is due, who is overdue, who
 * has been chased and how.
 *
 * Three collections rather than one, and each division comes from how real
 * products behave rather than from taste:
 *
 *   recall_types     — an OPEN set. Practices invent their own ("perio
 *                      maintenance", "child fluoride"), so a fixed enum
 *                      would be wrong. What IS closed is the special type
 *                      attached to each, which drives behaviour.
 *   recall_statuses  — also an open lookup. Open Dental stores status as a
 *                      foreign key into a user-editable definition list,
 *                      and the shipped examples are contact-attempt
 *                      oriented: "Mailed postcard", "Texted". A CHECK enum
 *                      here would be a guess about somebody's workflow.
 *   recalls          — the per-patient record.
 */

/** Practices define their own recall kinds. */
export const recallTypes: Collection = {
  collection: "recall_types",
  meta: {
    icon: "event_repeat",
    note: "$t:enamel_note_recall_types",
    display_template: "{{name}}",
    sort: 9,
    group: "clinical",
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "name",
      type: "string",
      meta: { interface: "input", required: true, width: "half", options: { placeholder: "Examination" } },
      schema: { is_nullable: false },
    },
    {
      /**
       * The one closed axis. Open Dental's Special Type has exactly four
       * values and they drive behaviour rather than labelling: a child
       * prophy series and an adult one are not interchangeable, and a
       * perio maintenance series runs on its own interval.
       */
      field: "special_type",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_special_type",
        options: {
          choices: [
            { text: "$t:enamel_rt_prophy", value: "prophy" },
            { text: "$t:enamel_rt_child_prophy", value: "child_prophy" },
            { text: "$t:enamel_rt_perio", value: "perio" },
            { text: "$t:enamel_rt_none", value: "none" },
          ],
        },
      },
      schema: { default_value: "none", is_nullable: false },
    },
    {
      field: "default_interval_months",
      type: "integer",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_default_interval",
        validation: { default_interval_months: { _in: [3, 6, 9, 12, 15, 18, 21, 24] } },
        validation_message:
          "NICE CG19 assigns recall intervals in 3-month steps: 3–12 months under 18, 3–24 months at 18 and over.",
      },
      schema: { default_value: 6 },
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "recall_types", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
  ],
};

/** Where a patient is in the chase, in the practice's own words. */
export const recallStatuses: Collection = {
  collection: "recall_statuses",
  meta: {
    icon: "label",
    note: "$t:enamel_note_recall_statuses",
    display_template: "{{name}}",
    sort: 10,
    group: "clinical",
    hidden: true,
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "name",
      type: "string",
      meta: { interface: "input", required: true, width: "half", options: { placeholder: "Mailed postcard" } },
      schema: { is_nullable: false },
    },
    {
      field: "abbreviation",
      type: "string",
      meta: { interface: "input", width: "half", options: { placeholder: "MP" } },
      schema: {},
    },
    { field: "sort", type: "integer", meta: { interface: "input", hidden: true }, schema: {} },
    ...timestamps(),
  ],
  relations: [
    { collection: "recall_statuses", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
  ],
};

export const recalls: Collection = {
  collection: "recalls",
  meta: {
    icon: "notifications_active",
    note: "$t:enamel_note_recalls",
    display_template: "{{patient.last_name}}, {{patient.first_name}} · {{recall_type.name}}",
    sort: 8,
    group: "clinical",
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "patient",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{last_name}}, {{first_name}}" },
        width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * A patient can legitimately hold more than one series at once —
       * NICE's interval governs oral health *reviews* by a dentist, which
       * is a separate rhythm from hygienist visits. So this is not unique
       * per patient.
       */
      field: "recall_type",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        note: "$t:enamel_note_recall_type",
        options: { template: "{{name}}" },
        width: "half",
      },
      schema: { is_nullable: false },
    },
    divider("$t:enamel_div_recall_interval", "divider_recall_interval", "schedule"),
    {
      /**
       * NICE CG19, verbatim: "the patient should be assigned a recall
       * interval of 3, 6, 9 or 12 months if he or she is younger than 18
       * years, or 3, 6, 9, 12, 15, 18, 21 or 24 months if he or she is
       * aged 18 years or older."
       *
       * So the domain is 3-month steps, floor 3, ceiling 24 — and 12 for
       * under-18s, which is an age-conditional bound this validation
       * cannot express because it depends on another collection's row.
       * The message says so rather than pretending otherwise.
       *
       * The US has no equivalent table: the ADA states of periodontal
       * maintenance that "no time frame is outlined in the CDT", and the
       * 3-month convention is payer practice, not a standard. A US-facing
       * deployment should relax this, not copy it.
       */
      field: "interval_months",
      type: "integer",
      meta: {
        interface: "input", required: true, width: "half",
        note: "$t:enamel_note_interval_months",
        validation: { interval_months: { _in: [3, 6, 9, 12, 15, 18, 21, 24] } },
        validation_message:
          "NICE CG19: 3-month steps only. Under 18, the longest interval is 12 months; at 18 and over, 24.",
      },
      schema: { is_nullable: false, default_value: 6 },
    },
    {
      /**
       * NICE again, and the field almost every schema omits: "The dentist
       * should discuss the recommended recall interval with the patient
       * and record this interval, and the patient's agreement or
       * disagreement with it."
       *
       * Three values, not a nullable boolean — "not discussed" is a
       * different fact from "disagreed", and a null in a two-valued column
       * makes a reader guess which one it means.
       */
      field: "patient_agreed",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_patient_agreed",
        display: "labels",
        display_options: {
          // No `showAsDot` here, unlike the archive statuses. A dot works
          // when the colour carries the whole meaning; agreed, disagreed
          // and not discussed are three facts a reader has to be able to
          // tell apart in a worklist without hovering over them.
          choices: [
            { text: "$t:enamel_ag_agreed", value: "agreed", color: "#2ECDA7" },
            { text: "$t:enamel_ag_disagreed", value: "disagreed", color: "#E35169" },
            { text: "$t:enamel_ag_not_discussed", value: "not_discussed", color: "#A2B5CD" },
          ],
        },
        options: {
          choices: [
            { text: "$t:enamel_ag_agreed", value: "agreed" },
            { text: "$t:enamel_ag_disagreed", value: "disagreed" },
            { text: "$t:enamel_ag_not_discussed", value: "not_discussed" },
          ],
        },
      },
      schema: { default_value: "not_discussed" },
    },
    {
      field: "interval_set_by",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_interval_set_by",
        options: { template: "{{first_name}} {{last_name}}" },
      },
      schema: {},
    },
    {
      field: "interval_set_on",
      type: "date",
      meta: { interface: "datetime", width: "half" },
      schema: {},
    },
    divider("$t:enamel_div_recall_dates", "divider_recall_dates", "event"),
    {
      field: "date_previous",
      type: "date",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_date_previous" },
      schema: {},
    },
    {
      /**
       * Two due dates, deliberately. Open Dental distinguishes a
       * Calculated Due Date — "the recall due date based on the Previous
       * Date plus the recall interval" — from an Actual Due Date that
       * "typically matches the calculated due date but can be manually
       * adjusted". Collapsing them into one column loses the ability to
       * say "this patient is being seen early, on purpose".
       *
       * Kept in step by whoever writes the recall, not by a flow: a flow
       * cannot add an interval to a date. There is no arithmetic without
       * the script operation, and that operation is inert in this image.
       * A production deployment would make this a generated column.
       */
      field: "date_due_calculated",
      type: "date",
      meta: {
        interface: "datetime", readonly: true, width: "half",
        note: "$t:enamel_note_date_due_calculated",
      },
      schema: {},
    },
    {
      field: "date_due",
      type: "date",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_date_due" },
      schema: {},
    },
    {
      field: "date_scheduled",
      type: "date",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_date_scheduled" },
      schema: {},
    },
    {
      /**
       * Where the chase has got to. Not a state machine the user walks
       * through: the real cycle is driven by procedure completion —
       * appointment set complete, date_previous advances, due date
       * recomputes, status clears — and everything in between is contact
       * attempts. "Due" and "overdue" are computed from date_due against
       * today, so they are not stored here.
       */
      field: "recall_status",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_recall_status",
        options: { template: "{{name}}" },
      },
      schema: {},
    },
    divider("$t:enamel_div_recall_suppression", "divider_recall_suppression", "notifications_off"),
    {
      /**
       * Three suppression modes, which is the non-obvious part. A patient
       * who has moved away, one mid-treatment, and one who owes money are
       * all excluded from a recall run — and none of them should have the
       * recall deleted, because the history matters and they may come
       * back.
       */
      field: "is_disabled",
      type: "boolean",
      meta: { interface: "boolean", width: "half", note: "$t:enamel_note_is_disabled" },
      schema: { default_value: false, is_nullable: false },
    },
    {
      field: "disable_until",
      type: "date",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_disable_until" },
      schema: {},
    },
    {
      field: "disable_until_balance_under",
      type: "decimal",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_disable_until_balance",
        display: "formatted-value", display_options: { prefix: "€ " },
        validation: { disable_until_balance_under: { _gte: 0 } },
        validation_message: "A balance threshold cannot be negative.",
      },
      schema: { numeric_precision: 10, numeric_scale: 2 },
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
    { collection: "recalls", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "recalls",
      field: "patient",
      related_collection: "patients",
      meta: { one_field: "recalls" },
      schema: { on_delete: "CASCADE" },
    },
    { collection: "recalls", field: "recall_type", related_collection: "recall_types", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "recalls", field: "recall_status", related_collection: "recall_statuses", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "recalls", field: "interval_set_by", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};
