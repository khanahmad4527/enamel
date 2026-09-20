import type { Collection, Field } from "../types.js";
import { pk, timestamps, divider } from "./_helpers.js";

/**
 * When the practice, the clinician and the chair are actually available.
 *
 * The appointments table has always been able to say *that* something was
 * booked. None of this said whether it could be: an appointment at three
 * in the morning on Christmas Day, with a hygienist who left in March, in
 * a chair that is in pieces waiting for a part, was a perfectly valid row.
 *
 * Four tables, because the four answers come from four different places
 * and change on four different rhythms:
 *
 *   clinic_hours        — the practice's own opening times. Changes maybe
 *                         twice a year.
 *   practitioner_hours  — who works which sessions. Dentistry runs on
 *                         half-days, so this is a list of sessions per
 *                         weekday rather than one span: a dentist working
 *                         Tuesday morning and Thursday all day is the
 *                         normal shape, not the exception.
 *   absences            — leave, sickness, training, and the days the
 *                         whole practice shuts. One table rather than two
 *                         because a bank holiday is an absence with no
 *                         practitioner on it, and splitting them means
 *                         every availability query has to read both.
 *   room_closures       — a chair out of service. Separate from absences
 *                         because a chair is not a person: it has no
 *                         leave entitlement and no working pattern, it is
 *                         either usable or it is not.
 *
 * Times here are wall-clock `time` columns, not timestamps. A practice
 * opens at nine o'clock local, and that stays nine o'clock across a
 * daylight-saving change — storing an instant would move opening time by
 * an hour twice a year. The clinic carries the timezone that resolves
 * them.
 */

/** Monday-first, matching how a rota is read rather than Postgres's Sunday-first DOW. */
const WEEKDAYS = [
  { text: "$t:enamel_wd_monday", value: "mon" },
  { text: "$t:enamel_wd_tuesday", value: "tue" },
  { text: "$t:enamel_wd_wednesday", value: "wed" },
  { text: "$t:enamel_wd_thursday", value: "thu" },
  { text: "$t:enamel_wd_friday", value: "fri" },
  { text: "$t:enamel_wd_saturday", value: "sat" },
  { text: "$t:enamel_wd_sunday", value: "sun" },
];

const weekday = (): Field => ({
  field: "weekday",
  type: "string",
  meta: {
    interface: "select-dropdown",
    required: true,
    width: "half",
    options: { choices: WEEKDAYS },
  },
  schema: { is_nullable: false },
});

const timeField = (field: string, note: string, required = true): Field => ({
  field,
  type: "time",
  meta: { interface: "datetime", required, width: "half", note, display: "formatted-value" },
  schema: { is_nullable: !required },
});

