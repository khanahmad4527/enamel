import type { Collection } from "../types.js";
import { pk, clinicRef, timestamps, divider, PERMANENT_FDI } from "./_helpers.js";

/**
 * Periodontal screening and charting.
 *
 * Two different acts, so two different shapes. A BPE is a *screen* — six
 * numbers, thirty seconds — and the BSP is explicit that it "should be
 * used for screening only and should not be used for diagnosis" and
 * "cannot be used to monitor the response to periodontal therapy". A full
 * chart is six measurements per tooth and is what you monitor with. Fold
 * them together and you get a screen pretending to be a chart.
 */

const SEXTANTS = [
  { text: "$t:enamel_sx_ur", value: "UR" },
  { text: "$t:enamel_sx_ua", value: "UA" },
  { text: "$t:enamel_sx_ul", value: "UL" },
  { text: "$t:enamel_sx_lr", value: "LR" },
  { text: "$t:enamel_sx_la", value: "LA" },
  { text: "$t:enamel_sx_ll", value: "LL" },
];

/**
 * The BPE screen.
 *
 * `guideline_version` is not bureaucracy. The asterisk meant total
 * attachment loss before 2011 and furcation involvement from 2011; the
 * third-molar rule changed in 2016; and the pre-2016 rule that carried a
 * single remaining tooth into the adjoining sextant was dropped. A code
 * recorded in 2009 and one recorded today are not the same measurement,
 * and without the version you cannot tell them apart.
 */
export const perioScreenings: Collection = {
  collection: "perio_screenings",
  meta: {
    icon: "rule",
    note: "$t:enamel_note_perio_screenings",
    display_template: "{{examined_on}} — {{patient.last_name}}",
    sort: 14,
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
        options: { template: "{{last_name}}, {{first_name}}" }, width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "examined_on",
      type: "date",
      meta: {
        interface: "datetime", required: true, width: "half",
        validation: { examined_on: { _lte: "$NOW" } },
        validation_message: "$t:enamel_vm_screening_future",
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * The simplified BPE for children is not a variant of the adult one
       * at row level — different teeth, different permitted codes — so it
       * is recorded as a different instrument rather than a flag.
       */
      field: "instrument",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_instrument",
        options: {
          choices: [
            { text: "BPE", value: "BPE" },
            { text: "sBPE (under 18)", value: "sBPE" },
          ],
        },
      },
      schema: { default_value: "BPE", is_nullable: false },
    },
    {
      field: "guideline_version",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_guideline_version",
        options: {
          choices: [
            { text: "BSP BPE 2019", value: "BSP_BPE_2019" },
            { text: "BSP BPE 2016", value: "BSP_BPE_2016" },
            { text: "BSP BPE 2011", value: "BSP_BPE_2011" },
            { text: "BSP/BSPD sBPE 2021", value: "BSP_BSPD_sBPE_2021" },
          ],
        },
      },
      schema: { default_value: "BSP_BPE_2019", is_nullable: false },
    },
    {
      field: "examiner",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        options: { template: "{{first_name}} {{last_name}}" },
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
    { collection: "perio_screenings", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "perio_screenings", field: "patient", related_collection: "patients",
      meta: { one_field: "perio_screenings" }, schema: { on_delete: "CASCADE" },
    },
    { collection: "perio_screenings", field: "examiner", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

/** One sextant of a screen. Six rows per screening, never six columns. */
export const perioSextants: Collection = {
  collection: "perio_sextants",
  meta: {
    icon: "grid_view",
    note: "$t:enamel_note_perio_sextants",
    display_template: "{{sextant}}: {{bpe_code}}",
    sort: 15,
    group: "clinical",
    hidden: true,
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "screening",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{examined_on}}" }, width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "sextant",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_sextant",
        options: { choices: SEXTANTS },
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Nullable, and null means "not scored" — never 0, which is a real
       * finding, and never a sentinel. The BSP defines no symbol for an
       * unscored sextant; its own worked example just shows a dash.
       *
       * The code is stored as the clinician recorded it and never
       * recomputed from a probing depth. BSP's own wording disagrees with
       * itself at exactly 3.5mm — 2011 said "no pockets >3.5mm" for codes
       * 0-2 while 2019 says "pockets <3.5mm", and 3.5 falls in the gap —
       * so a system that derives the code from millimetres would be
       * inventing a boundary the guideline declines to draw.
       */
      field: "bpe_code",
      type: "integer",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_bpe_code",
        display: "labels",
        display_options: {
          showAsDot: true,
          choices: [
            { text: "0", value: 0, color: "#2ECDA7" },
            { text: "1", value: 1, color: "#8FEADC" },
            { text: "2", value: 2, color: "#FFC23B" },
            { text: "3", value: 3, color: "#F97316" },
            { text: "4", value: 4, color: "#E35169" },
          ],
        },
        options: {
          allowNone: true,
          choices: [
            { text: "0 — no pockets, no calculus, no bleeding", value: 0 },
            { text: "1 — bleeding on probing", value: 1 },
            { text: "2 — calculus or overhangs", value: 2 },
            { text: "3 — probing depth 3.5–5.5mm", value: 3 },
            { text: "4 — probing depth over 5.5mm", value: 4 },
          ],
        },
        validation: { _or: [{ bpe_code: { _null: true } }, { bpe_code: { _between: [0, 4] } }] },
        validation_message: "$t:enamel_vm_bpe",
      },
      schema: {},
    },
    {
      /**
       * A separate axis, on the BSP's own instruction: "Both the number
       * and the * should be recorded if a furcation is detected. E.g. the
       * score for a sextant could be 3*". So it is a boolean beside the
       * code — never a fifth code value, never folded in.
       */
      field: "furcation",
      type: "boolean",
      meta: {
        interface: "boolean", width: "half",
        note: "$t:enamel_note_furcation_flag",
      },
      schema: { default_value: false, is_nullable: false },
    },
    {
      field: "not_scored_reason",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_not_scored",
        options: {
          choices: [
            { text: "$t:enamel_ns_fewer_than_two", value: "fewer_than_two_teeth" },
            { text: "$t:enamel_ns_edentulous", value: "edentulous" },
            { text: "$t:enamel_ns_declined", value: "patient_declined" },
            { text: "$t:enamel_ns_not_examined", value: "not_examined" },
          ],
        },
        conditions: [
          { name: "Only when unscored", rule: { bpe_code: { _nnull: true } }, hidden: true },
        ],
      },
      schema: {},
    },
    {
      /**
       * "For a sextant to qualify for recording, it must contain at least
       * 2 teeth." Recording how many were scored is what makes a null
       * code auditable rather than merely blank.
       */
      field: "teeth_scored",
      type: "integer",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_teeth_scored",
        validation: { _or: [{ teeth_scored: { _null: true } }, { teeth_scored: { _between: [0, 8] } }] },
        validation_message: "$t:enamel_vm_sextant_teeth",
      },
      schema: {},
    },
    {
      // Third molars are excluded "unless 1st and/or 2nd molars are
      // missing" — a 2016 change; before that they were simply excluded.
      field: "third_molar_included",
      type: "boolean",
      meta: {
        interface: "boolean", width: "half",
        note: "$t:enamel_note_third_molar",
      },
      schema: { default_value: false, is_nullable: false },
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "perio_sextants", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "perio_sextants", field: "screening", related_collection: "perio_screenings",
      meta: { one_field: "sextants" }, schema: { on_delete: "CASCADE" },
    },
  ],
};

