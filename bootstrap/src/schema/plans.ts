import type { Collection } from "../types.js";
import { pk, clinicRef, timestamps, divider, ALL_TOOTH_CODES, TOOTH_CODE_MESSAGE } from "./_helpers.js";

/**
 * Treatment planning, and case acceptance.
 *
 * Not a filter over procedures with a "planned" status — that is the thing
 * it is mistaken for. In Open Dental a treatment plan is a first-class
 * record with a three-value status, and the transitions are real:
 * "Make Active Treatment Plan" promotes an inactive plan and demotes the
 * current active one.
 *
 *   active   — exactly one per patient. Supplies the defaults for the
 *              chart, the progress notes and appointment creation.
 *   inactive — as many as you like. Alternatives, superseded versions,
 *              the cheaper option the patient is thinking about.
 *   saved    — a permanent snapshot. Signing one is what makes it
 *              immutable: procedures on a signed plan cannot be edited
 *              until the signature is cleared.
 *
 * "Exactly one active per patient" is a partial unique index — unique on
 * (patient) WHERE status = 'active' — which Directus cannot create through
 * its API. It is enforced by whoever promotes a plan, asserted by the
 * verify suite, and stated here rather than left implied. A production
 * deployment would add the index by hand.
 */
export const treatmentPlans: Collection = {
  collection: "treatment_plans",
  meta: {
    icon: "assignment",
    note: "$t:enamel_note_treatment_plans",
    display_template: "{{patient.last_name}}, {{patient.first_name}} — {{title}}",
    sort: 6,
    group: "clinical",
    archive_field: "status",
    archive_value: "inactive",
    unarchive_value: "active",
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
      field: "title",
      type: "string",
      meta: {
        interface: "input", required: true, width: "half",
        options: { placeholder: "Upper right quadrant, phase 1" },
      },
      schema: { is_nullable: false },
    },
    {
      field: "status",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_plan_status",
        display: "labels",
        display_options: {
          showAsDot: true,
          choices: [
            { text: "$t:enamel_tp_active", value: "active", color: "#2ECDA7" },
            { text: "$t:enamel_tp_inactive", value: "inactive", color: "#A2B5CD" },
            { text: "$t:enamel_tp_saved", value: "saved", color: "#B4762A" },
          ],
        },
        options: {
          choices: [
            { text: "$t:enamel_tp_active", value: "active" },
            { text: "$t:enamel_tp_inactive", value: "inactive" },
            { text: "$t:enamel_tp_saved", value: "saved" },
          ],
        },
      },
      schema: { default_value: "active", is_nullable: false },
    },
    divider("$t:enamel_div_plan_acceptance", "divider_plan_acceptance", "handshake"),
    {
      field: "presented_on",
      type: "date",
      meta: {
        interface: "datetime", width: "half",
        note: "$t:enamel_note_presented_on",
        validation: { presented_on: { _lte: "$NOW" } },
        validation_message: "A plan cannot have been presented in the future.",
      },
      schema: {},
    },
    {
      /**
       * Frozen at presentation, and this is the whole reason it exists as
       * a column rather than a sum over the items.
       *
       * Case acceptance by value is (accepted ÷ presented) × 100. If
       * "presented" is recomputed from today's fee schedule, every price
       * rise silently rewrites last year's acceptance rate. The number has
       * to be the number the patient was actually shown.
       */
      field: "presented_total",
      type: "decimal",
      meta: {
        interface: "input", readonly: true, width: "half",
        note: "$t:enamel_note_presented_total",
        display: "formatted-value", display_options: { prefix: "€ " },
      },
      schema: { numeric_precision: 12, numeric_scale: 2, default_value: 0 },
    },
    {
      field: "accepted_on",
      type: "date",
      meta: { interface: "datetime", width: "half" },
      schema: {},
    },
    {
      /**
       * Stored beside the presented total rather than as a percentage.
       *
       * Both a value-based and a count-based acceptance rate matter, and
       * the *gap between them* is the diagnostic signal: a count rate much
       * higher than the value rate means the expensive cases are the ones
       * being declined. A single blended percentage throws that away, so
       * neither rate is stored — both are derivable from these amounts and
       * from the item rows.
       */
      field: "accepted_total",
      type: "decimal",
      meta: {
        interface: "input", readonly: true, width: "half",
        note: "$t:enamel_note_accepted_total",
        display: "formatted-value", display_options: { prefix: "€ " },
      },
      schema: { numeric_precision: 12, numeric_scale: 2, default_value: 0 },
    },
    divider("$t:enamel_div_plan_signature", "divider_plan_signature", "draw"),
    {
      /**
       * A signature is not decoration: it is what freezes the plan.
       * Clearing it is the only way to edit a signed plan, and doing so
       * has to be a visible act rather than a silent one.
       */
      field: "signed_on",
      type: "timestamp",
      meta: {
        interface: "datetime", width: "half",
        note: "$t:enamel_note_signed_on",
      },
      schema: {},
    },
    {
      field: "signed_by",
      type: "string",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_signed_by",
        options: { placeholder: "Signed in surgery on the tablet" },
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
    { collection: "treatment_plans", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "treatment_plans",
      field: "patient",
      related_collection: "patients",
      meta: { one_field: "treatment_plans" },
      schema: { on_delete: "CASCADE" },
    },
  ],
};

