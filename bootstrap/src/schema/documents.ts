import type { Collection } from "../types.js";
import { pk, clinicRef, timestamps, divider, status } from "./_helpers.js";

/**
 * Patient documents: radiographs, referral letters, signed consent, lab
 * reports, clinical photographs.
 *
 * This is the reason `directus_files` needed a tenant boundary of its
 * own. A row here is metadata — who the file belongs to, what it is,
 * when it was taken — but the bytes live in the file library, and
 * `/assets/<id>` will serve them to anybody with read on
 * `directus_files`. Scoping this collection and leaving that one open
 * would be a permission model with a hole in the shape of every x-ray in
 * the building.
 */
export const documents: Collection = {
  collection: "documents",
  meta: {
    icon: "attach_file",
    note: "$t:enamel_note_documents",
    display_template: "{{patient.first_name}} {{patient.last_name}} — {{kind}}",
    sort: 8,
    group: "clinical",
    archive_field: "status",
    archive_value: "archived",
    unarchive_value: "active",
    sort_field: "sort",
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
        options: { template: "{{first_name}} {{last_name}} ({{reference}})" },
        width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "file",
      type: "uuid",
      meta: {
        interface: "file", special: ["file"], required: true, width: "half",
        note: "$t:enamel_note_document_file",
      },
      schema: { is_nullable: false },
    },
    {
      field: "kind",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half", required: true,
        display: "labels",
        display_options: {
          showAsDot: true,
          choices: [
            { text: "$t:enamel_doc_radiograph", value: "radiograph", color: "#0D6E63" },
            { text: "$t:enamel_doc_photograph", value: "photograph", color: "#6FD8C8" },
            { text: "$t:enamel_doc_referral", value: "referral", color: "#3399FF" },
            { text: "$t:enamel_doc_consent", value: "consent", color: "#B4762A" },
            { text: "$t:enamel_doc_lab_report", value: "lab_report", color: "#A2B5CD" },
            { text: "$t:enamel_doc_correspondence", value: "correspondence", color: "#8866FF" },
          ],
        },
        options: {
          choices: [
            { text: "$t:enamel_doc_radiograph", value: "radiograph" },
            { text: "$t:enamel_doc_photograph", value: "photograph" },
            { text: "$t:enamel_doc_referral", value: "referral" },
            { text: "$t:enamel_doc_consent", value: "consent" },
            { text: "$t:enamel_doc_lab_report", value: "lab_report" },
            { text: "$t:enamel_doc_correspondence", value: "correspondence" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      // Not date_created: a radiograph taken in 2019 and scanned in today
      // is dated 2019, and a clinician comparing bone levels needs the
      // date the image was captured, not the date somebody uploaded it.
      field: "taken_on",
      type: "date",
      meta: {
        interface: "datetime", width: "half",
        note: "$t:enamel_note_taken_on",
        validation: { taken_on: { _lte: "$NOW" } },
        validation_message: "$t:enamel_vm_doc_future",
      },
      schema: {},
    },
    status(
      [
        { text: "$t:enamel_s_active", value: "active", color: "#2ECDA7" },
        { text: "$t:enamel_s_archived", value: "archived", color: "#A2B5CD" },
      ],
      "active",
    ),
    divider("$t:enamel_div_document_detail", "divider_document_detail", "description"),
    {
      field: "note",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_document_note" },
      schema: {},
    },
    { field: "sort", type: "integer", meta: { interface: "input", hidden: true }, schema: {} },
    ...timestamps(),
  ],
  relations: [
    { collection: "documents", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "documents",
      field: "patient",
      related_collection: "patients",
      meta: { one_field: "documents" },
      schema: { on_delete: "CASCADE" },
    },
    {
      // SET NULL rather than CASCADE: deleting the row that describes a
      // radiograph should not silently delete the radiograph, and
      // deleting the file should leave the record of it having existed.
      collection: "documents",
      field: "file",
      related_collection: "directus_files",
      // Named, because the patient-portal file permission filters
      // `directus_files` *through* it — "you may read this file if a
      // document pointing at it belongs to you". Without one_field there
      // is no path from a file back to the patient.
      meta: { one_field: "documents" },
      schema: { on_delete: "SET NULL" },
    },
  ],
};
