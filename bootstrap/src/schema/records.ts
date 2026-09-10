import type { Collection } from "../types.js";
import { pk, clinicRef, timestamps, divider, status } from "./_helpers.js";

/**
 * Clinical notes, medical history and consent — the medico-legal layer.
 *
 * The thing this replaces was a mutable free-text field on the patient,
 * which is the shape record-keeping guidance specifically rules out. Not
 * the GDC, incidentally: GDC standard 4.1 requires records to be
 * "contemporaneous, complete and accurate" and guidance 4.1.5 requires
 * that amendments be "clearly marked up and dated", but Principle 4 says
 * nothing about deletion. The append-only requirement comes from
 * FGDP(UK) Clinical Examination and Record-Keeping, which asks for
 * "a full audit trail facility... to prevent the overwriting, erasure or
 * corruption of data", entries signed off and locked, and — where a
 * correction cannot be made before locking — "an entry should be inserted
 * as soon as any error is discovered, drawing attention to the original
 * entry and error", with void entries remaining printable.
 *
 * So: notes are entries, never edits. A correction is a new entry that
 * points at the one it corrects, and the original stays legible. That is
 * the paper convention — a single line through the error, initialled —
 * expressed in a schema.
 */
export const clinicalNotes: Collection = {
  collection: "clinical_notes",
  meta: {
    icon: "history_edu",
    note: "$t:enamel_note_clinical_notes",
    display_template: "{{written_on}} — {{patient.last_name}}",
    sort: 5,
    group: "clinical",
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "patient",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{last_name}}, {{first_name}}" },
        width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "written_on",
      type: "timestamp",
      meta: {
        interface: "datetime", required: true, width: "half",
        note: "$t:enamel_note_written_on",
      },
      schema: { is_nullable: false },
    },
    {
      field: "author",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{first_name}} {{last_name}}" },
        width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "kind",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        display: "labels",
        display_options: {
          choices: [
            { text: "$t:enamel_cn_examination", value: "examination", color: "#0D6E63" },
            { text: "$t:enamel_cn_treatment", value: "treatment", color: "#2ECDA7" },
            { text: "$t:enamel_cn_telephone", value: "telephone", color: "#A2B5CD" },
            { text: "$t:enamel_cn_amendment", value: "amendment", color: "#B4762A" },
          ],
        },
        options: {
          choices: [
            { text: "$t:enamel_cn_examination", value: "examination" },
            { text: "$t:enamel_cn_treatment", value: "treatment" },
            { text: "$t:enamel_cn_telephone", value: "telephone" },
            { text: "$t:enamel_cn_amendment", value: "amendment" },
          ],
        },
      },
      schema: { default_value: "examination", is_nullable: false },
    },
    {
      field: "body",
      type: "text",
      meta: {
        interface: "input-multiline", required: true,
        note: "$t:enamel_note_note_body",
      },
      schema: { is_nullable: false },
    },
    divider("$t:enamel_div_note_amendment", "divider_note_amendment", "edit_note"),
    {
      /**
       * An amendment does not replace anything. It points at the entry it
       * corrects, both stay in the record, and the reader sees the
       * sequence — which is what "drawing attention to the original entry
       * and error" means in practice.
       */
      field: "amends",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_amends",
        options: { template: "{{written_on}} — {{kind}}" },
        conditions: [
          { name: "Amendments only", rule: { kind: { _neq: "amendment" } }, hidden: true },
        ],
      },
      schema: {},
    },
    {
      field: "amendment_reason",
      type: "string",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_amendment_reason",
        conditions: [
          { name: "Amendments only", rule: { kind: { _neq: "amendment" } }, hidden: true },
        ],
      },
      schema: {},
    },
    {
      /**
       * Locking is what an audit trail is for. A locked entry is the
       * record; anything after it is a new entry. Nothing here deletes.
       */
      field: "locked_on",
      type: "timestamp",
      meta: {
        interface: "datetime", readonly: true, width: "half",
        note: "$t:enamel_note_locked_on",
      },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "clinical_notes", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "clinical_notes",
      field: "patient",
      related_collection: "patients",
      meta: { one_field: "clinical_note_entries" },
      schema: { on_delete: "CASCADE" },
    },
    { collection: "clinical_notes", field: "author", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "clinical_notes", field: "amends", related_collection: "clinical_notes", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

/**
 * Medical history, which is two things at once and has to be modelled as
 * both.
 *
 * A **snapshot**: the form the patient filled in and signed, on a date.
 * Updating it does not edit it — it pre-fills a new copy for the patient
 * to amend and sign, and "changes are saved to the new form; they do not
 * overwrite the original". FGDP 8.9.1 is blunt about the consequence:
 * "The system should NOT delete the previous medical history."
 *
 * And **current state**: the structured allergies, medications and
 * problems a clinician acts on today, which live in their own collections
 * because a free-text summary is not something you can safely filter a
 * worklist on.
 *
 * The two coexist. The snapshot is what the patient asserted and when;
 * the structured rows are what the practice believes now.
 */
export const medicalHistories: Collection = {
  collection: "medical_histories",
  meta: {
    icon: "clinical_notes",
    note: "$t:enamel_note_medical_histories",
    display_template: "{{taken_on}} — {{patient.last_name}}",
    sort: 4,
    group: "clinical",
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "patient",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{last_name}}, {{first_name}}" },
        width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "taken_on",
      type: "date",
      meta: {
        interface: "datetime", required: true, width: "half",
        note: "$t:enamel_note_history_taken_on",
        validation: { taken_on: { _lte: "$NOW" } },
        validation_message: "$t:enamel_vm_history_future",
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Three states, not a boolean. An imported medical history carries
       * "yes, no and unknown", and unknown is the answer that changes what
       * a clinician does next — it is not a missing value.
       */
      field: "pregnant",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        options: {
          choices: [
            { text: "$t:enamel_yn_yes", value: "yes" },
            { text: "$t:enamel_yn_no", value: "no" },
            { text: "$t:enamel_yn_unknown", value: "unknown" },
          ],
        },
      },
      schema: { default_value: "unknown" },
    },
    {
      field: "smoker",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        options: {
          choices: [
            { text: "$t:enamel_yn_yes", value: "yes" },
            { text: "$t:enamel_yn_no", value: "no" },
            { text: "$t:enamel_yn_unknown", value: "unknown" },
          ],
        },
      },
      schema: { default_value: "unknown" },
    },
    {
      field: "anticoagulants",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_anticoagulants",
        options: {
          choices: [
            { text: "$t:enamel_yn_yes", value: "yes" },
            { text: "$t:enamel_yn_no", value: "no" },
            { text: "$t:enamel_yn_unknown", value: "unknown" },
          ],
        },
      },
      schema: { default_value: "unknown" },
    },
    {
      field: "summary",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_history_summary" },
      schema: {},
    },
    divider("$t:enamel_div_history_signature", "divider_history_signature", "draw"),
    {
      field: "signed_on",
      type: "timestamp",
      meta: {
        interface: "datetime", width: "half",
        note: "$t:enamel_note_history_signed_on",
      },
      schema: {},
    },
    {
      /**
       * Supersession is recorded forwards, not by deletion. The newest
       * unsuperseded history is the current one; every earlier one stays
       * exactly as the patient signed it.
       */
      field: "superseded_by",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], readonly: true, width: "half",
        note: "$t:enamel_note_superseded_by",
        options: { template: "{{taken_on}}" },
      },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "medical_histories", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "medical_histories",
      field: "patient",
      related_collection: "patients",
      meta: { one_field: "medical_histories" },
      schema: { on_delete: "CASCADE" },
    },
    { collection: "medical_histories", field: "superseded_by", related_collection: "medical_histories", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

/** One current-state clinical fact: an allergy, a drug, or a condition. */
export const patientFindings: Collection = {
  collection: "patient_findings",
  meta: {
    icon: "warning",
    note: "$t:enamel_note_patient_findings",
    display_template: "{{category}}: {{label}}",
    sort: 12,
    group: "clinical",
    archive_field: "status",
    archive_value: "inactive",
    unarchive_value: "active",
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "patient",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{last_name}}, {{first_name}}" },
        width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "category",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        display: "labels",
        display_options: {
          choices: [
            { text: "$t:enamel_pf_allergy", value: "allergy", color: "#E35169" },
            { text: "$t:enamel_pf_medication", value: "medication", color: "#3399FF" },
            { text: "$t:enamel_pf_problem", value: "problem", color: "#B4762A" },
          ],
        },
        options: {
          choices: [
            { text: "$t:enamel_pf_allergy", value: "allergy" },
            { text: "$t:enamel_pf_medication", value: "medication" },
            { text: "$t:enamel_pf_problem", value: "problem" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      field: "label",
      type: "string",
      meta: {
        interface: "input", required: true, width: "half",
        options: { placeholder: "Penicillin" },
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Two states, and neither of them is deletion. An allergy the
       * patient turns out not to have is *inactive*, not absent: the fact
       * that it was once believed is part of the record.
       */
      field: "status",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_finding_status",
        display: "labels",
        display_options: {
          choices: [
            { text: "$t:enamel_s_active", value: "active", color: "#2ECDA7" },
            { text: "$t:enamel_s_inactive", value: "inactive", color: "#A2B5CD" },
          ],
        },
        options: {
          choices: [
            { text: "$t:enamel_s_active", value: "active" },
            { text: "$t:enamel_s_inactive", value: "inactive" },
          ],
        },
      },
      schema: { default_value: "active", is_nullable: false },
    },
    {
      field: "severity",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_severity",
        options: {
          choices: [
            { text: "$t:enamel_sv_mild", value: "mild" },
            { text: "$t:enamel_sv_moderate", value: "moderate" },
            { text: "$t:enamel_sv_severe", value: "severe" },
          ],
        },
        conditions: [
          { name: "Allergies only", rule: { category: { _neq: "allergy" } }, hidden: true },
        ],
      },
      schema: {},
    },
    {
      field: "noted_on",
      type: "date",
      meta: { interface: "datetime", width: "half" },
      schema: {},
    },
    {
      field: "note",
      type: "text",
      meta: { interface: "input-multiline" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "patient_findings", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "patient_findings",
      field: "patient",
      related_collection: "patients",
      meta: { one_field: "findings" },
      schema: { on_delete: "CASCADE" },
    },
  ],
};

/**
 * Consent.
 *
 * The instinct is to store the PDF you printed. Open Dental does the
 * opposite, and it is right: it keeps the structured answers and a
 * signature "electronically linked to the data it applies to", and the
 * signature is invalidated if that data changes. A rendered document
 * cannot do that — it goes stale silently, and you find out in a
 * complaint.
 *
 * So the retention unit here is the answers plus a signature that knows
 * what it signed. `data_fingerprint` is that link: change the answers and
 * it no longer matches, which is what marks a signature invalid rather
 * than quietly leaving it attached to something else.
 */
export const consents: Collection = {
  collection: "consents",
  meta: {
    icon: "how_to_reg",
    note: "$t:enamel_note_consents",
    display_template: "{{title}} — {{patient.last_name}}",
    sort: 13,
    group: "clinical",
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "patient",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{last_name}}, {{first_name}}" },
        width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "title",
      type: "string",
      meta: {
        interface: "input", required: true, width: "half",
        options: { placeholder: "Surgical extraction, lower right first molar" },
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Linkage to a plan is optional, not intrinsic — a consent form is
       * built from a template and only carries procedures when the
       * template asks for them. Modelling it as mandatory would be a
       * guess dressed as a constraint.
       */
      field: "treatment_plan",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        note: "$t:enamel_note_consent_plan",
        options: { template: "{{title}}" },
      },
      schema: {},
    },
    {
      field: "risks_discussed",
      type: "text",
      meta: { interface: "input-multiline", required: true, note: "$t:enamel_note_risks" },
      schema: { is_nullable: false },
    },
    {
      field: "alternatives_discussed",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_alternatives" },
      schema: {},
    },
    divider("$t:enamel_div_consent_signature", "divider_consent_signature", "draw"),
    {
      field: "signed_on",
      type: "timestamp",
      meta: { interface: "datetime", width: "half" },
      schema: {},
    },
    {
      field: "witnessed_by",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        options: { template: "{{first_name}} {{last_name}}" },
      },
      schema: {},
    },
    {
      /**
       * A hash of what was signed. Not decoration: it is the difference
       * between "the patient signed this" and "the patient signed
       * something that used to be here".
       */
      field: "data_fingerprint",
      type: "string",
      meta: {
        interface: "input", readonly: true, width: "half",
        note: "$t:enamel_note_fingerprint",
      },
      schema: {},
    },
    {
      field: "signature_invalidated_on",
      type: "timestamp",
      meta: {
        interface: "datetime", readonly: true, width: "half",
        note: "$t:enamel_note_invalidated",
      },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "consents", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "consents",
      field: "patient",
      related_collection: "patients",
      meta: { one_field: "consents" },
      schema: { on_delete: "CASCADE" },
    },
    { collection: "consents", field: "treatment_plan", related_collection: "treatment_plans", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "consents", field: "witnessed_by", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};
