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

export const presets: Preset[] = [
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
    icon: "notification_important",
    color: "#E35169",
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
    icon: "event_upcoming",
    color: "#0D6E63",
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
    icon: "today",
    color: "#0D6E63",
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
    icon: "person_pin",
    color: "#0D6E63",
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
    icon: "notifications_active",
    color: "#B4762A",
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
    icon: "person_off",
    color: "#E35169",
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
    icon: "receipt_long",
    color: "#E35169",
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
    icon: "person_add",
    color: "#0D6E63",
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
    icon: "pending_actions",
    color: "#6644FF",
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
    icon: "task_alt",
    color: "#0D6E63",
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
    icon: "e911_emergency",
    color: "#E35169",
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
