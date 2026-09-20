import { Injectable, Logger } from "@nestjs/common";
import { DbService } from "../../db/db.service";
import { DocketAdapter } from "./docket.adapter";
import { MockLabAdapter } from "./mock-lab.adapter";
import type { LabAdapter } from "./lab";

type CaseRow = {
  id: string; instructions: string; due_at: string | null;
  dispatch_reference: string | null; sent_at: string | null;
  laboratory_name: string | null; practice_name: string; patient_reference: string | null;
};

export type DispatchOutcome =
  | { ok: true; reference: string; docket?: string | undefined; alreadySent: boolean }
  | { ok: false; reason: string; retryable: boolean };

@Injectable()
export class LabService {
  private readonly log = new Logger(LabService.name);

  constructor(
    private readonly db: DbService,
    private readonly docket: DocketAdapter,
    private readonly mock: MockLabAdapter,
  ) {}

  adapters(): Array<{ id: string; kind: string; describe: string }> {
    return [this.docket, this.mock].map((a) => ({ id: a.id, kind: a.kind, describe: a.describe }));
  }

  private adapterFor(via: string): LabAdapter {
    return via === "mock-api" ? this.mock : this.docket;
  }

  /**
   * Send a case to the laboratory.
   *
   * Idempotent by the same reasoning as a payment, for a different
   * reason: dispatching twice does not cost money, it costs a second
   * crown. A case that already has a dispatch reference is answered from
   * it rather than sent again.
   */
  async dispatch(caseId: string, via: string): Promise<DispatchOutcome> {
    const row = await this.db.one<CaseRow>(
      `SELECT lc.id, lc.instructions, lc.due_at::text AS due_at,
              lc.dispatch_reference, lc.sent_at::text AS sent_at,
              l.name AS laboratory_name, c.name AS practice_name, p.reference AS patient_reference
         FROM lab_cases lc
         CROSS JOIN practice c
         LEFT JOIN laboratories l ON l.id = lc.laboratory
         LEFT JOIN patients p ON p.id = lc.patient
        WHERE lc.id = $1`,
      [caseId],
    );
    if (!row) return { ok: false, reason: "No such lab case.", retryable: false };

    if (row.dispatch_reference) {
      this.log.log(`case ${caseId} was already sent as ${row.dispatch_reference}`);
      return { ok: true, reference: row.dispatch_reference, alreadySent: true };
    }

    const adapter = this.adapterFor(via);
    const result = await adapter.dispatch({
      caseId: row.id,
      laboratory: row.laboratory_name ?? "the laboratory",
      instructions: row.instructions,
      dueAt: row.due_at,
      // The reference, never the name. A lab needs to match work to a
      // case; it does not need to know whose mouth it is.
      patientReference: row.patient_reference ?? `CASE-${row.id.slice(0, 8)}`,
      practice: row.practice_name,
    });

    if (!result.ok) return result;

    // `sent_at`, and no status column, because this collection
    // deliberately has none: four timestamps are the state machine. "Has
    // it gone" is `sent_at IS NOT NULL`, which cannot disagree with the
    // date it went — a status string beside those timestamps is a second
    // copy of the same fact, and the two drift the first time somebody
    // sets one without the other.
    //
    // `coalesce` so a re-dispatch never moves the date it originally
    // left, which is the date an argument with the lab is about.
    await this.db.query(
      `UPDATE lab_cases
          SET dispatch_provider = $2, dispatch_reference = $3,
              sent_at = coalesce(sent_at, now())
        WHERE id = $1`,
      [caseId, adapter.id, result.reference],
    );

    return {
      ok: true,
      reference: result.reference,
      docket: result.docket,
      alreadySent: false,
    };
  }

  /**
   * A status update from the laboratory.
   *
   * Matched on the dispatch reference rather than on anything the lab
   * chose, because the reference is the one identifier both sides agreed
   * on. An update for a reference nobody recognises is recorded as
   * unmatched and answered 200 — the lab did its job, and a 4xx would
   * make it retry a message that was received perfectly well.
   */
  async update(reference: string, state: string): Promise<{ matched: boolean; at?: string }> {
    // An allowlist, not interpolation of whatever arrived. The column
    // name goes into the SQL text — it cannot be a parameter — so the
    // only safe way to accept it from a webhook is to never accept it:
    // two known states map to two known columns and everything else is
    // refused before it reaches a query.
    const column =
      state === "received" ? "received_at" :
      state === "checked" ? "checked_at" : null;
    if (!column) return { matched: false };

    const updated = await this.db.one<{ id: string; at: string }>(
      `UPDATE lab_cases
          SET ${column} = coalesce(${column}, now())
        WHERE dispatch_reference = $1
        RETURNING id, ${column}::text AS at`,
      [reference],
    );
    if (!updated) {
      this.log.warn(`lab update for an unknown reference: ${reference}`);
      return { matched: false };
    }
    return { matched: true, at: updated.at };
  }
}