/** One proposed procedure on a plan. */
export const treatmentPlanItems: Collection = {
  collection: "treatment_plan_items",
  meta: {
    icon: "list",
    note: "$t:enamel_note_plan_items",
    display_template: "{{treatment.name}} {{tooth}} — {{status}}",
    sort: 11,
    group: "clinical",
    hidden: true,
    sort_field: "sort",
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "plan",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{title}}" },
        width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "treatment",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{code}} — {{name}}" },
        width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "tooth",
      type: "string",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_tooth",
        options: { placeholder: "36" },
        validation: { _or: [{ tooth: { _null: true } }, { tooth: { _in: ALL_TOOTH_CODES } }] },
        validation_message: TOOTH_CODE_MESSAGE,
      },
      schema: {},
    },
    {
      /**
       * Free text up to seven characters, not an enum. Open Dental's
       * treatment-plan priorities are a user-editable definition list
       * accepting "numbers, letters or words up to 7 characters" — so a
       * practice can run 1/2/3, or A/B/C, or URGENT/SOON.
       */
      field: "priority",
      type: "string",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_plan_priority",
        options: { placeholder: "1" },
        validation: { priority: { _regex: "^.{0,7}$" } },
        validation_message: "Seven characters at most — numbers, letters or a short word.",
      },
      schema: { max_length: 7 },
    },
    {
      /**
       * The fee as quoted, not as currently priced. Same argument as the
       * plan's presented total, one level down: this is the row that makes
       * a per-item acceptance analysis possible at all.
       */
      field: "fee_presented",
      type: "decimal",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_fee_presented",
        display: "formatted-value", display_options: { prefix: "€ " },
        validation: { fee_presented: { _gte: 0 } },
        validation_message: "A quoted fee cannot be negative.",
      },
      schema: { numeric_precision: 10, numeric_scale: 2, default_value: 0 },
    },
    {
      field: "status",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        display: "labels",
        display_options: {
          showAsDot: true,
          choices: [
            { text: "$t:enamel_pi_proposed", value: "proposed", color: "#A2B5CD" },
            { text: "$t:enamel_pi_accepted", value: "accepted", color: "#2ECDA7" },
            { text: "$t:enamel_pi_declined", value: "declined", color: "#E35169" },
            { text: "$t:enamel_pi_completed", value: "completed", color: "#0D6E63" },
          ],
        },
        options: {
          choices: [
            { text: "$t:enamel_pi_proposed", value: "proposed" },
            { text: "$t:enamel_pi_accepted", value: "accepted" },
            { text: "$t:enamel_pi_declined", value: "declined" },
            { text: "$t:enamel_pi_completed", value: "completed" },
          ],
        },
      },
      schema: { default_value: "proposed", is_nullable: false },
    },
    { field: "sort", type: "integer", meta: { interface: "input", hidden: true }, schema: {} },
    ...timestamps(),
  ],
  relations: [
    { collection: "treatment_plan_items", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "treatment_plan_items",
      field: "plan",
      related_collection: "treatment_plans",
      meta: { one_field: "items" },
      schema: { on_delete: "CASCADE" },
    },
    { collection: "treatment_plan_items", field: "treatment", related_collection: "treatments", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};
