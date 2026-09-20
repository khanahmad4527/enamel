import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Queue, type Job } from "bullmq";
import { config } from "../config/config";
import { DbService } from "../db/db.service";
import { REMINDERS_QUEUE, type ReminderJob } from "./reminders.processor";
import { MessagesService } from "../messaging/messages.service";

export const SWEEP_QUEUE = "reminder-sweep";

type DueRow = {
  id: string;
  patient_id: string;
  email: string | null;
  patient_first: string | null;
  patient_last: string | null;
  practice: string;
  timezone: string | null;
  pr_first: string | null;
  pr_last: string | null;
  starts_at: Date;
};

/**
 * Finding the appointments that have come due.
 *
 * A repeatable job rather than a cron expression on the sending queue,
 * because the two have different shapes: the sweep is one query that must
 * not run twice at once, and the sends are many small jobs that should.
 *
 * The job id is the appointment id, which is what makes the sweep safe to
 * run every fifteen minutes. BullMQ refuses a duplicate id while the job
 * is still known to the queue, so an appointment that has already been
 * queued is not queued again — the sweep can overlap itself, run twice
 * after a restart, or be triggered by hand, and the patient still gets
 * one email.
 */
@Injectable()
export class RemindersSweep implements OnModuleInit {
  private readonly log = new Logger(RemindersSweep.name);

  constructor(
    @InjectQueue(SWEEP_QUEUE) private readonly sweep: Queue,
    @InjectQueue(REMINDERS_QUEUE) private readonly reminders: Queue<ReminderJob>,
    private readonly db: DbService,
    private readonly messages: MessagesService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Named, so re-registering on every boot replaces the schedule rather
    // than stacking another copy of it on top.
    await this.sweep.add(
      "scan",
      {},
      {
        repeat: { every: config.reminders.sweepMinutes * 60_000 },
        jobId: "reminder-sweep",
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    );
    this.log.log(
      `sweeping every ${config.reminders.sweepMinutes}m for appointments ` +
        `${config.reminders.leadHours}h out`,
    );
  }

  async run(): Promise<number> {
    const due = await this.db.rows<DueRow>(
      `SELECT a.id,
              p.id AS patient_id,
              p.email,
              p.first_name AS patient_first, p.last_name AS patient_last,
              c.name AS practice, c.timezone,
              u.first_name AS pr_first, u.last_name AS pr_last,
              a.starts_at
         FROM appointments a
         JOIN patients p ON p.id = a.patient
         CROSS JOIN practice c
         LEFT JOIN directus_users u ON u.id = a.practitioner
        WHERE a.status IN ('scheduled','confirmed')
          AND NOT a.reminder_sent
          AND p.email IS NOT NULL
          AND a.starts_at > now()
          AND a.starts_at <= now() + ($1 || ' hours')::interval`,
      [config.reminders.leadHours],
    );

    let queued = 0;
    for (const row of due) {
      const tz = row.timezone || "UTC";
      const localWhen = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(row.starts_at);

      // Written to the message log as well as queued, so the practice has
      // one place that answers "what have we said to this patient" —
      // reminders, confirmations, chases and replies in one thread rather
      // than reminders in a queue and everything else in a table. The
      // reminder queue still does the sending, because it already retries
      // and already reports its failures.
      await this.messages.enqueue(
        {
          patient: row.patient_id,
          kind: "reminder",
          subject: `Your appointment at ${row.practice} — ${localWhen}`,
          body: [
            `Dear ${`${row.patient_first ?? ""} ${row.patient_last ?? ""}`.trim() || "there"},`,
            "",
            `This is a reminder of your appointment at ${row.practice}:`,
            "",
            `    ${localWhen}`,
            "",
            "If you can no longer make it, please call us as soon as you can",
            "so we can offer the time to somebody on the waiting list.",
            "",
            row.practice,
          ].join("\n"),
          appointment: row.id,
          prefer: ["email", "sms", "whatsapp"],
        },
        `reminder-${row.id}`,
      );

      const added = await this.reminders.add(
        "send",
        {
          appointmentId: row.id,
          email: row.email!,
          patientName: `${row.patient_first ?? ""} ${row.patient_last ?? ""}`.trim(),
          practiceName: row.practice,
          practitionerName: `${row.pr_first ?? ""} ${row.pr_last ?? ""}`.trim(),
          localWhen,
          timezone: tz,
        },
        {
          // The appointment id, so a second sweep cannot double-send.
          // Hyphen, not colon: BullMQ uses ":" to build its own Redis
          // keys and rejects a custom id containing one.
          jobId: `reminder-${row.id}`,
          attempts: config.reminders.attempts,
          backoff: { type: "exponential", delay: 30_000 },
          // Failures are kept. A reminder nobody can see failing is the
          // bug this whole queue exists to fix.
          removeOnComplete: 200,
          removeOnFail: false,
        },
      );
      if (added) queued++;
    }

    if (queued) this.log.log(`queued ${queued} reminder(s) from ${due.length} due`);
    return queued;
  }
}

/** Runs the sweep when its repeatable job fires. */
@Processor(SWEEP_QUEUE)
export class SweepProcessor extends WorkerHost {
  constructor(private readonly sweep: RemindersSweep) {
    super();
  }

  async process(_job: Job): Promise<{ queued: number }> {
    return { queued: await this.sweep.run() };
  }
}
