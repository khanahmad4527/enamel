import type { Collection } from "../types.js";
import { pk, timestamps, status, clinicRef, divider, ALL_FDI } from "./_helpers.js";

/** Catalogue of billable procedures. */
export const treatments: Collection = {
  collection: "treatments",
  meta: {
    icon: "medical_services",
    note: "Procedure catalogue with default pricing and chair time.",
    color: "#0D6E63",
    display_template: "{{code}} — {{name}}",
    sort: 3,
    group: "clinical",
  },
  fields: [
    pk(),
    clinicRef(),
    {
      field: "code",
      type: "string",
      meta: { interface: "input", required: true, width: "half", note: "$t:enamel_note_code" },
      schema: { is_nullable: false },
    },
    { field: "name", type: "string", meta: { interface: "input", required: true, width: "half" }, schema: { is_nullable: false } },
    {
      field: "category",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        options: { choices: [
          { text: "Diagnostic", value: "diagnostic" }, { text: "Preventive", value: "preventive" },
          { text: "Restorative", value: "restorative" }, { text: "Endodontic", value: "endodontic" },
          { text: "Periodontic", value: "periodontic" }, { text: "Prosthodontic", value: "prosthodontic" },
          { text: "Oral surgery", value: "surgery" }, { text: "Orthodontic", value: "orthodontic" },
        ] },
      },
      schema: {},
    },
    {
      field: "duration_minutes",
      type: "integer",
      meta: {
        interface: "input", width: "half", note: "$t:enamel_note_duration",
        validation: { duration_minutes: { _between: [5, 480] } },
        validation_message: "Chair time must be between 5 and 480 minutes.",
      },
      schema: { default_value: 30 },
    },
    {
      field: "default_price",
      type: "decimal",
      meta: {
        interface: "input", width: "half", display: "formatted-value", display_options: { prefix: "€ " },
        validation: { default_price: { _gte: 0 } },
        validation_message: "A price cannot be negative.",
      },
      schema: { numeric_precision: 10, numeric_scale: 2, default_value: 0 },
    },
    {
      field: "requires_tooth",
      type: "boolean",
      meta: { interface: "boolean", width: "half", note: "$t:enamel_note_requires_tooth" },
      schema: { default_value: false },
    },
    { field: "description", type: "text", meta: { interface: "input-multiline" }, schema: {} },
    { field: "active", type: "boolean", meta: { interface: "boolean", width: "half" }, schema: { default_value: true } },
    ...timestamps(),
  ],
  relations: [
    { collection: "treatments", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
  ],
};

