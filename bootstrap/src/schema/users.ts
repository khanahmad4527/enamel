import type { Field } from "../types.js";

/**
 * Multi-tenancy hangs off these two fields on `directus_users`.
 *
 * `clinic` is what every policy filter compares against
 * (`$CURRENT_USER.clinic`), so a user physically cannot read another
 * practice's rows — no application code involved, enforced by the API.
 */
export const userFields: Field[] = [
  {
    field: "clinic",
    type: "uuid",
    meta: {
      interface: "select-dropdown-m2o",
      special: ["m2o"],
      note: "$t:enamel_note_user_clinic",
      options: { template: "{{name}}" },
      width: "half",
      group: null,
    },
    schema: {},
  },
  {
    field: "job_title",
    type: "string",
    meta: {
      interface: "select-dropdown",
      width: "half",
      note: "Display only — access comes from the assigned role and policies.",
      options: {
        choices: [
          { text: "Principal dentist", value: "principal_dentist" },
          { text: "Associate dentist", value: "associate_dentist" },
          { text: "Dental hygienist", value: "hygienist" },
          { text: "Dental nurse", value: "nurse" },
          { text: "Receptionist", value: "receptionist" },
          { text: "Practice manager", value: "practice_manager" },
        ],
      },
    },
    schema: {},
  },
];

/**
 * `directus_files` gets the same tenant field, for the same reason.
 *
 * Files are a shared collection: without a boundary of its own, any
 * signed-in member of any practice could fetch `/assets/<id>` for every
 * radiograph in the instance. The field is nullable on purpose — the
 * brand kit has no practice, and every policy that reads files therefore
 * allows `clinic` null alongside the user's own.
 */
export const fileFields: Field[] = [
  {
    /**
     * The reverse side of documents.file.
     *
     * Directus materialises an o2m alias automatically on collections it
     * manages, and not on system ones — so `one_field: "documents"` on
     * the relation gave the permission engine a path to filter through,
     * while every query for the field returned "you don't have permission
     * to access field documents, or it does not exist". Declaring it here
     * is what makes `filter[documents][_none]` usable.
     */
    field: "documents",
    type: "alias",
    meta: {
      interface: "list-o2m",
      special: ["o2m"],
      readonly: true,
      note: "$t:enamel_note_file_documents",
      options: { template: "{{patient.first_name}} {{patient.last_name}} — {{kind}}" },
    },
    schema: null,
  },
  {
    /**
     * Whether the bytes behind this file are clinical.
     *
     * The obvious design was to filter reception's file access through
     * the document that points at it — "you may read this file unless a
     * radiograph record references it". It does not work, and the reason
     * is worth knowing: a relational filter inside a *permission* is
     * evaluated with the caller's own visibility. Reception cannot see
     * radiograph documents, so "no radiograph document points at this
     * file" is true for them about every file in the building. The rule
     * could never exclude the thing it existed to exclude.
     *
     * So the marker lives on the file itself, where the filter needs no
     * subquery. It stores the document's `kind` rather than a boolean,
     * because a flow can copy a value and cannot evaluate a condition —
     * there is no arithmetic and no branching without the script
     * operation, which this image does not run. Two flows maintain it.
     *
     * It is null until classified, which is a trade: a file is
     * visible in the seconds between upload and the document row that
     * classifies it. Defaulting to closed would shut reception out of
     * avatars, the brand kit and their own uploads-in-progress. A
     * deployment holding real patient images should flip that default and
     * accept the friction.
     */
    field: "document_kind",
    type: "string",
    meta: {
      interface: "input",
      readonly: true,
      width: "half",
      note: "$t:enamel_note_file_clinical",
    },
    schema: {},
  },
  {
    field: "clinic",
    type: "uuid",
    meta: {
      interface: "select-dropdown-m2o",
      special: ["m2o"],
      note: "$t:enamel_note_file_clinic",
      options: { template: "{{name}}" },
      width: "half",
      readonly: true,
    },
    schema: {},
  },
];
