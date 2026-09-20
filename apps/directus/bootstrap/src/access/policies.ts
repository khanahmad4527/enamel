import type { Policy, Permission } from "../types.js";

/**
 * Access model.
 *
 * Directus 11 splits roles from policies: a policy is the bundle of
 * permissions, a role is a bag of policies. That separation is what lets
 * live in one place instead of being copied into every role.
 *
 * One rule runs through everything below — and it used to be two. The
 * first was tenancy: every filter carried `clinic = $CURRENT_USER.clinic`
 * so cross-practice reads were impossible at the API layer. The product
 * serves one practice now and that rule has nothing left to say.
 *
 * What remains is the one that was always doing the interesting work:
 *
 *   Least privilege by field, not by collection. Reception needs the
 *      patient list to run a diary, so denying `patients` outright breaks
 *      the practice. Instead the receptionist policy names the contact
 *      fields it may touch and never names the clinical ones — see
 *      FRONT_DESK_PATIENT_FIELDS.
 */

/*
 * There used to be an `ownClinic` filter here — `clinic =
 * $CURRENT_USER.clinic` — spread into every rule, and it was the first
 * of the two things this file did. It is gone with multi-tenancy: the
 * system serves one practice, so "is this row yours" has no second
 * answer. What survives is the half that was always more interesting —
 * which *fields* a role may touch, and the collections it may not reach
 * at all.
 */

/** Rows for the signed-in user's own patient record (portal). */
const ownPatientRecord = { portal_user: { _eq: "$CURRENT_USER" } };
const ownPatientChild = { patient: { portal_user: { _eq: "$CURRENT_USER" } } };

/**
 * Everything front-desk staff may see on a patient. `medical_alerts`,
 * `allergies` and `clinical_notes` are deliberately absent — that
 * omission is the entire access-control story of this project.
 */
const FRONT_DESK_PATIENT_FIELDS = [
  "id", "reference", "status",
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
    presets: null,
  },
  {
    collection: "directus_files",
    action: "update",
    permissions: {},
    fields: ["title", "description", "tags", "folder", "location"],
  },
  // Folder names are navigation, not data. Without read here the file
  // library renders as a flat, unusable list.
  { collection: "directus_folders", action: "read", permissions: {}, fields: ALL },
];

/**
 * Read/write a collection, scoped to the user's practice.
 *
 * `extra` narrows it further — "only your own treatment records", "only
 * the document kinds reception handles" — and where it lands depends on
 * the action, which is the part that is easy to get wrong and was.
 *
 * On read, update and delete it is a `permissions` filter: it decides
 * which existing rows the action may touch. On **create** there is no
 * existing row to filter, and Directus ignores `permissions` entirely for
 * that action — so `extra` has to be `validation`, which is checked
 * against the payload instead.
 *
 * Written the obvious way, with `extra` in `permissions` for everything,
 * both of this file's uses of it silently did nothing on create: a
 * receptionist could file a radiograph, and a hygienist could record
 * treatment under the principal dentist's name. Both create rows they
 * then cannot read, which is exactly the shape of bug that survives —
 * the list looks right afterwards because the row is invisible to the
 * person who made it.
 */
function crud(
  collection: string,
  actions: Permission["action"][],
  fields: string[] = ALL,
  extra: Record<string, unknown> = {},
): Permission[] {
  const narrowed = Object.keys(extra).length > 0;
  return actions.map((action) => ({
    collection,
    action,
    permissions: action === "create" ? {} : { ...extra },
    fields,
    presets: null,
    ...(action === "create" && narrowed ? { validation: extra } : {}),
  }));
}

function readOnly(collection: string, fields: string[] = ALL, extra = {}): Permission[] {
  return [{ collection, action: "read", permissions: { ...extra }, fields }];
}

/**
 * An absence, as everyone except the owner sees it.
 *
 * Reception has to know Dr Okafor is away from the 21st — they cannot run
 * a diary otherwise. They do not have to know it is sick leave. `kind`
 * separates annual leave from sickness from parental leave, which is
 * health and family information about a colleague, and `note` is where
 * the detail behind it ends up. Both are withheld from everyone but the
 * practice owner.
 *
 * The absence still blocks the booking either way: the rule lives in the
 * database trigger, which reads the row regardless of who is asking. This
 * decides what the screen shows, not what the schedule enforces.
 */
const ABSENCE_FIELDS_WITHOUT_REASON = [
  "id", "practitioner", "starts_at", "ends_at", "status",
];

/**
 * Everyone reads the retention rules.
 *
 * A clinician asked to delete something, or a receptionist asked how long
 * a record is kept, should be able to answer without a permissions
 * conversation. Nothing here is confidential — it is a statement of what
 * the law requires — and the figure being visible is what stops somebody
 * guessing at it.
 */
const retentionReadOnly: Permission[] = [...readOnly("retention_rules")];

