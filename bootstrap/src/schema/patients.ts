import type { Collection } from "../types.js";
import { pk, timestamps, status, clinicRef, divider, EMAIL_RE } from "./_helpers.js";

/**
 * The field split here is the point of the whole project.
 *
 * Front-desk staff need `first_name`, `phone` and `email` to run a diary.
 * They have no business reading `medical_alerts`, `allergies` or
 * `clinical_notes`. In Directus that isn't two collections or a custom
 * API — it's the `fields` array on a permission. See access/policies.ts:
 * the receptionist policy lists contact fields explicitly and simply
 * never names the clinical ones.
 */
export const patients: Collection = {
  collection: "patients",
  meta: {
    icon: "person",
    note: "Patient records. Clinical fields are withheld from front-desk policies.",
    color: "#0D6E63",
    display_template: "{{last_name}}, {{first_name}}",
    sort: 1,
    group: "clinical",
    archive_field: "status",
    archive_value: "inactive",
    unarchive_value: "active",
  },
  fields: [
    pk(),
    clinicRef(),
    divider("$t:enamel_div_identity", "divider_identity", "badge"),
    {
      field: "first_name",
      type: "string",
      meta: { interface: "input", required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      field: "last_name",
      type: "string",
      meta: { interface: "input", required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      field: "date_of_birth",
      type: "date",
      meta: {
        interface: "datetime", width: "half",
        note: "$t:enamel_note_dob",
        validation: { date_of_birth: { _lte: "$NOW" } },
        validation_message: "$t:enamel_vm_dob_future",
      },
      schema: {},
    },
    {
      field: "reference",
      type: "string",
      meta: {
        interface: "input", width: "half", readonly: true,
        note: "$t:enamel_note_reference",
      },
      schema: { is_unique: true },
    },
    status(
      [
        { text: "$t:enamel_s_active", value: "active", color: "#2ECDA7" },
        { text: "$t:enamel_s_inactive", value: "inactive", color: "#A2B5CD" },
      ],
      "active",
    ),
    divider("$t:enamel_div_contact_fd", "divider_contact", "call"),
    {
      field: "email",
      type: "string",
      meta: {
        interface: "input", options: { iconLeft: "mail" }, width: "half",
        validation: { email: { _regex: EMAIL_RE } },
        validation_message: "$t:enamel_vm_email_example",
      },
      schema: {},
    },
    {
      field: "phone",
      type: "string",
      meta: {
        interface: "input", options: { iconLeft: "call" }, width: "half",
        // Digits, spaces and the usual separators; permissive enough for
        // every country the demo practices sit in.
        validation: { phone: { _regex: "^[+]?[0-9 ()./-]{6,24}$" } },
        validation_message: "$t:enamel_vm_phone",
      },
      schema: {},
    },
    { field: "address", type: "text", meta: { interface: "input-multiline" }, schema: {} },
    {
      field: "preferred_language",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        options: { choices: [
          { text: "English", value: "en" }, { text: "Nederlands", value: "nl" },
          { text: "Deutsch", value: "de" }, { text: "Português", value: "pt" },
          { text: "العربية", value: "ar" }, { text: "Türkçe", value: "tr" },
        ] },
      },
      schema: { default_value: "en" },
    },
    {
      field: "portal_user",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_portal_user",
        options: { template: "{{email}}" },
      },
      schema: {},
    },
    divider("$t:enamel_div_clinical", "divider_clinical", "medical_information"),
    {
      field: "medical_alerts",
      type: "text",
      meta: {
        interface: "input-multiline",
        note: "$t:enamel_note_medical_alerts",
        options: { placeholder: "Anticoagulant therapy, latex allergy, pacemaker…" },
      },
      schema: {},
    },
    {
      field: "allergies",
      type: "csv",
      meta: {
        interface: "tags", special: ["cast-csv"],
        options: { placeholder: "Add an allergy and press enter" },
      },
      schema: {},
    },
    {
      field: "clinical_notes",
      type: "text",
      meta: { interface: "input-rich-text-md", note: "Free-text clinical history." },
      schema: {},
    },
    divider("$t:enamel_div_chart", "divider_chart", "dentistry"),
    {
      // An alias holds no column: it renders the tooth_conditions log for
      // this patient through the custom interface. Front-desk policies
      // deny that collection, so the chart shows an access message rather
      // than leaking anything.
      field: "tooth_chart",
      type: "alias",
      meta: {
        interface: "tooth-chart",
        special: ["alias", "no-data"],
        note: "$t:enamel_note_tooth_chart",
      },
      schema: null,
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "patients", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "patients", field: "portal_user", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};
