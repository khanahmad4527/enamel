import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { DbService } from "../db/db.service";
import { MESSAGES_QUEUE, type MessageJob } from "./messages.service";
import { ChannelRegistry } from "./registry";
import type { Channel } from "./channel";

type Row = {
  id: string;
  channel: Channel;
  address: string | null;
  subject: string | null;
  body: string;
  status: string;
  attempts: number;
};

/**
 * Handing one message to its channel, and writing down what happened.
 *
 * The status on the row is the practice's answer to "was this sent", so it
 * is only ever set from what the adapter actually returned. Nothing here
 * sets `sent` optimistically — that is the exact failure this replaced: a
 * Directus flow that called the mail operation without awaiting it and
 * marked the appointment reminded either way, so a bounced address and a
 * delivered message were indistinguishable.
 *
 * A permanent refusal stops retrying immediately. Trying a malformed phone
 * number five times with exponential backoff is a slower way of not
 * telling anybody, and it buries the row that needs a human under four
 * that do not.
 */
@Processor(MESSAGES_QUEUE, { concurrency: 4 })
export class MessagesProcessor extends WorkerHost {
  private readonly log = new Logger(MessagesProcessor.name);

  constructor(
    private readonly db: DbService,
    private readonly registry: ChannelRegistry,
  ) {
    super();
  }

  async process(job: Job<MessageJob>): Promise<{ status: string }> {
    const row = await this.db.one<Row>(
      `SELECT id, channel, address, subject, body, status, attempts FROM messages WHERE id = $1`,
      [job.data.messageId],
    );
    if (!row) {
      // Deleted between queueing and sending. Nothing to do and nothing
      // worth failing over.
      this.log.warn(`message ${job.data.messageId} is gone; dropping the job`);
      return { status: "gone" };
    }
    if (row.status === "sent" || row.status === "delivered") {
      return { status: row.status };
    }

    const adapter = this.registry.for(row.channel);
    if (!adapter) {
      await this.fail(row.id, `no adapter is registered for ${row.channel}`, row.attempts + 1);
      return { status: "failed" };
    }

    const result = await adapter.send({
      to: row.address ?? "",
      subject: row.subject ?? undefined,
      body: row.body,
      reference: row.id,
    });

    if (result.ok) {
      await this.db.rows(
        `UPDATE messages
            SET status = 'sent', provider_id = $2, sent_at = now(),
                attempts = $3, failure_reason = NULL
          WHERE id = $1`,
        [row.id, result.providerId, row.attempts + 1],
      );
      return { status: "sent" };
    }

    await this.fail(row.id, result.reason, row.attempts + 1);

    // Throwing is what tells BullMQ to retry. A permanent refusal returns
    // instead, so the job completes and the row is left `failed` for a
    // human — which is the outcome, not an error.
    if (result.retryable) throw new Error(result.reason);
    this.log.warn(`message ${row.id} refused permanently: ${result.reason}`);
    return { status: "failed" };
  }

  private async fail(id: string, reason: string, attempts: number): Promise<void> {
    await this.db.rows(
      `UPDATE messages SET status = 'failed', failure_reason = $2, attempts = $3 WHERE id = $1`,
      [id, reason, attempts],
    );
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<MessageJob>, err: Error): void {
    const attempts = job.opts.attempts ?? 1;
    const last = job.attemptsMade >= attempts;
    this.log.warn(
      `message ${job.data.messageId} attempt ${job.attemptsMade}/${attempts}` +
        `${last ? " — giving up, left on the failed set" : ", will retry"}: ${err.message}`,
    );
  }
}
