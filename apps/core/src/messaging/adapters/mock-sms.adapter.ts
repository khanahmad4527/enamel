import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { looksLikePhone, normalisePhone, type ChannelAdapter, type Outbound, type SendResult } from "../channel";

/**
 * SMS, mocked — and saying so.
 *
 * There is no local Mailpit for text messages, so this accepts the message,
 * gives it a `mock:` provider id and logs it. The record of what was sent
 * is the `messages` row, which is what a receptionist looks at anyway, and
 * the `mock:` prefix is deliberately visible there: a demo that silently
 * pretends to text people is worse than one with no SMS at all, because
 * somebody will eventually believe it.
 *
 * The real implementation is about fifteen lines and is written out in the
 * README rather than left as an exercise. Twilio's REST API takes a POST
 * to /Messages.json with To, From and Body, basic-auths with the account
 * SID and auth token, and returns a `sid` that goes in `provider_id`. Its
 * 4xx codes are permanent (21211 is an invalid number, 21610 is an
 * unsubscribed recipient); 429 and 5xx are retryable. That mapping is the
 * only judgement the adapter interface asks for.
 */
@Injectable()
export class MockSmsAdapter implements ChannelAdapter {
  readonly channel = "sms" as const;
  readonly describe = "mock — recorded in `messages` with a mock: id, never sent";

  private readonly log = new Logger(MockSmsAdapter.name);

  accepts(to: string): boolean {
    return looksLikePhone(to);
  }

  async send(message: Outbound): Promise<SendResult> {
    const to = normalisePhone(message.to);
    if (!this.accepts(to)) {
      // Not retryable and not an outage: a number without a country code
      // is unsendable and a provider would take the money anyway.
      return { ok: false, reason: `${message.to} is not in international format`, retryable: false };
    }
    this.log.log(`[mock sms] → ${to}: ${message.body.replace(/\s+/g, " ").slice(0, 80)}`);
    return { ok: true, providerId: `mock:${randomUUID()}`, note: "mock adapter — nothing was sent" };
  }
}
