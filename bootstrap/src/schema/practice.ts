import type { Collection } from "../types.js";
import { pk, clinicRef, timestamps, divider, status } from "./_helpers.js";

/**
 * The three modules that are named, shipped features in real practice
 * software and are almost always missing from a demo: payment plans, the
 * short-notice cancellation list, and lab case tracking.
 *
 * Each one is modelled on what products actually do rather than on what
 * sounds reasonable, and where the products disagree with each other that
 * disagreement is in the schema instead of being averaged away.
 */

/** ------------------------------------------------------------------ */

/**
 * A payment plan, which is not a repeating charge.
 *
 * Three types, deliberately — Open Dental has four, but two of them
 * ("Patient Payment Plan" and "Old Payment Plan") are the same object
 * under two names, and modelling them separately would be copying a
 * rename rather than a distinction.
 */
export const paymentPlans: Collection = {
  collection: "payment_plans",
  meta: {
    icon: "request_quote",
    note: "$t:enamel_note_payment_plans",
    display_template: "{{patient.last_name}} — {{total_principal}}",
    sort: 4,
    group: "billing",
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
        options: { template: "{{last_name}}, {{first_name}}" }, width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "plan_type",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_plan_type",
        options: {
          choices: [
            { text: "$t:enamel_pp_payment_plan", value: "payment_plan" },
            { text: "$t:enamel_pp_installment", value: "installment" },
            { text: "$t:enamel_pp_insurance", value: "insurance" },
          ],
        },
      },
      schema: { default_value: "payment_plan", is_nullable: false },
    },
    {
      field: "agreed_on",
      type: "date",
      meta: { interface: "datetime", required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      field: "total_principal",
      type: "decimal",
      meta: {
        interface: "input", required: true, width: "half",
        display: "formatted-value", display_options: { prefix: "€ " },
        validation: { total_principal: { _gt: 0 } },
        validation_message: "A plan has to be for something.",
      },
      schema: { numeric_precision: 12, numeric_scale: 2, is_nullable: false },
    },
    {
      /**
       * Subtracted from the balance *before* the schedule and the
       * interest are computed, which is the part people get wrong: a down
       * payment is not the first instalment.
       */
      field: "down_payment",
      type: "decimal",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_down_payment",
        display: "formatted-value", display_options: { prefix: "€ " },
        validation: { down_payment: { _gte: 0 } },
        validation_message: "A down payment cannot be negative.",
      },
      schema: { numeric_precision: 12, numeric_scale: 2, default_value: 0 },
    },
    {
      field: "first_payment_on",
      type: "date",
      meta: { interface: "datetime", width: "half" },
      schema: {},
    },
    divider("$t:enamel_div_plan_interest", "divider_plan_interest", "percent"),
    {
      field: "apr",
      type: "decimal",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_apr",
        validation: { apr: { _between: [0, 100] } },
        validation_message: "An APR is a percentage.",
      },
      schema: { numeric_precision: 5, numeric_scale: 2, default_value: 0 },
    },
    {
      /**
       * Two ways to say when interest starts, and the product accepts
       * exactly one of them: a count of interest-free payments OR a date.
       * Leave both empty and interest applies to everything due.
       *
       * "Enter only one" is a cross-field rule Directus validation cannot
       * express — it constrains a pair, not a value — so it is stated
       * here, enforced by whoever writes the plan, and asserted by the
       * verify suite. Pretending a single-field rule covers it would be
       * worse than saying so.
       */
      field: "interest_free_payments",
      type: "integer",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_interest_free",
        validation: { _or: [{ interest_free_payments: { _null: true } }, { interest_free_payments: { _gte: 0 } }] },
        validation_message: "A count of payments, or leave it empty and set an interest start date instead.",
      },
      schema: {},
    },
    {
      field: "interest_starts_on",
      type: "date",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_interest_starts" },
      schema: {},
    },
    divider("$t:enamel_div_plan_schedule", "divider_plan_schedule", "calendar_month"),
    {
      // The same "enter only one" shape: a count of payments or an amount
      // per payment, and the other is derived from it.
      field: "number_of_payments",
      type: "integer",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_number_of_payments",
        validation: { _or: [{ number_of_payments: { _null: true } }, { number_of_payments: { _gt: 0 } }] },
        validation_message: "A count of payments, or leave it empty and set a payment amount instead.",
      },
      schema: {},
    },
    {
      field: "payment_amount",
      type: "decimal",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_payment_amount",
        display: "formatted-value", display_options: { prefix: "€ " },
      },
      schema: { numeric_precision: 12, numeric_scale: 2 },
    },
    {
      field: "charge_frequency",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        options: {
          choices: [
            { text: "$t:enamel_cf_weekly", value: "weekly" },
            { text: "$t:enamel_cf_fortnightly", value: "fortnightly" },
            { text: "$t:enamel_cf_monthly", value: "monthly" },
            { text: "$t:enamel_cf_day_of_month", value: "day_of_month" },
            { text: "$t:enamel_cf_quarterly", value: "quarterly" },
          ],
        },
      },
      schema: { default_value: "monthly", is_nullable: false },
    },
    {
      /**
       * Whether treatment-planned work is charged now or when it
       * completes. Not a detail: it decides whether a plan covers work
       * that has not happened yet.
       */
      field: "handle_treatment_planned",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_handle_tp",
        options: {
          choices: [
            { text: "$t:enamel_htp_await", value: "await_completion" },
            { text: "$t:enamel_htp_as_complete", value: "as_complete" },
          ],
        },
      },
      schema: { default_value: "await_completion" },
    },
    {
      /**
       * Called "Permanent Lock" since v24.3 and "Full Lock" before it.
       * An APR does not unconditionally force it — that depends on a
       * practice-level preference — so this is a field, not a derived
       * consequence.
       */
      field: "permanent_lock",
      type: "boolean",
      meta: {
        interface: "boolean", width: "half",
        note: "$t:enamel_note_permanent_lock",
      },
      schema: { default_value: false, is_nullable: false },
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
    { collection: "payment_plans", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "payment_plans", field: "patient", related_collection: "patients",
      meta: { one_field: "payment_plans" }, schema: { on_delete: "CASCADE" },
    },
  ],
};

