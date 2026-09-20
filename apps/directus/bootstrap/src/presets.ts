import type { Preset } from "./types.js";

/**
 * Global bookmarks.
 *
 * `role: null` shows a bookmark to everyone, narrowed by whatever their
 * own policies already allow — one definition, correct for all five
 * roles, because the permission layer does the narrowing rather than the
 * bookmark. Directus hides a bookmark entirely when the user cannot read
 * its collection, which is why "Treatment plans" never appears for front
 * desk without any extra configuration.
 *
 * A named `role` scopes a bookmark to one role. "Medical alerts" uses
 * that, because its filter touches a field front desk cannot read — a
 * global bookmark referencing a denied field would 403 for them.
 *
 * `$NOW` and `$CURRENT_USER` resolve per request, so these stay correct
 * without a job rewriting them.
 */

const w = (widths: Record<string, number>) => ({ tabular: { widths } });

/**
 * Default list layouts.
 *
 * A preset with no bookmark, no role and no user IS the collection's
 * default view — which matters more than it sounds. Without one, Directus
 * picks the first few columns it finds, and Lab Cases opened showing
 * "Appointment, Clinic, Laboratory" with the appointment column empty:
 * none of the four timestamps that are the entire point of the module,
 * and none of the instructions. A module can be modelled correctly and
 * still be useless on the screen where somebody opens it.
 */