/**
 * A full periodontal chart.
 *
 * The `assessed_*` flags are the part that looks like clutter and is not:
 * a bleeding score of "12%" means nothing unless you know how many sites
 * were actually probed for bleeding. Recording what was assessed is what
 * keeps a denominator honest, and it is why a chart with recession
 * unassessed is different from one where every recession happened to be
 * zero.
 */
export const perioExams: Collection = {
  collection: "perio_exams",
  meta: {
    icon: "monitor_heart",
    note: "$t:enamel_note_perio_exams",
    display_template: "{{examined_on}} — {{patient.last_name}}",
    sort: 16,
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
        options: { template: "{{last_name}}, {{first_name}}" }, width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "examined_on",
      type: "date",
      meta: {
        interface: "datetime", required: true, width: "half",
        validation: { examined_on: { _lte: "$NOW" } },
        validation_message: "$t:enamel_vm_exam_future",
      },
      schema: { is_nullable: false },
    },
    {
      field: "examiner",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        options: { template: "{{first_name}} {{last_name}}" },
      },
      schema: {},
    },
    {
      field: "probe_type",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_probe_type",
        options: {
          choices: [
            { text: "WHO / BPE", value: "who" },
            { text: "UNC-15", value: "unc15" },
            { text: "Williams", value: "williams" },
            { text: "Florida (electronic)", value: "florida" },
          ],
        },
      },
      schema: {},
    },
    {
      field: "charts_third_molars",
      type: "boolean",
      meta: {
        interface: "boolean", width: "half",
        note: "$t:enamel_note_charts_third_molars",
      },
      schema: { default_value: false, is_nullable: false },
    },
    divider("$t:enamel_div_perio_assessed", "divider_perio_assessed", "fact_check"),
    ...(
      [
        ["assessed_recession", "$t:enamel_note_assessed_recession"],
        ["assessed_bleeding", "$t:enamel_note_assessed_bleeding"],
        ["assessed_plaque", null],
        ["assessed_calculus", null],
        ["assessed_mobility", null],
        ["assessed_furcation", null],
      ] as Array<[string, string | null]>
    ).map(([field, note]) => ({
      field,
      type: "boolean" as const,
      meta: {
        interface: "boolean",
        width: "half" as const,
        ...(note ? { note } : {}),
      },
      schema: { default_value: false, is_nullable: false },
    })),
    {
      field: "note",
      type: "text",
      meta: { interface: "input-multiline" },
      schema: {},
    },
    ...timestamps(),
  ],
  relations: [
    { collection: "perio_exams", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "perio_exams", field: "patient", related_collection: "patients",
      meta: { one_field: "perio_exams" }, schema: { on_delete: "CASCADE" },
    },
    { collection: "perio_exams", field: "examiner", related_collection: "directus_users", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

/**
 * Per tooth: mobility and furcation, both of which are tooth-level facts
 * and belong nowhere near the six-site grid.
 *
 * A tooth moves as a rigid body — there is no such thing as site
 * mobility — and Open Dental enforces exactly that: "Only one number per
 * tooth, in the middle cell, is allowed."
 */
export const perioTeeth: Collection = {
  collection: "perio_teeth",
  meta: {
    icon: "dentistry",
    note: "$t:enamel_note_perio_teeth",
    display_template: "{{tooth}} — mobility {{mobility}}",
    sort: 17,
    group: "clinical",
    hidden: true,
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "exam",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{examined_on}}" }, width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "tooth",
      type: "string",
      meta: {
        interface: "input", required: true, width: "half",
        note: "$t:enamel_note_perio_tooth",
        options: { placeholder: "16" },
        validation: { tooth: { _in: PERMANENT_FDI } },
        validation_message: "$t:enamel_vm_perm_only",
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Kept explicitly rather than inferred from six null sites. "Not
       * charted" and "absent" are different facts, and six nulls cannot
       * tell you which one you are looking at.
       */
      field: "is_present",
      type: "boolean",
      meta: { interface: "boolean", width: "half", note: "$t:enamel_note_is_present" },
      schema: { default_value: true, is_nullable: false },
    },
    {
      /**
       * A four-point ordinal scale. The grade definitions are stable —
       * SDCEP: "Grade 0 physiological mobility; Grade 1 increased
       * mobility... to at the most 1 mm; Grade 2 exceeds 1 mm but less
       * than 2 mm; Grade 3 involves both horizontal and vertical
       * directions" — but the *attribution* is not: the "Miller index" is
       * reported inconsistently across the literature and products
       * disagree outright. So the scale is recorded, and which index it
       * belongs to is recorded beside it rather than assumed.
       */
      field: "mobility",
      type: "integer",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_mobility",
        options: {
          allowNone: true,
          choices: [
            { text: "0 — physiological", value: 0 },
            { text: "1 — up to 1mm horizontally", value: 1 },
            { text: "2 — over 1mm, under 2mm", value: 2 },
            { text: "3 — horizontal and vertical", value: 3 },
          ],
        },
        validation: { _or: [{ mobility: { _null: true } }, { mobility: { _between: [0, 3] } }] },
        validation_message: "$t:enamel_vm_mobility",
      },
      schema: {},
    },
    {
      field: "mobility_index",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_mobility_index",
        options: {
          choices: [
            { text: "Miller / Lindhe–Nyman", value: "miller_lindhe_nyman" },
            { text: "Glickman", value: "glickman" },
            { text: "Other", value: "other" },
          ],
        },
      },
      schema: {},
    },
    divider("$t:enamel_div_furcation", "divider_furcation", "account_tree"),
    ...(
      [
        ["furcation_buccal", "$t:enamel_note_furc_buccal"],
        ["furcation_lingual", null],
        ["furcation_mesial", "$t:enamel_note_furc_mesial"],
        ["furcation_distal", null],
      ] as Array<[string, string | null]>
    ).map(([field, note]) => ({
      field,
      type: "integer" as const,
      meta: {
        interface: "select-dropdown",
        width: "half" as const,
        ...(note ? { note } : {}),
        options: {
          allowNone: true,
          choices: [
            { text: "I — probe enters, under a third", value: 1 },
            { text: "II — over a third, not through", value: 2 },
            { text: "III — through and through", value: 3 },
          ],
        },
        validation: { _or: [{ [field]: { _null: true } }, { [field]: { _between: [1, 3] } }] },
        validation_message: "$t:enamel_vm_furcation",
      },
      schema: {},
    })),
    ...timestamps(),
  ],
  relations: [
    { collection: "perio_teeth", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "perio_teeth", field: "exam", related_collection: "perio_exams",
      meta: { one_field: "teeth" }, schema: { on_delete: "CASCADE" },
    },
  ],
};

