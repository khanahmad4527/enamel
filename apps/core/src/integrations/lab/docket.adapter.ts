import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { DispatchResult, LabAdapter, LabDispatch } from "./lab";
import type { AdapterKind } from "../integration";

/**
 * A printed docket.
 *
 * `real`, and not a fallback. Most dental laboratories in the world
 * receive work in a box with a sheet of paper in it, and a practice
 * management system that can only talk to labs over an API is a system
 * that cannot send work to the lab down the road.
 *
 * The docket is generated and **kept**, which is the point. A lab case is
 * an instruction about a person's mouth that leaves the building, and
 * when a crown comes back the wrong shade the argument is about what the
 * sheet said. Storing the sheet as a file means it cannot be quietly
 * edited afterwards into what everybody now wishes it had said.
 */
@Injectable()
export class DocketAdapter implements LabAdapter {
  readonly id = "lab.docket";
  readonly kind: AdapterKind = "real";
  readonly describe =
    "a printable docket, kept as filed — how most laboratories actually receive work";

  async dispatch(work: LabDispatch): Promise<DispatchResult> {
    if (!work.instructions.trim()) {
      return { ok: false, reason: "A lab case needs instructions.", retryable: false };
    }

    const reference = `DOCKET-${work.caseId.slice(0, 8).toUpperCase()}`;
    const docket = [
      `LABORATORY WORK DOCKET`,
      `${"=".repeat(58)}`,
      ``,
      `Reference        ${reference}`,
      `Practice         ${work.practice}`,
      `Laboratory       ${work.laboratory}`,
      // A reference, never a name. See the note on LabDispatch.
      `Patient ref.     ${work.patientReference}`,
      `Required by      ${work.dueAt ? work.dueAt.slice(0, 10) : "not specified"}`,
      ``,
      `INSTRUCTIONS`,
      `${"-".repeat(58)}`,
      wrap(work.instructions),
      ...(work.detail ? ["", `Detail: ${work.detail}`] : []),
      ``,
      `${"-".repeat(58)}`,
      `Return this sheet with the work. Queries to the practice quoting`,
      `the reference above.`,
      ``,
    ].join("\n");

    return {
      ok: true,
      reference,
      docket,
      contentType: "text/plain",
      // Not used by the caller, but computed so the stored file and the
      // dispatch record can be shown to be the same thing.
      ...{ checksum: createHash("sha256").update(docket).digest("hex") },
    };
  }
}

/** Sixty columns, because this is printed. */
function wrap(text: string, width = 58): string {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > width) {
      out.push(line.trim());
      line = word;
    } else {
      line += ` ${word}`;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out.join("\n");
}