export const collectionDefaults: Preset[] = [
  {
    bookmark: null, collection: "lab_cases", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-sent_at"], fields: ["patient", "instructions", "due_at", "sent_at", "received_at", "checked_at"] } },
    layout_options: w({ patient: 170, instructions: 300, due_at: 130, sent_at: 130, received_at: 130, checked_at: 130 }),
  },
  {
    bookmark: null, collection: "waiting_list", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["added_on"], fields: ["patient", "added_on", "source", "wanted_from", "status", "priority"] } },
    layout_options: w({ patient: 180, added_on: 130, source: 200, wanted_from: 140, status: 130 }),
  },
  {
    bookmark: null, collection: "payment_plans", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-agreed_on"], fields: ["patient", "agreed_on", "total_principal", "down_payment", "apr", "payment_amount", "charge_frequency"] } },
    layout_options: w({ patient: 170, agreed_on: 130, total_principal: 140, down_payment: 130, apr: 90, payment_amount: 140 }),
  },
  {
    bookmark: null, collection: "dentition", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["patient", "designation"], fields: ["patient", "designation", "dentition_type", "state", "absence_reason", "retained"] } },
    layout_options: w({ patient: 180, designation: 130, dentition_type: 150, state: 130, absence_reason: 150 }),
  },
  {
    bookmark: null, collection: "clinical_notes", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-written_on"], fields: ["written_on", "patient", "kind", "author", "body"] } },
    layout_options: w({ written_on: 160, patient: 170, kind: 130, author: 160, body: 400 }),
  },
  {
    bookmark: null, collection: "medical_histories", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-taken_on"], fields: ["taken_on", "patient", "anticoagulants", "smoker", "signed_on", "superseded_by"] } },
    layout_options: w({ taken_on: 130, patient: 180, anticoagulants: 150, smoker: 110, signed_on: 150 }),
  },
  {
    bookmark: null, collection: "patient_findings", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["patient"], fields: ["patient", "category", "label", "severity", "status", "noted_on"] } },
    layout_options: w({ patient: 180, category: 140, label: 220, severity: 120, status: 120 }),
  },
  {
    bookmark: null, collection: "consents", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-signed_on"], fields: ["patient", "title", "signed_on", "witnessed_by", "signature_invalidated_on"] } },
    layout_options: w({ patient: 170, title: 320, signed_on: 150, witnessed_by: 170 }),
  },
  {
    bookmark: null, collection: "treatment_plans", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-presented_on"], fields: ["patient", "title", "status", "presented_on", "presented_total", "accepted_total"] } },
    layout_options: w({ patient: 170, title: 260, status: 120, presented_on: 140, presented_total: 140, accepted_total: 140 }),
  },
  {
    bookmark: null, collection: "recalls", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["date_due"], fields: ["patient", "recall_type", "interval_months", "date_due", "recall_status", "patient_agreed"] } },
    layout_options: w({ patient: 180, recall_type: 170, interval_months: 120, date_due: 130, recall_status: 160, patient_agreed: 150 }),
  },
  {
    bookmark: null, collection: "perio_screenings", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-examined_on"], fields: ["patient", "examined_on", "instrument", "guideline_version", "examiner"] } },
    layout_options: w({ patient: 180, examined_on: 140, instrument: 130, guideline_version: 180 }),
  },
  {
    bookmark: null, collection: "perio_exams", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-examined_on"], fields: ["patient", "examined_on", "examiner", "probe_type", "charts_third_molars"] } },
    layout_options: w({ patient: 180, examined_on: 140, examiner: 170, probe_type: 130 }),
  },
  {
    bookmark: null, collection: "documents", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-taken_on"], fields: ["patient", "kind", "taken_on", "file", "note"] } },
    layout_options: w({ patient: 180, kind: 160, taken_on: 130, file: 200, note: 320 }),
  },

  // The perio tables were the worst of these, and the reason this list
  // grew to cover everything. Perio Sites opened on "Clinic, Exam, Site,
  // Tooth" — 240 rows of readings with not one reading among the columns.
  // The measurement is the record; everything else is where it came from.
  {
    // Deepest first. A flat list of 240 sites across several exams is not
    // a chart — the chart is per-exam and per-tooth — so it is more use as
    // a queue, and tooth order opens on the lower anteriors, which in this
    // data are all 2s and 3s with nothing bleeding.
    //
    // Calculus is deliberately not a column: this exam recorded
    // `assessed_calculus: false`, so every row is false, and a column of
    // crosses would read as "no calculus" when the truth is "not looked
    // for". That distinction is the reason the assessed_* flags exist.
    bookmark: null, collection: "perio_sites", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-probing_depth_mm", "tooth", "site"], fields: ["tooth", "site", "probing_depth_mm", "recession_mm", "bleeding_on_probing", "plaque", "suppuration", "exam"] } },
    layout_options: w({ tooth: 90, site: 270, probing_depth_mm: 190, recession_mm: 160, bleeding_on_probing: 200, plaque: 110, suppuration: 150, exam: 240 }),
  },
  {
    bookmark: null, collection: "perio_teeth", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["exam", "tooth"], fields: ["tooth", "is_present", "mobility", "mobility_index", "furcation_buccal", "furcation_lingual", "exam"] } },
    layout_options: w({ tooth: 90, is_present: 130, mobility: 130, mobility_index: 180, furcation_buccal: 190, furcation_lingual: 190, exam: 240 }),
  },
  {
    bookmark: null, collection: "perio_sextants", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["screening", "sextant"], fields: ["sextant", "bpe_code", "furcation", "teeth_scored", "not_scored_reason", "third_molar_included", "screening"] } },
    layout_options: w({ sextant: 130, bpe_code: 130, furcation: 130, teeth_scored: 160, not_scored_reason: 220, third_molar_included: 230, screening: 240 }),
  },

  // Clinical and billing tables that already have bookmarks still need a
  // default: a bookmark is a saved question, and clicking the collection
  // in the sidebar does not ask it.
  {
    bookmark: null, collection: "appointments", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-starts_at"], fields: ["starts_at", "ends_at", "patient", "practitioner", "room", "status", "reason"] } },
    layout_options: w({ starts_at: 170, ends_at: 130, patient: 190, practitioner: 170, room: 130, status: 130, reason: 220 }),
  },
  {
    bookmark: null, collection: "treatment_records", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-performed_at"], fields: ["performed_at", "patient", "treatment", "tooth", "practitioner", "price", "status"] } },
    layout_options: w({ performed_at: 170, patient: 190, treatment: 240, tooth: 80, practitioner: 170, price: 100 }),
  },
  {
    bookmark: null, collection: "tooth_conditions", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["patient", "tooth"], fields: ["patient", "tooth", "surface", "condition", "recorded_at", "treatment_record"] } },
    layout_options: w({ patient: 190, tooth: 80, surface: 140, condition: 140, recorded_at: 160, treatment_record: 260 }),
  },
  {
    bookmark: null, collection: "treatment_plan_items", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["plan", "priority"], fields: ["plan", "priority", "treatment", "tooth", "fee_presented", "status"] } },
    layout_options: w({ plan: 260, priority: 100, treatment: 240, tooth: 80, fee_presented: 130 }),
  },
  {
    bookmark: null, collection: "payment_plan_charges", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["payment_plan", "due_on"], fields: ["due_on", "principal", "interest", "balance_after", "status", "payment_plan"] } },
    layout_options: w({ due_on: 130, principal: 120, interest: 110, balance_after: 140, status: 120, payment_plan: 200 }),
  },
  {
    bookmark: null, collection: "invoices", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-issued_at"], fields: ["number", "patient", "status", "issued_at", "due_at", "total", "paid_at"] } },
    layout_options: w({ number: 150, patient: 190, status: 120, issued_at: 130, due_at: 130, total: 110, paid_at: 130 }),
  },
  {
    bookmark: null, collection: "invoice_lines", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["invoice", "sort"], fields: ["invoice", "description", "quantity", "unit_price", "amount", "treatment_record"] } },
    layout_options: w({ invoice: 170, description: 320, quantity: 100, unit_price: 120, amount: 110, treatment_record: 260 }),
  },

  // Reference tables. Short, but Directus led every one of them with the
  {
    bookmark: null, collection: "patients", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["last_name", "first_name"], fields: ["reference", "last_name", "first_name", "date_of_birth", "phone", "email", "status"] } },
    layout_options: w({ reference: 120, last_name: 170, first_name: 150, date_of_birth: 140, phone: 160, email: 220, status: 110 }),
  },
  {
    bookmark: null, collection: "treatments", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["code"], fields: ["code", "name", "category", "duration_minutes", "default_price", "requires_tooth", "active"] } },
    layout_options: w({ code: 100, name: 320, category: 150, duration_minutes: 130, default_price: 120, requires_tooth: 130, active: 90 }),
  },
  {
    bookmark: null, collection: "rooms", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["name"], fields: ["name", "chair_number", "active"] } },
    layout_options: w({ name: 200, chair_number: 130, active: 90 }),
  },
  {
    bookmark: null, collection: "laboratories", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["name"], fields: ["name", "turnaround_days", "phone", "email"] } },
    layout_options: w({ name: 240, turnaround_days: 150, phone: 160, email: 240 }),
  },
  {
    bookmark: null, collection: "recall_types", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["name"], fields: ["name", "default_interval_months", "special_type"] } },
    layout_options: w({ name: 240, default_interval_months: 200, special_type: 160 }),
  },
  {
    bookmark: null, collection: "recall_statuses", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["name"], fields: ["name", "abbreviation"] } },
    layout_options: w({ name: 240, abbreviation: 160 }),
  },

  // Scheduling. The week is read in order, so these sort by weekday
  // rather than alphabetically — "fri, mon, sat, sun, thu, tue, wed" is
  // the shape a default sort gives you and it is useless to look at.
  {
    bookmark: null, collection: "clinic_hours", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["weekday"], fields: ["weekday", "opens_at", "closes_at", "closed", "note"] } },
    layout_options: w({ weekday: 140, opens_at: 130, closes_at: 130, closed: 110, note: 320 }),
  },
  {
    bookmark: null, collection: "practitioner_hours", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["practitioner", "weekday"], fields: ["practitioner", "weekday", "starts_at", "ends_at", "room", "effective_from", "effective_to"] } },
    layout_options: w({ practitioner: 210, weekday: 130, starts_at: 130, ends_at: 130, room: 170, effective_from: 150, effective_to: 150 }),
  },
  {
    // Soonest first: the question asked of this screen is "who is off
    // next", not "who was off in March".
    bookmark: null, collection: "absences", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["starts_at"], fields: ["practitioner", "kind", "starts_at", "ends_at", "status", "note"] } },
    layout_options: w({ practitioner: 210, kind: 170, starts_at: 180, ends_at: 180, status: 130, note: 280 }),
  },
  {
    // Newest first, and both directions in one list: a conversation is a
    // thread, and splitting sent from received is how nobody notices the
    // reply that came back.
    bookmark: null, collection: "messages", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-date_created"], fields: ["date_created", "direction", "channel", "kind", "status", "patient", "subject", "body"] } },
    layout_options: w({ date_created: 170, direction: 110, channel: 110, kind: 140, status: 150, patient: 180, subject: 240, body: 320 }),
  },
  {
    // Published first, because the question on this screen is always
    // "what is live" — and the summary, because that is the text most
    // visitors actually read.
    bookmark: null, collection: "services", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["sort"], fields: ["name", "published", "price_from", "summary"] } },
    layout_options: w({ name: 220, published: 110, price_from: 120, summary: 380 }),
  },
  {
    bookmark: null, collection: "faqs", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["sort"], fields: ["question", "published", "answer"] } },
    layout_options: w({ question: 300, published: 110, answer: 420 }),
  },
  {
    // The basis beside the figure, because that is the pair anybody
    // checking this actually reads — a number on its own invites being
    // shortened.
    bookmark: null, collection: "retention_rules", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["record_type"], fields: ["record_type", "years", "starts_from", "legal_basis"] } },
    layout_options: w({ record_type: 190, years: 90, starts_from: 170, legal_basis: 320 }),
  },
  {
    /*
     * The deadline next to the discovery, and the risk next to both.
     *
     * Sorted by `notify_by` ascending rather than by discovery: on this
     * screen the question is always "what is running out", and the row
     * that matters is the one nearest its seventy-two hours. `risk` is
     * there because it decides whether there is a deadline at all.
     *
     * `why_not_notified` is on the list on purpose. A register whose
     * default view hides the reasoning behind the decisions not to report
     * is a register that looks empty of decisions.
     */
    bookmark: null, collection: "data_breaches", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["notify_by"], fields: ["reference", "status", "risk", "discovered_at", "notify_by", "authority_notified_at", "why_not_notified", "summary"] } },
    layout_options: w({ reference: 180, status: 130, risk: 190, discovered_at: 170, notify_by: 170, authority_notified_at: 180, why_not_notified: 280, summary: 320 }),
  },
  {
    /*
     * The signature and the shredder side by side.
     *
     * Those two columns are the only reason this register exists, and the
     * question anybody opens it to answer is whether they are in the
     * right order. `withheld_reason` is on the list because a review whose
     * default view hides the records that were *held back* looks like a
     * review that found nothing worth keeping.
     */
    bookmark: null, collection: "disposals", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-reviewed_as_at"], fields: ["reference", "status", "record_type", "reviewed_as_at", "authorised_by", "authorised_on", "carried_out_on", "method", "withheld_reason"] } },
    layout_options: w({ reference: 170, status: 140, record_type: 170, reviewed_as_at: 170, authorised_by: 180, authorised_on: 170, carried_out_on: 170, method: 150, withheld_reason: 300 }),
  },
  {
    // Money in, newest first. `method` before `status` because the
    // question at the desk is "how did they pay", and the outstanding
    // ones are found by sorting rather than by hunting a column.
    bookmark: null, collection: "payments", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-received_at"], fields: ["received_at", "patient", "invoice", "amount", "method", "status", "provider_reference"] } },
    layout_options: w({ received_at: 170, patient: 190, invoice: 170, amount: 110, method: 140, status: 130, provider_reference: 200 }),
  },
  {
    // The two totals side by side, because the only thing anybody checks
    // on this screen is whether they match.
    bookmark: null, collection: "ledger_exports", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-date_created"], fields: ["date_created", "reference", "period_start", "period_end", "line_count", "total_debits", "total_credits"] } },
    layout_options: w({ date_created: 170, reference: 230, period_start: 130, period_end: 130, line_count: 110, total_debits: 130, total_credits: 130 }),
  },
  {
    // Newest first, and the reader comes before the record: the question
    // asked of an audit log is "who has been in here", not "what was
    // touched". Sorting oldest-first would open on the day the practice
    // was provisioned.
    bookmark: null, collection: "access_log", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-date_created"], fields: ["date_created", "action", "user", "attempted_email", "collection", "patient", "item_count", "ip"] } },
    layout_options: w({ date_created: 180, action: 140, user: 190, attempted_email: 220, collection: 170, patient: 180, item_count: 100, ip: 140 }),
  },
  {
    bookmark: null, collection: "room_closures", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["starts_at"], fields: ["room", "reason", "starts_at", "ends_at", "note"] } },
    layout_options: w({ room: 190, reason: 180, starts_at: 180, ends_at: 180, note: 320 }),
  },
];