export const clinicHours: Collection = {
  collection: "clinic_hours",
  meta: {
    icon: "schedule",
    note: "$t:enamel_note_clinic_hours",
    display_template: "{{weekday}} {{opens_at}}–{{closes_at}}",
    sort: 2,
    group: "scheduling",
  },
  schema: {},
  fields: [
    pk(),
    weekday(),
    {
      /**
       * A closed day is a row, not a missing row.
       *
       * "No row for Sunday" and "we are shut on Sunday" look identical to
       * a query and mean different things to a practice manager: the
       * first is a rota nobody has finished, the second is a decision.
       * Making closure explicit is also what lets the UI show a seven-row
       * week rather than a list with gaps in it.
       */
      field: "closed",
      type: "boolean",
      meta: { interface: "boolean", width: "half", note: "$t:enamel_note_closed_day" },
      schema: { default_value: false, is_nullable: false },
    },
    timeField("opens_at", "$t:enamel_note_opens_at", false),
    timeField("closes_at", "$t:enamel_note_closes_at", false),
    divider("$t:enamel_div_notes", "divider_notes", "notes"),
    {
      field: "note",
      type: "string",
      meta: { interface: "input", width: "full", options: { placeholder: "$t:enamel_ph_hours_note" } },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
  ],
};

export const practitionerHours: Collection = {
  collection: "practitioner_hours",
  meta: {
    icon: "badge",
    note: "$t:enamel_note_practitioner_hours",
    display_template: "{{practitioner.first_name}} {{practitioner.last_name}} — {{weekday}}",
    sort: 3,
    group: "scheduling",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "practitioner",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half",
        options: { template: "{{first_name}} {{last_name}}" },
      },
      schema: { is_nullable: false },
    },
    weekday(),
    timeField("starts_at", "$t:enamel_note_session_start"),
    timeField("ends_at", "$t:enamel_note_session_end"),
    {
      /**
       * A session can name a chair. Many practices run a dentist in the
       * same surgery every Tuesday, and knowing that turns "find me a
       * slot" from a search across every chair into a first guess that is
       * usually right. Nullable, because plenty of practices float.
       */
      field: "room",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_usual_room",
        options: { template: "{{name}}" },
      },
      schema: {},
    },
    {
      field: "effective_from",
      type: "date",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_effective_from" },
      schema: {},
    },
    {
      field: "effective_to",
      type: "date",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_effective_to" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "practitioner_hours", field: "practitioner", related_collection: "directus_users", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "practitioner_hours", field: "room", related_collection: "rooms", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

export const absences: Collection = {
  collection: "absences",
  meta: {
    icon: "event_busy",
    note: "$t:enamel_note_absences",
    display_template: "{{kind}} — {{starts_at}}",
    sort: 4,
    group: "scheduling",
    archive_field: "status",
    archive_value: "cancelled",
    unarchive_value: "booked",
  },
  schema: {},
  fields: [
    pk(),
    {
      /**
       * Null means the whole practice. A bank holiday is not one person's
       * leave, and modelling it as a row per clinician would mean adding
       * one every time somebody joins — and quietly leaving the practice
       * open on Christmas Day for whoever nobody remembered.
       */
      field: "practitioner",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_absence_who",
        options: { template: "{{first_name}} {{last_name}}" },
      },
      schema: {},
    },
    {
      field: "kind",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        options: {
          choices: [
            { text: "$t:enamel_ab_annual_leave", value: "annual_leave", color: "#3399FF" },
            { text: "$t:enamel_ab_sick", value: "sick", color: "#E35169" },
            { text: "$t:enamel_ab_training", value: "training", color: "#A855F7" },
            { text: "$t:enamel_ab_parental", value: "parental", color: "#2ECDA7" },
            { text: "$t:enamel_ab_public_holiday", value: "public_holiday", color: "#FFC23B" },
            { text: "$t:enamel_ab_practice_closure", value: "practice_closure", color: "#7A8B99" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Timestamps, not dates, because half-days are the common case: an
       * afternoon off for a hospital appointment is the request a practice
       * actually receives, and a date-only model rounds it up to the whole
       * day and loses a morning's surgery time.
       */
      field: "starts_at",
      type: "timestamp",
      meta: { interface: "datetime", required: true, width: "half", display: "datetime" },
      schema: { is_nullable: false },
    },
    {
      field: "ends_at",
      type: "timestamp",
      meta: { interface: "datetime", required: true, width: "half", display: "datetime" },
      schema: { is_nullable: false },
    },
    {
      field: "status",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        display: "labels",
        options: {
          choices: [
            { text: "$t:enamel_abs_requested", value: "requested", color: "#FFC23B" },
            { text: "$t:enamel_abs_booked", value: "booked", color: "#2ECDA7" },
            { text: "$t:enamel_abs_cancelled", value: "cancelled", color: "#A2B5CD" },
          ],
        },
      },
      schema: { default_value: "booked", is_nullable: false },
    },
    divider("$t:enamel_div_notes", "divider_notes", "notes"),
    {
      field: "note",
      type: "string",
      meta: { interface: "input", width: "full" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "absences", field: "practitioner", related_collection: "directus_users", meta: {}, schema: { on_delete: "CASCADE" } },
  ],
};

export const roomClosures: Collection = {
  collection: "room_closures",
  meta: {
    icon: "build",
    note: "$t:enamel_note_room_closures",
    display_template: "{{room.name}} — {{reason}}",
    sort: 5,
    group: "scheduling",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "room",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half",
        options: { template: "{{name}}" },
      },
      schema: { is_nullable: false },
    },
    {
      field: "reason",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        options: {
          choices: [
            { text: "$t:enamel_rc_maintenance", value: "maintenance", color: "#FFC23B" },
            { text: "$t:enamel_rc_equipment_fault", value: "equipment_fault", color: "#E35169" },
            { text: "$t:enamel_rc_deep_clean", value: "deep_clean", color: "#2ECDA7" },
            { text: "$t:enamel_rc_refurbishment", value: "refurbishment", color: "#A855F7" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      field: "starts_at",
      type: "timestamp",
      meta: { interface: "datetime", required: true, width: "half", display: "datetime" },
      schema: { is_nullable: false },
    },
    {
      field: "ends_at",
      type: "timestamp",
      meta: { interface: "datetime", required: true, width: "half", display: "datetime" },
      schema: { is_nullable: false },
    },
    divider("$t:enamel_div_notes", "divider_notes", "notes"),
    {
      field: "note",
      type: "string",
      meta: { interface: "input", width: "full", options: { placeholder: "$t:enamel_ph_closure_reason" } },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "room_closures", field: "room", related_collection: "rooms", meta: {}, schema: { on_delete: "CASCADE" } },
  ],
};

export const availabilityCollections = [clinicHours, practitionerHours, absences, roomClosures];