/** One row of the amortisation schedule. */
export const paymentPlanCharges: Collection = {
  collection: "payment_plan_charges",
  meta: {
    icon: "receipt",
    note: "$t:enamel_note_plan_charges",
    display_template: "{{due_on}} — {{amount}}",
    sort: 5,
    group: "billing",
    hidden: true,
    sort_field: "sort",
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "payment_plan",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{patient.last_name}}" }, width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "due_on",
      type: "date",
      meta: { interface: "datetime", required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      field: "principal",
      type: "decimal",
      meta: {
        interface: "input", width: "half",
        display: "formatted-value", display_options: { prefix: "€ " },
      },
      schema: { numeric_precision: 12, numeric_scale: 2, default_value: 0 },
    },
    {
      field: "interest",
      type: "decimal",
      meta: {
        interface: "input", width: "half",
        display: "formatted-value", display_options: { prefix: "€ " },
      },
      schema: { numeric_precision: 12, numeric_scale: 2, default_value: 0 },
    },
    {
      field: "balance_after",
      type: "decimal",
      meta: {
        interface: "input", readonly: true, width: "half",
        note: "$t:enamel_note_balance_after",
        display: "formatted-value", display_options: { prefix: "€ " },
      },
      schema: { numeric_precision: 12, numeric_scale: 2 },
    },
    status(
      [
        { text: "$t:enamel_ch_due", value: "due", color: "#A2B5CD" },
        { text: "$t:enamel_ch_paid", value: "paid", color: "#2ECDA7" },
        { text: "$t:enamel_ch_missed", value: "missed", color: "#E35169" },
      ],
      "due",
    ),
    { field: "sort", type: "integer", meta: { interface: "input", hidden: true }, schema: {} },
    ...timestamps(),
  ],
  relations: [
    { collection: "payment_plan_charges", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "payment_plan_charges", field: "payment_plan", related_collection: "payment_plans",
      meta: { one_field: "charges" }, schema: { on_delete: "CASCADE" },
    },
  ],
};

