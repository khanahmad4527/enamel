import { Injectable } from "@nestjs/common";
import type { DispatchResult, LabAdapter, LabDispatch } from "./lab";
import { mockReference, type AdapterKind } from "../integration";

/**
 * A laboratory with an API, which this repository has no account with.
 *
 * The larger labs do offer one, and the shape is always the same: post a
 * case, get a reference, receive status updates by webhook. The webhook
 * is the interesting half and it is real — see the inbound endpoint on
 * the integrations controller, which is held to its own secret rather
 * than to an operator token, for the same reason the messaging one is.
 *
 * Every reference starts `mock:`.
 */
@Injectable()
export class MockLabAdapter implements LabAdapter {
  readonly id = "lab.mock-api";
  readonly kind: AdapterKind = "mock";
  readonly describe =
    "mock laboratory API — dispatch and webhook status updates, with visible mock: references";

  async dispatch(work: LabDispatch): Promise<DispatchResult> {
    if (!work.instructions.trim()) {
      return { ok: false, reason: "A lab case needs instructions.", retryable: false };
    }
    // A lab that is closed for the weekend is a retryable refusal, and
    // this is the shape of it — a caller should try again, not give up
    // and tell the dentist the case cannot be sent.
    if (/closed|holiday/i.test(work.laboratory)) {
      return {
        ok: false,
        reason: "The laboratory is not accepting work at the moment.",
        retryable: true,
      };
    }
    return { ok: true, reference: mockReference("lab", work.caseId) };
  }
}
