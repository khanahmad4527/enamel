import type { Integration, IntegrationResult } from "../integration";

export type LabDispatch = {
  caseId: string;
  laboratory: string;
  /** What the lab is being asked to make. */
  instructions: string;
  /** The tooth or teeth, when the case names them. */
  detail?: string | null;
  dueAt: string | null;
  /**
   * Who it is for — as a reference, not a name.
   *
   * A lab needs to be able to match a returned crown to a case, and a
   * case number does that. Sending a patient's name and date of birth to
   * a third party because the form had a box for it is how a practice
   * ends up explaining a data-sharing agreement it never signed.
   */
  patientReference: string;
  practice: string;
};

export type DispatchResult = IntegrationResult<{
  /** The printable docket, when the adapter produced one. */
  docket?: string;
  contentType?: string;
}>;

export interface LabAdapter extends Integration {
  dispatch(work: LabDispatch): Promise<DispatchResult>;
}
