import type { Collection } from "../types.js";
import { pk, timestamps, divider } from "./_helpers.js";

/**
 * What this practice does with personal data, and on what legal footing.
 *
 * Article 30 asks a controller to keep a record of its processing
 * activities. Article 6 asks for a lawful basis for each. Most systems
 * carry neither, and answer "why do you hold this?" with a paragraph in a
 * privacy notice that nothing in the software refers to.
 *
 * ## The interesting claim is how little of this is consent
 *
 * A dental practice runs almost entirely without it. The clinical record
 * is Article 9(2)(h) — health care by a professional under an obligation
 * of secrecy — with Article 6(1)(c) underneath it, because the WGBO
 * *requires* the record to be kept for twenty years in the Netherlands.
 * Appointments and invoices are 6(1)(b), performance of a contract.
 *
 * That matters practically, not academically. A practice that asks a
 * patient to "consent" to its clinical record has told them they may
 * withdraw it — and then cannot honour the withdrawal, because the law
 * says keep the record. Article 7(3) says withdrawal must be as easy as
 * giving; a consent that cannot be withdrawn was never consent, and
 * asking for it is worse than not asking. So `lawful_basis` is a field
 * with six values and `consent` is one of them, not the default.
 *
 * What genuinely *is* consent here is narrow: the channels a practice may
 * use to reach someone beyond what the appointment itself requires, and
 * anything done with a patient's image beyond their own record.
 */
export const processingPurposes: Collection = {
  collection: "processing_purposes",
  meta: {
    icon: "gavel",
    note: "$t:enamel_note_purposes",
    display_template: "{{name}} — {{lawful_basis}}",
    sort: 5,
    group: "governance",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "code",
      type: "string",
      meta: { interface: "input", required: true, width: "half", note: "$t:enamel_note_purpose_code" },
      schema: { is_nullable: false },
    },
    {
      field: "name",
      type: "string",
      meta: { interface: "input", required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      /**
       * Article 6(1)(a)–(f). Not a free-text box: a basis a controller
       * made up is a basis it cannot defend, and the six are the six.
       */
      field: "lawful_basis",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half", display: "labels",
        options: {
          choices: [
            { text: "$t:enamel_lb_consent", value: "consent", color: "#FFA439" },
            { text: "$t:enamel_lb_contract", value: "contract", color: "#3399FF" },
            { text: "$t:enamel_lb_legal", value: "legal_obligation", color: "#2ECDA7" },
            { text: "$t:enamel_lb_vital", value: "vital_interests", color: "#E35169" },
            { text: "$t:enamel_lb_public", value: "public_task", color: "#8196B1" },
            { text: "$t:enamel_lb_legitimate", value: "legitimate_interests", color: "#A2B5CD" },
          ],
        },
        note: "$t:enamel_note_purpose_basis",
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Health data needs a second gate.
       *
       * Article 6 permits the processing; Article 9(1) prohibits health
       * data outright unless one of 9(2)'s conditions lifts it. A basis
       * under 6 alone is not enough for anything clinical, and a record
       * of processing that lists only the 6 basis is missing the half
       * that actually makes it lawful.
       */
      field: "special_category_condition",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        options: {
          choices: [
            { text: "$t:enamel_sc_none", value: "not_special_category" },
            { text: "$t:enamel_sc_9_2_a", value: "9_2_a_explicit_consent" },
            { text: "$t:enamel_sc_9_2_c", value: "9_2_c_vital_interests" },
            { text: "$t:enamel_sc_9_2_f", value: "9_2_f_legal_claims" },
            { text: "$t:enamel_sc_9_2_h", value: "9_2_h_health_care" },
          ],
        },
        note: "$t:enamel_note_purpose_special",
      },
      schema: { default_value: "not_special_category" },
    },
    {
      field: "description",
      type: "text",
      meta: { interface: "input-multiline", required: true, note: "$t:enamel_note_purpose_desc" },
      schema: { is_nullable: false },
    },
    {
      /**
       * The statute, where there is one.
       *
       * `legal_obligation` with nothing cited is an assertion. The same
       * reasoning as `retention_rules.authority`, and for the same
       * reason: two practices in this repository answer to different law.
       */
      field: "authority",
      type: "string",
      meta: { interface: "input", width: "half", note: "$t:enamel_note_purpose_authority" },
      schema: {},
    },
    divider("$t:enamel_div_purpose_consent", "divider_purpose_consent", "how_to_reg"),
    {
      /**
       * The words. Article 7(1) asks a controller to demonstrate that the
       * data subject consented — and "they ticked a box" demonstrates
       * nothing without the sentence beside the box. Versioned, because
       * the wording changes and consent given to the old sentence was
       * given to the old sentence.
       */
      field: "consent_wording",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_purpose_wording" },
      schema: {},
    },
    {
      field: "wording_version",
      type: "integer",
      meta: { interface: "input", width: "half", note: "$t:enamel_note_purpose_version" },
      schema: { default_value: 1 },
    },
    ...timestamps(),
  ],
  relations: [
  ],
};

