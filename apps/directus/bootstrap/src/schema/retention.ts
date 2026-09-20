import type { Collection } from "../types.js";
import { pk, timestamps } from "./_helpers.js";

/**
 * How long each kind of record has to be kept, per practice.
 *
 * A constant in the code would be wrong, and this repository can prove
 * it: Kadehuis is in Amsterdam and Marina is in Dubai, and the two are
 * subject to **different statutory periods** — twenty years under the
 * Dutch WGBO, twenty-five under UAE Federal Law No. 2 of 2019. Germany
 * says ten. The UK says eleven, or until a child turns twenty-five.
 * There is no number that is right for all of them.
 *
 * So it is data, keyed by clinic and record type, and it carries the
 * legal basis alongside the figure — because "twenty years" with no
 * citation is a number somebody will eventually change to eighteen
 * because it seemed long.
 *
 * **Nothing here deletes anything.** These rules record what the
 * obligation *is*. Acting on one is a decision with a human in it, and a
 * system that silently destroyed clinical records on a timer would be a
 * worse problem than the one it solved. What the table makes possible is
 * answering the two questions that matter: "may we erase this yet" when a
 * patient asks under GDPR Article 17, and "what are we still obliged to
 * hold" when anybody asks at all.
 */
export const retentionRules: Collection = {
  collection: "retention_rules",
  meta: {
    icon: "gavel",
    note: "$t:enamel_note_retention",
    display_template: "{{record_type}} — {{years}} years",
    sort: 2,
    group: "governance",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "record_type",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half", display: "labels",
        options: {
          choices: [
            { text: "$t:enamel_rt_clinical", value: "clinical_record" },
            { text: "$t:enamel_rt_imaging", value: "imaging" },
            { text: "$t:enamel_rt_consent", value: "consent" },
            { text: "$t:enamel_rt_financial", value: "financial" },
            { text: "$t:enamel_rt_correspondence", value: "correspondence" },
            { text: "$t:enamel_rt_audit", value: "audit_log" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      field: "years",
      type: "integer",
      meta: {
        interface: "input", required: true, width: "half",
        note: "$t:enamel_note_retention_years",
        validation: { _and: [{ years: { _gte: 1 } }, { years: { _lte: 100 } }] },
        validation_message: "$t:enamel_vm_retention_years",
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * When the clock starts.
       *
       * The Dutch twenty years run from the **end of treatment**, not
       * from the date each note was written — so a patient seen for
       * fifteen years has notes that must be kept for thirty-five. Getting
       * this wrong in the safe direction costs storage; getting it wrong
       * in the other direction destroys evidence.
       */
      field: "starts_from",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_retention_from",
        options: {
          choices: [
            { text: "$t:enamel_rf_last_contact", value: "last_contact" },
            { text: "$t:enamel_rf_record_date", value: "record_date" },
            { text: "$t:enamel_rf_majority", value: "age_of_majority" },
          ],
        },
      },
      schema: { default_value: "last_contact" },
    },
    {
      /**
       * Required, and the reason the table is worth having.
       *
       * A figure with no citation is a figure somebody will shorten
       * because it seemed long. "WGBO, Art. 7:454 BW" is a figure
       * somebody has to argue with a statute about.
       */
      field: "legal_basis",
      type: "string",
      meta: {
        interface: "input", required: true,
        note: "$t:enamel_note_retention_basis",
        options: { placeholder: "WGBO, Art. 7:454 BW" },
      },
      schema: { is_nullable: false },
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
  ],
};

export const retentionCollections = [retentionRules];