/** Hours, rota and chair downtime: every clinical role reads these, none writes them. */
const availabilityReadOnly: Permission[] = [
  ...readOnly("clinic_hours"),
  ...readOnly("practitioner_hours"),
  ...readOnly("absences", ABSENCE_FIELDS_WITHOUT_REASON),
  ...readOnly("room_closures"),
];

/* ---------------------------------------------------------------- */

const clinicScoped: Policy = {
  name: "Clinic member",
  icon: "domain",
  description:
    "Baseline every staff policy is paired with: read your own practice, read colleagues, nothing else.",
  app_access: true,
  permissions: [
    { collection: "practice", action: "read", permissions: {}, fields: ALL },
    ...readOnly("rooms"),
    {
      collection: "directus_users",
      action: "read",
      permissions: {},
      fields: ["id", "first_name", "last_name", "email", "avatar", "job_title", "status"],
    },
    ...fileAccess,
    // Everyone on staff reads these. A clinician asked to delete
    // something, or a receptionist asked how long a record is kept,
    // should be able to answer without a permissions conversation —
    // nothing here is confidential, it is a statement of what the law
    // requires, and the figure being visible is what stops somebody
    // guessing at it.
    ...retentionReadOnly,
  ],
};

const receptionist: Policy = {
  name: "Front desk",
  icon: "support_agent",
  description:
    "Runs the diary and billing. Sees patient contact details; cannot read medical alerts, allergies or clinical notes, and cannot see treatment records or the tooth chart at all.",
  app_access: true,
  permissions: [
    // The inbox. Reception writes manual messages and reads the thread;
    // the delivery columns are the pipeline's to set, so they are absent
    // from the writable list rather than merely discouraged.
    ...crud("messages", ["create", "read", "update"],
      ["id", "patient", "direction", "channel", "kind", "subject", "body",
       "appointment", "invoice", "recall", "status", "address", "attempts",
       "failure_reason", "provider_id", "sent_at", "date_created", "user_created"]),
    ...crud("patients", ["create", "read", "update"], FRONT_DESK_PATIENT_FIELDS),
    ...crud("appointments", ["create", "read", "update", "delete"]),
    ...crud("invoices", ["create", "read", "update"]),
    ...crud("invoice_lines", ["create", "read", "update", "delete"]),
    // Reception takes the money, so reception records it. No delete: a
    // payment that turns out to be wrong is reversed with a negative
    // row, not erased — the money still moved, and a deleted payment is
    // a reconciliation that will never balance again.
    ...crud("payments", ["create", "read", "update"]),
    // Read-only on the accounting batches. Reception can see that a
    // period has been posted; posting one is the practice owner's.
    ...readOnly("ledger_exports"),
    ...readOnly("treatments", ["id", "code", "name", "category", "duration_minutes", "default_price", "active"]),
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
    // Reception owns the diary, so filling a cancellation is theirs; and
    // they take the money, so the payment plans are too.
    ...crud("waiting_list", ["create", "read", "update", "delete"]),
    ...crud("payment_plans", ["create", "read", "update"]),
    ...crud("payment_plan_charges", ["create", "read", "update"]),
    ...readOnly("lab_cases"),
    ...readOnly("laboratories"),
    // The diary is reception's, so everything that decides whether a slot
    // exists has to be readable by them — hours, rota, who is away, which
    // chair is down. Withheld: why anybody is away.
    ...readOnly("clinic_hours"),
    ...readOnly("practitioner_hours"),
    ...readOnly("absences", ABSENCE_FIELDS_WITHOUT_REASON),
    // Writable, unlike the rest: a chair breaks while reception is on the
    // desk, and making them find the owner before the diary reflects it
    // means the diary is wrong for as long as that takes.
    ...crud("room_closures", ["create", "read", "update"]),
    // Reception sees THAT a patient has an active allergy — they book and
    // greet, and a penicillin allergy on the day list is safety, not
    // clinical detail. They do not get the note, the severity or anything
    // in the history.
    ...readOnly("patient_findings", ["id", "patient", "category", "label", "status"], {
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
    ...readOnly("messages"),
    ...availabilityReadOnly,
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
    ...crud("perio_screenings", ["create", "read"]),
    ...crud("perio_sextants", ["create", "read"]),
    ...crud("perio_exams", ["create", "read"]),
    ...crud("perio_teeth", ["create", "read"]),
    ...crud("perio_sites", ["create", "read"]),
    ...crud("waiting_list", ["create", "read", "update"]),
    ...crud("lab_cases", ["create", "read", "update"]),
    ...readOnly("laboratories"),
    ...crud("consents", ["create", "read"]),
    ...readOnly("recall_types"),
    ...readOnly("recall_statuses"),
    // Directus unions permissions across the policies on a role, so this
    // widens the Clinic member baseline rather than replacing it: a
    // clinician reads every file in their practice, radiographs included.
    { collection: "directus_files", action: "read", permissions: {}, fields: ALL },
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
    ...readOnly("messages"),
    ...availabilityReadOnly,
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
    ...crud("perio_screenings", ["create", "read", "update", "delete"]),
    ...crud("perio_sextants", ["create", "read", "update", "delete"]),
    ...crud("perio_exams", ["create", "read", "update", "delete"]),
    ...crud("perio_teeth", ["create", "read", "update", "delete"]),
    ...crud("perio_sites", ["create", "read", "update", "delete"]),
    ...crud("waiting_list", ["create", "read", "update", "delete"]),
    ...crud("lab_cases", ["create", "read", "update", "delete"]),
    ...readOnly("laboratories"),
    ...crud("payment_plans", ["create", "read", "update", "delete"]),
    ...crud("payment_plan_charges", ["create", "read", "update", "delete"]),
    ...crud("laboratories", ["create", "read", "update", "delete"]),
    ...crud("consents", ["create", "read"]),
    ...readOnly("recall_types"),
    ...readOnly("recall_statuses"),
    // Directus unions permissions across the policies on a role, so this
    // widens the Clinic member baseline rather than replacing it: a
    // clinician reads every file in their practice, radiographs included.
    { collection: "directus_files", action: "read", permissions: {}, fields: ALL },
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
    ...crud("messages", ["create", "read", "update", "delete"]),
    /**
     * The audit log: read, and only read.
     *
     * No create — the hook writes these with `accountability: null`,
     * because a row anybody can author is a row anybody can forge. No
     * update or delete either, and that is enforced twice: absent here,
     * and refused by a database trigger that an administrator cannot talk
     * their way past.
     *
     * The owner sees their own practice's rows plus the ones with no
     * clinic at all — a failed sign-in against an address that matches no
     * account belongs to nobody, and hiding it from everyone is how it
     * goes unnoticed.
     */
    {
      collection: "access_log",
      action: "read",
      permissions: {},
      fields: ALL,
    },
    // The owner maintains all of it, and is the only role that sees the
    // reason behind an absence — everyone else gets the dates.
    ...crud("clinic_hours", ["create", "read", "update", "delete"]),
    ...crud("practitioner_hours", ["create", "read", "update", "delete"]),
    ...crud("absences", ["create", "read", "update", "delete"]),
    ...crud("room_closures", ["create", "read", "update", "delete"]),
    { collection: "practice", action: "update", permissions: {}, fields: ALL },
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
    ...crud("perio_screenings", ["create", "read", "update", "delete"]),
    ...crud("perio_sextants", ["create", "read", "update", "delete"]),
    ...crud("perio_exams", ["create", "read", "update", "delete"]),
    ...crud("perio_teeth", ["create", "read", "update", "delete"]),
    ...crud("perio_sites", ["create", "read", "update", "delete"]),
    ...crud("waiting_list", ["create", "read", "update", "delete"]),
    ...crud("lab_cases", ["create", "read", "update", "delete"]),
    ...readOnly("laboratories"),
    ...crud("payment_plans", ["create", "read", "update", "delete"]),
    ...crud("payment_plan_charges", ["create", "read", "update", "delete"]),
    ...crud("laboratories", ["create", "read", "update", "delete"]),
    ...crud("consents", ["create", "read"]),
    ...readOnly("recall_types"),
    ...readOnly("recall_statuses"),
    // Directus unions permissions across the policies on a role, so this
    // widens the Clinic member baseline rather than replacing it: a
    // clinician reads every file in their practice, radiographs included.
    { collection: "directus_files", action: "read", permissions: {}, fields: ALL },
    ...crud("documents", ["create", "read", "update", "delete"]),
    ...crud("invoices", ["create", "read", "update", "delete"]),
    ...crud("invoice_lines", ["create", "read", "update", "delete"]),
    ...crud("payments", ["create", "read", "update", "delete"]),
    ...crud("ledger_exports", ["create", "read", "update", "delete"]),
    // Retention is the practice owner's to set: it is a statement about
    // what the law requires of this practice, not a preference.
    ...crud("retention_rules", ["create", "read", "update", "delete"]),
    /*
     * The breach register, and deliberately **no delete**.
     *
     * Article 33(5) requires a practice to document every breach; a
     * register somebody can tidy is not a record of anything. The row
     * that most wants deleting is the one an authority most wants to
     * read, and "we removed it because it turned out to be nothing" is
     * the sentence that ends badly. Closing a breach is a status, not a
     * deletion.
     *
     * Owner-only for the same reason the retention rules are: this is the
     * practice's account of itself, and the assessment in it is a
     * decision with a name on it.
     */
    ...crud("data_breaches", ["create", "read", "update"]),
    /*
     * The disposal register, and again no delete.
     *
     * It is the record of a decision somebody signed for. A register the
     * signatory can remove is not evidence of anything, and the row most
     * worth deleting is the one somebody later wishes had gone
     * differently.
     */
    ...crud("disposals", ["create", "read", "update"]),
    /*
     * The record of processing, and what patients decided about it.
     *
     * `processing_purposes` is the practice's statement of what it does
     * and under which Article 6 basis — an owner's decision, the same as
     * the retention rules, and for the same reason: it is an assertion
     * about this practice's legal position rather than a preference.
     *
     * `consent_records` is **create and read, with no update and no
     * delete at all** — narrower than either register above, which at
     * least allow a status change. Article 7(1) asks a controller to
     * demonstrate that consent was given; an editable log demonstrates
     * only what somebody last decided it should say. A withdrawal is a
     * new row. There is nothing to correct in a past decision, because
     * the past decision is the evidence.
     */
    /*
     * The website's content, which the owner could not edit.
     *
     * `services`, `faqs` and `pages` had a read rule for the website
     * token and nothing else — so the only account that could change
     * what the practice's own front page said was the instance
     * administrator, which is not a person a practice has. "Controlled
     * from Directus" has to mean controlled by somebody who works there.
     *
     * No delete on `pages`: an address that once existed and now 404s is
     * a link somebody has bookmarked, and `archived` says the same thing
     * without breaking it.
     */
    ...crud("services", ["create", "read", "update", "delete"]),
    ...crud("faqs", ["create", "read", "update", "delete"]),
    ...crud("pages", ["create", "read", "update"]),
    ...crud("processing_purposes", ["create", "read", "update"]),
    ...crud("consent_records", ["create", "read"]),
    {
      collection: "directus_users",
      action: "update",
      permissions: {},
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
    /**
     * Booking online, which is a new privilege and worth naming as one.
     *
     * The portal was read-only on appointments until the patient site
     * existed. Letting a patient create one is a deliberate widening, and
     * it is narrow in three ways: the row has to be theirs, the status is
     * forced to `scheduled` by a preset rather than accepted from the
     * form, and the clinic is forced to their own.
     *
     * Everything that makes a booking legal still applies underneath —
     * the exclusion constraints, the availability trigger, the scheduling
     * hook. A patient cannot double-book a dentist for the same reason a
     * receptionist cannot: Postgres refuses, and they get the same
     * sentence back.
     */
    {
      collection: "appointments",
      action: "create",
      permissions: { patient: { portal_user: { _eq: "$CURRENT_USER" } } },
      fields: ["patient", "practitioner", "room", "treatment", "starts_at", "ends_at", "reason", "status"],
      presets: { status: "scheduled" },
    },
    {
      /**
       * Cancelling, and only cancelling.
       *
       * One writable field. A patient can call off an appointment they
       * made; they cannot move it onto somebody else's slot, change the
       * clinician, or mark it completed. Rescheduling is a cancel and a
       * rebook, which is also what a practice would do on the phone.
       */
      collection: "appointments",
      action: "update",
      permissions: {
        _and: [
          { patient: { portal_user: { _eq: "$CURRENT_USER" } } },
          { status: { _in: ["scheduled", "confirmed"] } },
          { starts_at: { _gt: "$NOW" } },
        ],
      },
      fields: ["status"],
      validation: { status: { _eq: "cancelled" } },
    },
    ...readOnly("treatments", ["id", "code", "name", "category", "duration_minutes", "default_price"]),
    {
      // Their own thread, and only the parts that are about them: not the
      // provider id, not the failure reason, not how many times the
      // practice tried. A patient asking "did you tell me" gets the
      // message; the plumbing is the practice's business.
      collection: "messages",
      action: "read",
      permissions: { patient: { portal_user: { _eq: "$CURRENT_USER" } } },
      fields: ["id", "direction", "channel", "kind", "subject", "body", "sent_at", "date_created"],
    },
    {
      collection: "patients",
      action: "read",
      permissions: ownPatientRecord,
      // `clinic` and the three consent booleans were added when the
      // patient site was built. The clinic because every time on the site
      // is drawn in the practice's timezone and the patient has to be
      // able to reach it; the booleans because they are the patient's own
      // consent, and a portal that shows a preference it will not let you
      // change is worse than one that never mentions it.
      fields: [
        "id", "status", "reference", "first_name", "last_name", "date_of_birth",
        "email", "phone", "address", "preferred_language",
        "allow_email", "allow_sms", "allow_whatsapp",
      ],
    },
    {
      collection: "patients",
      action: "update",
      permissions: ownPatientRecord,
      // Contact details and consent. Not `status` — a pending record is
      // pending until the practice looks at it, and a patient who could
      // set their own to `active` would be verifying themselves.
      fields: ["email", "phone", "address", "preferred_language", "allow_email", "allow_sms", "allow_whatsapp"],
    },
    {
      /**
       * Their own practice: where it is, what to ring, and — the part the
       * site cannot work without — which timezone its diary is kept in.
       *
       * No row filter: there is one practice and its address is on the
       * front of the building. What is scoped here is the field list.
       *
       * The fields are what a practice puts on its front door.
       */
      collection: "practice",
      action: "read",
      permissions: {},
      // The theme columns are here because the patient site renders in
      // the practice's own colour. A brand colour is what is painted on
      // the front of the building — it is the least confidential thing a
      // practice owns, and withholding it only means the site cannot
      // look like the practice.
      fields: [
        "id", "name", "city", "country", "timezone", "currency", "phone", "email", "address",
        "theme_primary", "theme_logo",
      ],
    },
    {
      /**
       * Who works there — and deliberately not who else is registered.
       *
       * A patient looking at "Tuesday, 09:30, Dr Visser" needs the name,
       * and the booking page needs the list to offer a choice. The
       * clinicians at a practice are on its website; this is not a leak.
       *
       * The second arm is the one that matters. Portal logins carry a
       * clinic too, so a filter that stopped at "same practice" would
       * hand every patient the names of every other patient registered
       * there. Excluding the Patient role leaves the staff, and the
       * service accounts are already excluded by having no clinic.
       */
      collection: "directus_users",
      action: "read",
      permissions: { role: { name: { _neq: "Patient" } } },
      fields: ["id", "first_name", "last_name", "job_title"],
    },
    {
      /**
       * Their own login row, for one column: `clinic`.
       *
       * The core service decides which practice's diary a caller may read
       * from the clinic on their user record, and it asks with the
       * caller's own token so that it can never see more than the caller
       * can. Without this the answer comes back empty — Directus special-
       * cases `id` on /users/me and silently drops every field the policy
       * does not grant — and a patient is told their account is not
       * attached to a practice while looking at that practice's name.
       *
       * Directus unions the field lists of every permission on a
       * collection, so this also adds `clinic` to what a patient sees on
       * the staff rows above. That is the same clinic they are in — the
       * filter there says so — which is why the widening is `clinic` and
       * not `email`.
       */
      collection: "directus_users",
      action: "read",
      permissions: { id: { _eq: "$CURRENT_USER" } },
      fields: ["id"],
    },
    {
      collection: "appointments",
      action: "read",
      permissions: ownPatientChild,
      // `patient` is granted deliberately. A patient knowing their own
      // record id is not a leak, and without it the verify suite cannot
      // assert that every appointment they can see is actually theirs —
      // the check would ask for a denied field, get a 403, and pass on an
      // empty result. A test that passes because the request failed is
      // worse than no test.
      fields: ["id", "patient", "starts_at", "ends_at", "status", "reason", "practitioner", "room"],
    },
    {
      collection: "tooth_conditions",
      action: "read",
      permissions: ownPatientChild,
      fields: ["id", "tooth", "surface", "condition", "recorded_at"],
    },
    {
      collection: "payment_plans",
      action: "read",
      permissions: ownPatientChild,
      fields: ["id", "plan_type", "agreed_on", "total_principal", "payment_amount", "charge_frequency"],
    },
    {
      collection: "payment_plan_charges",
      action: "read",
      permissions: { payment_plan: { patient: { portal_user: { _eq: "$CURRENT_USER" } } } },
      fields: ["id", "due_on", "principal", "interest", "balance_after", "status"],
    },
    {
      collection: "perio_screenings",
      action: "read",
      permissions: ownPatientChild,
      fields: ["id", "examined_on", "instrument"],
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
      /**
       * The practice's logo, and nothing else that is not a document.
       *
       * A **separate** permission rather than a wider filter on the one
       * above. Directus unions permissions on a collection, so this adds a
       * second way in without loosening the first by a millimetre — the
       * clinical rule still says "a consent form of yours points at this
       * file" and still refuses everything else.
       *
       * Widening the document filter to also allow "…or it has no
       * document" would have been the tempting one-line version, and it
       * would have granted every unfiled upload in the practice, which is
       * every radiograph in the seconds between the upload and the
       * document row that classifies it.
       *
       * Scoped to their own practice or to none, like every other file
       * rule here. A logo is the least confidential thing a practice
       * owns — it is painted on the front of the building — but the
       * boundary costs nothing and staying consistent is worth more than
       * the exception.
       */
      collection: "directus_files",
      action: "read",
      permissions: { brand_asset: { _eq: true } },
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
    {
      /**
       * What they have paid, and when.
       *
       * A patient looking at an invoice marked unpaid, who paid it in
       * cash last Tuesday, needs to be able to see the receipt rather
       * than ring the practice. Their own rows only, and deliberately not
       * `idempotency_key` or `provider_reference` — those are the
       * practice's plumbing and one of them is a key that must not leak.
       */
      collection: "payments",
      action: "read",
      permissions: ownPatientChild,
      fields: ["id", "invoice", "amount", "method", "status", "received_at", "date_created"],
    },
  ],
};

/**
 * The reminder sweep's credential, and nothing else it might one day want.
 *
 * The reminder sweep has no user to borrow a token from, so it carries a
 * static one. The temptation is to hand it an admin token and move on;
 * the reason not to is that a static token is the credential most likely
 * to end up in a log, an env file in a screenshot, or a container image.
 * What it can do if that happens is the only thing standing behind it.
 *
 * So: it may read the diary it has to scan, and it may set one boolean.
 * It cannot read a medical alert, write a clinical note, create an
 * appointment or see a patient's address. Not clinic-scoped, because the
 * sweep runs across every practice — which is exactly why the rest is cut
 * so close to the bone.
 *
 * Named for the job rather than for the service that runs it. When `core`
 * grows a second background job it gets its own account at its own width;
 * "the service's token" is how one credential quietly acquires everything
 * the service can do, which is everything.
 *
 * `app_access: false` — this account is not a person and has no business
 * being able to open the admin.
 */
const reminderWorker: Policy = {
  name: "Reminder worker",
  icon: "schedule_send",
  description:
    "One job, one credential. Reads appointments due and marks them reminded — nothing else, across all practices.",
  app_access: false,
  permissions: [
    {
      collection: "appointments",
      action: "read",
      permissions: {},
      fields: ["id", "patient", "practitioner", "starts_at", "ends_at", "status", "reminder_sent"],
    },
    {
      // One field. The sweep's only side effect is recording that it
      // sent something, and a wider grant here would let a leaked token
      // move every appointment in the book.
      collection: "appointments",
      action: "update",
      permissions: {},
      fields: ["reminder_sent"],
    },
    {
      collection: "patients",
      action: "read",
      permissions: {},
      fields: ["id", "first_name", "last_name", "email"],
    },
    { collection: "practice", action: "read", permissions: {}, fields: ["id", "name", "timezone"] },
    {
      collection: "directus_users",
      action: "read",
      permissions: {},
      fields: ["id", "first_name", "last_name"],
    },
  ],
};

/**
 * The portal's registration account, and nothing beyond it.
 *
 * A second service credential rather than reusing the reminder sweep's,
 * for the reason that one exists at all: the blast radius of a leaked
 * token is whatever the token can do, and "create a login" and "mark a
 * reminder sent" should not be the same key.
 *
 * This one creates a user and a patient record. It cannot read the patient
 * list — which matters more than it sounds, because the endpoint behind it
 * is the only unauthenticated surface in the system. A token that could
 * read patients would turn a registration form into a lookup service for
 * anybody who can guess an email address.
 */
const portalRegistrar: Policy = {
  name: "Portal registrar",
  icon: "person_add",
  description:
    "Creates a patient login and a pending patient record. Cannot read either afterwards.",
  app_access: false,
  permissions: [
    { collection: "patients", action: "create", permissions: {}, fields: ALL },
    {
      /**
       * Attaching the login to the record it was made for, and nothing
       * else.
       *
       * One writable field, and a filter that only matches a record that
       * is still pending and still has no login. It cannot rename a
       * patient, cannot approve one, and cannot move an existing
       * patient's portal access to an account it controls.
       */
      collection: "patients",
      action: "update",
      permissions: { _and: [{ status: { _eq: "pending" } }, { portal_user: { _null: true } }] },
      fields: ["portal_user"],
    },
    {
      /**
       * Taking back a half-made registration.
       *
       * The record is created before the login, because the other order
       * leaves somebody with an account that signs in to nothing and an
       * address that can never be registered again. The cost of that
       * order is a record with no login when the second step fails —
       * Directus's own email validation is stricter than the form's, so
       * this is a real path and not a theoretical one.
       *
       * Same filter as the update above, and for the same reason it is
       * safe: still pending, still unclaimed. A record the practice has
       * looked at, or one somebody has a login for, is outside it.
       */
      collection: "patients",
      action: "delete",
      permissions: { _and: [{ status: { _eq: "pending" } }, { portal_user: { _null: true } }] },
      fields: ALL,
    },
    {
      /**
       * Creating the login itself.
       *
       * `role` is in the list because a user with no role in Directus 11
       * has no policies and therefore cannot do anything — the account
       * would exist and the patient could never sign in. The service
       * names the Patient role explicitly; nothing here lets it pick a
       * different one, because it cannot read directus_roles to find
       * another.
       *
       * `id` is in the list because the registrar cannot read this
       * collection, and Directus answers a create it cannot read back
       * with 204 and an empty body. The service therefore generates the
       * uuid itself and sends it, rather than being handed one. Keeping
       * create-without-read is worth that much: a token that could read
       * users back is a token that can enumerate them.
       */
      collection: "directus_users",
      action: "create",
      permissions: {},
      fields: ["id", "email", "password", "first_name", "last_name", "role", "status"],
    },
    {
      /**
       * Undoing a half-made account, and only that.
       *
       * If the login is created and then cannot be attached to its
       * record, the alternative to deleting it is leaving somebody with
       * an account that signs in to nothing and an email address that
       * can never be registered again. So: delete, scoped to a Patient
       * account that has never once signed in.
       *
       * Not `delete on directus_users`. A patient who has used the portal
       * is outside this filter, and so is every member of staff.
       */
      collection: "directus_users",
      action: "delete",
      permissions: {
        _and: [{ role: { name: { _eq: "Patient" } } }, { last_access: { _null: true } }],
      },
      fields: ALL,
    },
    // Read on clinics only, and only the three columns the sign-up form
    // shows. Everything else it needs, it is told by the caller.
    { collection: "practice", action: "read", permissions: {}, fields: ["id", "name", "city"] },
  ],
};

/**
 * The public website's credential.
 *
 * This is the one Ahmad asked for, and it is right **for content**: the
 * site is server-rendered, so opening hours and a list of services have
 * to be fetched by something with no visitor attached. A narrowly-scoped
 * read-only token held server-side is the correct way to do that, and it
 * keeps Directus itself closed to the internet.
 *
 * It is emphatically **not** how the patient area works, and the
 * distinction is the most important thing on this page. Behind the
 * sign-in, every request carries *that patient's own token* — which is
 * what makes the site incapable of reading somebody else's record even
 * if the code is wrong. If this token could read `patients`, the site
 * would become the thing deciding who sees what, and it would be one
 * bug away from showing the wrong person's history. Two credentials,
 * both server-side, neither ever reaching a browser.
 *
 * So: read, on five collections, and nothing else. No patients, no
 * appointments, no invoices, no documents, no messages, no access log —
 * asserted by the verify suite rather than left to review.
 *
 * `published` is in every filter. A practice drafting a new service must
 * be able to save it without it appearing on the internet, and "we will
 * remember to set it live last" is not a mechanism.
 */
const websiteVisitor: Policy = {
  name: "Website",
  icon: "public",
  description:
    "Read-only, public content only. Cannot read patients, appointments, invoices, documents, messages or the audit log.",
  app_access: false,
  permissions: [
    {
      collection: "practice",
      action: "read",
      permissions: {},
      // What a practice puts on its own front door, plus the theme the
      // site renders in. Not `slug`-only: the site needs the address and
      // the telephone number to build a contact page and the structured
      // data a search engine reads.
      fields: [
        "id", "slug", "name", "strapline", "intro", "city", "country",
        "timezone", "currency", "phone", "email", "address", "phone_note",
        "theme_primary", "theme_logo", "hero_image", "website_domain",
      ],
    },
    {
      collection: "services",
      action: "read",
      permissions: { published: { _eq: true } },
      fields: ["id", "name", "slug", "summary", "body", "price_from", "sort", "image"],
    },
    {
      collection: "faqs",
      action: "read",
      permissions: { published: { _eq: true } },
      fields: ["id", "question", "answer", "sort"],
    },
    {
      /*
       * Pages the practice wrote, and **published only**.
       *
       * The site also filters on status in its query, and that is not
       * belt and braces doing the same job twice: the query is what
       * builds the navigation, this is what makes a draft unreachable.
       * A draft the website token can read is a published page that
       * happens not to be linked, and anybody who guesses the address
       * has it.
       */
      collection: "pages",
      action: "read",
      permissions: { status: { _eq: "published" } },
      fields: ["id", "title", "slug", "summary", "body", "nav", "sort", "date_updated"],
    },
    {
      // The same rows the scheduling engine refuses bookings against. A
      // website that publishes hours from a second table is a website
      // that will eventually disagree with the diary.
      collection: "clinic_hours",
      action: "read",
      permissions: {},
      fields: ["id", "weekday", "closed", "opens_at", "closes_at"],
    },
    {
      /**
       * The logo on the practice's own website.
       *
       * The same rule as the patient area's, for the same reason: this
       * token reads `clinics.theme_logo` and gets a uuid, and a uuid is
       * not an image. Only files a practice has marked as brand assets,
       */
      collection: "directus_files",
      action: "read",
      permissions: { brand_asset: { _eq: true } },
      fields: ["id", "title", "type", "filesize"],
    },
    {
      /**
       * What the practice keeps, and for how long.
       *
       * Read by the privacy notice, which is obliged to state exactly
       * this — GDPR Article 13(2)(a) asks for the period, not for "as
       * long as necessary". Publishing it from the same rows the
       * practice maintains is what stops the notice drifting from the
       * policy, and it is how two practices on one installation publish
       * genuinely different periods without a second template.
       *
       * Nothing here is personal data: a statutory retention period is a
       * fact about the law, not about a patient.
       */
      collection: "retention_rules",
      action: "read",
      permissions: {},
      fields: ["id", "record_type", "years", "starts_from", "legal_basis"],
    },
    {
      /**
       * The team page — and this filter is the one to read twice.
       *
       * `public_profile` is opt-in and defaults to false, because a
       * clinician's name and photograph on a public website is their
       * decision rather than the practice's. Without the second arm this
       * would also expose every *patient* login, which carries a clinic
       * exactly as a clinician's does — the same trap the portal's own
       * staff-list permission has.
       */
      collection: "directus_users",
      action: "read",
      permissions: {
        _and: [
          { public_profile: { _eq: true } },
          { status: { _eq: "active" } },
          { role: { name: { _neq: "Patient" } } },
        ],
      },
      fields: ["id", "first_name", "last_name", "job_title", "public_bio", "public_sort", "public_photo"],
    },
  ],
};

/**
 * Somebody who watches the job queues and may not read a patient.
 *
 * The board used to require `admin_access`, and that is not "may open
 * the job board" — it is god-mode: every clinical note, every
 * radiograph, the audit log, the ability to edit permissions. Letting a
 * contractor see why a reminder failed meant handing them the lot, which
 * is precisely backwards.
 *
 * So this policy grants **nothing**. Not a narrowed set of collections —
 * an empty list. `app_access` is true only so the person can load the
 * admin shell far enough to click Queues; the sidebar they get has no
 * collections in it, because they have permission on none.
 *
 * What lets them through the door is not a permission at all. The core
 * service asks Directus whether the caller holds this policy by name,
 * the same way it asks whether they are an administrator — one identity
 * system, still no second password, and an account that cannot read a
 * single patient row.
 *
 * ## Worth being clear about what they *can* see
 *
 * Job payloads. A reminder job carries a patient's name, their
 * appointment time and the message body, so this is not "no patient data
 * ever" — it is "no access to the record, and a window onto what is
 * being sent right now". That is the honest description, and it is why
 * this is a deliberate grant rather than a role to hand out freely.
 */
const queueOperator: Policy = {
  name: "Queue operator",
  icon: "conveyor_belt",
  description:
    "Opens the job board and nothing else. Not one clinical collection — " +
    "cannot read a patient, a note or a radiograph. Job payloads carry patient " +
    "names, so grant it deliberately.",
  app_access: true,
  admin_access: false,
  permissions: [
    {
      /**
       * The policy's permission to notice that it is itself.
       *
       * The core service decides whether to open the board by asking
       * `/users/me` which policies the caller holds and looking for this
       * one by name. That worked for an administrator and for nobody
       * else: an account with no permission on `directus_policies` cannot
       * expand `policies.policy.name`, and Directus does not refuse the
       * query — it answers 200 with the nested field quietly absent. So
       * the check saw no policies at all and the one account the grant
       * was built for was the one account it locked out.
       *
       * Reading the caller's own role instead would have avoided the
       * lookup, and made the role the grant. The policy is the grant —
       * that is what lets somebody be given board access without the
       * role, and what makes the description above the honest place to
       * write down what it costs. So the policy is made visible to
       * whoever holds it, and to nobody else.
       *
       * `$CURRENT_POLICIES` resolves to the caller's own policy ids at
       * request time, so this grants sight of exactly the policies the
       * caller already has. Two fields, because a name is what the code
       * matches on and `admin_access` is what it must be able to see is
       * false. No create, update or delete: this cannot edit the thing it
       * can read, which is the difference between reading a grant and
       * writing one.
       */
      collection: "directus_policies",
      action: "read",
      permissions: { id: { _in: "$CURRENT_POLICIES" } },
      fields: ["id", "name", "admin_access", "app_access"],
    },
    {
      /**
       * And the join that attaches it.
       *
       * Reading `directus_policies` alone was not enough, because the
       * question is asked as `/users/me?fields=policies.policy.name` and
       * that traverses `directus_access` on the way. Without this the
       * traversal still broke, and broke in the same silent way — 200,
       * field absent. One unreadable link in a path is indistinguishable
       * from holding no policies at all.
       *
       * Scoped to the caller's own attachments in both the shapes
       * Directus uses: a policy granted straight to the person, and one
       * granted through their role. This account is the second kind, and
       * writing only that half would have worked here and failed for
       * anybody handed the policy directly.
       */
      collection: "directus_access",
      action: "read",
      permissions: {
        _or: [{ user: { _eq: "$CURRENT_USER" } }, { role: { _eq: "$CURRENT_ROLE" } }],
      },
      fields: ["id", "user", "role", "policy"],
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
  reminderWorker,
  portalRegistrar,
  websiteVisitor,
  queueOperator,
];

export { FRONT_DESK_PATIENT_FIELDS };
