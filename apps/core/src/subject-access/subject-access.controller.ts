import {
  Controller, ConflictException, Get, Header, NotFoundException, Param, Req, Res, UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { config } from "../config/config";
import { DirectusAuthGuard, type AuthedRequest } from "../auth/directus-auth.guard";
import { AuditService } from "../audit/audit.service";
import { SubjectAccessService } from "./subject-access.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("subject-access")
export class SubjectAccessController {
  constructor(
    private readonly subject: SubjectAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Everything held about one patient, as a file.
   *
   * Held to the caller's own token like everything else here, and it
   * reads with that token rather than a privileged one — see the service
   * for why that is the whole design and not a detail.
   *
   * **The export is itself a read of the patient's entire record**, so it
   * is written to the access log before the bytes leave. Somebody
   * exporting a file that nobody asked for is the single event a practice
   * most wants to be able to find afterwards, and an export that did not
   * log itself would be the one read in the system that left no trace.
   */
  @Get(":patient")
  @UseGuards(DirectusAuthGuard)
  @Header("cache-control", "no-store")
  async export(
    @Param("patient") patientId: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!UUID.test(patientId)) throw new NotFoundException("No such patient.");

    // Resolved with the caller's token, so a patient at another practice
    // is a 404 here for the same reason they are invisible everywhere
    // else — not because this endpoint checked, but because Directus did.
    const found = await fetch(
      `${config.directus.url}/items/patients/${patientId}?fields=id,first_name,last_name`,
      { headers: { authorization: `Bearer ${req.callerToken}` } },
    );
    if (!found.ok) throw new NotFoundException("No such patient, or not one of yours.");
    const patient = ((await found.json()) as { data?: Record<string, unknown> }).data;
    if (!patient) throw new NotFoundException("No such patient, or not one of yours.");

    // The practice is a singleton, so this is a read with no id in it.
    // Read as the caller, not with a service token: what a patient is
    // told about the controller has to come back through their own
    // permissions like everything else in the export.
    const practiceRes = await fetch(
      `${config.directus.url}/items/practice?fields=name,address,city,country,email,phone`,
      { headers: { authorization: `Bearer ${req.callerToken}` } },
    );
    const practice = ((await practiceRes.json().catch(() => ({}))) as {
      data?: Record<string, unknown>;
    }).data ?? {};

    const name = [patient["first_name"], patient["last_name"]].filter(Boolean).join(" ");
    const built = await this.subject.build(
      req.callerToken,
      { id: String(patient["id"]), name },
      practice,
    );

    if ("complete" in built) {
      /*
       * 409, not 403.
       *
       * The caller is allowed to ask — they got this far. What they
       * cannot do is produce a *complete* answer, and handing over an
       * incomplete one as though it were the patient's whole record is
       * the failure this endpoint exists to avoid. 403 would say "you may
       * not do this", which is not what happened.
       */
      throw new ConflictException({
        message:
          "This would not be a complete record. Your role cannot read every part of it, and an " +
          "Article 15 response has to be complete or it is misleading. Ask a clinician or the " +
          "practice owner to produce it.",
        refused: built.refused,
      });
    }

    await this.audit.recordExport({
      user: req.caller.id,
      patient: String(patient["id"]),
      itemCount: built.sections.reduce((n, s) => n + s.count, 0),
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });

    // Named so that a file saved from a browser is identifiable a year
    // later without opening it.
    const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "patient";
    res.setHeader(
      "content-disposition",
      `attachment; filename="subject-access-${safe}-${built.generated_at.slice(0, 10)}.json"`,
    );
    return built;
  }
}
