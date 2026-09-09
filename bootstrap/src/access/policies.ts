import type { Policy, Permission } from "../types.js";

/**
 * Access model.
 *
 * Directus 11 splits roles from policies: a policy is the bundle of
 * permissions, a role is a bag of policies. That separation is what lets
 * "everyone in a practice is scoped to that practice" live in one place
 * instead of being copied into every role.
 *
 * Two rules run through everything below:
 *
 *   1. Tenancy. Every filter carries `clinic = $CURRENT_USER.clinic`, so
 *      cross-practice reads are impossible at the API layer. No
 *      application code can forget it.
 *
 *   2. Least privilege by field, not by collection. Reception needs the
 *      patient list to run a diary, so denying `patients` outright breaks
 *      the practice. Instead the receptionist policy names the contact
 *      fields it may touch and never names the clinical ones — see
 *      FRONT_DESK_PATIENT_FIELDS.
 */

/** Rows belonging to the signed-in user's practice. */
const ownClinic = { clinic: { _eq: "$CURRENT_USER.clinic" } };

/** Rows for the signed-in user's own patient record (portal). */
const ownPatientRecord = { portal_user: { _eq: "$CURRENT_USER" } };
const ownPatientChild = { patient: { portal_user: { _eq: "$CURRENT_USER" } } };

/**
 * Everything front-desk staff may see on a patient. `medical_alerts`,
 * `allergies` and `clinical_notes` are deliberately absent — that
 * omission is the entire access-control story of this project.
 */
const FRONT_DESK_PATIENT_FIELDS = [
  "id", "clinic", "reference", "status",
  "first_name", "last_name", "date_of_birth",
  "email", "phone", "address", "preferred_language",
  "date_created", "date_updated",
];

const ALL = ["*"];

/**
 * Which document kinds reception may touch.
 *
 * The same argument as FRONT_DESK_PATIENT_FIELDS, one level up: a
 * receptionist files referral letters and chases signed consent, and has
 * no business opening a radiograph. Splitting by `kind` rather than by
 * collection keeps the diary working and the images closed.
 */
const ADMIN_DOCUMENT_KINDS = ["referral", "consent", "correspondence"];

/**
 * Files the signed-in user may see: their own practice's, plus the ones
 * belonging to no practice — the brand kit, which the admin shell loads
 * for everybody. Without the null arm, staff get a broken logo.
 */
const ownClinicOrShared = {
  _or: [{ clinic: { _eq: "$CURRENT_USER.clinic" } }, { clinic: { _null: true } }],
};

/**
 * `directus_files` is a shared collection with a public asset endpoint,
 * so the tenant boundary has to be on it directly. Reading a document row
 * gets you a uuid; reading the file gets you the x-ray.
 */
const CLINICAL_DOCUMENT_KINDS = ["radiograph", "photograph", "lab_report"];

/**
 * The baseline file read, and the thing this whole module got wrong at
 * first: hiding the *document row* from reception hid the metadata and
 * not the bytes. `/assets/<uuid>` answers on `directus_files` alone, so
 * a receptionist who could not see a radiograph in the list could still
 * open it by URL. The verify suite caught it; nothing else would have.
 *
 * The marker is a plain boolean on the file, not a filter through the
 * document that references it: a relational filter inside a permission is
 * evaluated with the caller's own visibility, so "no radiograph document
 * points at this file" was true for reception about every file in the
 * building. See directus_files.clinical for the whole story.
 */
const nonClinicalFiles = {
  _and: [
    ownClinicOrShared,
    {
      // `_nin` alone would also exclude every unclassified file, because
      // SQL's NOT IN is null-hostile — and that is the brand kit, every
      // avatar and every upload that is not a patient document.
      _or: [
        { document_kind: { _null: true } },
        { document_kind: { _nin: CLINICAL_DOCUMENT_KINDS } },
      ],
    },
  ],
};

const fileAccess: Permission[] = [
  { collection: "directus_files", action: "read", permissions: nonClinicalFiles, fields: ALL },
  {
    collection: "directus_files",
    action: "create",
    permissions: {},
    fields: ALL,
    // The upload endpoint never sends `clinic`, so the preset is what
    // stamps it. A user physically cannot upload into another practice.
    presets: { clinic: "$CURRENT_USER.clinic" },
  },
  {
    collection: "directus_files",
    action: "update",
    permissions: { clinic: { _eq: "$CURRENT_USER.clinic" } },
    fields: ["title", "description", "tags", "folder", "location"],
  },
  // Folder names are navigation, not data. Without read here the file
  // library renders as a flat, unusable list.
  { collection: "directus_folders", action: "read", permissions: {}, fields: ALL },
];

