import { Injectable, Logger } from "@nestjs/common";
import type { ChargeRequest, ChargeResult, PaymentGateway } from "./gateway";
import { mockReference, type AdapterKind } from "../integration";

/**
 * A card gateway this repository has no account with.
 *
 * Written as a mock rather than left out, because the interesting part of
 * a payment integration is not the HTTP call to Stripe — it is everything
 * around it, and that part is identical whoever the provider is: what
 * happens when the request times out, what a decline means, and whether
 * pressing the button twice takes the money twice.
 *
 * So this simulates the behaviours that matter and is loud about being a
 * simulation. Every reference it returns starts `mock:`.
 *
 * The idempotency store here is in memory, which is the one thing a real
 * gateway does differently — Stripe keeps keys for 24 hours, on their
 * side, across every server they own. That difference is why the
 * authoritative guard in this system is the unique index on
 * `payments.idempotency_key` and not this map: a gateway's memory is a
 * convenience, and the database is the thing that cannot forget.
 */
@Injectable()
export class MockGatewayAdapter implements PaymentGateway {
  private readonly log = new Logger(MockGatewayAdapter.name);
  readonly id = "payments.mock-gateway";
  readonly kind: AdapterKind = "mock";
  readonly describe =
    "mock card gateway — declines, timeouts and idempotent replays, with visible mock: references";

  /** key → the result that key already produced. */
  private readonly seen = new Map<string, { reference: string; settledAt: string }>();

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const { idempotencyKey } = request;

    // The replay path, and the reason this class exists. A second request
    // with a key the gateway has seen returns the *first* result. It does
    // not move money again, and it does not error — because the caller
    // asking again is a caller who does not know what happened, and an
    // error would tell them the wrong thing.
    const already = this.seen.get(idempotencyKey);
    if (already) {
      this.log.log(`replayed ${idempotencyKey} → ${already.reference}`);
      return { ok: true, reference: already.reference, replayed: true, settledAt: already.settledAt };
    }

    if (request.amountMinor <= 0) {
      return { ok: false, reason: "A charge has to be more than nothing.", retryable: false };
    }

    // A declined card is a fact about the patient's account. Retrying it
    // changes nothing, so `retryable` is false and the queue above will
    // not spend five attempts learning that.
    if (request.simulate === "decline") {
      return {
        ok: false,
        reason: "The card was declined. Ask the patient for another card.",
        retryable: false,
      };
    }

    // A timeout is the opposite: nothing is known about whether the money
    // moved, and that is exactly when the idempotency key earns its keep.
    // Deliberately *not* recorded in `seen`, because a real gateway that
    // never answered may or may not have charged — which is the honest
    // simulation of the worst case.
    if (request.simulate === "network-error") {
      return {
        ok: false,
        reason: "The gateway did not answer in time. The charge may or may not have gone through.",
        retryable: true,
      };
    }

    const reference = mockReference("ch", idempotencyKey);
    const settledAt = new Date().toISOString();
    this.seen.set(idempotencyKey, { reference, settledAt });
    return { ok: true, reference, replayed: false, settledAt };
  }

  async refund(reference: string, amountMinor: number, idempotencyKey: string): Promise<ChargeResult> {
    const already = this.seen.get(idempotencyKey);
    if (already) {
      return { ok: true, reference: already.reference, replayed: true, settledAt: already.settledAt };
    }
    if (!reference.startsWith("mock:")) {
      return {
        ok: false,
        reason: "That is not a reference this gateway issued.",
        retryable: false,
      };
    }
    if (amountMinor <= 0) {
      return { ok: false, reason: "A refund has to be more than nothing.", retryable: false };
    }
    const made = mockReference("re", idempotencyKey);
    const settledAt = new Date().toISOString();
    this.seen.set(idempotencyKey, { reference: made, settledAt });
    return { ok: true, reference: made, replayed: false, settledAt };
  }
}