/**
 * Per site. Six per tooth, and the names are canonical rather than
 * regional: MB, B, DB, ML, L, DL. In the maxilla "lingual" is properly
 * palatal, so ML/L/DL are the same three sites a UK chart labels MP/P/DP
 * — a display concern, not a different column.
 */
export const perioSites: Collection = {
  collection: "perio_sites",
  meta: {
    icon: "straighten",
    note: "$t:enamel_note_perio_sites",
    display_template: "{{tooth}} {{site}} — {{probing_depth_mm}}mm",
    sort: 18,
    group: "clinical",
    hidden: true,
  },
  schema: {},
  fields: [
    pk(),
    clinicRef(),
    {
      field: "exam",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], required: true,
        options: { template: "{{examined_on}}" }, width: "half",
      },
      schema: { is_nullable: false },
    },
    {
      field: "tooth",
      type: "string",
      meta: {
        interface: "input", required: true, width: "half",
        options: { placeholder: "16" },
        validation: { tooth: { _in: PERMANENT_FDI } },
        validation_message: "$t:enamel_vm_perm_only",
      },
      schema: { is_nullable: false },
    },
    {
      field: "site",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half",
        note: "$t:enamel_note_site",
        options: {
          choices: [
            { text: "MB — mesiobuccal", value: "MB" },
            { text: "B — mid-buccal", value: "B" },
            { text: "DB — distobuccal", value: "DB" },
            { text: "ML — mesiolingual / mesiopalatal", value: "ML" },
            { text: "L — mid-lingual / palatal", value: "L" },
            { text: "DL — distolingual / distopalatal", value: "DL" },
          ],
        },
      },
      schema: { is_nullable: false },
    },
    {
      /**
       * Millimetres, from the free gingival margin to the base of the
       * pocket. Nullable, and null means not probed — 0 is a real, if
       * unusual, reading and the two must stay distinguishable. Open
       * Dental uses -1 as its sentinel for the same reason; a nullable
       * column says it better.
       */
      field: "probing_depth_mm",
      type: "integer",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_pd",
        validation: { _or: [{ probing_depth_mm: { _null: true } }, { probing_depth_mm: { _between: [0, 20] } }] },
        validation_message: "$t:enamel_vm_pd",
      },
      schema: {},
    },
    {
      /**
       * THE SIGN CONVENTION, stated once and enforced by the name.
       *
       * `recession_mm` is POSITIVE when the gingival margin is APICAL to
       * the CEJ — the root is exposed — and NEGATIVE when it is CORONAL,
       * which is overgrowth or a pseudopocket. Zero is the margin at the
       * CEJ.
       *
       * Clinical attachment level is then plain addition:
       *
       *     CAL = probing_depth_mm + recession_mm
       *
       * This matches Eaglesoft ("a positive value between 1-19 when the
       * gum line is below the CEJ", "a negative value of 1-10 when the
       * gumline is above"), Dentrix and Open Dental, so an import needs no
       * sign flip. Both conventions genuinely exist in the wild, and this
       * is the one place where an inverted sign produces clinically wrong
       * output in silence — hence the field is called recession rather
       * than gingival_margin, which is the ambiguous name.
       *
       * CAL is deliberately NOT stored. It is derived from two columns in
       * the same row, and a stored copy is a column that can disagree with
       * its own inputs. Open Dental labels its own as "auto CAL" and
       * computes it; here any query can.
       */
      field: "recession_mm",
      type: "integer",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_recession",
        validation: { _or: [{ recession_mm: { _null: true } }, { recession_mm: { _between: [-10, 20] } }] },
        validation_message: "$t:enamel_vm_recession",
      },
      schema: {},
    },
    divider("$t:enamel_div_site_findings", "divider_site_findings", "colorize"),
    ...(
      [
        ["bleeding_on_probing", "$t:enamel_note_bop"],
        ["suppuration", "$t:enamel_note_suppuration"],
        ["plaque", null],
        ["calculus", null],
      ] as Array<[string, string | null]>
    ).map(([field, note]) => ({
      field,
      type: "boolean" as const,
      meta: {
        interface: "boolean",
        width: "half" as const,
        ...(note ? { note } : {}),
      },
      schema: { default_value: false, is_nullable: false },
    })),
    ...timestamps(),
  ],
  relations: [
    { collection: "perio_sites", field: "clinic", related_collection: "clinics", meta: {}, schema: { on_delete: "CASCADE" } },
    {
      collection: "perio_sites", field: "exam", related_collection: "perio_exams",
      meta: { one_field: "sites" }, schema: { on_delete: "CASCADE" },
    },
  ],
};