/** Read/write a collection, scoped to the user's practice. */
function crud(
  collection: string,
  actions: Permission["action"][],
  fields: string[] = ALL,
  extra: Record<string, unknown> = {},
): Permission[] {
  return actions.map((action) => ({
    collection,
    action,
    permissions: { ...ownClinic, ...extra },
    fields,
    // Anything created is stamped with the creator's practice, so a user
    // cannot plant a row in someone else's tenant.
    presets: action === "create" ? { clinic: "$CURRENT_USER.clinic" } : null,
  }));
}

function readOnly(collection: string, fields: string[] = ALL, extra = {}): Permission[] {
  return [{ collection, action: "read", permissions: { ...ownClinic, ...extra }, fields }];
}

/* ---------------------------------------------------------------- */

const clinicScoped: Policy = {
  name: "Clinic member",
  icon: "domain",
  description:
    "Baseline every staff policy is paired with: read your own practice, read colleagues, nothing else.",
  app_access: true,
  permissions: [
    { collection: "clinics", action: "read", permissions: { id: { _eq: "$CURRENT_USER.clinic" } }, fields: ALL },
    ...readOnly("rooms"),
    {
      collection: "directus_users",
      action: "read",
      permissions: { clinic: { _eq: "$CURRENT_USER.clinic" } },
      fields: ["id", "first_name", "last_name", "email", "avatar", "job_title", "clinic", "status"],
    },
    ...fileAccess,
  ],
};

const receptionist: Policy = {
  name: "Front desk",
  icon: "support_agent",
  description:
    "Runs the diary and billing. Sees patient contact details; cannot read medical alerts, allergies or clinical notes, and cannot see treatment records or the tooth chart at all.",
  app_access: true,
  permissions: [
    ...crud("patients", ["create", "read", "update"], FRONT_DESK_PATIENT_FIELDS),
    ...crud("appointments", ["create", "read", "update", "delete"]),
    ...crud("invoices", ["create", "read", "update"]),
    ...crud("invoice_lines", ["create", "read", "update", "delete"]),
    ...readOnly("treatments", ["id", "clinic", "code", "name", "category", "duration_minutes", "default_price", "active"]),
    ...crud("documents", ["create", "read", "update"], ALL, {
      kind: { _in: ADMIN_DOCUMENT_KINDS },
    }),
    // Reception owns the chase — booking, contacting, marking a status —
    // so this is the one clinical-adjacent collection they write freely.
    // Setting the interval is a clinical decision, but recording that the
    // patient was rung is not.
    ...crud("recalls", ["create", "read", "update"]),
    ...readOnly("recall_types"),
    ...readOnly("recall_statuses"),
    // Read-only on purpose. Reception quotes from a plan and books the
    // procedures on it; proposing treatment is a clinical act.
    ...readOnly("treatment_plans"),
    ...readOnly("treatment_plan_items"),
    // Reception sees THAT a patient has an active allergy — they book and
    // greet, and a penicillin allergy on the day list is safety, not
    // clinical detail. They do not get the note, the severity or anything
    // in the history.
    ...readOnly("patient_findings", ["id", "clinic", "patient", "category", "label", "status"], {
      status: { _eq: "active" },
    }),
    // No clinical_notes. No medical_histories. No consents. Deliberate.
    // No treatment_records. No tooth_conditions. No radiographs. Deliberate.
  ],
};

