import type { Field } from "../types.js";
import { publicProfileFields } from "./website.js";

/**
 * Extra fields on `directus_users`, beyond what Directus ships.
 *
 * This used to be where multi-tenancy hung: a `clinic` column that every
 * policy filter compared against. The system serves one practice now, so
 * a row filter that asks "is this yours" has nothing left to answer —
 * what a user may see is decided by their role and their policy's field
 * list, which is where the interesting part always was.
 */
export const userFields: Field[] = [
  ...publicProfileFields,
  {
    /**
     * The bearer credential behind a clinician's calendar feed.
     *
     * A subscribed ICS URL is a bearer token by construction — no
     * calendar client will do an OAuth dance for a text file, so whatever
     * holds the URL reads the diary. What can be controlled is the blast
     * radius, and that is the whole reason this is a separate column
     * rather than a reuse of `directus_users.token`: the API token can
     * write clinical records, and a calendar URL must never be able to.
     *
     * Hidden and readable only by the owner and the practice owner. It is
     * minted on request by the core service and rotating it is one
     * UPDATE, which is what revoking a feed somebody pasted into the
     * wrong calendar looks like.
     */
    field: "calendar_token",
    type: "string",
    meta: {
      interface: "input",
      note: "$t:enamel_note_calendar_token",
      width: "half",
      group: null,
      hidden: true,
      readonly: true,
    },
    schema: { is_unique: true },
  },
  {
    field: "job_title",
    type: "string",
    meta: {
      interface: "select-dropdown",
      width: "half",
      note: "$t:enamel_note_job_title",
      options: {
        choices: [
          { text: "$t:enamel_jt_principal", value: "principal_dentist" },
          { text: "$t:enamel_jt_associate", value: "associate_dentist" },
          { text: "$t:enamel_jt_hygienist", value: "hygienist" },
          { text: "$t:enamel_jt_nurse", value: "nurse" },
          { text: "$t:enamel_jt_receptionist", value: "receptionist" },
          { text: "$t:enamel_jt_manager", value: "practice_manager" },
        ],
      },
    },
    schema: {},
  },
];

/**
 * Extra fields on `directus_files`.
 *
 * Files are a shared collection and Directus gives them no per-record
 * classification, so without a marker of its own any signed-in account
 * could fetch `/assets/<id>` for every radiograph in the building. That
 * was true before this served one practice and is still true now: the
 * boundary that matters here is clinical-versus-not, not whose it is.
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
    /**
     * A logo, an icon, a letterhead — a file a practice is happy to have
     * on the front of the building.
     *
     * It exists because `theme_logo` could not be rendered without it.
     * The Patient policy reads `directus_files` *through* the document
     * that references it — "you may read this file if a consent form of
     * yours points at it" — which is exactly right for clinical bytes and
     * gives a logo no path at all. A logo has no document, so
     * `/assets/<id>` answered 403 for every patient, and the field sat in
     * the schema unrendered.
     *
     * Widening the document filter would have been the wrong fix: the
     * whole point of that rule is that it is narrow. A second permission
     * on a separate flag is additive — Directus unions permissions on a
     * collection — so the clinical rule is untouched and the new one
     * grants exactly one thing.
     *
     * Deliberately **not** another value in `document_kind`. That column
     * mirrors a patient document's kind and is maintained by two flows
     * that copy it; putting a value in it that no document ever has would
     * make both of them lie. This is a different question about a
     * different kind of file.
     */
    field: "brand_asset",
    type: "boolean",
    meta: {
      interface: "boolean",
      width: "half",
      note: "$t:enamel_note_file_brand",
    },
    schema: { default_value: false },
  },
];