/** What was actually performed, on which tooth, by whom. */
export const treatmentRecords: Collection = {
  collection: "treatment_records",
  meta: {
    icon: "history_edu",
    note: "Clinical record of work performed. Invisible to front-desk policies.",
    color: "#0D6E63",
    display_template: "{{treatment.name}} — {{tooth_fdi}}",
    sort: 4,
    group: "clinical",
  },
  fields: [
    pk(),
    clinicRef(),
    {
      field: "patient",
      type: "uuid",
      meta: { interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half", options: { template: "{{last_name}}, {{first_name}}" } },
      schema: { is_nullable: false },
    },
    {
      field: "appointment",
      type: "uuid",
      meta: { interface: "select-dropdown-m2o", special: ["m2o"], width: "half" },
      schema: {},
    },
    {
      field: "treatment",
      type: "uuid",
      meta: { interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half", options: { template: "{{code}} — {{name}}" } },
      schema: { is_nullable: false },
    },
    {
      field: "practitioner",
      type: "uuid",
      meta: { interface: "select-dropdown-m2o", special: ["m2o"], width: "half", options: { template: "{{first_name}} {{last_name}}" } },
      schema: {},
    },
    divider("$t:enamel_div_tooth", "divider_tooth", "dentistry"),
    {
      field: "tooth_fdi",
      type: "integer",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_tooth_fdi",
        // FDI skips 19, 20, 29 and so on, so an explicit list beats a range.
        validation: { _or: [{ tooth_fdi: { _null: true } }, { tooth_fdi: { _in: ALL_FDI } }] },
        validation_message: "Not a valid FDI tooth number (11–18, 21–28, 31–38, 41–48 adult; 51–85 deciduous).",
      },
      schema: {},
    },
    {
      field: "surfaces",
      type: "csv",
      meta: {
        interface: "select-multiple-checkbox", special: ["cast-csv"], width: "half",
        options: { choices: [
          { text: "Mesial", value: "M" }, { text: "Occlusal", value: "O" },
          { text: "Distal", value: "D" }, { text: "Buccal", value: "B" },
          { text: "Lingual", value: "L" },
        ] },
      },
      schema: {},
    },
    divider("$t:enamel_div_outcome", "divider_outcome", "task_alt"),
    {
      field: "performed_at",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", display: "datetime" },
      schema: {},
    },
    {
      field: "price",
      type: "decimal",
      meta: {
        interface: "input", width: "half", display: "formatted-value", display_options: { prefix: "€ " },
        validation: { price: { _gte: 0 } },
        validation_message: "A price cannot be negative.",
      },
      schema: { numeric_precision: 10, numeric_scale: 2, default_value: 0 },
    },
    status(
      [
        { text: "$t:enamel_s_planned", value: "planned", color: "#6644FF" },
        { text: "$t:enamel_s_completed", value: "completed", color: "#2ECDA7" },
        { text: "$t:enamel_s_cancelled", value: "cancelled", color: "#A2B5CD" },
      ],
      "planned",
    ),
    { field: "notes", type: "text", meta: { interface: "input-rich-text-md" }, schema: {} },
    ...timestamps(),
  ],
  relations: [
    { collection: "treatment_records", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "treatment_records", field: "patient", related_collection: "patients", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "treatment_records", field: "appointment", related_collection: "appointments", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "treatment_records", field: "treatment", related_collection: "treatments", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "treatment_records", field: "practitioner", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

/**
 * An append-only log of tooth findings rather than 32 mutable rows per
 * patient. A chart is a view over history: "what is tooth 26 today" is
 * the latest row, and the whole clinical timeline stays intact.
 */
export const toothConditions: Collection = {
  collection: "tooth_conditions",
  meta: {
    icon: "dentistry",
    note: "Append-only findings per tooth. The chart interface reads this.",
    color: "#0D6E63",
    display_template: "{{tooth_fdi}} — {{condition}}",
    sort: 5,
    group: "clinical",
  },
  fields: [
    pk(),
    clinicRef(),
    {
      field: "patient",
      type: "uuid",
      meta: { interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half", options: { template: "{{last_name}}, {{first_name}}" } },
      schema: { is_nullable: false },
    },
    {
      field: "tooth_fdi",
      type: "integer",
      meta: {
        interface: "input", required: true, width: "half", note: "FDI notation.",
        validation: { tooth_fdi: { _in: ALL_FDI } },
        validation_message: "Not a valid FDI tooth number.",
      },
      schema: { is_nullable: false },
    },
    {
      field: "surface",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        options: { choices: [
          { text: "Whole tooth", value: "whole" }, { text: "Mesial", value: "M" },
          { text: "Occlusal", value: "O" }, { text: "Distal", value: "D" },
          { text: "Buccal", value: "B" }, { text: "Lingual", value: "L" },
        ] },
      },
      schema: { default_value: "whole" },
    },
    {
      field: "condition",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half", display: "labels",
        display_options: { showAsDot: true },
        options: { choices: [
          { text: "Healthy", value: "healthy", color: "#2ECDA7" },
          { text: "Caries", value: "caries", color: "#E35169" },
          { text: "Filled", value: "filled", color: "#3399FF" },
          { text: "Crown", value: "crown", color: "#FFC23B" },
          { text: "Root canal", value: "root_canal", color: "#A855F7" },
          { text: "Implant", value: "implant", color: "#0D6E63" },
          { text: "Missing", value: "missing", color: "#7A8B99" },
          { text: "Fractured", value: "fractured", color: "#F97316" },
        ] },
      },
      schema: { is_nullable: false },
    },
    {
      field: "recorded_at",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", display: "datetime" },
      schema: {},
    },
    {
      field: "treatment_record",
      type: "uuid",
      meta: { interface: "select-dropdown-m2o", special: ["m2o"], width: "half", note: "$t:enamel_note_treatment_record" },
      schema: {},
    },
    { field: "notes", type: "text", meta: { interface: "input-multiline" }, schema: {} },
    ...timestamps(),
  ],
  relations: [
    { collection: "tooth_conditions", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "tooth_conditions", field: "patient", related_collection: "patients", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "tooth_conditions", field: "treatment_record", related_collection: "treatment_records", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};
