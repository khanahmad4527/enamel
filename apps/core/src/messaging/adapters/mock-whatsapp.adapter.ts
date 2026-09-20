import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { looksLikePhone, normalisePhone, type ChannelAdapter, type Outbound, type SendResult } from "../channel";

/**
 * WhatsApp, mocked — and the one with a caveat worth reading.
 *
 * The adapter shape fits, but WhatsApp is not a drop-in third SMS channel
 * and pretending otherwise would be the misleading part. Meta's Business
 * API only lets you start a conversation with a *pre-approved template*,
 * submitted for review and approved per language; free-form text is only
 * allowed inside a 24-hour window that opens when the patient messages
 * you first. So "send this reminder over WhatsApp" is really "send
 * approved template `appointment_reminder_v1` with these variables", and a
 * practice cannot adopt it in an afternoon: business verification takes
 * days.
 *
 * That is why `body` is still what gets stored. The template id and its
 * variables are what a real implementation would send, and the rendered
 * text is what belongs in the log — because the log exists for the
 * receptionist, who wants to know what the patient read.
 */
@Injectable()
export class MockWhatsAppAdapter implements ChannelAdapter {
  readonly channel = "whatsapp" as const;
  readonly describe =
    "mock — template approval and business verification required for the real thing";

  private readonly log = new Logger(MockWhatsAppAdapter.name);

  accepts(to: string): boolean {
    return looksLikePhone(to);
  }

  async send(message: Outbound): Promise<SendResult> {
    const to = normalisePhone(message.to);
    if (!this.accepts(to)) {
      return { ok: false, reason: `${message.to} is not in international format`, retryable: false };
    }
    this.log.log(`[mock whatsapp] → ${to}: ${message.body.replace(/\s+/g, " ").slice(0, 80)}`);
    return { ok: true, providerId: `mock:${randomUUID()}`, note: "mock adapter — nothing was sent" };
  }
}
