import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AvailabilityService } from "./availability.service";
import { DirectusAuthGuard, type AuthedRequest } from "../auth/directus-auth.guard";
import { DiaryGuard } from "../auth/diary.guard";
import { DirectusError, DirectusService } from "../directus/directus.service";
import { AuditService } from "../audit/audit.service";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A day either side keeps "today" answerable without a date parameter. */
function defaultRange(): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  const fortnight = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  return { from: today, to: fortnight };
}

function isoDate(value: unknown, fallback: string, label: string): string {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new BadRequestException(`${label} should look like 2026-09-14.`);
  }
  return value;
}

function bounded(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new BadRequestException(`${label} should be between ${min} and ${max}.`);
  }
  return Math.round(n);
}

function uuid(value: unknown, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new BadRequestException(`${label} should be an id.`);
  }
  return value;
}

/**
 * Read the diary, and book into it.
 *
 * Note what is missing from every signature here: a clinic. It comes from
 * the caller's token, never from the request, because the database
 * connection underneath this has no permission layer to catch a forged
 * one. Accepting `?clinic=` would turn a query parameter into a way to
 * read another practice's day.
 */
@Controller("availability")
@UseGuards(DirectusAuthGuard)
export class AvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly directus: DirectusService,
    private readonly audit: AuditService,
  ) {}

  /** Free slots, soonest first. */
  @Get("slots")
  async slots(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    const range = defaultRange();
    return this.availability.slots({
      from: isoDate(query["from"], range.from, "from"),
      to: isoDate(query["to"], range.to, "to"),
      // Long enough to matter, short enough that the walk stays cheap.
      durationMinutes: bounded(query["duration"], 30, 5, 480, "duration"),
      // Fifteen minutes is the grid a practice books on. Five would offer
      // 08:05 and nobody would take it.
      stepMinutes: bounded(query["step"], 15, 5, 120, "step"),
      practitioner: uuid(query["practitioner"], "practitioner"),
      room: uuid(query["room"], "room"),
      limit: bounded(query["limit"], 50, 1, 500, "limit"),
    });
  }

  /**
   * One day, laid out by chair — what the day sheet draws.
   *
   * The only route here with a second guard on it, because it is the only
   * one that answers with patients' names. `slots` returns free time and
   * nothing about who is in the occupied part, which is why a patient
   * booking through the portal may ask for it; this could not be handed
   * to a patient, or to anybody else whose policy stops at the diary
   * door.
   */
  @UseGuards(DiaryGuard)
  @Get("day")
  async day(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    const today = new Date().toISOString().slice(0, 10);
    const full = await this.availability.daySheet(
      isoDate(query["date"], today, "date"),
    );

    // The grid is built in SQL and SQL has not heard of a policy, so what
    // it built is passed back through Directus before it is passed to
    // anybody. `DiaryGuard` has already turned away callers who may read
    // no appointment at all; this is the row-level half, and it is the
    // half a patient needed — their policy grants the collection and
    // filters it to them, which the guard's coarser question could not
    // see. Whoever is asking gets exactly the appointments Directus would
    // hand them one at a time.
    const allowed = await this.directus.visibleAppointments(
      req.callerToken,
      full.appointments.map((a) => a.id),
    );
    const sheet = {
      ...full,
      appointments: full.appointments.filter((a) => allowed.has(a.id)),
    };

    // This read never touches Directus, so the audit hook never sees it —
    // and a day sheet lists a dozen patients by name. Recorded here, in
    // the same append-only table, or it would not be recorded at all.
    await this.audit.recordRead({
      user: req.caller.id,
      collection: "appointments",
      itemCount: sheet.appointments.length,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    return sheet;
  }

  /**
   * Book one.
   *
   * Straight back through Directus with the caller's own token, so the
   * permission model, the scheduling hook and the availability trigger
   * all apply exactly as they would to a booking made in the admin. This
   * endpoint's value is not that it writes — it is that the slot it was
   * handed came from a search that already knew about the rota.
   */
  @Post("book")
  async book(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const patient = uuid(body["patient"], "patient");
    if (!patient) throw new BadRequestException("Which patient is this for?");
    if (typeof body["starts_at"] !== "string") {
      throw new BadRequestException("starts_at is required.");
    }

    try {
      return await this.directus.createAppointment(req.callerToken, {
        patient,
        practitioner: uuid(body["practitioner"], "practitioner") ?? null,
        room: uuid(body["room"], "room") ?? null,
        treatment: uuid(body["treatment"], "treatment") ?? null,
        starts_at: body["starts_at"],
        // Absent on purpose when a treatment is given: the scheduling
        // hook derives the end from `treatments.duration_minutes`, and
        // guessing one here would override the catalogue.
        ...(typeof body["ends_at"] === "string" ? { ends_at: body["ends_at"] } : {}),
        reason: typeof body["reason"] === "string" ? body["reason"] : null,
        status: "scheduled",
      });
    } catch (e) {
      // The hook's refusals are written to be read by a receptionist —
      // "Hannah Prins is already booked from 09:30 to 10:15". Rewriting
      // that into a generic 400 would throw away the only part of the
      // error anybody can act on.
      if (e instanceof DirectusError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Move one. Same reasoning as booking: the rules live downstream. */
  @Post("move")
  async move(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const id = uuid(body["id"], "id");
    if (!id) throw new BadRequestException("Which appointment?");

    const patch: Record<string, unknown> = {};
    if (typeof body["starts_at"] === "string") patch["starts_at"] = body["starts_at"];
    if (typeof body["ends_at"] === "string") patch["ends_at"] = body["ends_at"];
    const room = uuid(body["room"], "room");
    if (room) patch["room"] = room;
    const practitioner = uuid(body["practitioner"], "practitioner");
    if (practitioner) patch["practitioner"] = practitioner;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException("Nothing to change.");
    }

    try {
      return await this.directus.updateAppointment(req.callerToken, id, patch);
    } catch (e) {
      if (e instanceof DirectusError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