const hygienist: Policy = {
  name: "Hygienist",
  icon: "cleaning_services",
  description:
    "Full clinical read and write on their own work. No billing whatsoever — cannot read invoices.",
  app_access: true,
  permissions: [
    ...crud("patients", ["read", "update"]),
    ...readOnly("appointments"),
    ...crud("treatment_records", ["create", "read", "update"], ALL, {
      practitioner: { _eq: "$CURRENT_USER" },
    }),
    ...crud("tooth_conditions", ["create", "read", "update"]),
    ...crud("dentition", ["create", "read", "update"]),
    ...crud("recalls", ["create", "read", "update"]),
    ...crud("treatment_plans", ["create", "read", "update"]),
    ...crud("treatment_plan_items", ["create", "read", "update"]),
    ...crud("clinical_notes", ["create", "read"]),
    ...crud("medical_histories", ["create", "read"]),
    ...crud("patient_findings", ["create", "read", "update"]),
    ...crud("consents", ["create", "read"]),
    ...readOnly("recall_types"),
    ...readOnly("recall_statuses"),
    // Directus unions permissions across the policies on a role, so this
    // widens the Clinic member baseline rather than replacing it: a
    // clinician reads every file in their practice, radiographs included.
    { collection: "directus_files", action: "read", permissions: ownClinicOrShared, fields: ALL },
    ...crud("documents", ["create", "read"]),
    ...readOnly("treatments"),
    // No invoices, no invoice_lines.
  ],
};

const dentist: Policy = {
  name: "Dentist",
  icon: "medical_services",
  description:
    "Full clinical access across the practice, plus read-only visibility of billing so they can answer a patient's question without being able to alter an invoice.",
  app_access: true,
  permissions: [
    ...crud("patients", ["create", "read", "update"]),
    ...crud("appointments", ["create", "read", "update"]),
    ...crud("treatment_records", ["create", "read", "update", "delete"]),
    ...crud("tooth_conditions", ["create", "read", "update", "delete"]),
    ...crud("dentition", ["create", "read", "update", "delete"]),
    ...crud("recalls", ["create", "read", "update", "delete"]),
    ...crud("treatment_plans", ["create", "read", "update", "delete"]),
    ...crud("treatment_plan_items", ["create", "read", "update", "delete"]),
    // Create and read, never update or delete. An append-only record is
    // append-only because nothing can rewrite it, not because everyone
    // agrees not to — so no policy grants update on notes, histories or
    // consents, including the practice owner's.
    ...crud("clinical_notes", ["create", "read"]),
    ...crud("medical_histories", ["create", "read"]),
    ...crud("patient_findings", ["create", "read", "update", "delete"]),
    ...crud("consents", ["create", "read"]),
    ...readOnly("recall_types"),
    ...readOnly("recall_statuses"),
    // Directus unions permissions across the policies on a role, so this
    // widens the Clinic member baseline rather than replacing it: a
    // clinician reads every file in their practice, radiographs included.
    { collection: "directus_files", action: "read", permissions: ownClinicOrShared, fields: ALL },
    ...crud("documents", ["create", "read", "update", "delete"]),
    ...crud("treatments", ["create", "read", "update"]),
    ...readOnly("invoices"),
    ...readOnly("invoice_lines"),
  ],
};

const practiceOwner: Policy = {
  name: "Practice owner",
  icon: "admin_panel_settings",
  description:
    "Everything inside their own practice, including staff administration — but still tenant-scoped, so an owner cannot see another practice.",
  app_access: true,
  permissions: [
    { collection: "clinics", action: "update", permissions: { id: { _eq: "$CURRENT_USER.clinic" } }, fields: ALL },
    ...crud("rooms", ["create", "read", "update", "delete"]),
    ...crud("patients", ["create", "read", "update", "delete"]),
    ...crud("appointments", ["create", "read", "update", "delete"]),
    ...crud("treatments", ["create", "read", "update", "delete"]),
    ...crud("treatment_records", ["create", "read", "update", "delete"]),
    ...crud("tooth_conditions", ["create", "read", "update", "delete"]),
    ...crud("dentition", ["create", "read", "update", "delete"]),
    ...crud("recalls", ["create", "read", "update", "delete"]),
    ...crud("treatment_plans", ["create", "read", "update", "delete"]),
    ...crud("treatment_plan_items", ["create", "read", "update", "delete"]),
    // Create and read, never update or delete. An append-only record is
    // append-only because nothing can rewrite it, not because everyone
    // agrees not to — so no policy grants update on notes, histories or
    // consents, including the practice owner's.
    ...crud("clinical_notes", ["create", "read"]),
    ...crud("medical_histories", ["create", "read"]),
    ...crud("patient_findings", ["create", "read", "update", "delete"]),
    ...crud("consents", ["create", "read"]),
    ...readOnly("recall_types"),
    ...readOnly("recall_statuses"),
    // Directus unions permissions across the policies on a role, so this
    // widens the Clinic member baseline rather than replacing it: a
    // clinician reads every file in their practice, radiographs included.
    { collection: "directus_files", action: "read", permissions: ownClinicOrShared, fields: ALL },
    ...crud("documents", ["create", "read", "update", "delete"]),
    ...crud("invoices", ["create", "read", "update", "delete"]),
    ...crud("invoice_lines", ["create", "read", "update", "delete"]),
    {
      collection: "directus_users",
      action: "update",
      permissions: { clinic: { _eq: "$CURRENT_USER.clinic" } },
      fields: ["first_name", "last_name", "email", "job_title", "status", "avatar"],
    },
  ],
};

