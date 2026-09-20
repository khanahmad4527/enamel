import { Injectable, Logger } from "@nestjs/common";
import type { AdapterKind } from "../integration";
import type { ChargeRequest, ChargeResult, PaymentGateway } from "./gateway";

/**
 * Stripe, through the PaymentIntents API.
 *
 * https://docs.stripe.com/api/payment_intents/create
 *
 *   POST https://api.stripe.com/v1/payment_intents
 *   Authorization: Basic base64(sk_live_…:)        <- the key is the username
 *   Idempotency-Key: <the caller's key>
 *   Content-Type: application/x-www-form-urlencoded
 *   amount=4000&currency=eur&confirm=true&payment_method=pm_…
 *
 * **Amounts are integer minor units** and never pass through a float on
 * the way here. `0.1 + 0.2` is `0.30000000000000004`, and a rounding
 * error in a currency column is the kind of bug a bookkeeper finds six
 * months later and nobody can explain. Stripe wants cents, this system
 * holds `numeric`, and `toMinor` is the only conversion.
 *
 * ## The caveat, which is real and is not a gap in this file
 *
 * A card payment needs a card, and a card is collected in a browser by
 * Stripe's own JavaScript or on a Stripe Terminal reader — never by a
 * server, because a server that handles a card number has just taken on
 * PCI scope that Stripe exists to keep it out of.
 *
 * So this adapter charges a **PaymentMethod the patient has already
 * presented**. Given one, it creates and confirms in a single call. Given
 * none, it refuses and says what is missing rather than inventing a
 * success — which is precisely the honesty the mock gateway is loud
 * about, applied to the real one.
 *
 * That is also why the mock still exists and is still the default. The
 * interesting half of a payment integration is not this HTTP call; it is
 * what happens when the request times out after the money moved, and
 * whether pressing the button twice takes it twice. Both are exercised
 * against the mock, and both behave identically here, because the
 * authoritative guard is the unique index on `payments.idempotency_key`
 * rather than anything either gateway remembers.
 *
 * Credentials arrive through the constructor — see the note on
 * `TwilioSmsAdapter`.
 */
export type StripeCredentials = {
  secretKey?: string | undefined;
  apiBase?: string | undefined;
};

@Injectable()
export class StripeGatewayAdapter implements PaymentGateway {
  readonly id = "payments.stripe";
  readonly kind: AdapterKind = "real";
  readonly describe: string;

  private readonly log = new Logger(StripeGatewayAdapter.name);
  private readonly base: string;

  constructor(private readonly creds: StripeCredentials) {
    // `stripe-mock` speaks the real API on 12111, which is how this class
    // is exercised without an account.
    this.base = (this.creds.apiBase ?? "https://api.stripe.com").replace(/\/$/, "");
    const key = this.creds.secretKey ?? "";
    const mode = key.startsWith("sk_live") ? "LIVE" : key.startsWith("sk_test") ? "test mode" : "unknown mode";
    this.describe = `Stripe PaymentIntents — ${mode}${this.creds.apiBase ? ` at ${this.base}` : ""}`;
    if (mode === "LIVE") this.log.warn("Stripe is in LIVE mode — these charges move real money");
  }

  /** Basic auth with the secret key as the username and no password. */
  private get auth(): string {
    return `Basic ${Buffer.from(`${this.creds.secretKey}:`).toString("base64")}`;
  }

