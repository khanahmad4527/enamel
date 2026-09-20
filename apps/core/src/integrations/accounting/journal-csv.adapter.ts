import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { LedgerAdapter, LedgerBatch, PostResult } from "./ledger";
import type { AdapterKind } from "../integration";

const HEADER = "date,reference,account,account_name,description,debit,credit";

/**
 * A journal, as a CSV file.
 *
 * `real`, not `mock`, and the distinction is not a technicality: this
 * produces a file, and a file is not a simulation of a file. It is also
 * what most practices actually want — an accountant who receives a CSV
 * once a month is a solved problem, and one who has to be given API
 * access to the clinical system is a governance conversation.
 *
 * The format is the plainest thing every package imports. Sage, Xero,
 * QuickBooks and a spreadsheet all read this; none of them reads the
 * others' native format.
 */
@Injectable()
export class JournalCsvAdapter implements LedgerAdapter {
  readonly id = "accounting.journal-csv";
  readonly kind: AdapterKind = "real";
  readonly describe =
    "a double-entry journal as CSV — the format every accounting package imports, and no account anywhere";

  async post(batch: LedgerBatch): Promise<PostResult> {
    if (batch.lines.length === 0) {
      return { ok: false, reason: "There is nothing to post for that period.", retryable: false };
    }

    // The check that has to happen before anything leaves. An unbalanced
    // journal is rejected by the receiving package with an error nobody
    // in the practice can act on, hours after the export — so it is
    // refused here, where the reason is still in front of whoever asked.
    const debits = batch.lines.reduce((sum, l) => sum + Math.round(Number(l.debit) * 100), 0);
    const credits = batch.lines.reduce((sum, l) => sum + Math.round(Number(l.credit) * 100), 0);
    if (debits !== credits) {
      return {
        ok: false,
        reason:
          `The journal does not balance: ${(debits / 100).toFixed(2)} in debits against ` +
          `${(credits / 100).toFixed(2)} in credits. Nothing has been exported.`,
        retryable: false,
      };
    }

    const body = [HEADER, ...batch.lines.map((l) => [
      l.date, l.reference, l.account, csv(l.accountName), csv(l.description), l.debit, l.credit,
    ].join(","))].join("\n") + "\n";

    return {
      ok: true,
      reference: batch.reference,
      checksum: createHash("sha256").update(body).digest("hex"),
      body,
      contentType: "text/csv",
    };
  }
}

/**
 * A CSV field, quoted when it has to be.
 *
 * A patient's surname with a comma in it is not exotic — "de Vries, Sofie"
 * is a normal way to write a name — and an unquoted one shifts every
 * column after it by one, silently, for that row only.
 */
function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
