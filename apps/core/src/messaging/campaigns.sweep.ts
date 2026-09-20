import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Queue, type Job } from "bullmq";
import { config } from "../config/config";
import { DbService } from "../db/db.service";
import { MessagesService } from "./messages.service";

export const CAMPAIGNS_QUEUE = "message-sweeps";

type Due = {
  id: string;
  patient: string;
  practice: string;
  timezone: string | null;
  first_name: string | null;
  last_name: string | null;
  when?: Date;
  amount?: string;
  number?: string;
};

/**
 * Finding the people who should have heard something and have not.
 *
 * Four sweeps, one pattern, and the pattern is the interesting part: each
 * asks the *message log* whether the practice has already said this, not a
 * flag on the thing being talked about.
 *
 *   NOT EXISTS (SELECT 1 FROM messages
 *                WHERE appointment = a.id AND kind = 'confirmation')
 *
 * A boolean per message type on each parent would need a column every time
 * a fifth kind is added, and — worse — can drift from the log it is
 * supposed to summarise. Asking the log cannot drift, because the log is
 * the thing being asked about.
 *
 * Sweeping rather than reacting to events is the other deliberate choice.
 * A hook that fires on booking is one missed webhook away from a patient
 * never being confirmed; a sweep that runs every fifteen minutes catches
 * up after a restart, a deploy, or an hour of Redis being down. The cost
 * is up to fifteen minutes of latency on a confirmation, which nobody
 * notices, and the benefit is that "we never told them" stops being a
 * possible outcome.
 */
@Injectable()
export class CampaignsSweep implements OnModuleInit {
  private readonly log = new Logger(CampaignsSweep.name);

  constructor(
    @InjectQueue(CAMPAIGNS_QUEUE) private readonly queue: Queue,
    private readonly db: DbService,
    private readonly messages: MessagesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      "scan",
      {},
      {
        repeat: { every: config.messaging.sweepMinutes * 60_000 },
        jobId: "message-sweep",
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    );
    this.log.log(`sweeping every ${config.messaging.sweepMinutes}m for messages that have come due`);
  }

  /** A time as the practice's town would say it. */
  private when(at: Date, tz: string | null): string {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || "UTC",
      weekday: "long", day: "numeric", month: "long",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(at);
  }

  private name(row: Due): string {
    return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "there";
  }

  /**
   * A booking the patient has not been told about.
   *
   * Deliberately only for appointments made *ahead* of time. Booking
   * somebody in at the desk while they stand there and then texting them a
   * confirmation as they walk out is the kind of thing that makes a
   * practice look automated rather than organised, so anything starting
   * within the day is left alone — the reminder will cover it.
   */
  private async confirmations(): Promise<number> {
    const due = await this.db.rows<Due>(
      `SELECT a.id, a.patient, c.name AS practice, c.timezone,
              p.first_name, p.last_name, a.starts_at AS when
         FROM appointments a
         CROSS JOIN practice c
         JOIN patients p ON p.id = a.patient
        WHERE a.status IN ('scheduled','confirmed')
          AND a.starts_at > now() + interval '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.appointment = a.id AND m.kind = 'confirmation')
        LIMIT 200`,
    );

    let queued = 0;
    for (const row of due) {
      const sent = await this.messages.enqueue(
        {
          patient: row.patient,
          kind: "confirmation",
          subject: `Your appointment at ${row.practice} is booked`,
          body: [
            `Dear ${this.name(row)},`,
            "",
            `Your appointment at ${row.practice} is booked for:`,
            "",
            `    ${this.when(row.when!, row.timezone)}`,
            "",
            "We will send a reminder the day before. If you need to change it,",
            "please call us as soon as you can.",
            "",
            row.practice,
          ].join("\n"),
          appointment: row.id,
          prefer: ["email", "sms", "whatsapp"],
        },
        `confirm-${row.id}`,
      );
      if (sent) queued++;
    }
    return queued;
  }

