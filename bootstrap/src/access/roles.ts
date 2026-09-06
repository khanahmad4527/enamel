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
    name: "Patient",
    icon: "account_circle",
    description: "Portal access to their own record. No admin app.",
    policies: ["Patient portal"],
  },
];
