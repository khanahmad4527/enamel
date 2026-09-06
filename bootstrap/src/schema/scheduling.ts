import type { Collection } from "../types.js";
import { pk, timestamps, status, clinicRef, divider } from "./_helpers.js";

export const appointments: Collection = {
  collection: "appointments",
  meta: {
    icon: "event",
    note: "The diary. Front desk owns this; clinicians read their own.",
    color: "#0D6E63",
    display_template: "{{starts_at}} — {{patient.last_name}}",
    sort: 2,
    group: "clinical",
    archive_field: "status",
    archive_value: "cancelled",
    unarchive_value: "scheduled",
  },
  fields: [
    pk(),
    clinicRef(),
    divider("$t:enamel_div_booking", "divider_booking", "event"),
    {
      field: "patient",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half",
        options: { template: "{{last_name}}, {{first_name}}" },
      },
      schema: { is_nullable: false },
    },
    {
      field: "practitioner",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half",
        options: { template: "{{first_name}} {{last_name}}" },
      },
      schema: { is_nullable: false },
    },
    {
      field: "room",
      type: "uuid",
      meta: { interface: "select-dropdown-m2o", special: ["m2o"], width: "half", options: { template: "{{name}}" } },
      schema: {},
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
    status(
      [
        { text: "$t:enamel_s_scheduled", value: "scheduled", color: "#6644FF" },
        { text: "$t:enamel_s_confirmed", value: "confirmed", color: "#2ECDA7" },
        { text: "$t:enamel_s_completed", value: "completed", color: "#0D6E63" },
        { text: "$t:enamel_s_cancelled", value: "cancelled", color: "#A2B5CD" },
        { text: "$t:enamel_s_no_show", value: "no_show", color: "#E35169" },
      ],
      "scheduled",
    ),
    {
      field: "reason",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        options: { allowOther: true, choices: [
          { text: "Check-up", value: "checkup" }, { text: "Hygiene", value: "hygiene" },
          { text: "Filling", value: "filling" }, { text: "Extraction", value: "extraction" },
          { text: "Root canal", value: "root_canal" }, { text: "Crown fit", value: "crown" },
          { text: "Emergency", value: "emergency" }, { text: "Consultation", value: "consultation" },
        ] },
      },
      schema: {},
    },
    divider("$t:enamel_div_reminders", "divider_reminders", "notifications"),
    {
      // A boolean, not a timestamp, and that is a platform constraint
      // rather than a preference: `$NOW` is interpolated in filters but
      // not in an operation payload, so a flow writing `$NOW` here sends
      // Postgres the literal string and the update fails. Nothing in a
      // flow can produce the current time without the script operation,
      // which this image does not run. `date_updated` records when.
      field: "reminder_sent",
      type: "boolean",
      meta: {
        interface: "boolean", readonly: true, width: "half",
        note: "$t:enamel_note_reminder",
      },
      schema: { default_value: false, is_nullable: false },
    },
    {
      field: "notes",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_appt_notes" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "appointments", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "appointments", field: "patient", related_collection: "patients", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "appointments", field: "practitioner", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "appointments", field: "room", related_collection: "rooms", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};
