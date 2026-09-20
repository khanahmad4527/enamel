import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { config } from "../config/config";
import { RemindersSweep } from "./reminders.sweep";
import { REMINDERS_QUEUE } from "./reminders.processor";

/**
 * Operating the queue, rather than reading data through it.
 *
 * Two things a practice needs that a timer alone does not give you: a way
 * to run the sweep now, and a way to see what failed. The second matters
 * more than it sounds — the Directus flow this replaces could not fail
 * visibly, so "have the reminders gone out" was a question nobody could
 * answer.
 *
 * Guarded by the service token rather than by a user session. The sweep
 * crosses every practice, so a receptionist's token is the wrong shape of
 * credential for it: they would be authorising an action outside their
 * own tenant. This is an operator's button, and it is held to an
 * operator's secret.
 */
@Controller("reminders")
export class RemindersController {
  constructor(
    private readonly sweep: RemindersSweep,
    @InjectQueue(REMINDERS_QUEUE) private readonly queue: Queue,
  ) {}

  private authorise(token: string | undefined): void {
    if (!config.directus.reminderToken) {
      throw new ServiceUnavailableException(
        "No service token is configured, so there is nothing to check this against.",
      );
    }
    // Length-independent comparison is overkill for a local demo and the
    // right habit regardless; an early return on the first wrong byte
    // leaks the prefix to anyone willing to time it.
    const expected = config.directus.reminderToken;
    const given = token ?? "";
    let mismatch = given.length === expected.length ? 0 : 1;
    for (let i = 0; i < Math.max(given.length, expected.length); i++) {
      mismatch |= (given.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
    }
    if (mismatch !== 0) throw new ForbiddenException("Wrong service token.");
  }

  /** Run the sweep now. Returns how many reminders it queued. */
  @Post("sweep")
  async run(@Headers("x-reminder-token") token?: string) {
    this.authorise(token);
    return { queued: await this.sweep.run() };
  }

  /**
   * What the queue is holding.
   *
   * `failed` is the number that matters. A reminder that bounced used to
   * be indistinguishable from one that arrived; this is the counter that
   * makes the difference visible without reading a log.
   */
  @Get("status")
  async status(@Headers("x-reminder-token") token?: string) {
    this.authorise(token);
    const counts = await this.queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
    );
    const failures = await this.queue.getFailed(0, 9);
    return {
      counts,
      failed: failures.map((job) => ({
        appointment: (job.data as { appointmentId?: string }).appointmentId,
        attempts: job.attemptsMade,
        reason: job.failedReason,
      })),
    };
  }
}
