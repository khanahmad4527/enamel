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
