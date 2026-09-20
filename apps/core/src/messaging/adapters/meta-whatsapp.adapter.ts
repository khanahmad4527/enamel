import { Injectable, Logger } from "@nestjs/common";
import {
  looksLikePhone, normalisePhone,
  type ChannelAdapter, type Outbound, type SendResult,
} from "../channel";

/**
 * WhatsApp, through Meta's Cloud API — and the one adapter whose caveat
 * is bigger than its code.
 *
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *
 *   POST https://graph.facebook.com/{version}/{phone-number-id}/messages
 *   Authorization: Bearer {token}
 *   Content-Type: application/json
 *   { "messaging_product": "whatsapp", "to": "...", "type": "template",
 *     "template": { "name": "...", "language": { "code": "en" },
 *                   "components": [ ... ] } }
 *
 * **WhatsApp is not a third SMS channel.** A business may only *start* a
 * conversation with a template that Meta has reviewed and approved, per
 * language; free-form text is allowed only inside the 24-hour window that
 * opens when the patient messages the practice first. So "send this
 * reminder over WhatsApp" is really "send approved template
 * `appointment_reminder_v1` with these variables", and a practice cannot
 * adopt it in an afternoon — business verification takes days.
 *
 * That is why `WHATSAPP_TEMPLATE` is a required setting rather than an
 * optional one. There is no sensible default: a template name this
 * account has not had approved is a 132001, and inventing one would turn
 * a configuration mistake into a runtime mystery.
 *
 * The message body the rest of the system composed is still what gets
 * **stored**, because the `messages` log exists for the receptionist, who
 * wants to know what the patient read — not which template id produced
 * it. Here the body is passed as the template's first body parameter,
 * which is the shape a reminder template actually takes:
 * "Hello {{1}}" with the whole sentence in `{{1}}`.
 *
 * Credentials arrive through the constructor — see the note on
 * `TwilioSmsAdapter` for why the config module is read once at import and
 * why that makes it the wrong place for an adapter to reach into.
 */
export type WhatsAppCredentials = {
  phoneNumberId?: string | undefined;
  token?: string | undefined;
  template?: string | undefined;
  language?: string | undefined;
  apiBase?: string | undefined;
  version?: string | undefined;
};

@Injectable()
export class MetaWhatsAppAdapter implements ChannelAdapter {
  readonly channel = "whatsapp" as const;
  readonly describe: string;

  private readonly log = new Logger(MetaWhatsAppAdapter.name);
  private readonly base: string;
  private readonly version: string;
  private readonly language: string;

  constructor(private readonly creds: WhatsAppCredentials) {
    this.base = (this.creds.apiBase ?? "https://graph.facebook.com").replace(/\/$/, "");
    // Pinned rather than floating. Meta's Graph versions are deprecated on
    // a schedule, and a system that silently follows "latest" is a system
    // that breaks on somebody else's release day.
    this.version = this.creds.version ?? "v21.0";
    this.language = this.creds.language ?? "en";
    this.describe =
      `WhatsApp Cloud API — live, template "${this.creds.template}" (${this.language}), ` +
      `number ${this.creds.phoneNumberId}`;
  }

  accepts(to: string): boolean {
    return looksLikePhone(to);
  }

  /**
   * Meta's error codes, sorted.
   * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
   *
   * The interesting ones are the template failures: 132000-132015 mean
   * this account cannot send this template to this person, today or ever,
   * and retrying is pure noise in the log.
   */
  private static permanent(code: number | null | undefined): boolean {
    if (code == null) return false;
    if (code >= 132000 && code <= 132015) return true; // template problems
    return [
      131026, // message undeliverable — not a WhatsApp user, or cannot receive
      131047, // outside the 24-hour window and no template — re-engagement
      131051, // unsupported message type
      100,    // invalid parameter
      190,    // the access token is expired or revoked
      200,    // permission denied
    ].includes(code);
  }

  async send(message: Outbound): Promise<SendResult> {
    const to = normalisePhone(message.to);
    if (!this.accepts(to)) {
      return { ok: false, reason: `${message.to} is not in international format`, retryable: false };
    }

    // Meta wants the number without the leading +.
    const recipient = to.replace(/^\+/, "");

    let res: Response;
    try {
      res = await fetch(`${this.base}/${this.version}/${this.creds.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.creds.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "template",
          template: {
            name: this.creds.template,
            language: { code: this.language },
            components: [
              {
                type: "body",
                // Newlines are not allowed in a template parameter and are
                // rejected with a 132000 that says nothing useful. Folded
                // here rather than left to fail in production.
                parameters: [{ type: "text", text: message.body.replace(/\s*\n\s*/g, " ").trim() }],
              },
            ],
          },
        }),
      });
    } catch (e) {
      return {
        ok: false,
        reason: `could not reach the WhatsApp Cloud API: ${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
      };
    }

    const payload = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string; code?: number; error_subcode?: number; type?: string };
    };

    if (!res.ok || payload.error) {
      const code = payload.error?.code ?? null;
      const retryable = res.status === 429 || res.status >= 500
        ? true
        : !MetaWhatsAppAdapter.permanent(code);
      this.log.warn(
        `whatsapp refused ${to}: ${res.status} ${payload.error?.message ?? ""} (${code ?? "no code"})`,
      );
      return {
        ok: false,
        reason: payload.error?.message ?? `the WhatsApp Cloud API answered ${res.status}`,
        retryable,
      };
    }

    const id = payload.messages?.[0]?.id;
    if (!id) {
      return { ok: false, reason: "the WhatsApp Cloud API returned no message id", retryable: true };
    }
    return {
      ok: true,
      providerId: id,
      note: `sent as template "${this.creds.template}" — delivery is reported by webhook`,
    };
  }

  /**
   * Does this token still open this phone number?
   *
   * `GET /{phone-number-id}` is the documented read on the number itself.
   * It is also the call that catches the failure this integration is most
   * prone to: Meta's access tokens expire, and a practice discovers it
   * when the reminders stop.
   */
  async preflight(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(
        `${this.base}/${this.version}/${this.creds.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
        { headers: { authorization: `Bearer ${this.creds.token}` } },
      );
      const body = (await res.json().catch(() => ({}))) as {
        display_phone_number?: string;
        verified_name?: string;
        quality_rating?: string;
        error?: { message?: string };
      };
      if (!res.ok || body.error) {
        return { ok: false, detail: body.error?.message ?? `HTTP ${res.status}` };
      }
      return {
        ok: true,
        detail:
          `${body.verified_name ?? "number"} ${body.display_phone_number ?? ""}`.trim() +
          (body.quality_rating ? ` — quality ${body.quality_rating}` : ""),
      };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
