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
    // No treatment_records. No tooth_conditions. Deliberate.
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
      fields: ["id", "tooth_fdi", "surface", "condition", "recorded_at"],
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
