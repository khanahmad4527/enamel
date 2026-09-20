/**
 * One interface per way of reaching a patient.
 *
 * The point of this file is that everything above it — the sweeps, the
 * queue, the message log — knows nothing about Twilio or Meta or SMTP. It
 * knows there is a thing you can hand a recipient and a body to, which
 * either accepts it and returns the provider's id, or refuses and says
 * why. Swapping a provider is writing one of these; nothing else moves.
 *
 * Two decisions are baked in, and both come from what goes wrong in real
 * systems rather than from tidiness:
 *
 * `send` returns a result rather than throwing on a refusal. A bounced
 * address and a broken network are different events: the first is a fact
 * about the patient's details that no amount of retrying will change, and
 * the second is worth trying again in thirty seconds. A thrown error makes
 * them look the same, and a queue that retries a dead address five times
 * is just a slower way of not telling anybody.
 *
 * `retryable` is therefore the adapter's judgement, not the queue's. Only
 * the thing talking to the provider can tell a 429 from a 400.
 */

export type Channel = "email" | "sms" | "whatsapp";

export type Outbound = {
  to: string;
  subject?: string | undefined;
  body: string;
  /** The message row, so an adapter can quote it back to a provider. */
  reference: string;
};

export type SendResult =
  | { ok: true; providerId: string; note?: string }
  | { ok: false; reason: string; retryable: boolean };

export interface ChannelAdapter {
  readonly channel: Channel;

  /**
   * What this adapter is, in a few words, for the provisioning log and the
   * README. A demo that quietly mocks its SMS gateway and does not say so
   * is worse than one with no SMS at all.
   *
   * This string is PUBLIC — `/api/integrations/adapters` answers without
   * a token, deliberately, because "does this really take card payments"
   * should not need a login. So it says what kind of thing the adapter
   * is and never where it points. The email adapter used to answer
   * `SMTP to mail:1025`, which told an unauthenticated caller the mail
   * relay's address for no reader's benefit.
   */
  readonly describe: string;

  /**
   * Where it actually points, for an operator. Optional, because most
   * adapters have nowhere to point. Returned by `/messaging/channels`
   * and `/integrations/preflight`, both of which require a token.
   */
  readonly detail?: string;

  /** Whether the address is the shape this channel can reach at all. */
  accepts(to: string): boolean;

  send(message: Outbound): Promise<SendResult>;
}

/** Anything with an @ and a dot after it. Providers do the real validation. */
export const looksLikeEmail = (to: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(to);

/**
 * E.164-ish: a leading +, then 8 to 15 digits.
 *
 * Deliberately strict about the +. A number stored as "07700 900123" is
 * unsendable internationally and the failure is silent — the provider
 * accepts it, bills for it, and nothing arrives. Refusing it here turns
 * that into a visible `suppressed` row with a reason.
 */
export const looksLikePhone = (to: string): boolean => /^\+\d{8,15}$/.test(to.replace(/[\s-]/g, ""));

export const normalisePhone = (to: string): string => to.replace(/[\s-]/g, "");
