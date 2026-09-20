import type { Collection } from "../types.js";
import { pk, timestamps } from "./_helpers.js";

/**
 * Who looked at what, and when.
 *
 * Directus already keeps a good activity log: creates, updates, deletes,
 * successful logins, flow runs — each with an IP, a user agent and an
 * origin. Permission changes are in there too, because editing a policy is
 * a write to `directus_permissions` like any other. None of that is
 * reinvented here.
 *
 * Two things are missing, and in a clinical system they are the two that
 * matter most.
 *
 *   Reads are not logged at all. Directus records zero of them, by
 *   design — the volume would be enormous and most applications do not
 *   care. A dental practice cares: "which of my staff opened this
 *   patient's record, and when" is the question an information governance
 *   review actually asks, and nothing in the platform could answer it.
 *
 *   Failed logins are not logged either. A successful login appears; four
 *   wrong passwords against a dentist's account at two in the morning
 *   leave no trace whatsoever.
 *
 * So this is a separate table rather than more rows in
 * `directus_activity`, for three reasons that are all about it being a
 * different kind of record:
 *
 *   Volume. Reads outnumber writes by orders of magnitude, and mixing
 *   them in would make the admin's activity view useless for the thing it
 *   is good at.
 *
 *   Immutability. `directus_activity` can be edited by an administrator.
 *   An audit log that the most powerful account can rewrite is not
 *   evidence of anything. A database trigger makes this one append-only —
 *   see `constraints.ts`.
 *
 *   Shape. This carries a `patient`, so the question above is one query
 *   rather than a join through whichever collection happened to be read.
 */
export const accessLog: Collection = {
  collection: "access_log",
  meta: {
    icon: "policy",
    note: "$t:enamel_note_access_log",
    display_template: "{{action}} — {{collection}}",
    sort: 1,
    group: "governance",
    // Nobody creates one of these by hand; the hook writes them.
    singleton: false,
    hidden: false,
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "user",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        readonly: true, note: "$t:enamel_note_log_user",
        options: { template: "{{first_name}} {{last_name}}" },
      },
      schema: {},
    },
    {
      /**
       * What was typed, when there is no user to point at.
       *
       * A failed login against an address that does not exist is the most
       * interesting row in this table and the only one with nobody to
       * attribute it to.
       */
      field: "attempted_email",
      type: "string",
      meta: { interface: "input", width: "half", readonly: true, note: "$t:enamel_note_attempted_email" },
      schema: {},
    },
    {
      field: "action",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half", readonly: true,
        options: {
          choices: [
            { text: "$t:enamel_al_read", value: "read", color: "#3399FF" },
            { text: "$t:enamel_al_export", value: "export", color: "#FFC23B" },
            { text: "$t:enamel_al_download", value: "download", color: "#A855F7" },
            { text: "$t:enamel_al_login", value: "login", color: "#2ECDA7" },
            { text: "$t:enamel_al_login_failed", value: "login_failed", color: "#E35169" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      field: "collection",
      type: "string",
      meta: { interface: "input", width: "half", readonly: true },
      schema: {},
    },
    {
      field: "item",
      type: "string",
      meta: { interface: "input", width: "half", readonly: true, note: "$t:enamel_note_log_item" },
      schema: {},
    },
    {
      /**
       * Whose record it was.
       *
       * The point of the table. Without it, "who has opened Mrs Okafor's
       * file this year" means reading every row, working out which
       * collection each one names, and joining differently for each —
       * which is the sort of query nobody runs, so the log goes unread.
       */
      field: "patient",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        readonly: true, note: "$t:enamel_note_log_patient",
        options: { template: "{{last_name}}, {{first_name}}" },
      },
      schema: {},
    },
    {
      field: "item_count",
      type: "integer",
      meta: { interface: "input", width: "half", readonly: true, note: "$t:enamel_note_item_count" },
      schema: { default_value: 0 },
    },
    {
      field: "ip",
      type: "string",
      meta: { interface: "input", width: "half", readonly: true, note: "$t:enamel_note_log_ip" },
      schema: {},
    },
    {
      field: "user_agent",
      type: "string",
      meta: { interface: "input", width: "full", readonly: true },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    // SET NULL, not CASCADE. Deleting a user must not delete the record of
    // what they looked at — that is the one deletion an audit log exists
    // to survive.
    { collection: "access_log", field: "user", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "access_log", field: "patient", related_collection: "patients", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

export const auditCollections = [accessLog];
