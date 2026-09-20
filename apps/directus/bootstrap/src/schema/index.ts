import type { Collection } from "../types.js";
import { withRelatedDisplay, withChoiceDisplay } from "./_helpers.js";
import { practice, rooms } from "./clinics.js";
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
import { clinicHours, practitionerHours, absences, roomClosures } from "./availability.js";
import { accessLog } from "./audit.js";
import { retentionCollections } from "./retention.js";
import { breachCollections } from "./breaches.js";
import { disposalCollections } from "./disposals.js";
import { consentRegisterCollections } from "./consent-register.js";
import { websiteCollections } from "./website.js";
import { messages } from "./messaging.js";
import { integrationCollections } from "./integrations.js";

import { userFields as rawUserFields, fileFields as rawFileFields } from "./users.js";

export const userFields = rawUserFields.map(withRelatedDisplay).map(withChoiceDisplay);
export const fileFields = rawFileFields.map(withRelatedDisplay).map(withChoiceDisplay);

/** Sidebar folders. Created before the collections that sit in them. */
export const groups: Collection[] = [
  {
    collection: "clinical",
    meta: { icon: "folder", note: "$t:enamel_note_folder_clinical", sort: 2 },
    schema: undefined,
    fields: [],
  },
  {
    collection: "billing",
    meta: { icon: "folder", note: "$t:enamel_note_folder_billing", sort: 3 },
    schema: undefined,
    fields: [],
  },
  {
    // Its own group rather than inside clinical: a rota is run by the
    // practice manager, not the dentist, and burying opening hours under
    // patients puts it where the person who maintains it will not look.
    collection: "scheduling",
    meta: { icon: "folder", note: "$t:enamel_note_folder_scheduling", sort: 4 },
    schema: undefined,
    fields: [],
  },
  {
    // The public face of the practice, kept apart from everything
    // clinical: the person who updates the opening hours on the website
    // is not the person reading a chart, and burying it under Clinical
    // puts it where they will not look.
    collection: "website",
    meta: { icon: "folder", note: "$t:enamel_note_folder_website", sort: 6 },
    schema: undefined,
    fields: [],
  },
  {
    // Not under scheduling or clinical: the audience is whoever is
    // answering an information-governance question, and they are looking
    // for "the logs", not for a patient.
    collection: "governance",
    meta: { icon: "folder", note: "$t:enamel_note_folder_governance", sort: 5 },
    schema: undefined,
    fields: [],
  },
];

/**
 * Order matters: a relation can only be created once both sides exist,
 * so parents come before children.
 */
const declared: Collection[] = [
  practice,
  rooms,
  // Availability before appointments: an appointment is validated against
  // these, so on a fresh database the tables it reads have to exist first.
  clinicHours,
  practitionerHours,
  absences,
  roomClosures,
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
  // After invoices, because `payments.invoice` and `invoices.ledger_export`
  // both point at rows that have to exist first.
  ...integrationCollections,
  paymentPlans,
  paymentPlanCharges,
  messages,
  accessLog,
  // Governance, alongside the audit log: both answer "what are we
  // obliged to do about this record", from opposite ends.
  ...retentionCollections,
  ...breachCollections,
  ...disposalCollections,
  ...consentRegisterCollections,
  ...websiteCollections,
];

export const collections: Collection[] = declared.map((c) => ({
  ...c,
  fields: c.fields.map(withRelatedDisplay).map(withChoiceDisplay),
}));