/**
 * Every decision a patient made about a purpose, kept.
 *
 * `patients.allow_email`, `allow_sms` and `allow_whatsapp` are three
 * booleans, and three booleans are the *current state*. Article 7(1)
 * asks for something a boolean structurally cannot hold: that the
 * controller be able to **demonstrate** the data subject consented. Not
 * that they currently do — that they did, when, to which words, by what
 * route, and who was standing there.
 *
 * So this is an append-only log and not a mutable flag. A withdrawal is a
 * new row saying withdrawn; it does not edit the row that said given,
 * because Article 7(3) is explicit that withdrawal does not affect the
 * lawfulness of what was done beforehand — and a system that overwrites
 * the "given" row has destroyed the evidence that the earlier processing
 * was lawful. Same shape as `tooth_conditions`, for the same reason: the
 * current answer is the latest row, and the history is the point.
 *
 * ## What this does not do yet
 *
 * It does not *drive* the three booleans. Making a consent row the thing
 * that sets `patients.allow_sms` is the obvious next step and it is
 * blocked on a question that is not a technical one: who may decide for
 * a patient who does not decide for themselves. A parent for a child, an
 * attorney for an adult who lacks capacity — `given_by` exists for that
 * and is deliberately nullable until the answer is known. Wiring it up
 * first and answering afterwards would bake the one-to-one assumption
 * into the column that records who consented.
 *
 * A check asserts the register and the booleans agree, so the two cannot
 * quietly drift while they remain separate.
 */
export const consentRecords: Collection = {
  collection: "consent_records",
  meta: {
    icon: "fact_check",
    note: "$t:enamel_note_consent_records",
    display_template: "{{patient.last_name}} — {{purpose.name}} — {{decision}}",
    sort: 6,
    group: "governance",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "patient",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half",
        options: { template: "{{last_name}}, {{first_name}}" },
      },
      schema: { is_nullable: false },
    },
    {
      field: "purpose",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true, width: "half",
        options: { template: "{{name}} — {{lawful_basis}}" },
      },
      schema: { is_nullable: false },
    },
    {
      field: "decision",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half", display: "labels",
        options: {
          choices: [
            { text: "$t:enamel_cd_given", value: "given", color: "#2ECDA7" },
            { text: "$t:enamel_cd_withdrawn", value: "withdrawn", color: "#E35169" },
            { text: "$t:enamel_cd_refused", value: "refused", color: "#8196B1" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      field: "decided_on",
      type: "timestamp",
      meta: { interface: "datetime", required: true, width: "half", note: "$t:enamel_note_consent_when" },
      schema: { is_nullable: false },
    },
    {
      /**
       * How it was collected. Article 7(2) cares that the request was
       * distinguishable and in plain language, and you cannot judge that
       * without knowing whether it was a portal checkbox, a sentence
       * somebody read out on the telephone, or a line in a paper form
       * the patient signed for something else.
       */
      field: "route",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        options: {
          choices: [
            { text: "$t:enamel_cr_portal", value: "portal" },
            { text: "$t:enamel_cr_in_surgery", value: "in_surgery" },
            { text: "$t:enamel_cr_telephone", value: "telephone" },
            { text: "$t:enamel_cr_paper", value: "paper_form" },
            { text: "$t:enamel_cr_migrated", value: "migrated" },
          ],
        },
        note: "$t:enamel_note_consent_route",
      },
      schema: { is_nullable: false },
    },
    divider("$t:enamel_div_consent_evidence", "divider_consent_evidence", "history_edu"),
    {
      /**
       * The sentence they actually saw, copied in rather than linked.
       *
       * A link to the purpose would follow the wording forward: change
       * the text and every past consent would silently claim to have been
       * given to the new words. This is the same argument as
       * `invoice_lines` storing the fee rather than pointing at the
       * price list.
       */
      field: "wording_shown",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_consent_wording" },
      schema: {},
    },
    {
      field: "wording_version",
      type: "integer",
      meta: { interface: "input", width: "half", note: "$t:enamel_note_consent_version" },
      schema: {},
    },
    {
      /**
       * Who decided, when it was not the patient.
       *
       * Null means the patient themselves. Non-null is a proxy, and the
       * shape of that link is the open question this register is
       * deliberately not answering — see the note on the collection.
       */
      field: "given_by",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        options: { template: "{{first_name}} {{last_name}}" },
        note: "$t:enamel_note_consent_given_by",
      },
      schema: {},
    },
    {
      // Who typed it in. Different from `given_by`: a receptionist
      // recording a decision a patient made on the telephone did not
      // make the decision.
      field: "recorded_by",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        options: { template: "{{first_name}} {{last_name}}" },
        note: "$t:enamel_note_consent_recorded_by",
      },
      schema: {},
    },
    {
      field: "note",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_consent_note" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "consent_records", field: "patient", related_collection: "patients", meta: {}, schema: { on_delete: "CASCADE" } },
    { collection: "consent_records", field: "purpose", related_collection: "processing_purposes", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "consent_records", field: "given_by", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "consent_records", field: "recorded_by", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

export const consentRegisterCollections = [processingPurposes, consentRecords];
