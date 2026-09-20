import { Injectable } from "@nestjs/common";
import type { ChargeRequest, ChargeResult, PaymentGateway } from "./gateway";
import type { AdapterKind } from "../integration";

/**
 * Money taken at the desk.
 *
 * `manual`, not `mock`: nothing is being simulated. A receptionist took
 * forty euros in cash, or ran a card through a standalone terminal that
 * this software has never heard of, and recording that is the whole
 * integration. Most dental practices in the world work exactly this way,
 * and a system that only knows how to take money through an API is a
 * system half of them cannot use.
 *
 * It always succeeds, because the money is already in the drawer. The
 * failure mode this has to get right is not a declined card — it is being
 * asked to record the same takings twice, which is the same idempotency
 * problem as the gateway and is solved in the same place: the unique key
 * on the payments table.
 */
@Injectable()
export class DeskAdapter implements PaymentGateway {
  readonly id = "payments.desk";
  readonly kind: AdapterKind = "manual";
  readonly describe =
    "cash or a standalone card terminal, recorded by whoever took it — no gateway involved";

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (request.amountMinor <= 0) {
      return { ok: false, reason: "A payment has to be more than nothing.", retryable: false };
    }
    return {
      ok: true,
      // Not a mock id, because it is not pretending to be a provider's.
      // It is what it says: a hand-entered receipt, referenced by the key
      // that keeps it unique.
      reference: `desk:${request.idempotencyKey.slice(0, 12)}`,
      replayed: false,
      settledAt: new Date().toISOString(),
    };
  }

  async refund(reference: string, amountMinor: number): Promise<ChargeResult> {
    if (amountMinor <= 0) {
      return { ok: false, reason: "A refund has to be more than nothing.", retryable: false };
    }
    return {
      ok: true,
      reference: `desk:refund:${reference.replace(/^desk:/, "").slice(0, 12)}`,
      replayed: false,
      settledAt: new Date().toISOString(),
    };
  }
}
