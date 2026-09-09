import type { Collection } from "../types.js";
import { pk, clinicRef, timestamps, divider, ALL_TOOTH_CODES, TOOTH_CODE_MESSAGE } from "./_helpers.js";

/**
 * What teeth this patient actually has.
 *
 * The naive model is a fixed chart — 32 boxes for an adult, 20 for a
 * child, picked from the date of birth. It is wrong in both directions
 * and in a third way nobody expects.
 *
 * **Fewer.** Tooth agenesis is common, not exotic: pooled prevalence of
 * hypodontia excluding third molars is around 6% of people, and the third
 * molars themselves are absent in roughly 23%. The commonest absentees
 * are the mandibular second premolars (35, 45) at 29.9% of affected
 * people, then the maxillary lateral incisors (12, 22) at 24.3%, then the
 * maxillary second premolars (15, 25) at 13.7% — Polder et al. 2004, third
 * molars excluded. About 42% of affected people are missing exactly one
 * tooth. A chart that cannot say "this tooth was never there" cannot
 * describe one person in fifteen.
 *
 * **More.** Supernumerary teeth do not fit in ISO 3950 at all, which is
 * why ISO 10394:2023 exists — see ALL_TOOTH_CODES. They are not deciduous
 * or permanent, they are not unique per location, and a documented case
 * reached 64 of them in one mouth, so nothing here caps the count.
 *
 * **Neither.** Age does not tell you which dentition a tooth belongs to.
 * Eruption timing varies enough that deriving it would misclassify a
 * large fraction of perfectly normal children, and a retained primary
 * molar in a forty-year-old is still charted with its primary
 * designation. Real systems agree on this by disagreeing with each other:
 * Open Dental uses a dual namespace and derives dentition from nothing,
 * Dentrix uses an exclusive per-position toggle a clinician sets by hand,
 * Carestream SoftDent carries both a primary and a permanent tooth at the
 * twenty succedaneous positions — and only those twenty, because the
 * twelve permanent molars have no primary predecessor to replace.
 *
 * So dentition is recorded state, not a derivation. One row per tooth the
 * clinician has actually looked at, and the absence of a row means "not
 * assessed" rather than "not there" — which is a distinction the
 * radiograph, not the calendar, is entitled to make.
 */
export const dentition: Collection = {
  collection: "dentition",
  meta: {
    icon: "dentistry",
    note: "$t:enamel_note_dentition",
    display_template: "{{designation}} · {{state}}",
    sort: 7,
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
      /**
       * Deliberately not unique per patient. ISO 10394:2023: "When
       * multiple supernumerary teeth are present in the same location,
       * the same code is used for the designation of each of those
       * supernumerary teeth." A double mesiodens is two rows both saying
       * AB, and a unique constraint here would reject a real mouth.
       */
      field: "designation",
      type: "string",
      meta: {
        interface: "input", required: true, width: "half",
        note: "$t:enamel_note_designation",
        options: { placeholder: "35" },
        validation: { designation: { _in: ALL_TOOTH_CODES } },
        validation_message: TOOTH_CODE_MESSAGE,
      },
      schema: { is_nullable: false },
    },
    {
      // A property of the tooth, never of the patient's age.
      field: "dentition_type",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        display: "labels",
        display_options: {
          showAsDot: true,
          choices: [
            { text: "$t:enamel_dent_permanent", value: "permanent", color: "#0D6E63" },
            { text: "$t:enamel_dent_deciduous", value: "deciduous", color: "#6FD8C8" },
            { text: "$t:enamel_dent_supernumerary", value: "supernumerary", color: "#B4762A" },
          ],
        },
        options: {
          choices: [
            { text: "$t:enamel_dent_permanent", value: "permanent" },
            { text: "$t:enamel_dent_deciduous", value: "deciduous" },
            { text: "$t:enamel_dent_supernumerary", value: "supernumerary" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Present, unerupted and absent are three states, not two. An
       * unerupted tooth is there — it just is not in the mouth yet, or
       * ever, and charting it as missing loses the thing a radiograph was
       * taken to establish.
       */
      field: "state",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_tooth_state",
        display: "labels",
        display_options: {
          showAsDot: true,
          choices: [
            { text: "$t:enamel_st_present", value: "present", color: "#2ECDA7" },
            { text: "$t:enamel_st_unerupted", value: "unerupted", color: "#A2B5CD" },
            { text: "$t:enamel_st_absent", value: "absent", color: "#E35169" },
          ],
        },
        options: {
          choices: [
            { text: "$t:enamel_st_present", value: "present" },
            { text: "$t:enamel_st_unerupted", value: "unerupted" },
            { text: "$t:enamel_st_absent", value: "absent" },
          ],
        },
      },
      schema: { default_value: "present", is_nullable: false },
    },
    {
      /**
       * Why it is gone, which is a different question from whether it is
       * gone — and one with consequences. Congenital absence and
       * extraction are mutually exclusive states in ICD-10-CM (K00.0
       * carries Excludes1 against K08.1-, meaning never code both), and
       * an insurer's missing-tooth clause turns the answer into money.
       * Paper charts collapse the two into one X through the tooth. This
       * does not.
       */
      field: "absence_reason",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_absence_reason",
        conditions: [
          {
            name: "Only when absent",
            rule: { state: { _neq: "absent" } },
            hidden: true,
          },
        ],
        options: {
          choices: [
            { text: "$t:enamel_ab_congenital", value: "congenital" },
            { text: "$t:enamel_ab_extracted", value: "extracted" },
            { text: "$t:enamel_ab_exfoliated", value: "exfoliated" },
            { text: "$t:enamel_ab_trauma", value: "trauma" },
            { text: "$t:enamel_ab_unknown", value: "unknown" },
          ],
        },
      },
      schema: {},
    },
    {
      // A deciduous tooth still in place past the age its successor
      // should have replaced it — usually because the successor never
      // formed. Second primary molars retained for that reason routinely
      // last into adulthood, so this is a normal row, not an anomaly.
      field: "retained",
      type: "boolean",
      meta: {
        interface: "boolean", width: "half",
        note: "$t:enamel_note_retained",
        conditions: [
          {
            name: "Deciduous only",
            rule: { dentition_type: { _neq: "deciduous" } },
            hidden: true,
          },
        ],
      },
      schema: { default_value: false, is_nullable: false },
    },
    divider("$t:enamel_div_dentition_evidence", "divider_dentition_evidence", "fact_check"),
    {
      /**
       * When somebody established this, which for congenital absence is
       * the whole of its credibility: you cannot call a tooth
       * congenitally absent before the age it would have begun to
       * calcify, and development varies widely enough that an early
       * assertion is a guess. Recording the date is what separates a
       * finding from an assumption.
       */
      field: "assessed_on",
      type: "date",
      meta: {
        interface: "datetime", width: "half",
        note: "$t:enamel_note_assessed_on",
        validation: { assessed_on: { _lte: "$NOW" } },
        validation_message: "An assessment cannot be dated in the future.",
      },
      schema: {},
    },
    {
      field: "assessed_from",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_assessed_from",
        options: {
          choices: [
            { text: "$t:enamel_ev_clinical", value: "clinical" },
            { text: "$t:enamel_ev_radiograph", value: "radiograph" },
            { text: "$t:enamel_ev_history", value: "history" },
          ],
        },
      },
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
    { collection: "dentition", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "dentition",
      field: "patient",
      related_collection: "patients",
      meta: { one_field: "dentition" },
      schema: { on_delete: "CASCADE" },
    },
  ],
};
