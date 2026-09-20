import type { Collection, Field } from "../types.js";
import { pk, timestamps, divider, status } from "./_helpers.js";

/**
 * Money received, and the accounting batches it was posted in.
 *
 * Before this there was no record of a payment at all — `invoices.paid_at`
 * was the whole story, which answers "is it settled" and nothing else. It
 * cannot answer "how did they pay", "which card reference does this bank
 * line match", "what was refunded", or the one that matters when a
 * gateway times out and the receptionist presses the button again: "did
 * that charge already go through".
 */
export const payments: Collection = {
  collection: "payments",
  meta: {
    icon: "payments",
    note: "$t:enamel_note_payments",
    display_template: "{{amount}} — {{patient.last_name}} ({{method}})",
    sort: 3,
    group: "billing",
    archive_field: "status",
    archive_value: "void",
    unarchive_value: "settled",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "invoice",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        options: { template: "{{number}} — {{total}}" },
        note: "$t:enamel_note_payment_invoice",
      },
      schema: {},
    },
    {
      field: "patient",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half",
        options: { template: "{{first_name}} {{last_name}} ({{reference}})" },
      },
      schema: { is_nullable: false },
    },
    {
      field: "amount",
      type: "decimal",
      meta: {
        interface: "input", required: true, width: "half",
        note: "$t:enamel_note_payment_sum",
        // Negative is a refund, and it is the same row shape on purpose:
        // a refund is a movement of money, not a different kind of thing,
        // and a separate `refunds` table means every balance is a union.
        validation: { amount: { _neq: 0 } },
        validation_message: "$t:enamel_vm_payment_zero",
      },
      schema: { numeric_precision: 10, numeric_scale: 2, is_nullable: false },
    },
    {
      field: "method",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half", display: "labels",
        options: {
          choices: [
            { text: "$t:enamel_pay_card", value: "card" },
            { text: "$t:enamel_pay_cash", value: "cash" },
            { text: "$t:enamel_pay_bank", value: "bank_transfer" },
            { text: "$t:enamel_pay_plan", value: "payment_plan" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    status(
      [
        { text: "$t:enamel_s_pending", value: "pending", color: "#FFA439" },
        { text: "$t:enamel_s_settled", value: "settled", color: "#2ECDA7" },
        { text: "$t:enamel_s_failed", value: "failed", color: "#E35169" },
        { text: "$t:enamel_s_void", value: "void", color: "#A2B5CD" },
      ],
      "pending",
    ),
    divider("$t:enamel_div_payment_provider", "divider_payment_provider", "hub"),
    {
      /**
       * Which adapter took it. `desk` is not a gateway — it is a
       * receptionist recording cash — and naming it here rather than
       * leaving it null keeps "how was this taken" a single question with
       * a single answer.
       */
      field: "provider",
      type: "string",
      meta: {
        interface: "input", readonly: true, width: "half",
        note: "$t:enamel_note_payment_provider",
      },
      schema: {},
    },
    {
      field: "provider_reference",
      type: "string",
      meta: {
        interface: "input", readonly: true, width: "half",
        note: "$t:enamel_note_payment_reference",
      },
      schema: {},
    },
    {
      /**
       * The column that stops a patient being charged twice.
       *
       * A gateway that times out has not told you whether it took the
       * money. The receptionist sees a spinner, then an error, and presses
       * the button again — and the honest answer to "what happens now" has
       * to be decided here rather than hoped about. Unique, so the second
       * attempt collides with the first and the adapter returns the
       * original result instead of moving more money.
       *
       * Unique across the whole table rather than per clinic, because a
       * key is a random string and scoping it would only make the
       * constraint harder to reason about without making anything safer.
       */
      field: "idempotency_key",
      type: "string",
      meta: {
        interface: "input", readonly: true, hidden: true,
        note: "$t:enamel_note_idempotency",
      },
      schema: { is_unique: true },
    },
    {
      field: "failure_reason",
      type: "string",
      meta: { interface: "input", readonly: true, note: "$t:enamel_note_payment_failure" },
      schema: {},
    },
    {
      field: "received_at",
      type: "timestamp",
      meta: { interface: "datetime", width: "half", note: "$t:enamel_note_received_at" },
      schema: {},
    },
    divider("$t:enamel_div_payment_posting", "divider_payment_posting", "receipt_long"),
    {
      /**
       * The batch this was posted in, or null if it has not been.
       *
       * This is what makes the accounting export idempotent: a row that
       * already points at a batch is never exported again. A date range
       * would not be enough — a payment entered late, dated last week, is
       * exactly the row a "everything between these dates" query exports
       * twice.
       */
      field: "ledger_export",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], readonly: true, width: "half",
        options: { template: "{{reference}}" },
        note: "$t:enamel_note_ledger_export",
      },
      schema: {},
    },
    { field: "note", type: "text", meta: { interface: "input-multiline" }, schema: {} },
    ...timestamps(),
  ],
  relations: [
    {
      collection: "payments", field: "invoice", related_collection: "invoices",
      meta: { one_field: "payments" },
      // SET NULL, not CASCADE. Deleting an invoice must not delete the
      // record that money changed hands — that money still left a
      // patient's account, and a missing payment row is a reconciliation
      // that will never balance again.
      schema: { on_delete: "SET NULL" },
    },
    {
      collection: "payments", field: "patient", related_collection: "patients",
      meta: { one_field: "payments" }, schema: { on_delete: "CASCADE" },
    },
    {
      collection: "payments", field: "ledger_export", related_collection: "ledger_exports",
      meta: { one_field: "payments" }, schema: { on_delete: "SET NULL" },
    },
  ],
};

