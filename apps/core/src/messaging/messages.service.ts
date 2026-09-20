import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { DbService } from "../db/db.service";
import type { Channel } from "./channel";

export const MESSAGES_QUEUE = "messages";

export type MessageJob = { messageId: string };

export type Draft = {
  patient: string;
  kind: "reminder" | "confirmation" | "cancellation" | "recall" | "payment" | "reply" | "manual";
  subject?: string | null;
  body: string;
  appointment?: string | null;
  invoice?: string | null;
  recall?: string | null;
  /** Ordered by preference; the first the patient has consented to wins. */
  prefer?: Channel[];
};

type Contact = {
  email: string | null;
  phone: string | null;
  allow_email: boolean;
  allow_sms: boolean;
  allow_whatsapp: boolean;
};

/**
 * Writing the message down, then queueing it.
 *
 * In that order, and the order is the design. The row is created `queued`
 * *before* anything is handed to a provider, so a message can never be
 * delivered without a record of it existing — which is the failure the
 * whole log is here to prevent. The reverse order has a window where the
 * patient has the text and the practice has nothing.
 *
 * Consent is resolved here rather than in the adapters. An adapter's job
 * is to talk to a provider; deciding whether a patient agreed to be texted
 * is a question about the patient, and putting it in three adapters is
 * three places to forget it. A message to a channel the patient declined
 * is written down as `suppressed` rather than dropped — "we did not tell
 * them, and here is why" is an answer; silence is not.
 */
@Injectable()
export class MessagesService {
  private readonly log = new Logger(MessagesService.name);

  constructor(
    private readonly db: DbService,
    @InjectQueue(MESSAGES_QUEUE) private readonly queue: Queue<MessageJob>,
  ) {}

  /** Address and consent for one patient. */
  private async contact(patient: string): Promise<Contact | null> {
    return this.db.one<Contact>(
      `SELECT email, phone, allow_email, allow_sms, allow_whatsapp
         FROM patients WHERE id = $1`,
      [patient],
    );
  }

  /**
   * The first channel the patient has both an address for and agreed to.
   *
   * Preference order is the caller's — a payment chase would rather email,
   * a same-day cancellation would rather text — but consent always wins
   * over preference, which is the point.
   */
  private choose(
    contact: Contact,
    prefer: Channel[],
  ): { channel: Channel; address: string } | { declined: true } {
    for (const channel of prefer) {
      if (channel === "email" && contact.allow_email && contact.email) {
        return { channel, address: contact.email };
      }
      if (channel === "sms" && contact.allow_sms && contact.phone) {
        return { channel, address: contact.phone };
      }
      if (channel === "whatsapp" && contact.allow_whatsapp && contact.phone) {
        return { channel, address: contact.phone };
      }
    }
    return { declined: true };
  }

  /**
   * Records a message and queues it for delivery.
   *
   * `dedupeKey` makes the sweeps safe to run on a timer: the same
   * appointment reminder asked for twice produces one row and one send.
   * Without it, a sweep that overlaps itself — or simply runs again before
   * the first batch finished — texts everybody twice.
   */
  async enqueue(draft: Draft, dedupeKey?: string): Promise<{ id: string; status: string } | null> {
    const contact = await this.contact(draft.patient);
    if (!contact) return null;

    const prefer = draft.prefer ?? ["email", "sms", "whatsapp"];
    const chosen = this.choose(contact, prefer);

    if ("declined" in chosen) {
      // Written down, not dropped. A practice asked "did we chase this
      // invoice" deserves "no, they opted out of everything" rather than
      // an empty result that looks like the sweep never ran.
      const row = await this.db.one<{ id: string }>(
        `INSERT INTO messages
           (id, patient, direction, channel, kind, status, subject, body,
            appointment, invoice, recall, failure_reason, date_created)
         VALUES (gen_random_uuid(), $1, 'outbound', $2, $3, 'suppressed', $4, $5, $6, $7, $8,
                 'No channel the patient has consented to and has an address for', now())
         RETURNING id`,
        [draft.patient, prefer[0] ?? "email", draft.kind,
         draft.subject ?? null, draft.body, draft.appointment ?? null,
         draft.invoice ?? null, draft.recall ?? null],
      );
      return row ? { id: row.id, status: "suppressed" } : null;
    }

    const row = await this.db.one<{ id: string }>(
      `INSERT INTO messages
         (id, patient, direction, channel, kind, status, address, subject, body,
          appointment, invoice, recall, date_created)
       VALUES (gen_random_uuid(), $1, 'outbound', $2, $3, 'queued', $4, $5, $6, $7, $8, $9, now())
       RETURNING id`,
      [draft.patient, chosen.channel, draft.kind, chosen.address,
       draft.subject ?? null, draft.body, draft.appointment ?? null,
       draft.invoice ?? null, draft.recall ?? null],
    );
    if (!row) return null;

    await this.queue.add(
      "send",
      { messageId: row.id },
      {
        // Hyphens, not colons: BullMQ builds its own Redis keys with ":"
        // and refuses a custom id containing one.
        jobId: dedupeKey ? `msg-${dedupeKey}` : `msg-${row.id}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 500,
        // Failures are kept. A message nobody can see failing is the bug
        // this whole pipeline exists to avoid.
        removeOnFail: false,
      },
    );

    return { id: row.id, status: "queued" };
  }

  /** Records an inbound message against whichever patient it came from. */
  async receive(params: {
    channel: Channel;
    from: string;
    body: string;
    providerId?: string | null;
  }): Promise<{ id: string; matched: boolean } | null> {
    const digits = params.from.replace(/[\s-]/g, "");
    // Matched on the address the message came from. A reply from a number
    // no patient has is still recorded — with no patient attached — rather
    // than discarded: an unmatched inbound message is a person trying to
    // reach the practice, which is exactly what the inbox is for.
    const patient = await this.db.one<{ id: string }>(
      `SELECT id FROM patients
        WHERE (${params.channel === "email" ? "lower(email) = lower($1)" : "replace(replace(phone,' ',''),'-','') = $1"})
        LIMIT 1`,
      [params.channel === "email" ? params.from : digits],
    );

    const row = await this.db.one<{ id: string }>(
      `INSERT INTO messages
         (id, patient, direction, channel, kind, status, address, body, provider_id, date_created)
       VALUES (gen_random_uuid(), $1, 'inbound', $2, 'reply', 'received', $3, $4, $5, now())
       RETURNING id`,
      [patient?.id ?? null, params.channel,
       params.from, params.body, params.providerId ?? null],
    );
    if (!row) return null;
    if (!patient) this.log.warn(`inbound ${params.channel} from ${params.from} matched no patient`);
    return { id: row.id, matched: Boolean(patient) };
  }
}
