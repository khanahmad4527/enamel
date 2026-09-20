import { Injectable, Logger } from "@nestjs/common";
import {
  looksLikePhone, normalisePhone,
  type ChannelAdapter, type Outbound, type SendResult,
} from "../channel";

/**
 * Twilio Programmable Messaging, spoken directly.
 *
 * https://www.twilio.com/docs/messaging/api/message-resource
 *
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   Authorization: Basic base64(AccountSid:AuthToken)
 *   Content-Type: application/x-www-form-urlencoded
 *   To=+31…&From=+31…&Body=…
 *
 * No SDK. Not on principle — the SDK is fine — but because the whole of
 * the integration is the form post above and the twenty lines below that
 * decide what a failure *means*. A dependency that wraps one HTTP call
 * hides the only part worth reading, and the docs are the spec either
 * way.
 *
 * **The judgement this adapter exists to make is retryable or not.** The
 * queue above it retries five times; only the thing talking to Twilio can
 * tell a network blip from a number that will never receive anything, and
 * retrying a dead number five times is a slower way of not telling
 * anybody.
 *
 * Credentials arrive through the constructor rather than being read from
 * the config module. `config` reads the environment **once, at import**,
 * which is right for a service that must not change provider while it is
 * running — and it means an adapter that reaches into it can only ever be
 * built one way. Handing them in keeps the composition root in
 * `select.ts` and lets `test/adapter-contract.ts` point this class at a
 * server that answers the way Twilio's reference says it will.
 */
export type TwilioCredentials = {
  accountSid?: string | undefined;
  authToken?: string | undefined;
  from?: string | undefined;
  messagingServiceSid?: string | undefined;
  apiBase?: string | undefined;
  statusCallback?: string | undefined;
};

@Injectable()
export class TwilioSmsAdapter implements ChannelAdapter {
  readonly channel = "sms" as const;
  readonly describe: string;

  private readonly log = new Logger(TwilioSmsAdapter.name);
  private readonly base: string;

  constructor(private readonly creds: TwilioCredentials) {
    // Regional endpoints are a data-residency requirement, not a nicety:
    // an EU practice may be obliged to keep message content in the EU, and
    // Twilio's answer to that is api.ie1.twilio.com rather than a setting.
    this.base = (this.creds.apiBase ?? "https://api.twilio.com").replace(/\/$/, "");
    const sender = this.creds.messagingServiceSid
      ? `Messaging Service ${this.creds.messagingServiceSid}`
      : `from ${this.creds.from}`;
    this.describe = `Twilio — live, ${sender}, account ${this.creds.accountSid?.slice(0, 6)}…`;
  }

  accepts(to: string): boolean {
    return looksLikePhone(to);
  }

  /**
   * Twilio's own errors, sorted into the two that matter.
   *
   * https://www.twilio.com/docs/api/errors
   *
   * These are the codes a practice actually meets. Everything in the
   * 21xxx range is a fact about the request or the recipient and will be
   * exactly as true on the fifth attempt as on the first.
   */
  private static permanent(code: number | null | undefined): boolean {
    if (code == null) return false;
    return [
      21211, // 'To' is not a valid phone number
      21214, // 'To' is not a mobile number
      21408, // permission to send to this region is not enabled on the account
      21606, // the 'From' number is not a valid, SMS-capable Twilio number
      21610, // the recipient has replied STOP — sending anyway is unlawful
      21612, // unreachable by this route
      21614, // 'To' is not a mobile number
      30003, // handset unreachable
      30005, // unknown destination
      30006, // landline, or unreachable carrier
    ].includes(code);
  }

  async send(message: Outbound): Promise<SendResult> {
    const to = normalisePhone(message.to);
    if (!this.accepts(to)) {
      return { ok: false, reason: `${message.to} is not in international format`, retryable: false };
    }

    const body = new URLSearchParams({ To: to, Body: message.body });
    // One or the other, never both — the API rejects a request carrying a
    // Messaging Service and a From together.
    if (this.creds.messagingServiceSid) body.set("MessagingServiceSid", this.creds.messagingServiceSid);
    else if (this.creds.from) body.set("From", this.creds.from);
    if (this.creds.statusCallback) body.set("StatusCallback", this.creds.statusCallback);

    const auth = Buffer.from(`${this.creds.accountSid}:${this.creds.authToken}`).toString("base64");

    let res: Response;
    try {
      res = await fetch(
        `${this.base}/2010-04-01/Accounts/${this.creds.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${auth}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        },
      );
    } catch (e) {
      // Never reached Twilio at all. Always worth another go.
      return {
        ok: false,
        reason: `could not reach Twilio: ${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
      };
    }

    const payload = (await res.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      error_code?: number | null;
      error_message?: string | null;
      code?: number;
      message?: string;
    };

    if (!res.ok) {
      const code = payload.code ?? null;
      /*
       * 429 and 5xx are about the minute; anything else Twilio refuses
       * outright is about the request or the recipient, and will be just
       * as refused in thirty seconds.
       *
       * The error-code list is deliberately **not** consulted here. It was
       * at first, alongside a `res.status < 400` that could never be true
       * inside this branch — so the call read as though it decided
       * something and decided nothing. Sabotaging the list failed one
       * assertion instead of two, which is how the dead half was found.
       * The list earns its keep below, where Twilio reports a failure on
       * an otherwise successful response.
       */
      const retryable = res.status === 429 || res.status >= 500;
      this.log.warn(`twilio refused ${to}: ${res.status} ${payload.message ?? ""} (${code ?? "no code"})`);
      return {
        ok: false,
        reason: payload.message ?? `Twilio answered ${res.status}`,
        retryable,
      };
    }

    // A 201 is not a delivery. Twilio accepts the message and reports
    // `queued` or `accepted`; `failed` and `undelivered` come back on this
    // same response when it could not even be enqueued, and carry the
    // reason in `error_code`.
    if (payload.status === "failed" || payload.status === "undelivered") {
      return {
        ok: false,
        reason: payload.error_message ?? `Twilio returned status ${payload.status}`,
        retryable: !TwilioSmsAdapter.permanent(payload.error_code),
      };
    }

    return {
      ok: true,
      providerId: payload.sid ?? message.reference,
      // Said out loud because it is the thing people get wrong about SMS:
      // the provider accepting a message is not the handset receiving it.
      note: `accepted by Twilio (${payload.status ?? "queued"}) — delivery is reported later`,
    };
  }

  /**
   * Do these credentials work?
   *
   * `GET /Accounts/{Sid}.json` is the cheapest authenticated call Twilio
   * has and it changes nothing. Used by the preflight endpoint, so
   * "I added the environment variables" can be confirmed rather than
   * assumed — which is the whole point of being able to swap a provider
   * by configuration.
   */
  async preflight(): Promise<{ ok: boolean; detail: string }> {
    const auth = Buffer.from(`${this.creds.accountSid}:${this.creds.authToken}`).toString("base64");
    try {
      const res = await fetch(`${this.base}/2010-04-01/Accounts/${this.creds.accountSid}.json`, {
        headers: { authorization: `Basic ${auth}` },
      });
      const body = (await res.json().catch(() => ({}))) as {
        friendly_name?: string; status?: string; message?: string;
      };
      if (!res.ok) return { ok: false, detail: body.message ?? `HTTP ${res.status}` };
      return {
        ok: body.status === "active",
        detail: `${body.friendly_name ?? "account"} (${body.status ?? "unknown status"})`,
      };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