/**
 * One accounting export, as a row.
 *
 * The batch exists so the export can be idempotent, and idempotent is the
 * only property an accounting export really has to have. Posting the same
 * invoice into a ledger twice does not produce an obvious error — it
 * produces a set of books that is wrong by exactly one invoice, and
 * nobody finds out until a reconciliation months later.
 *
 * So: rows are claimed by a batch as they are exported, and a claimed row
 * is never offered again. The checksum is what a bookkeeper compares
 * against the file they were sent, because a batch row saying 40 lines
 * and a file containing 39 is a question worth being able to ask.
 */
export const ledgerExports: Collection = {
  collection: "ledger_exports",
  meta: {
    icon: "receipt_long",
    note: "$t:enamel_note_ledger_exports",
    display_template: "{{reference}} — {{line_count}} lines",
    sort: 4,
    group: "billing",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "reference",
      type: "string",
      meta: { interface: "input", readonly: true, required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      field: "format",
      type: "string",
      meta: {
        interface: "select-dropdown", readonly: true, width: "half", display: "labels",
        options: {
          choices: [
            { text: "$t:enamel_ledger_journal_csv", value: "journal_csv" },
            { text: "$t:enamel_ledger_mock_api", value: "mock_api" },
          ],
        },
      },
      schema: {},
    },
    { field: "period_start", type: "date", meta: { interface: "datetime", readonly: true, width: "half" }, schema: {} },
    { field: "period_end", type: "date", meta: { interface: "datetime", readonly: true, width: "half" }, schema: {} },
    {
      field: "line_count",
      type: "integer",
      meta: { interface: "input", readonly: true, width: "half" },
      schema: {},
    },
    {
      field: "total_debits",
      type: "decimal",
      meta: { interface: "input", readonly: true, width: "half", note: "$t:enamel_note_total_debits" },
      schema: { numeric_precision: 12, numeric_scale: 2 },
    },
    {
      field: "total_credits",
      type: "decimal",
      meta: { interface: "input", readonly: true, width: "half", note: "$t:enamel_note_total_credits" },
      schema: { numeric_precision: 12, numeric_scale: 2 },
    },
    {
      /**
       * sha256 of the file that was produced.
       *
       * So "is this the file you sent us" is answerable a year later
       * without keeping a copy of every export in the database.
       */
      field: "checksum",
      type: "string",
      meta: { interface: "input", readonly: true, note: "$t:enamel_note_checksum" },
      schema: {},
    },
    {
      field: "file",
      type: "uuid",
      meta: { interface: "file", special: ["file"], note: "$t:enamel_note_ledger_file" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "ledger_exports", field: "file", related_collection: "directus_files", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

/**
 * Added to `invoices` rather than declared here, for the same reason
 * `payments.ledger_export` exists: an invoice that has been posted is
 * never posted again.
 */
export const invoiceLedgerField: Field = {
  field: "ledger_export",
  type: "uuid",
  meta: {
    interface: "select-dropdown-m2o",
    special: ["m2o"],
    readonly: true,
    width: "half",
    group: null,
    options: { template: "{{reference}}" },
    note: "$t:enamel_note_ledger_export",
  },
  schema: {},
};

export const integrationCollections = [ledgerExports, payments];
