import type { Collection } from "../types.js";
import { pk, timestamps, status, clinicRef, divider } from "./_helpers.js";

export const invoices: Collection = {
  collection: "invoices",
  meta: {
    icon: "receipt_long",
    note: "Billing. Hygienists have no access; front desk has no clinical context.",
    color: "#B4762A",
    display_template: "{{number}} — {{patient.last_name}}",
    sort: 1,
    group: "billing",
    archive_field: "status",
    archive_value: "void",
    unarchive_value: "draft",
  },
  fields: [
    pk(),
    clinicRef(),
    {
      field: "number",
      type: "string",
      meta: { interface: "input", readonly: true, width: "half", note: "$t:enamel_note_number" },
      schema: { is_unique: true },
    },
    {
      field: "patient",
      type: "uuid",
      meta: { interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half", options: { template: "{{last_name}}, {{first_name}}" } },
      schema: { is_nullable: false },
    },
    status(
      [
        { text: "$t:enamel_s_draft", value: "draft", color: "#A2B5CD" },
        { text: "$t:enamel_s_sent", value: "sent", color: "#6644FF" },
        { text: "$t:enamel_s_paid", value: "paid", color: "#2ECDA7" },
        { text: "$t:enamel_s_overdue", value: "overdue", color: "#E35169" },
        { text: "$t:enamel_s_void", value: "void", color: "#7A8B99" },
      ],
      "draft",
    ),
    divider("$t:enamel_div_dates", "divider_dates", "calendar_month"),
    { field: "issued_at", type: "date", meta: { interface: "datetime", width: "half" }, schema: {} },
    { field: "due_at", type: "date", meta: { interface: "datetime", width: "half" }, schema: {} },
    { field: "paid_at", type: "timestamp", meta: { interface: "datetime", width: "half", readonly: true }, schema: {} },
    divider("$t:enamel_div_amounts", "divider_amounts", "payments"),
    {
      field: "subtotal",
      type: "decimal",
      meta: { interface: "input", readonly: true, width: "half", display: "formatted-value", display_options: { prefix: "€ " },
        note: "$t:enamel_note_subtotal" },
      schema: { numeric_precision: 12, numeric_scale: 2, default_value: 0 },
    },
    {
      field: "tax_rate",
      type: "decimal",
      meta: {
        interface: "input", width: "half", display: "formatted-value", display_options: { suffix: " %" },
        validation: { tax_rate: { _between: [0, 100] } },
        validation_message: "$t:enamel_vm_vat",
      },
      schema: { numeric_precision: 5, numeric_scale: 2, default_value: 0 },
    },
    {
      field: "total",
      type: "decimal",
      meta: { interface: "input", readonly: true, width: "half", display: "formatted-value", display_options: { prefix: "€ ", bold: true } },
      schema: { numeric_precision: 12, numeric_scale: 2, default_value: 0 },
    },
    {
      field: "pdf",
      type: "uuid",
      meta: { interface: "file", special: ["file"], width: "half", note: "$t:enamel_note_pdf" },
      schema: {},
    },
    { field: "notes", type: "text", meta: { interface: "input-multiline" }, schema: {} },
    ...timestamps(),
  ],
  relations: [
    { collection: "invoices", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "invoices", field: "patient", related_collection: "patients", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "invoices", field: "pdf", related_collection: "directus_files", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

export const invoiceLines: Collection = {
  collection: "invoice_lines",
  meta: {
    icon: "list",
    note: "Line items, normally created from completed treatment records.",
    color: "#B4762A",
    display_template: "{{description}} — {{amount}}",
    sort: 2,
    group: "billing",
    hidden: true,
  },
  fields: [
    pk(),
    clinicRef(),
    {
      field: "invoice",
      type: "uuid",
      meta: { interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      field: "treatment_record",
      type: "uuid",
      meta: { interface: "select-dropdown-m2o", special: ["m2o"], width: "half" },
      schema: {},
    },
    { field: "description", type: "string", meta: { interface: "input", required: true }, schema: { is_nullable: false } },
    {
      field: "quantity",
      type: "integer",
      meta: {
        interface: "input", width: "half",
        validation: { quantity: { _gt: 0 } },
        validation_message: "$t:enamel_vm_quantity",
      },
      schema: { default_value: 1 },
    },
    {
      field: "unit_price",
      type: "decimal",
      meta: { interface: "input", width: "half", display: "formatted-value", display_options: { prefix: "€ " } },
      schema: { numeric_precision: 10, numeric_scale: 2, default_value: 0 },
    },
    {
      field: "amount",
      type: "decimal",
      // Editable, not readonly. Nothing can compute it: flows have no
      // arithmetic without the script operation, and that operation is
      // inert in this image. A readonly field with no writer is a field
      // that stays 0 while the invoice total quietly lies.
      meta: {
        interface: "input", width: "half", display: "formatted-value",
        display_options: { prefix: "€ " },
        note: "$t:enamel_note_amount",
        validation: { amount: { _gte: 0 } },
        validation_message: "$t:enamel_vm_amount_neg",
      },
      schema: { numeric_precision: 12, numeric_scale: 2, default_value: 0 },
    },
    { field: "sort", type: "integer", meta: { interface: "input", hidden: true }, schema: {} },
    ...timestamps(),
  ],
  relations: [
    { collection: "invoice_lines", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "invoice_lines",
      field: "invoice",
      related_collection: "invoices",
      // one_field creates the reciprocal O2M on invoices, so lines edit inline.
      meta: { one_field: "lines", sort_field: "sort", one_deselect_action: "delete" },
      schema: { on_delete: "CASCADE" },
    },
    { collection: "invoice_lines", field: "treatment_record", related_collection: "treatment_records", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};
