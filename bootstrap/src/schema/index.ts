import type { Collection } from "../types.js";
import { clinics, rooms } from "./clinics.js";
import { patients } from "./patients.js";
import { appointments } from "./scheduling.js";
import { treatments, treatmentRecords, toothConditions } from "./clinical.js";
import { invoices, invoiceLines } from "./billing.js";
import { documents } from "./documents.js";

export { userFields, fileFields } from "./users.js";

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
export const collections: Collection[] = [
  clinics,
  rooms,
  patients,
  appointments,
  treatments,
  treatmentRecords,
  toothConditions,
  documents,
  invoices,
  invoiceLines,
];