/** ------------------------------------------------------------------ */

/**
 * The short-notice cancellation list — Open Dental's "ASAP List",
 * Denticon's "Quick Fill", Dentally's waiting lists.
 *
 * The important thing here is what is NOT universal. Open Dental's ASAP
 * list is a **binary flag**: patients "who would like to be contacted
 * when an earlier appointment becomes available", with no urgency field
 * and no stored declined state. Its only ordering is a fixed system
 * heuristic — unscheduled appointments, then scheduled, then recalls,
 * farthest-future first — and a patient "declining" is an opt-out that
 * suppresses further notifications rather than a state on the list.
 * Denticon's Quick Fill documents neither priority nor a declined state.
 *
 * Priority tiers and wait-time targets are **Dentally only**, and even
 * its "declined" is documented as a note rather than a structured value.
 * So they are here as optional fields with that provenance recorded,
 * rather than presented as how waiting lists work. Averaging the products
 * into one invented model would have been the easy mistake.
 */
export const waitingList: Collection = {
  collection: "waiting_list",
  meta: {
    icon: "hourglass_top",
    note: "$t:enamel_note_waiting_list",
    display_template: "{{patient.last_name}} — {{source}}",
    sort: 19,
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
        options: { template: "{{last_name}}, {{first_name}}" }, width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "added_on",
      type: "date",
      meta: { interface: "datetime", required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      /**
       * How they got onto the list, which is the closest thing the
       * products have to a universal structure — Open Dental populates it
       * four ways and orders its outreach by exactly this.
       */
      field: "source",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_wl_source",
        options: {
          choices: [
            { text: "$t:enamel_wl_scheduled", value: "scheduled_appointment" },
            { text: "$t:enamel_wl_planned", value: "planned_appointment" },
            { text: "$t:enamel_wl_unscheduled", value: "unscheduled" },
            { text: "$t:enamel_wl_recall", value: "recall" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      field: "appointment",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_wl_appointment",
        options: { template: "{{starts_at}}" },
      },
      schema: {},
    },
    {
      field: "wanted_from",
      type: "date",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_wanted_from" },
      schema: {},
    },
    divider("$t:enamel_div_wl_uk", "divider_wl_uk", "flag"),
    {
      /**
       * Dentally only. Documented as "high, medium or low", and absent
       * from every US product examined — so it is optional and its
       * provenance is in the note rather than implied to be standard.
       */
      field: "priority",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_wl_priority",
        options: {
          choices: [
            { text: "$t:enamel_wp_high", value: "high" },
            { text: "$t:enamel_wp_medium", value: "medium" },
            { text: "$t:enamel_wp_low", value: "low" },
          ],
        },
      },
      schema: {},
    },
    {
      field: "wait_target_days",
      type: "integer",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_wait_target",
        validation: { _or: [{ wait_target_days: { _null: true } }, { wait_target_days: { _gt: 0 } }] },
        validation_message: "A target in days.",
      },
      schema: {},
    },
    status(
      [
        { text: "$t:enamel_wl_waiting", value: "waiting", color: "#2ECDA7" },
        { text: "$t:enamel_wl_offered", value: "offered", color: "#FFC23B" },
        { text: "$t:enamel_wl_filled", value: "filled", color: "#0D6E63" },
        { text: "$t:enamel_wl_removed", value: "removed", color: "#A2B5CD" },
      ],
      "waiting",
    ),
    {
      field: "note",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_wl_note" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "waiting_list", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "waiting_list", field: "patient", related_collection: "patients",
      meta: { one_field: "waiting_list" }, schema: { on_delete: "CASCADE" },
    },
    { collection: "waiting_list", field: "appointment", related_collection: "appointments", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

/** ------------------------------------------------------------------ */

/** The labs a practice sends work to. Its own table, as in the products. */
export const laboratories: Collection = {
  collection: "laboratories",
  meta: {
    icon: "science",
    note: "$t:enamel_note_laboratories",
    display_template: "{{name}}",
    sort: 20,
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
      meta: { interface: "input", required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      field: "phone",
      type: "string",
      meta: { interface: "input", width: "half" },
      schema: {},
    },
    {
      field: "email",
      type: "string",
      meta: { interface: "input", width: "half" },
      schema: {},
    },
    {
      field: "turnaround_days",
      type: "integer",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_turnaround",
        validation: { _or: [{ turnaround_days: { _null: true } }, { turnaround_days: { _gt: 0 } }] },
        validation_message: "Working days.",
      },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "laboratories", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
  ],
};

/**
 * Lab cases.
 *
 * Modelled as Open Dental's timestamp state machine rather than as a
 * status enum, and that choice is a real fork in the road: Dentally
 * models the same thing as a single "lab status" on the appointment —
 * None required / Sent / Received / Overdue — shown as a coloured beaker.
 * The enum is simpler; the timestamps answer "how long was it at the lab"
 * and "was the fit checked before the patient sat down", which the enum
 * cannot.
 *
 * Four datetimes, not two, and the distinction between them is the point:
 * `sent_at` is when the case was packaged and put out, which "may not
 * actually be picked up until hours later"; `checked_at` is quality
 * checked, which is a different act from received.
 */
export const labCases: Collection = {
  collection: "lab_cases",
  meta: {
    icon: "biotech",
    note: "$t:enamel_note_lab_cases",
    display_template: "{{patient.last_name}} — {{instructions}}",
    sort: 21,
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
        options: { template: "{{last_name}}, {{first_name}}" }, width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "laboratory",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{name}}" }, width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Two nullable appointment links, not one: the scheduled visit the
       * work is for, and a planned one for work not yet booked. The
       * manual says a case "should always be attached to an appointment"
       * and that unattached ones show as unattached — a workflow
       * expectation, not a constraint, so both are nullable.
       */
      field: "appointment",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_lab_appointment",
        options: { template: "{{starts_at}}" },
      },
      schema: {},
    },
    {
      field: "treatment_plan",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_lab_plan",
        options: { template: "{{title}}" },
      },
      schema: {},
    },
    {
      /**
       * Free text, and it stays free text. A shade is written the way a
       * technician reads it — "PFM crown #28. Shade A1" — and every
       * attempt to enumerate shade systems ends in a dropdown that does
       * not contain the one this lab uses.
       */
      field: "instructions",
      type: "text",
      meta: {
        interface: "input-multiline", required: true,
        note: "$t:enamel_note_lab_instructions",
        options: { placeholder: "PFM crown 46. Shade A1." },
      },
      schema: { is_nullable: false },
    },
    divider("$t:enamel_div_lab_timeline", "divider_lab_timeline", "timeline"),
    {
      field: "due_at",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_lab_due" },
      schema: {},
    },
    {
      field: "sent_at",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_lab_sent" },
      schema: {},
    },
    {
      field: "received_at",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_lab_received" },
      schema: {},
    },
    {
      field: "checked_at",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_lab_checked" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "lab_cases", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "lab_cases", field: "patient", related_collection: "patients",
      meta: { one_field: "lab_cases" }, schema: { on_delete: "CASCADE" },
    },
    { collection: "lab_cases", field: "laboratory", related_collection: "laboratories", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "lab_cases", field: "appointment", related_collection: "appointments", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "lab_cases", field: "treatment_plan", related_collection: "treatment_plans", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};
