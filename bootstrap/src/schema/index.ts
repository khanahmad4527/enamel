import type { Collection } from "../types.js";
import { withRelatedDisplay, withChoiceDisplay } from "./_helpers.js";
import { clinics, rooms } from "./clinics.js";
import { patients } from "./patients.js";
import { appointments } from "./scheduling.js";
import { treatments, treatmentRecords, toothConditions } from "./clinical.js";
import { invoices, invoiceLines } from "./billing.js";
import { dentition } from "./dentition.js";
import { recallTypes, recallStatuses, recalls } from "./recalls.js";
import { treatmentPlans, treatmentPlanItems } from "./plans.js";
import { clinicalNotes, medicalHistories, patientFindings, consents } from "./records.js";
import { perioScreenings, perioSextants, perioExams, perioTeeth, perioSites } from "./perio.js";
import { paymentPlans, paymentPlanCharges, waitingList, laboratories, labCases } from "./practice.js";
import { documents } from "./documents.js";

import { userFields as rawUserFields, fileFields as rawFileFields } from "./users.js";

export const userFields = rawUserFields.map(withRelatedDisplay).map(withChoiceDisplay);
export const fileFields = rawFileFields.map(withRelatedDisplay).map(withChoiceDisplay);

/** Sidebar folders. Created before the collections that sit in them. */
export const groups: Collection[] = [
  {
    collection: "clinical",
    meta: { icon: "folder", note: "Patients, diary and clinical records.", color: "#0D6E63", sort: 2 },
    schema: undefined,
    fields: [],
  },
  {
    collection: "billing",
    meta: { icon: "folder", note: "Invoicing.", color: "#B4762A", sort: 3 },
    schema: undefined,
    fields: [],
  },
];

/**
 * Order matters: a relation can only be created once both sides exist,
 * so parents come before children.
 */
const declared: Collection[] = [
  clinics,
  rooms,
  patients,
  appointments,
  treatments,
  treatmentRecords,
  toothConditions,
  dentition,
  medicalHistories,
  patientFindings,
  clinicalNotes,
  treatmentPlans,
  treatmentPlanItems,
  recallTypes,
  recallStatuses,
  recalls,
  documents,
  consents,
  perioScreenings,
  perioSextants,
  perioExams,
  perioTeeth,
  perioSites,
  waitingList,
  laboratories,
  labCases,
  invoices,
  invoiceLines,
  paymentPlans,
  paymentPlanCharges,
];

export const collections: Collection[] = declared.map((c) => ({
  ...c,
  fields: c.fields.map(withRelatedDisplay).map(withChoiceDisplay),
}));