  /** A cancelled appointment the patient has not been told about. */
  private async cancellations(): Promise<number> {
    const due = await this.db.rows<Due>(
      `SELECT a.id, a.patient, c.name AS practice, c.timezone,
              p.first_name, p.last_name, a.starts_at AS when
         FROM appointments a
         CROSS JOIN practice c
         JOIN patients p ON p.id = a.patient
        WHERE a.status = 'cancelled'
          AND a.date_updated > now() - interval '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.appointment = a.id AND m.kind = 'cancellation')
        LIMIT 200`,
    );

    let queued = 0;
    for (const row of due) {
      const sent = await this.messages.enqueue(
        {
          patient: row.patient,
          kind: "cancellation",
          subject: `Your appointment at ${row.practice} has been cancelled`,
          body: [
            `Dear ${this.name(row)},`,
            "",
            `Your appointment on ${this.when(row.when!, row.timezone)} has been cancelled.`,
            "",
            "Please call us to rebook whenever suits you.",
            "",
            row.practice,
          ].join("\n"),
          appointment: row.id,
          // A cancellation is time-sensitive in a way a confirmation is
          // not: somebody may be about to set off.
          prefer: ["sms", "email", "whatsapp"],
        },
        `cancel-${row.id}`,
      );
      if (sent) queued++;
    }
    return queued;
  }

  /** A recall that came due and has not been chased. */
  private async recalls(): Promise<number> {
    const due = await this.db.rows<Due>(
      `SELECT r.id, r.patient, c.name AS practice, c.timezone,
              p.first_name, p.last_name
         FROM recalls r
         CROSS JOIN practice c
         JOIN patients p ON p.id = r.patient
        WHERE NOT r.is_disabled
          AND r.date_due <= current_date
          AND r.date_scheduled IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM messages m WHERE m.recall = r.id AND m.kind = 'recall')
        LIMIT 200`,
    );

    let queued = 0;
    for (const row of due) {
      const sent = await this.messages.enqueue(
        {
          patient: row.patient,
          kind: "recall",
          subject: `Time for your check-up at ${row.practice}`,
          body: [
            `Dear ${this.name(row)},`,
            "",
            "Our records show you are due for a check-up.",
            "Please call us or book online whenever suits you.",
            "",
            row.practice,
          ].join("\n"),
          recall: row.id,
          prefer: ["email", "sms", "whatsapp"],
        },
        `recall-${row.id}`,
      );
      if (sent) queued++;
    }
    return queued;
  }

  /** An invoice that has gone past due and has not been chased. */
  private async payments(): Promise<number> {
    const due = await this.db.rows<Due>(
      `SELECT i.id, i.patient, c.name AS practice, c.timezone,
              p.first_name, p.last_name, i.total::text AS amount, i.number
         FROM invoices i
         CROSS JOIN practice c
         JOIN patients p ON p.id = i.patient
        WHERE i.status IN ('sent','overdue')
          AND i.due_at < current_date - ($1 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM messages m WHERE m.invoice = i.id AND m.kind = 'payment')
        LIMIT 200`,
      [config.messaging.paymentChaseDays],
    );

    let queued = 0;
    for (const row of due) {
      const sent = await this.messages.enqueue(
        {
          patient: row.patient,
          kind: "payment",
          subject: `Invoice ${row.number} from ${row.practice}`,
          body: [
            `Dear ${this.name(row)},`,
            "",
            `Invoice ${row.number} for ${row.amount} is still outstanding.`,
            "",
            "If you have already paid, please ignore this. Otherwise, please",
            "call us and we can take payment or arrange a plan.",
            "",
            row.practice,
          ].join("\n"),
          invoice: row.id,
          // Money goes by email. A text chasing a bill reads as a scam,
          // and increasingly is one.
          prefer: ["email"],
        },
        `pay-${row.id}`,
      );
      if (sent) queued++;
    }
    return queued;
  }

  async run(): Promise<Record<string, number>> {
    const [confirmations, cancellations, recalls, payments] = [
      await this.confirmations(),
      await this.cancellations(),
      await this.recalls(),
      await this.payments(),
    ];
    const total = confirmations + cancellations + recalls + payments;
    if (total) {
      this.log.log(
        `queued ${total}: ${confirmations} confirmations, ${cancellations} cancellations, ` +
          `${recalls} recalls, ${payments} payment chases`,
      );
    }
    return { confirmations, cancellations, recalls, payments, total };
  }
}

/** Runs the sweep when its repeatable job fires. */
@Processor(CAMPAIGNS_QUEUE)
export class CampaignsProcessor extends WorkerHost {
  constructor(private readonly sweep: CampaignsSweep) {
    super();
  }

  async process(_job: Job): Promise<Record<string, number>> {
    return this.sweep.run();
  }
}
