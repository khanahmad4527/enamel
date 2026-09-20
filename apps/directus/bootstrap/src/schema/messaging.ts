import type { Collection, Field } from "../types.js";
import { pk, timestamps, divider } from "./_helpers.js";

/**
 * Everything the practice has said to a patient, and everything back.
 *
 * A log, not a queue. The queue is BullMQ in the core service and it is
 * the right tool for *delivering*; this is the record a receptionist opens
 * when a patient says "nobody told me". Those are different jobs and
 * conflating them is how you end up with a system that can retry a text
 * message but cannot tell you whether one was ever sent.
 *
 * It is also the authority on what has been sent, rather than a flag per
 * message type on each parent. "Has this appointment been confirmed" is
 * `NOT EXISTS (SELECT 1 FROM messages WHERE appointment = ... AND kind =
 * 'confirmation')` — which needs no new column when a sixth kind of
 * message is added, and cannot drift from the thing it describes.
 *
 * `appointments.reminder_sent` predates this and is kept in step, because
 * the diary reads it and a bookmark filters on it. The log is what to
 * trust if they ever disagree.
 */
export const messages: Collection = {
  collection: "messages",
  meta: {
    icon: "forum",
    note: "$t:enamel_note_messages",
    display_template: "{{direction}} {{channel}} — {{patient.last_name}}",
    sort: 1,
    group: "clinical",
    archive_field: "status",
    archive_value: "archived",
    unarchive_value: "received",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "patient",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_message_patient",
        options: { template: "{{last_name}}, {{first_name}}" },
      },
      schema: {},
    },
    {
      /**
       * Which way it went.
       *
       * One table rather than two, because a conversation is a single
       * thread and splitting it means the inbox has to union two
       * collections to show one exchange in order.
       */
      field: "direction",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        options: {
          choices: [
            { text: "$t:enamel_dir_outbound", value: "outbound", color: "#3399FF" },
            { text: "$t:enamel_dir_inbound", value: "inbound", color: "#2ECDA7" },
          ],
        },
      },
      schema: { default_value: "outbound", is_nullable: false },
    },
    {
      field: "channel",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        options: {
          choices: [
            { text: "$t:enamel_ch_email", value: "email", color: "#3399FF" },
            { text: "$t:enamel_ch_sms", value: "sms", color: "#FFC23B" },
            { text: "$t:enamel_ch_whatsapp", value: "whatsapp", color: "#2ECDA7" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      field: "kind",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_message_kind",
        options: {
          choices: [
            { text: "$t:enamel_mk_reminder", value: "reminder", color: "#3399FF" },
            { text: "$t:enamel_mk_confirmation", value: "confirmation", color: "#2ECDA7" },
            { text: "$t:enamel_mk_cancellation", value: "cancellation", color: "#A2B5CD" },
            { text: "$t:enamel_mk_recall", value: "recall", color: "#A855F7" },
            { text: "$t:enamel_mk_payment", value: "payment", color: "#B4762A" },
            { text: "$t:enamel_mk_reply", value: "reply", color: "#2ECDA7" },
            { text: "$t:enamel_mk_manual", value: "manual", color: "#7A8B99" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      field: "status",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        display: "labels",
        note: "$t:enamel_note_message_status",
        options: {
          choices: [
            { text: "$t:enamel_ms_queued", value: "queued", color: "#7A8B99" },
            { text: "$t:enamel_ms_sent", value: "sent", color: "#3399FF" },
            { text: "$t:enamel_ms_delivered", value: "delivered", color: "#2ECDA7" },
            { text: "$t:enamel_ms_failed", value: "failed", color: "#E35169" },
            { text: "$t:enamel_ms_received", value: "received", color: "#2ECDA7" },
            { text: "$t:enamel_ms_suppressed", value: "suppressed", color: "#FFC23B" },
            { text: "$t:enamel_ms_archived", value: "archived", color: "#A2B5CD" },
          ],
        },
      },
      schema: { default_value: "queued", is_nullable: false },
    },
    {
      field: "address",
      type: "string",
      meta: {
        interface: "input", width: "half", readonly: true,
        note: "$t:enamel_note_message_address",
      },
      schema: {},
    },
    {
      field: "subject",
      type: "string",
      meta: { interface: "input", width: "full", note: "$t:enamel_note_message_subject" },
      schema: {},
    },
    {
      field: "body",
      type: "text",
      meta: { interface: "input-multiline", required: true, width: "full" },
      schema: { is_nullable: false },
    },
    divider("$t:enamel_div_delivery", "divider_delivery", "send"),
    {
      field: "attempts",
      type: "integer",
      meta: { interface: "input", width: "half", readonly: true },
      schema: { default_value: 0 },
    },
    {
      /**
       * Why it did not arrive, in the provider's words.
       *
       * The whole point of the status above being real rather than
       * optimistic. A row that says `failed` and cannot say why is only
       * marginally better than one that lies and says `sent`.
       */
      field: "failure_reason",
      type: "text",
      meta: { interface: "input-multiline", width: "full", readonly: true },
      schema: {},
    },
    {
      field: "provider_id",
      type: "string",
      meta: {
        interface: "input", width: "half", readonly: true,
        note: "$t:enamel_note_provider_id",
      },
      schema: {},
    },
    {
      field: "sent_at",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", readonly: true, display: "datetime" },
      schema: {},
    },
    divider("$t:enamel_div_about", "divider_about", "link"),
    ...(["appointment", "invoice", "recall"] as const).map<Field>((field) => ({
      /**
       * What the message was about.
       *
       * Nullable and mutually exclusive in practice: a reminder has an
       * appointment, a payment chase has an invoice. Kept as three columns
       * rather than a polymorphic pair because a foreign key that actually
       * constrains is worth more than the tidiness of one fewer column.
       */
      field,
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half", readonly: true,
        options: {
          template:
            field === "invoice" ? "{{number}}" : "{{patient.last_name}} — {{starts_at}}",
        },
      },
      schema: {},
    })),
    ...timestamps(),
  ],
  relations: [
    { collection: "messages", field: "patient", related_collection: "patients", meta: {}, schema: { on_delete: "CASCADE" } },
    // SET NULL rather than CASCADE: deleting an appointment must not erase
    // the record that the practice told somebody about it.
    { collection: "messages", field: "appointment", related_collection: "appointments", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "messages", field: "invoice", related_collection: "invoices", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "messages", field: "recall", related_collection: "recalls", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

/**
 * Consent, per channel.
 *
 * Added to `patients` rather than kept in a preferences table because it
 * has to be impossible to miss: anything that sends has to read it, and a
 * separate table is a join somebody forgets. Texting a patient who asked
 * you not to is not a missing feature, it is a complaint to the ICO.
 *
 * Email defaults on and the rest default off, which is the conservative
 * reading: a practice has an email address because the patient gave it for
 * correspondence, and having a mobile number is not consent to be texted.
 */
export const patientConsentFields: Field[] = [
  divider("$t:enamel_div_contact_consent", "divider_consent", "mark_email_read"),
  {
    field: "allow_email",
    type: "boolean",
    meta: { interface: "boolean", width: "half", note: "$t:enamel_note_allow_email" },
    schema: { default_value: true, is_nullable: false },
  },
  {
    field: "allow_sms",
    type: "boolean",
    meta: { interface: "boolean", width: "half", note: "$t:enamel_note_allow_sms" },
    schema: { default_value: false, is_nullable: false },
  },
  {
    field: "allow_whatsapp",
    type: "boolean",
    meta: { interface: "boolean", width: "half", note: "$t:enamel_note_allow_whatsapp" },
    schema: { default_value: false, is_nullable: false },
  },
];

export const messagingCollections = [messages];
