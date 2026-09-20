import type { Role } from "../types.js";

/**
 * Roles are thin on purpose: they compose policies rather than carrying
 * permissions of their own. Every staff role includes "Clinic member",
 * so the tenancy rule is written once and reused, and adding a new job
 * title later means composing existing policies rather than re-deriving
 * a permission matrix from scratch.
 */
export const roles: Role[] = [
  {
    name: "Practice owner",
    icon: "admin_panel_settings",
    description: "Principal dentist or practice manager. Full control of one practice.",
    policies: ["Clinic member", "Dentist", "Practice owner"],
  },
  {
    name: "Dentist",
    icon: "medical_services",
    description: "Associate dentist. Full clinical access, read-only billing.",
    policies: ["Clinic member", "Dentist"],
  },
  {
    name: "Hygienist",
    icon: "cleaning_services",
    description: "Clinical access to their own work. No billing.",
    policies: ["Clinic member", "Hygienist"],
  },
  {
    name: "Front desk",
    icon: "support_agent",
    description: "Scheduling and billing. No clinical data.",
    policies: ["Clinic member", "Front desk"],
  },
  {
    /**
     * A developer, or whoever is on call for the queues.
     *
     * Deliberately not composed with "Clinic member": every other staff
     * role includes it, and including it here would hand this account the
     * patient list it exists not to have.
     */
    name: "Queue operator",
    icon: "conveyor_belt",
    description: "Watches the job board. No access to any collection.",
    policies: ["Queue operator"],
  },
  {
    name: "Patient",
    icon: "account_circle",
    description: "Portal access to their own record. No admin app.",
    policies: ["Patient portal"],
  },
  {
    // Not a person: the public website's own read-only account. Separate
    // from every other service credential because what it can do if it
    // leaks is "read the opening hours", and that is only true while it
    // is the only thing it can do.
    name: "Website",
    icon: "public",
    description: "Service account for the public website. Read-only, public content only.",
    policies: ["Website"],
  },
  {
    // Not a person either, and deliberately a different account from the
    // reminder sweep: this one can create a login, and that is not a power
    // to share with a job that marks booleans.
    name: "Portal registrar",
    icon: "person_add",
    description: "Service account for patient self-registration. No admin access.",
    policies: ["Portal registrar"],
  },
  {
    // Not a person. The core service authenticates its reminder sweep as
    // this, and deliberately does not compose "Clinic member" — the sweep
    // runs across practices and the tenancy filter would stop it dead.
    name: "Reminder service",
    icon: "schedule_send",
    description: "Service account for the reminder sweep. No admin access.",
    policies: ["Reminder worker"],
  },
];