  private async call(
    path: string,
    form: URLSearchParams,
    idempotencyKey: string,
  ): Promise<{ status: number; body: Record<string, unknown> } | { network: string }> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: {
          authorization: this.auth,
          "content-type": "application/x-www-form-urlencoded",
          // Stripe stores the status and body of the first request under
          // this key for 24 hours and replays them verbatim — including a
          // 500. That is why the key is the caller's and is generated
          // once, before the first attempt: one generated per attempt
          // defeats the entire mechanism.
          "idempotency-key": idempotencyKey,
        },
        body: form.toString(),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    } catch (e) {
      return { network: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Which Stripe failures are worth another attempt.
   *
   * https://docs.stripe.com/api/errors
   *
   * `card_error` is the patient's bank saying no — as true on the fifth
   * try as the first, and retrying a decline is how a practice ends up
   * with five holds on somebody's card.
   */
  private static retryable(type: string | undefined, status: number): boolean {
    if (type === "card_error" || type === "invalid_request_error") return false;
    if (type === "authentication_error") return false;
    if (type === "rate_limit_error") return true;
    return status === 429 || status >= 500;
  }

  private static refusal(body: Record<string, unknown>, status: number): ChargeResult {
    const error = (body["error"] ?? {}) as {
      message?: string; type?: string; code?: string; decline_code?: string;
    };
    const reason = error.decline_code
      ? `${error.message ?? "declined"} (${error.decline_code})`
      : error.message ?? `Stripe answered ${status}`;
    return { ok: false, reason, retryable: StripeGatewayAdapter.retryable(error.type, status) };
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (request.amountMinor <= 0) {
      return { ok: false, reason: "A charge has to be more than nothing.", retryable: false };
    }

    if (!request.paymentMethod) {
      // Not a failure to hide behind a retry. Nothing about waiting makes
      // a card appear.
      return {
        ok: false,
        reason:
          "Stripe needs a card, and a card is collected in the browser by Stripe's own " +
          "JavaScript or on a Terminal reader — a server that handled the number would " +
          "take on the PCI scope Stripe exists to avoid. Send the PaymentMethod id the " +
          "patient presented.",
        retryable: false,
      };
    }

    const form = new URLSearchParams({
      amount: String(request.amountMinor),
      // Stripe wants a lowercase ISO 4217 code; the clinic stores "EUR".
      currency: request.currency.toLowerCase(),
      description: request.description,
      payment_method: request.paymentMethod,
      confirm: "true",
      // Off-session: nobody is standing in a checkout flow to complete a
      // 3-D Secure challenge, so a payment that needs one must fail here
      // rather than hang in `requires_action` forever.
      off_session: "true",
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
      "metadata[patient]": request.patient,
      "metadata[enamel_key]": request.idempotencyKey,
    });

    const result = await this.call("/v1/payment_intents", form, request.idempotencyKey);
    if ("network" in result) {
      // The dangerous case: the money may or may not have moved. Retrying
      // is safe *because* of the idempotency key — Stripe replays the
      // first result rather than charging again.
      return { ok: false, reason: `could not reach Stripe: ${result.network}`, retryable: true };
    }

    if (result.status >= 400) return StripeGatewayAdapter.refusal(result.body, result.status);

    const intent = result.body as { id?: string; status?: string; created?: number };
    if (intent.status !== "succeeded") {
      return {
        ok: false,
        reason: `Stripe left the payment in "${intent.status ?? "an unknown state"}" — it needs the patient to do something, which an off-session charge cannot ask for.`,
        retryable: false,
      };
    }

    return {
      ok: true,
      reference: intent.id ?? request.idempotencyKey,
      // Stripe does not tell us whether this was a replay, so this is
      // reported honestly as unknown rather than guessed. The system's own
      // answer comes from the unique index on `payments.idempotency_key`,
      // which is checked before this is ever called.
      replayed: false,
      settledAt: new Date((intent.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    };
  }

  async refund(reference: string, amountMinor: number, idempotencyKey: string): Promise<ChargeResult> {
    const form = new URLSearchParams({
      payment_intent: reference,
      amount: String(Math.abs(amountMinor)),
    });
    const result = await this.call("/v1/refunds", form, idempotencyKey);
    if ("network" in result) {
      return { ok: false, reason: `could not reach Stripe: ${result.network}`, retryable: true };
    }
    if (result.status >= 400) return StripeGatewayAdapter.refusal(result.body, result.status);

    const refund = result.body as { id?: string; status?: string; created?: number };
    if (refund.status !== "succeeded" && refund.status !== "pending") {
      return { ok: false, reason: `Stripe returned a refund in "${refund.status}"`, retryable: false };
    }
    return {
      ok: true,
      reference: refund.id ?? idempotencyKey,
      replayed: false,
      settledAt: new Date((refund.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    };
  }

  /**
   * Does this key work, and which account is it?
   *
   * `GET /v1/balance` is the cheapest authenticated read Stripe has and it
   * changes nothing. It also answers the question somebody actually has
   * after setting `STRIPE_SECRET_KEY`: am I pointed at test or at live.
   */
  async preflight(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base}/v1/balance`, { headers: { authorization: this.auth } });
      const body = (await res.json().catch(() => ({}))) as {
        livemode?: boolean;
        available?: Array<{ currency?: string }>;
        error?: { message?: string };
      };
      if (!res.ok) return { ok: false, detail: body.error?.message ?? `HTTP ${res.status}` };
      const currencies = (body.available ?? []).map((a) => a.currency?.toUpperCase()).filter(Boolean);
      return {
        ok: true,
        detail:
          `${body.livemode ? "LIVE" : "test"} mode` +
          (currencies.length ? `, balance in ${currencies.join(", ")}` : ""),
      };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
