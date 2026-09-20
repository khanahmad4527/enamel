import {
  BadRequestException,
  Body,
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
import { MESSAGES_QUEUE, MessagesService } from "./messages.service";
import { CampaignsSweep } from "./campaigns.sweep";
import { ChannelRegistry } from "./registry";
import type { Channel } from "./channel";

const CHANNELS: Channel[] = ["email", "sms", "whatsapp"];

/**
 * Operating the pipeline, and receiving replies.
 *
 * Two different audiences behind one controller, and they are authorised
 * differently on purpose.
 *
 * The operator endpoints — run the sweep now, what is on the failed set —
 * are held to the service token, because the sweeps cross every practice
 * and a receptionist's session is the wrong shape of credential for an
 * action outside her own tenant.
 *
 * The inbound webhook is held to a *separate* secret. A provider posting a
 * patient's reply has no Directus account and never will, and reusing the
 * operator token for it would mean handing Twilio a credential that can
 * also read the queue. One secret per caller, each doing one thing.
 */
@Controller("messaging")
export class MessagingController {
  constructor(
    private readonly messages: MessagesService,
    private readonly sweep: CampaignsSweep,
    private readonly registry: ChannelRegistry,
    @InjectQueue(MESSAGES_QUEUE) private readonly queue: Queue,
  ) {}

  /** Constant-time-ish compare; an early return leaks the prefix to anyone timing it. */
  private matches(given: string | undefined, expected: string): boolean {
    const a = given ?? "";
    let mismatch = a.length === expected.length ? 0 : 1;
    for (let i = 0; i < Math.max(a.length, expected.length); i++) {
      mismatch |= (a.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
    }
    return mismatch === 0;
  }

  private operator(token: string | undefined): void {
    if (!config.directus.reminderToken) {
      throw new ServiceUnavailableException("No service token is configured to check this against.");
    }
    if (!this.matches(token, config.directus.reminderToken)) {
      throw new ForbiddenException("Wrong service token.");
    }
  }

  private provider(secret: string | undefined): void {
    if (!config.messaging.inboundSecret) {
      throw new ServiceUnavailableException(
        "No inbound secret is configured, so this endpoint refuses everything.",
      );
    }
    if (!this.matches(secret, config.messaging.inboundSecret)) {
      throw new ForbiddenException("Wrong inbound secret.");
    }
  }

  /** What each channel actually is. Two of the three are mocks. */
  @Get("channels")
  channels(@Headers("x-reminder-token") token?: string) {
    this.operator(token);
    // Behind the operator token, so it gets where each channel points.
    return this.registry.describe(true);
  }

  @Post("sweep")
  async run(@Headers("x-reminder-token") token?: string) {
    this.operator(token);
    return this.sweep.run();
  }

  /**
   * What the queue is holding.
   *
   * `failed` is the number that matters, and the reason this exists: the
   * Directus flow this replaced could not fail visibly, so "have the
   * reminders gone out" was a question nobody could answer.
   */
  @Get("status")
  async status(@Headers("x-reminder-token") token?: string) {
    this.operator(token);
    const counts = await this.queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    const failures = await this.queue.getFailed(0, 9);
    return {
      counts,
      failed: failures.map((job) => ({
        message: (job.data as { messageId?: string }).messageId,
        attempts: job.attemptsMade,
        reason: job.failedReason,
      })),
    };
  }

  /**
   * Send one message, now, to one patient.
   *
   * An operator endpoint rather than a patient-facing one, and it exists
   * for two reasons: a receptionist writing to somebody by hand, and the
   * suite proving that consent is checked at send time rather than
   * audited afterwards. Historical rows cannot answer that question — a
   * patient who opted out last week leaves yesterday's email looking like
   * a violation when it was not.
   */
  @Post("probe")
  async probe(@Body() body: Record<string, unknown>, @Headers("x-reminder-token") token?: string) {
    this.operator(token);
    const patient = typeof body["patient"] === "string" ? body["patient"] : "";
    const text = typeof body["body"] === "string" ? body["body"] : "";
    if (!patient || !text) {
      throw new BadRequestException("patient and body are both required.");
    }
    const sent = await this.messages.enqueue({
      patient, kind: "manual", subject: "A message from your dental practice", body: text,
    });
    if (!sent) throw new BadRequestException("No such patient.");
    return sent;
  }

  /**
   * A patient replying.
   *
   * Shaped as one endpoint for every channel rather than one per provider,
   * because the thing that differs between Twilio's webhook and Meta's is
   * the request body — which belongs in whatever translates it, not in the
   * inbox. A real deployment puts a thin provider-shaped route in front of
   * this; the demo posts to it directly, which is also how the suite
   * exercises two-way messaging without an account anywhere.
   */
  @Post("inbound")
  async inbound(
    @Body() body: Record<string, unknown>,
    @Headers("x-inbound-secret") secret?: string,
  ) {
    this.provider(secret);

    const channel = String(body["channel"] ?? "");
    if (!CHANNELS.includes(channel as Channel)) {
      throw new BadRequestException(`channel must be one of ${CHANNELS.join(", ")}.`);
    }
    const from = typeof body["from"] === "string" ? body["from"].trim() : "";
    const text = typeof body["body"] === "string" ? body["body"].trim() : "";
    if (!from) throw new BadRequestException("`from` is required — who sent it?");
    if (!text) throw new BadRequestException("`body` is required — an empty reply is not a reply.");

    const received = await this.messages.receive({
      channel: channel as Channel,
      from,
      body: text,
      providerId: typeof body["providerId"] === "string" ? body["providerId"] : null,
    });
    if (!received) throw new BadRequestException("Could not record that message.");

    // 200 with `matched: false` rather than a 404. The provider did its
    // job; whether the number belongs to a patient is the practice's
    // problem, and answering 4xx would make Twilio retry a message that
    // was recorded perfectly well.
    return received;
  }
}