/**
 * Patients get API access but not the admin app (`app_access: false`),
 * and every filter walks back to their own linked record.
 */
const patientPortal: Policy = {
  name: "Patient portal",
  icon: "account_circle",
  description:
    "API-only. A patient sees their own appointments, chart and invoices — never another patient's, never clinical free-text notes.",
  app_access: false,
  permissions: [
    {
      collection: "patients",
      action: "read",
      permissions: ownPatientRecord,
      fields: ["id", "reference", "first_name", "last_name", "date_of_birth", "email", "phone", "address", "preferred_language"],
    },
    {
      collection: "patients",
      action: "update",
      permissions: ownPatientRecord,
      fields: ["email", "phone", "address", "preferred_language"],
    },
    {
      collection: "appointments",
      action: "read",
      permissions: ownPatientChild,
      fields: ["id", "starts_at", "ends_at", "status", "reason", "practitioner", "room"],
    },
    {
      collection: "tooth_conditions",
      action: "read",
      permissions: ownPatientChild,
      fields: ["id", "tooth", "surface", "condition", "recorded_at"],
    },
    {
      collection: "consents",
      action: "read",
      permissions: ownPatientChild,
      fields: ["id", "title", "risks_discussed", "alternatives_discussed", "signed_on"],
    },
    {
      collection: "medical_histories",
      action: "read",
      permissions: ownPatientChild,
      fields: ["id", "taken_on", "pregnant", "smoker", "anticoagulants", "signed_on"],
    },
    {
      collection: "treatment_plans",
      action: "read",
      permissions: { _and: [ownPatientChild, { status: { _neq: "inactive" } }] },
      fields: ["id", "title", "status", "presented_on", "presented_total", "accepted_on", "accepted_total", "signed_on"],
    },
    {
      collection: "treatment_plan_items",
      action: "read",
      permissions: { plan: { patient: { portal_user: { _eq: "$CURRENT_USER" } } } },
      fields: ["id", "plan", "treatment", "tooth", "priority", "fee_presented", "status"],
    },
    {
      collection: "recalls",
      action: "read",
      permissions: ownPatientChild,
      fields: ["id", "recall_type", "interval_months", "date_due", "date_scheduled"],
    },
    {
      collection: "dentition",
      action: "read",
      permissions: ownPatientChild,
      fields: ["id", "designation", "dentition_type", "state", "absence_reason", "retained", "assessed_on"],
    },
    {
      collection: "documents",
      action: "read",
      permissions: { _and: [ownPatientChild, { kind: { _in: ["consent", "correspondence"] } }] },
      fields: ["id", "kind", "taken_on", "note", "file", "date_created"],
    },
    {
      // The row above hands out a file uuid; this is what decides whether
      // /assets/<uuid> answers. It walks back through the document to the
      // patient — so a patient reaches the bytes of their own consent
      // form and of nothing else, not another patient's, and not a
      // radiograph of their own that they were never granted.
      collection: "directus_files",
      action: "read",
      permissions: {
        documents: {
          _and: [ownPatientChild, { kind: { _in: ["consent", "correspondence"] } }],
        },
      },
      fields: ["id", "title", "type", "filesize", "uploaded_on"],
    },
    {
      collection: "invoices",
      action: "read",
      permissions: ownPatientRecord.portal_user
        ? { patient: { portal_user: { _eq: "$CURRENT_USER" } } }
        : {},
      fields: ["id", "number", "status", "issued_at", "due_at", "total", "pdf"],
    },
  ],
};

export const policies: Policy[] = [
  clinicScoped,
  receptionist,
  hygienist,
  dentist,
  practiceOwner,
  patientPortal,
];

export { FRONT_DESK_PATIENT_FIELDS };
