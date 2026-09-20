/**
 * Everything this system holds about one person, and where to find it.
 *
 * A subject access request is answered from a list like this or it is
 * answered wrongly. The failure mode is not a bug — it is somebody
 * exporting the six tables they remembered, handing it over as complete,
 * and the seventh turning up later. So the list is written down once,
 * next to a note about what each part is, and the export walks it.
 *
 * `via` is the path from the collection to the patient. Most rows carry
 * the patient directly; a treatment plan item reaches them through its
 * plan, a perio site through its examination. Getting one of those wrong
 * produces an **empty section rather than an error**, which is exactly
 * the shape of mistake that survives — so every section the export
 * touches is one the suite asserts against a patient known to have data.
 */
export type Section = {
  collection: string;
  /** The filter path from this collection to `patients.id`. */
  via: string;
  /** What this is, in words a patient can read. */
  describe: string;
  /**
   * Whether a complete answer requires it.
   *
   * All of them do, and the flag exists so that the one exception is
   * visible rather than implied: nothing here is optional, and if that
   * ever changes the reason has to be typed next to it.
   */
  required: boolean;
};

export const SECTIONS: Section[] = [
  { collection: "patients", via: "id", required: true,
    describe: "Who you are: name, date of birth, contact details and the practice you are registered with." },
  { collection: "appointments", via: "patient", required: true,
    describe: "Every appointment booked for you, including ones you cancelled or did not attend." },
  { collection: "treatment_records", via: "patient", required: true,
    describe: "What was actually done, on which tooth, by whom, and what it cost." },
  { collection: "clinical_notes", via: "patient", required: true,
    describe: "What the clinician wrote at the time, including any later amendment and its reason." },
  { collection: "patient_findings", via: "patient", required: true,
    describe: "Medical alerts and findings recorded against your record — allergies, conditions, warnings." },
  { collection: "tooth_conditions", via: "patient", required: true,
    describe: "Your dental chart: what has been found or done on each surface of each tooth." },
  { collection: "dentition", via: "patient", required: true,
    describe: "Which teeth are present, which are absent and why." },
  { collection: "perio_screenings", via: "patient", required: true,
    describe: "Gum screening scores (BPE), which decide whether a full assessment is needed." },
  { collection: "perio_sextants", via: "screening.patient", required: true,
    describe: "The score for each sixth of the mouth in a screening." },
  { collection: "perio_exams", via: "patient", required: true,
    describe: "Full periodontal assessments, where one was carried out." },
  { collection: "perio_teeth", via: "exam.patient", required: true,
    describe: "Per-tooth findings from a periodontal assessment — mobility and furcation." },
  { collection: "perio_sites", via: "exam.patient", required: true,
    describe: "Per-site measurements: pocket depths, recession, bleeding, plaque and calculus." },
  { collection: "medical_histories", via: "patient", required: true,
    describe: "The medical history you gave, and when you signed it." },
  { collection: "consents", via: "patient", required: true,
    describe: "What you consented to, what risks and alternatives were discussed, and when you signed." },
  { collection: "treatment_plans", via: "patient", required: true,
    describe: "Treatment that was proposed to you, what it would cost, and whether you accepted it." },
  { collection: "treatment_plan_items", via: "plan.patient", required: true,
    describe: "The individual items inside each plan." },
  { collection: "recalls", via: "patient", required: true,
    describe: "When you are next due for a check-up or hygiene visit." },
  { collection: "invoices", via: "patient", required: true,
    describe: "What you were charged." },
  { collection: "invoice_lines", via: "invoice.patient", required: true,
    describe: "The lines that make up each invoice." },
  { collection: "payments", via: "patient", required: true,
    describe: "What you paid, how, and when — including any refund." },
  { collection: "payment_plans", via: "patient", required: true,
    describe: "Any arrangement to pay in instalments." },
  { collection: "payment_plan_charges", via: "payment_plan.patient", required: true,
    describe: "The instalments under that arrangement." },
  { collection: "messages", via: "patient", required: true,
    describe: "Every message the practice sent you and every reply, with the channel and the time." },
  { collection: "documents", via: "patient", required: true,
    describe:
      "Files held about you — consent forms, letters, radiographs and photographs. Listed here " +
      "with their type and date; the images themselves are supplied separately, because a " +
      "radiograph is not something to paste into a JSON file.",
  },
  { collection: "lab_cases", via: "patient", required: true,
    describe: "Work sent to a dental laboratory for you, and when it came back." },
  { collection: "waiting_list", via: "patient", required: true,
    describe: "Any time you asked to be told about an earlier appointment." },
  { collection: "access_log", via: "patient", required: true,
    describe:
      "Every time somebody at the practice opened your record: who, when, and which part. " +
      "Kept because a record of who looked is the only way to tell a proper clinical " +
      "interest from a nosy one.",
  },
];
