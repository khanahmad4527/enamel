import type { Collection } from "../types.js";
import { pk, timestamps, divider, status } from "./_helpers.js";

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
        // The custom viewer rather than the stock `file` interface. Same
        // stored value — a file uuid — so a practice that would rather
        // have the built-in one changes this line and loses nothing.
        interface: "radiograph-viewer",
        special: ["file"], required: true, width: "full",
        note: "$t:enamel_note_document_file",
        options: { invertByDefault: false },
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
    divider("$t:enamel_div_document_version", "divider_document_version", "history"),
    {
      /**
       * The document this one replaces.
       *
       * Retakes happen: a bitewing with the film clipped, a consent form
       * re-signed after the plan changed, a referral letter corrected.
       * The wrong way to handle that is to swap the file on the existing
       * row, which is a silent edit to a clinical record and leaves no
       * trace that the first version ever existed.
       *
       * So a retake is a *new* row pointing back at the one it replaces.
       * Both are kept, both stay readable, and "what did we have on the
       * 4th of March" is answerable a year later — which is the whole
       * point of a record.
       *
       * The chain is guarded in the database rather than here: a document
       * cannot supersede itself, cannot supersede one belonging to another
       * patient, and cannot be the second thing to supersede the same
       * document — see `enamel_document_supersedes`.
       */
      field: "supersedes",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o",
        special: ["m2o"],
        width: "half",
        note: "$t:enamel_note_supersedes",
        options: {
          template: "{{kind}} — {{taken_on}}",
          // Only this patient's documents, and only ones still current.
          // Offering the whole library here is how a radiograph ends up
          // pointing at somebody else's.
          filter: { superseded_by: { _null: true } },
        },
      },
      schema: {},
    },
    {
      /**
       * Set by the same trigger that guards the chain, not by hand.
       *
       * A boolean derived from "does anything point at me" could be a
       * view, and the reason it is a column is the list: Directus filters
       * and sorts on columns, and "show me current documents only" has to
       * work in the default view without a subquery every practice would
       * have to know to write.
       */
      field: "superseded_by",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o",
        special: ["m2o"],
        readonly: true,
        width: "half",
        note: "$t:enamel_note_doc_superseded_by",
        options: { template: "{{kind}} — {{taken_on}}" },
      },
      schema: {},
    },
    {
      /**
       * Why it was replaced.
       *
       * Required by the trigger whenever `supersedes` is set, because "a
       * newer one exists" is not a record of anything. A retake for
       * positioning and a retake because the first one was of the wrong
       * tooth are different facts, and only one of them is a complaint
       * waiting to happen.
       */
      field: "supersede_reason",
      type: "string",
      meta: {
        interface: "select-dropdown",
        width: "half",
        note: "$t:enamel_note_supersede_reason",
        display: "labels",
        options: {
          allowOther: true,
          choices: [
            { text: "$t:enamel_sup_retake", value: "retake" },
            { text: "$t:enamel_sup_quality", value: "quality" },
            { text: "$t:enamel_sup_wrong_site", value: "wrong_site" },
            { text: "$t:enamel_sup_corrected", value: "corrected" },
            { text: "$t:enamel_sup_resigned", value: "resigned" },
          ],
        },
      },
      schema: {},
    },
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
    {
      collection: "documents",
      field: "patient",
      related_collection: "patients",
      meta: { one_field: "documents" },
      schema: { on_delete: "CASCADE" },
    },
    {
      // A version chain inside one collection. RESTRICT rather than
      // CASCADE or SET NULL on purpose: deleting the document a retake
      // replaced would either take the retake with it, or quietly orphan
      // it — and both of those destroy the only evidence that a first
      // version existed. Refusing the delete is the correct answer, and
      // `status: archived` is what a practice actually wants.
      collection: "documents",
      field: "supersedes",
      related_collection: "documents",
      meta: { one_field: null },
      schema: { on_delete: "NO ACTION" },
    },
    {
      collection: "documents",
      field: "superseded_by",
      related_collection: "documents",
      meta: { one_field: null },
      schema: { on_delete: "SET NULL" },
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
