import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from "@nestjs/common";
import { config } from "../config/config";
import { DirectusAuthGuard, type AuthedRequest } from "../auth/directus-auth.guard";
import { DbService } from "../db/db.service";
import { AuditService } from "../audit/audit.service";
import { nameLooksLike, readDicomHeader } from "./dicom";

/** Sensors write large studies; a header lives in the first few hundred KB. */
const HEADER_BYTES = 512 * 1024;

/**
 * What a DICOM study says about itself.
 *
 * One endpoint, and what it refuses to do is as much the point as what it
 * does — see `dicom.ts` for why rendering the pixels is a PACS
 * integration rather than a feature.
 *
 * Fetched with the **caller's own token**, so a study they could not open
 * in the admin is a study they cannot read the tags of either. That
 * matters more here than usual: the header carries a patient name and a
 * date of birth, and an endpoint that read it with a service token would
 * be a way around the file permissions two floors down.
 */
@Controller("imaging")
@UseGuards(DirectusAuthGuard)
export class ImagingController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get("dicom/:document")
  async describe(@Req() req: AuthedRequest, @Param("document") document: string) {
    if (!/^[0-9a-f-]{36}$/i.test(document)) {
      throw new BadRequestException("That is not a document id.");
    }

    // The document row, scoped to the caller's practice. Read directly
    // because the file fetch below is what the permission model actually
    // gates — this only decides which uuid to ask for, and asking for
    // another practice's would be refused by Directus a line later.
    const doc = await this.db.one<{
      file: string | null; patient: string; first_name: string; last_name: string; kind: string;
    }>(
      `SELECT d.file, d.patient, p.first_name, p.last_name, d.kind
         FROM documents d
         JOIN patients p ON p.id = d.patient
        WHERE d.id = $1`,
      [document],
    );
    if (!doc?.file) throw new NotFoundException("No such document, or it has no file.");

    const res = await fetch(`${config.directus.url}/assets/${doc.file}`, {
      headers: {
        authorization: `Bearer ${req.callerToken}`,
        // Only the head of the file. A CBCT volume is hundreds of
        // megabytes and the header is in the first fraction of it;
        // pulling the whole study to read a date would be a denial of
        // service anybody with a token could aim at the practice.
        range: `bytes=0-${HEADER_BYTES - 1}`,
      },
    });
    if (res.status === 403) {
      throw new NotFoundException("No such document, or it has no file.");
    }
    if (!res.ok && res.status !== 206) {
      throw new BadRequestException(`Could not read that file — Directus answered ${res.status}.`);
    }

    const reading = readDicomHeader(await res.arrayBuffer());

    // A read of an identified patient's imaging, recorded in the same
    // append-only table as everything else. This never touches Directus's
    // item API, so its audit hook never sees it.
    await this.audit.recordRead({
      user: req.caller.id,
      collection: "documents",
      itemCount: 1,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    if (!reading.isDicom) {
      return { document, isDicom: false, reason: reading.reason };
    }

    const inFile = String(reading.header?.["patientName"] ?? "");
    return {
      document,
      isDicom: true,
      header: reading.header,
      rendering: reading.rendering,
      // The check worth doing, and the reason for reading the header at
      // all: a study filed against the wrong patient is the commonest
      // imaging incident in a practice, and the file itself knows.
      patientMatch: inFile
        ? {
            inFile,
            onRecord: `${doc.first_name} ${doc.last_name}`,
            looksRight: nameLooksLike(inFile, doc.first_name, doc.last_name),
          }
        : { inFile: null, onRecord: `${doc.first_name} ${doc.last_name}`, looksRight: null },
    };
  }
}
