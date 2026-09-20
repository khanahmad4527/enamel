import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DbService } from "../../db/db.service";
import { DeskAdapter } from "./desk.adapter";
import { CARD_GATEWAY } from "./select";
import { fromMinor, toMinor, type PaymentGateway } from "./gateway";

export type TakePayment = {
  patient: string;
  invoice?: string | null;
  /** Decimal string, as it comes off an invoice. Never a float. */
  amount: string;
  currency: string;
  method: "card" | "cash" | "bank_transfer" | "payment_plan";
  idempotencyKey: string;
  simulate?: "decline" | "network-error" | undefined;
  note?: string | null;
};

export type TakeResult =
  | { ok: true; id: string; reference: string; replayed: boolean; status: string }
  | { ok: false; reason: string; retryable: boolean; id?: string };

/**
 * Taking money, and never taking it twice.
 *
 * Two layers, and which one is authoritative matters.
 *
 * The adapter has an idempotency store — a real gateway keeps keys for a
 * day or so on its own servers. That is a convenience and it is not a
 * guarantee this system controls: the map is in one process, and the
 * gateway's copy is somebody else's promise.
 *
 * The thing that actually cannot forget is the unique index on
 * `payments.idempotency_key`. The row is written **before** the gateway
 * is called, so a second attempt with the same key collides with a row
 * that already exists and is answered from it. That ordering is the whole
 * design: a row written after a successful charge is a row that does not
 * exist when the process dies between the charge and the insert, which is
 * precisely the moment somebody's card has been debited and the practice
 * has no record of it.
 */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);

  constructor(
    private readonly db: DbService,
    private readonly desk: DeskAdapter,
    // Which gateway takes a card is the environment's decision — see
    // `select.ts`. Injected by token rather than by class so that
    // "swap the provider" is a variable rather than an edit here.
    @Inject(CARD_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /** Cash and bank transfers are recorded, cards go to a gateway. */
  private adapterFor(method: TakePayment["method"]): PaymentGateway {
    return method === "card" ? this.gateway : this.desk;
  }

  gateways(): Array<{ id: string; kind: string; describe: string }> {
    return [this.desk, this.gateway].map((a) => ({
      id: a.id, kind: a.kind, describe: a.describe,
    }));
  }

  /** Whether the configured gateway's credentials actually work. */
  async preflight(): Promise<Array<{ id: string; ok: boolean | null; detail: string }>> {
    return Promise.all(
      [this.desk, this.gateway].map(async (adapter) => {
        const probe = (adapter as PaymentGateway & {
          preflight?: () => Promise<{ ok: boolean; detail: string }>;
        }).preflight;
        if (!probe) {
          return { id: adapter.id, ok: null, detail: "nothing to check — no provider account is involved" };
        }
        const result = await probe.call(adapter).catch((e: unknown) => ({
          ok: false, detail: e instanceof Error ? e.message : String(e),
        }));
        return { id: adapter.id, ...result };
      }),
    );
  }

  async take(input: TakePayment): Promise<TakeResult> {
    const minor = toMinor(input.amount);
    if (minor === 0) {
      return { ok: false, reason: "A payment of zero is not a payment.", retryable: false };
    }

    // Claim the key first. `ON CONFLICT DO NOTHING` returning no row means
    // somebody already has it — which is the answer, not an error.
    const id = randomUUID();
    const claimed = await this.db.one<{ id: string }>(
      `INSERT INTO payments
         (id, patient, invoice, amount, method, status, provider,
          idempotency_key, note, date_created)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, now())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        id, input.patient, input.invoice ?? null,
        fromMinor(minor), input.method, this.adapterFor(input.method).id,
        input.idempotencyKey, input.note ?? null,
      ],
    );

    if (!claimed) {
      // The key is taken. Answer from the row that has it, whatever state
      // it is in — including `failed`, because "you already tried this and
      // it was declined" is the true answer and charging again would not
      // make it less true.
      const existing = await this.db.one<{
        id: string; status: string; provider_reference: string | null; failure_reason: string | null;
      }>(
        `SELECT id, status, provider_reference, failure_reason
           FROM payments WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (!existing) {
        return { ok: false, reason: "That payment key is in use.", retryable: true };
      }
      this.log.log(`idempotent replay of ${input.idempotencyKey} → ${existing.status}`);
      if (existing.status === "failed") {
        return {
          ok: false,
          reason: existing.failure_reason ?? "That payment was already attempted and refused.",
          retryable: false,
          id: existing.id,
        };
      }
      return {
        ok: true,
        id: existing.id,
        reference: existing.provider_reference ?? "",
        replayed: true,
        status: existing.status,
      };
    }

    const adapter = this.adapterFor(input.method);
    const result = await adapter.charge({
      amountMinor: Math.abs(minor),
      currency: input.currency,
      patient: input.patient,
      description: input.invoice ? `Invoice ${input.invoice}` : "Payment on account",
      idempotencyKey: input.idempotencyKey,
      simulate: input.simulate,
    });

    if (!result.ok) {
      // The row stays. A declined card is a fact about the patient's day
      // and deleting the evidence of it is how a practice ends up unable
      // to answer "did you try to take this on Tuesday".
      //
      // Except when the gateway never answered: then nobody knows whether
      // the money moved, and leaving a `failed` row would block the retry
      // that has to be allowed to find out. The key is released instead,
      // and the row is marked so the ambiguity is visible rather than
      // tidied away.
      const ambiguous = result.retryable;
      await this.db.query(
        `UPDATE payments
            SET status = 'failed',
                failure_reason = $2,
                idempotency_key = CASE WHEN $3 THEN NULL ELSE idempotency_key END
          WHERE id = $1`,
        [id, result.reason, ambiguous],
      );
      return { ok: false, reason: result.reason, retryable: result.retryable, id };
    }

    await this.db.query(
      `UPDATE payments
          SET status = 'settled', provider_reference = $2, received_at = $3
        WHERE id = $1`,
      [id, result.reference, result.settledAt],
    );

    // Settle the invoice when it is covered. Asked of the payments table
    // rather than tracked on the invoice, for the same reason the message
    // log is asked rather than a flag per kind: a sum cannot drift from
    // the rows it sums.
    if (input.invoice) await this.settleIfCovered(input.invoice);

    return { ok: true, id, reference: result.reference, replayed: result.replayed, status: "settled" };
  }

  /**
   * Mark an invoice paid once the payments against it cover the total.
   *
   * Only settled rows count, and refunds count against — a patient who
   * paid and was then refunded has not paid.
   */
  private async settleIfCovered(invoice: string): Promise<void> {
    await this.db.query(
      `UPDATE invoices i
          SET status = 'paid', paid_at = now()
        WHERE i.id = $1
          AND i.status <> 'paid'
          AND (SELECT coalesce(sum(p.amount), 0) FROM payments p
                WHERE p.invoice = i.id AND p.status = 'settled') >= i.total`,
      [invoice],
    );
  }

  /** What is still owed on an invoice, after everything settled against it. */
  async outstanding(invoice: string): Promise<string | null> {
    const row = await this.db.one<{ outstanding: string }>(
      `SELECT (i.total - coalesce(sum(p.amount) FILTER (WHERE p.status = 'settled'), 0))::text
                AS outstanding
         FROM invoices i
         LEFT JOIN payments p ON p.invoice = i.id
        WHERE i.id = $1
        GROUP BY i.total`,
      [invoice],
    );
    return row?.outstanding ?? null;
  }
}
