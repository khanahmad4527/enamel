import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { createTransport, type Transporter } from "nodemailer";
import { config } from "../config/config";
import { DirectusService } from "../directus/directus.service";

export const REMINDERS_QUEUE = "reminders";

export type ReminderJob = {
  appointmentId: string;
  email: string;
  patientName: string;
  practiceName: string;
  practitionerName: string;
  localWhen: string;
  timezone: string;
};

/**
 * Sending the reminder, and admitting when it did not send.
 *
 * This is the job that justified a queue at all. The Directus flow it
 * replaces called the mail operation, which invokes `send()` without
 * awaiting it and swallows the rejection — so a bounced address, a
 * refused connection and a delivered message were indistinguishable, and
 * the flow went on to mark the appointment reminded either way.
 *
 * Here the send is awaited, a failure throws, BullMQ retries with
 * exponential backoff, and a job that exhausts its attempts stays on the
 * failed set where somebody can look at it. The appointment is only
 * marked reminded after the transport has accepted the message — in that
 * order, so the failure mode is a patient reminded twice rather than a
 * patient not reminded at all.
 */
@Processor(REMINDERS_QUEUE, { concurrency: 4 })
export class RemindersProcessor extends WorkerHost {
  private readonly log = new Logger(RemindersProcessor.name);
  private readonly mail: Transporter;

  constructor(private readonly directus: DirectusService) {
    super();
    this.mail = createTransport({
      host: config.mail.host,
      port: config.mail.port,
      // Mailpit locally; a real transport would carry credentials. Left
      // insecure-by-default rather than pretending otherwise.
      secure: false,
      tls: { rejectUnauthorized: false },
    });
  }

  async process(job: Job<ReminderJob>): Promise<{ sent: true }> {
    const { appointmentId, email, patientName, practiceName, practitionerName, localWhen } = job.data;

    await this.mail.sendMail({
      from: config.mail.from,
      to: email,
      subject: `Your appointment at ${practiceName} — ${localWhen}`,
      text: [
        `Dear ${patientName},`,
        "",
        `This is a reminder of your appointment at ${practiceName}:`,
        "",
        `    ${localWhen}`,
        practitionerName ? `    with ${practitionerName}` : "",
        "",
        "If you can no longer make it, please call us as soon as you can so",
        "we can offer the time to somebody on the waiting list.",
        "",
        practiceName,
      ]
        .filter((line) => line !== "")
        .join("\n"),
    });

    // Only now. Marking first and sending second would mean a transport
    // failure left an appointment that says it was reminded and a patient
    // who was not.
    await this.directus.markReminded(appointmentId);
    return { sent: true };
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<ReminderJob>, err: Error): void {
    const attempts = job.opts.attempts ?? 1;
    const last = job.attemptsMade >= attempts;
    this.log.warn(
      `reminder for ${job.data.appointmentId} failed on attempt ${job.attemptsMade}/${attempts}` +
        `${last ? " — giving up, left on the failed set" : ", will retry"}: ${err.message}`,
    );
  }
}
