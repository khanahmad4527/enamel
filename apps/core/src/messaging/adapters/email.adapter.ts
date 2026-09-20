import { Injectable, Logger } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import { config } from "../../config/config";
import { looksLikeEmail, type ChannelAdapter, type Outbound, type SendResult } from "../channel";

/**
 * Email, for real, into a local sink.
 *
 * The only adapter here that is not a mock: it speaks SMTP to Mailpit,
 * which is a genuine mail server that simply never forwards anything.
 * Pointing `EMAIL_SMTP_HOST` at a real relay is the whole change needed to
 * make this production — no code, one variable.
 *
 * That is the bar the other adapters are measured against, and the reason
 * this one goes first in the README.
 */
@Injectable()
export class EmailAdapter implements ChannelAdapter {
  readonly channel = "email" as const;
  readonly describe = "real SMTP — the only channel here that is not a mock; one variable points it at a production relay";
  readonly detail = `SMTP to ${config.mail.host}:${config.mail.port} (Mailpit locally; point at a relay for production)`;

  private readonly log = new Logger(EmailAdapter.name);
  private readonly transport: Transporter;

  constructor() {
    this.transport = createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: false,
      tls: { rejectUnauthorized: false },
    });
  }

  accepts(to: string): boolean {
    return looksLikeEmail(to);
  }

  async send(message: Outbound): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: config.mail.from,
        to: message.to,
        subject: message.subject ?? "Your dental practice",
        text: message.body,
        headers: { "X-Enamel-Message": message.reference },
      });
      return { ok: true, providerId: String(info.messageId ?? message.reference) };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // A refused recipient is a fact about the address; a refused
      // connection is a fact about the minute. Only the second is worth
      // retrying, and only this layer can tell them apart.
      const permanent = /550|551|553|no such user|mailbox unavailable/i.test(reason);
      this.log.warn(`email to ${message.to} failed (${permanent ? "permanent" : "retryable"}): ${reason}`);
      return { ok: false, reason, retryable: !permanent };
    }
  }
}
