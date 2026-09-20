import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { config } from "../config/config";
import { DirectusAuthGuard, type AuthedRequest } from "../auth/directus-auth.guard";
import { PaymentsService } from "./payments/payments.service";
import { ChannelRegistry } from "../messaging/registry";
import { QueueAdminGuard } from "../queues/queue-admin.guard";
import { AccountingService } from "./accounting/accounting.service";
import { LabService } from "./lab/lab.service";
import { CalendarService } from "./calendar/calendar.service";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The four places this system touches something outside itself.
 *
 * Three of the routes here are held to a Directus token like everything
 * else. Two are not, and both exceptions are deliberate:
 *
 *   The calendar feed is a bearer URL, because no calendar client will
 *   authenticate for a text file. It carries its own per-clinician token,
 *   revocable on its own and never the account's API token.
 *
 *   The laboratory webhook is held to a separate secret, for the same
 *   reason the messaging one is: a laboratory posting a status update has
 *   no Directus account and never will, and reusing an operator token for
 *   it would mean handing a third party a credential that also reads the
 *   diary.
 */
@Controller("integrations")
export class IntegrationsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly accounting: AccountingService,
    private readonly lab: LabService,
    private readonly calendar: CalendarService,
    private readonly channels: ChannelRegistry,
  ) {}

  /** Constant-time-ish compare; an early return leaks the prefix. */
  private matches(given: string | undefined, expected: string): boolean {
    const a = given ?? "";
    let mismatch = a.length === expected.length ? 0 : 1;
    for (let i = 0; i < Math.max(a.length, expected.length); i++) {
      mismatch |= (a.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
    }
    return mismatch === 0;
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

  /**
   * What every integration actually is.
   *
   * Public, because the honest answer to "does this really take card
   * payments" should not require a login to get. Two of the six are
   * mocks, one records what a person did, and three are real — and saying
   * which is which is the point of the endpoint.
   */
  @Get("adapters")
  adapters() {
    return {
      // Messaging belongs on this list as much as the rest of it, and was
      // missing — which meant the one place that answers "what is real
      // here" left out the three channels a patient actually notices.
      messaging: Object.entries(this.channels.describe()).map(([channel, describe]) => ({
        id: `messaging.${channel}`, describe,
      })),
      payments: this.payments.gateways(),
      accounting: this.accounting.adapters(),
      lab: this.lab.adapters(),
      calendar: [this.calendar.describeAdapter()],
    };
  }

  /**
   * Do the credentials actually work?
   *
   * The missing half of "swap a provider by setting an environment
   * variable". Setting one is easy; being sure it took is the part people
   * discover by sending a real reminder to a real patient. This asks each
   * configured provider the cheapest authenticated question it has —
   * Twilio's `GET /Accounts/{Sid}`, Meta's `GET /{phone-number-id}`,
   * Stripe's `GET /v1/balance` — none of which change anything.
   *
   * Administrators only, unlike `/adapters` above. That one says what
   * kind of thing each integration is, which anybody may know; this one
   * reaches a provider with the installation's credentials and reports
   * what came back, including whether Stripe is in live mode. Neither is
   * patient data and both are somebody's business rather than everybody's.
   */
  @Get("preflight")
  @UseGuards(QueueAdminGuard)
  async preflight() {
    const [messaging, payments] = await Promise.all([
      this.channels.preflight(),
      this.payments.preflight(),
    ]);
    return {
      messaging,
      payments,
      // `ok: null` means there is nothing to check rather than that the
      // check failed — a mock has no account to reach, and a caller that
      // treats null as false would report a healthy system as broken.
      note: "ok: null means this adapter talks to nothing outside the building",
    };
  }

  /* ---------------- payments ---------------- */

  @Post("payments")
  @UseGuards(DirectusAuthGuard)
  async take(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
    const patient = str("patient");
    const amount = str("amount");
    const method = str("method");

    if (!/^[0-9a-f-]{36}$/i.test(patient)) throw new BadRequestException("Which patient is this for?");
    if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) {
      throw new BadRequestException("An amount looks like 40 or 40.00, and may be negative for a refund.");
    }
    if (!["card", "cash", "bank_transfer", "payment_plan"].includes(method)) {
      throw new BadRequestException("method must be card, cash, bank_transfer or payment_plan.");
    }

    // Generated here only when the caller did not send one, and the
    // distinction matters: a caller that lets the server invent the key
    // gets a new one on every retry and no protection at all. A client
    // that means to be safe sends the same key twice.
    const idempotencyKey = str("idempotency_key") || randomUUID();

    const result = await this.payments.take({
      patient,
      invoice: str("invoice") || null,
      amount,
      currency: str("currency") || "EUR",
      method: method as "card" | "cash" | "bank_transfer" | "payment_plan",
      idempotencyKey,
      simulate: ["decline", "network-error"].includes(str("simulate"))
        ? (str("simulate") as "decline" | "network-error")
        : undefined,
      note: str("note") || null,
    });

    if (!result.ok) {
      throw new BadRequestException({
        message: result.reason,
        retryable: result.retryable,
        payment: result.id,
      });
    }
    return { ...result, idempotency_key: idempotencyKey };
  }

  @Get("payments/outstanding")
  @UseGuards(DirectusAuthGuard)
  async outstanding(@Query("invoice") invoice: string) {
    if (!/^[0-9a-f-]{36}$/i.test(invoice ?? "")) throw new BadRequestException("Which invoice?");
    const amount = await this.payments.outstanding(invoice);
    if (amount === null) throw new NotFoundException("No such invoice.");
    return { invoice, outstanding: amount };
  }

  /* ---------------- accounting ---------------- */

  @Get("accounting/pending")
  @UseGuards(DirectusAuthGuard)
  async pending(@Req() req: AuthedRequest) {
    return this.accounting.pending();
  }

  @Post("accounting/export")
  @UseGuards(DirectusAuthGuard)
  async exportLedger(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const from = typeof body["from"] === "string" ? body["from"] : "";
    const to = typeof body["to"] === "string" ? body["to"] : "";
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      throw new BadRequestException("from and to should look like 2026-09-01.");
    }
    if (from > to) throw new BadRequestException("The period ends before it starts.");

    const result = await this.accounting.exportPeriod(from, to);
    if (!result.ok) throw new BadRequestException({ message: result.reason, retryable: result.retryable });
    return result;
  }

  /* ---------------- laboratory ---------------- */

  @Post("lab/dispatch")
  @UseGuards(DirectusAuthGuard)
  async dispatch(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const caseId = typeof body["case"] === "string" ? body["case"] : "";
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new BadRequestException("Which lab case?");
    const via = typeof body["via"] === "string" ? body["via"] : "docket";

    const result = await this.lab.dispatch(caseId, via);
    if (!result.ok) throw new BadRequestException({ message: result.reason, retryable: result.retryable });
    return result;
  }

  /**
   * A laboratory telling the practice where the work is.
   *
   * On the provider secret, not an operator token. An update for a
   * reference nobody recognises gets a 200 with `matched: false` — the
   * lab did its job, and a 4xx would make it retry a message that was
   * received perfectly well.
   */
  @Post("lab/inbound")
  async labInbound(
    @Body() body: Record<string, unknown>,
    @Headers("x-inbound-secret") secret?: string,
  ) {
    this.provider(secret);
    const reference = typeof body["reference"] === "string" ? body["reference"].trim() : "";
    const state = typeof body["state"] === "string" ? body["state"].trim() : "";
    if (!reference) throw new BadRequestException("`reference` is required — which case?");
    if (!["received", "checked"].includes(state)) {
      throw new BadRequestException("`state` must be received or checked.");
    }
    return this.lab.update(reference, state);
  }

  /* ---------------- calendar ---------------- */

  /** Mint or rotate the caller's own feed token. Never anybody else's. */
  @Post("calendar/token")
  @UseGuards(DirectusAuthGuard)
  async calendarToken(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const token = await this.calendar.tokenFor(req.caller.id, body["rotate"] === true);
    return {
      token,
      // The detail parameter is in the URL rather than in a setting, so
      // the person who turned patient names on can see that they did.
      url: `${config.publicBase}/api/integrations/calendar/${token}.ics`,
      named_url: `${config.publicBase}/api/integrations/calendar/${token}.ics?detail=named`,
      warning:
        "Anything holding this URL can read your diary. Rotate it rather than share it.",
    };
  }

  @Get("calendar/:token.ics")
  @Header("content-type", "text/calendar; charset=utf-8")
  @Header("cache-control", "private, max-age=300")
  async feed(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Query("detail") detail?: string,
  ): Promise<void> {
    // Taken off the path by hand: Nest's `:token.ics` parameter keeps the
    // extension, and stripping it here is clearer than a route regex
    // somebody will later misread.
    const raw = String((req.params as Record<string, string>)["token"] ?? "").replace(/\.ics$/, "");
    const user = await this.calendar.userForToken(raw);
    if (!user) {
      // 404, not 403. A 403 confirms that a token exists and is simply
      // not yours, which is a bit of information a guessing client should
      // not be given.
      res.status(404).send("Not found");
      return;
    }
    const body = await this.calendar.feed(user, detail === "named" ? "named" : "private");
    res.setHeader("content-disposition", 'inline; filename="enamel.ics"');
    res.send(body);
  }
}