export const presets: Preset[] = [
  {
    bookmark: null, collection: "pages", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["sort"], fields: ["title", "slug", "status", "nav", "summary"] } },
    layout_options: w({ title: 240, slug: 160, status: 120, nav: 140, summary: 400 }),
  },
  {
    bookmark: null, collection: "processing_purposes", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["code"], fields: ["name", "code", "lawful_basis", "special_category_condition", "authority"] } },
    layout_options: w({ name: 230, code: 150, lawful_basis: 180, special_category_condition: 200, authority: 200 }),
  },
  {
    bookmark: null, collection: "consent_records", role: null, layout: "tabular",
    layout_query: { tabular: { sort: ["-decided_on"], fields: ["patient", "purpose", "decision", "decided_on", "route"] } },
    layout_options: w({ patient: 200, purpose: 220, decision: 120, decided_on: 160, route: 150 }),
  },

  {
    /**
     * The follow-up list that pays for itself. A plan presented and not
     * yet answered is money sitting still, and "not yet answered" is a
     * filter — presented, no acceptance date — rather than a status
     * somebody has to remember to set.
     */
    bookmark: "$t:enamel_bm_plans_presented",
    collection: "treatment_plans",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["presented_on"],
        fields: ["patient", "title", "presented_on", "presented_total", "accepted_total"],
      },
    },
    layout_options: w({ patient: 190, title: 240, presented_on: 140, presented_total: 140, accepted_total: 140 }),
    filter: {
      _and: [
        { status: { _eq: "active" } },
        { presented_on: { _nnull: true } },
        { accepted_on: { _null: true } },
      ],
    },
  },
  {
    /**
     * The worklist a practice actually runs on. "Overdue" is a filter, not
     * a stored state — date_due against $NOW, resolved per request — and
     * the suppression fields are honoured here rather than in application
     * code: a patient who has moved away or owes money simply does not
     * appear.
     */
    bookmark: "$t:enamel_bm_recalls_overdue",
    collection: "recalls",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["date_due"],
        fields: ["patient", "recall_type", "date_due", "date_previous", "recall_status", "patient_agreed"],
      },
    },
    layout_options: w({ patient: 200, recall_type: 170, date_due: 130, date_previous: 130, recall_status: 160 }),
    filter: {
      _and: [
        { date_due: { _lt: "$NOW" } },
        { date_scheduled: { _null: true } },
        { is_disabled: { _eq: false } },
        { _or: [{ disable_until: { _null: true } }, { disable_until: { _lt: "$NOW" } }] },
      ],
    },
  },
  {
    bookmark: "$t:enamel_bm_recalls_due",
    collection: "recalls",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["date_due"],
        fields: ["patient", "recall_type", "date_due", "recall_status"],
      },
    },
    layout_options: w({ patient: 200, recall_type: 170, date_due: 130, recall_status: 160 }),
    filter: {
      _and: [
        { date_due: { _gte: "$NOW" } },
        { date_due: { _lte: "$NOW(+60 days)" } },
        { date_scheduled: { _null: true } },
        { is_disabled: { _eq: false } },
      ],
    },
  },
  {
    bookmark: "$t:enamel_bm_todays_diary",
    collection: "appointments",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        page: 1,
        sort: ["starts_at"],
        fields: [
          "starts_at", "ends_at", "patient", "patient.phone",
          "practitioner", "room", "reason", "status",
        ],
      },
    },
    layout_options: w({ starts_at: 170, ends_at: 130, patient: 200, "patient.phone": 160, practitioner: 170, room: 130 }),
    filter: {
      _and: [
        { starts_at: { _gte: "$NOW(-0 hours)" } },
        { starts_at: { _lte: "$NOW(+24 hours)" } },
        { status: { _in: ["scheduled", "confirmed"] } },
      ],
    },
  },
  {
    bookmark: "$t:enamel_bm_my_schedule",
    collection: "appointments",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["starts_at"],
        fields: ["starts_at", "ends_at", "patient", "patient.phone", "room", "reason", "status"],
      },
    },
    layout_options: w({ starts_at: 170, ends_at: 130, patient: 200, "patient.phone": 160, room: 130 }),
    filter: {
      _and: [
        { practitioner: { _eq: "$CURRENT_USER" } },
        { starts_at: { _gte: "$NOW(-1 days)" } },
      ],
    },
  },
  {
    bookmark: "$t:enamel_bm_needs_reminder",
    collection: "appointments",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["starts_at"],
        fields: [
          "starts_at", "patient", "patient.email", "patient.phone",
          "patient.preferred_language", "practitioner", "status", "reminder_sent",
        ],
      },
    },
    layout_options: w({ starts_at: 170, patient: 190, "patient.email": 220, "patient.phone": 160, "patient.preferred_language": 110 }),
    filter: {
      _and: [
        { reminder_sent: { _eq: false } },
        { starts_at: { _gte: "$NOW" } },
        { starts_at: { _lte: "$NOW(+48 hours)" } },
        { status: { _in: ["scheduled", "confirmed"] } },
      ],
    },
  },
  {
    bookmark: "$t:enamel_bm_no_shows",
    collection: "appointments",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["-starts_at"],
        fields: ["starts_at", "patient", "patient.phone", "practitioner", "reason", "room", "status"],
      },
    },
    layout_options: w({ starts_at: 170, patient: 200, "patient.phone": 160, practitioner: 170 }),
    filter: {
      _and: [{ status: { _eq: "no_show" } }, { starts_at: { _gte: "$NOW(-30 days)" } }],
    },
  },
  {
    bookmark: "$t:enamel_bm_unpaid",
    collection: "invoices",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["due_at"],
        fields: [
          "number", "patient", "patient.phone", "issued_at", "due_at",
          "subtotal", "tax_rate", "total", "status",
        ],
      },
    },
    layout_options: w({ number: 150, patient: 200, "patient.phone": 160, issued_at: 130, due_at: 130, total: 120 }),
    filter: { status: { _in: ["sent", "overdue"] } },
  },
  {
    bookmark: "$t:enamel_bm_new_patients",
    collection: "patients",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["-date_created"],
        fields: [
          "reference", "first_name", "last_name", "date_of_birth",
          "email", "phone", "preferred_language", "status", "date_created",
        ],
      },
    },
    layout_options: w({ reference: 120, first_name: 150, last_name: 170, email: 230, phone: 160, date_created: 160 }),
    filter: { date_created: { _gte: "$NOW(-30 days)" } },
  },
  {
    bookmark: "$t:enamel_bm_plans",
    collection: "treatment_records",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["-date_created"],
        fields: [
          "patient", "treatment", "tooth", "surfaces",
          "practitioner", "price", "status", "date_created",
        ],
      },
    },
    layout_options: w({ patient: 200, treatment: 240, tooth: 100, surfaces: 120, practitioner: 170, price: 110 }),
    filter: { status: { _eq: "planned" } },
  },
  {
    bookmark: "$t:enamel_bm_completed_today",
    collection: "treatment_records",
    role: null,
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["-performed_at"],
        fields: ["performed_at", "patient", "treatment", "tooth", "practitioner", "price", "status"],
      },
    },
    layout_options: w({ performed_at: 170, patient: 200, treatment: 240, practitioner: 170 }),
    filter: {
      _and: [{ status: { _eq: "completed" } }, { performed_at: { _gte: "$NOW(-1 days)" } }],
    },
  },
  {
    // Scoped, not global: the filter touches medical_alerts, which front
    // desk cannot read. A global bookmark here would 403 for them.
    bookmark: "$t:enamel_bm_medical_alerts",
    collection: "patients",
    role: "Dentist",
    layout: "tabular",
    layout_query: {
      tabular: {
        sort: ["last_name"],
        fields: ["reference", "first_name", "last_name", "medical_alerts", "allergies", "phone"],
      },
    },
    layout_options: w({ reference: 120, first_name: 150, last_name: 170, medical_alerts: 340, allergies: 200 }),
    filter: { medical_alerts: { _nnull: true } },
  },
];
