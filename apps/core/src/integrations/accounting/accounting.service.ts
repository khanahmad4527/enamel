import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DbService } from "../../db/db.service";
import { JournalCsvAdapter } from "./journal-csv.adapter";
import { NOMINAL, type JournalLine } from "./ledger";

type InvoiceRow = {
  id: string; number: string; issued_at: string;
  subtotal: string; tax_rate: string; total: string;
  first_name: string; last_name: string;
};

type PaymentRow = {
  id: string; amount: string; method: string; received_at: string;
  number: string | null; first_name: string; last_name: string;
};

export type ExportResult =
  | { ok: true; reference: string; lines: number; debits: string; credits: string; checksum: string; body: string; batch: string }
  | { ok: false; reason: string; retryable: boolean };

/**
 * Posting a period to the books, once.
 *
 * Idempotence is the only property an accounting export really has to
 * have, and it is the one a date range cannot give you. Posting the same
 * invoice twice does not produce an obvious error — it produces a set of
 * books that is wrong by exactly one invoice, found by a bookkeeper
 * months later, and by then nobody can say which run did it.
 *
 * So rows are *claimed*, not selected. The batch row is created first,
 * every unposted invoice and payment in the period is stamped with it in
 * one statement, and the journal is built from what the stamp actually
 * caught. An invoice entered late and dated last week — the exact row a
 * "everything between these dates" query exports twice — is unposted, so
 * it is picked up by the next run and by no other.
 */
@Injectable()
export class AccountingService {
  private readonly log = new Logger(AccountingService.name);

  constructor(
    private readonly db: DbService,
    private readonly journal: JournalCsvAdapter,
  ) {}

  adapters(): Array<{ id: string; kind: string; describe: string }> {
    return [this.journal].map((a) => ({ id: a.id, kind: a.kind, describe: a.describe }));
  }

  /** What is waiting to be posted, without posting it. */
  async pending(): Promise<{ invoices: number; payments: number }> {
    const row = await this.db.one<{ invoices: string; payments: string }>(
      `SELECT
         (SELECT count(*) FROM invoices
           WHERE ledger_export IS NULL AND status <> 'draft')::text AS invoices,
         (SELECT count(*) FROM payments
           WHERE ledger_export IS NULL AND status = 'settled')::text AS payments`,
      [],
    );
    return { invoices: Number(row?.invoices ?? 0), payments: Number(row?.payments ?? 0) };
  }

  async exportPeriod(from: string, to: string): Promise<ExportResult> {
    const reference = `LEDGER-${from.replace(/-/g, "")}-${to.replace(/-/g, "")}`;
    const batch = randomUUID();

    // The batch first, so the stamp below has something to point at. A
    // batch with nothing in it is deleted at the end rather than
    // prevented here — checking first and stamping second is a race, and
    // the race is the whole thing this is trying to avoid.
    await this.db.query(
      `INSERT INTO ledger_exports
         (id, reference, format, period_start, period_end, date_created)
       VALUES ($1, $2, 'journal_csv', $3, $4, now())`,
      [batch, `${reference}-${batch.slice(0, 8)}`, from, to],
    );

    // Claim, in one statement each. `ledger_export IS NULL` is what makes
    // a second run over the same dates find nothing.
    await this.db.query(
      `UPDATE invoices SET ledger_export = $1
        WHERE ledger_export IS NULL AND status <> 'draft'
          AND issued_at >= $2 AND issued_at <= $3`,
      [batch, from, to],
    );
    await this.db.query(
      `UPDATE payments SET ledger_export = $1
        WHERE ledger_export IS NULL AND status = 'settled'
          AND received_at >= $2::date AND received_at < ($3::date + 1)`,
      [batch, from, to],
    );

    const invoices = await this.db.rows<InvoiceRow>(
      `SELECT i.id, i.number, i.issued_at::text AS issued_at, i.subtotal::text AS subtotal,
              i.tax_rate::text AS tax_rate, i.total::text AS total,
              p.first_name, p.last_name
         FROM invoices i JOIN patients p ON p.id = i.patient
        WHERE i.ledger_export = $1
        ORDER BY i.number`,
      [batch],
    );
    const payments = await this.db.rows<PaymentRow>(
      `SELECT pay.id, pay.amount::text AS amount, pay.method,
              pay.received_at::text AS received_at, i.number,
              pat.first_name, pat.last_name
         FROM payments pay
         JOIN patients pat ON pat.id = pay.patient
         LEFT JOIN invoices i ON i.id = pay.invoice
        WHERE pay.ledger_export = $1
        ORDER BY pay.received_at`,
      [batch],
    );

    if (invoices.length === 0 && payments.length === 0) {
      await this.db.query(`DELETE FROM ledger_exports WHERE id = $1`, [batch]);
      return { ok: false, reason: "Nothing has happened in that period that has not already been posted.", retryable: false };
    }

    const lines: JournalLine[] = [];

    // An invoice is income earned and a debt owed to the practice.
    //
    //   Dr Trade debtors      the whole amount, because that is what the
    //                         patient owes including the tax
    //   Cr Fee income         net of tax — the tax was never the
    //                         practice's money
    //   Cr VAT control        the part being held for the tax authority
    for (const inv of invoices) {
      const who = `${inv.first_name} ${inv.last_name}`;
      const tax = (Number(inv.total) - Number(inv.subtotal)).toFixed(2);
      const date = inv.issued_at.slice(0, 10);
      lines.push({
        date, reference: inv.number,
        account: NOMINAL.debtors.code, accountName: NOMINAL.debtors.name,
        description: `Invoice ${inv.number} — ${who}`,
        debit: Number(inv.total).toFixed(2), credit: "0.00",
      });
      lines.push({
        date, reference: inv.number,
        account: NOMINAL.feeIncome.code, accountName: NOMINAL.feeIncome.name,
        description: `Treatment — ${who}`,
        debit: "0.00", credit: Number(inv.subtotal).toFixed(2),
      });
      // Only when there is tax. A zero-value line is noise in a journal
      // and some packages refuse an import containing one.
      if (Number(tax) !== 0) {
        lines.push({
          date, reference: inv.number,
          account: NOMINAL.vat.code, accountName: NOMINAL.vat.name,
          description: `VAT at ${inv.tax_rate}% — ${inv.number}`,
          debit: "0.00", credit: Number(tax).toFixed(2),
        });
      }
    }

    // A payment settles the debt, it does not earn anything. Income was
    // recognised when the invoice was raised; posting it again here is
    // the classic way to double-count a practice's turnover.
    //
    //   Dr Bank               money arrived
    //   Cr Trade debtors      the patient owes that much less
    //
    // A refund is the same entry with the signs the other way, which
    // falls out of the amount being negative rather than needing its own
    // branch.
    for (const pay of payments) {
      const who = `${pay.first_name} ${pay.last_name}`;
      const amount = Number(pay.amount);
      const date = pay.received_at.slice(0, 10);
      const ref = pay.number ?? `PAY-${pay.id.slice(0, 8)}`;
      const isRefund = amount < 0;
      const value = Math.abs(amount).toFixed(2);
      lines.push({
        date, reference: ref,
        account: NOMINAL.bank.code, accountName: NOMINAL.bank.name,
        description: `${isRefund ? "Refund to" : "Payment from"} ${who} (${pay.method})`,
        debit: isRefund ? "0.00" : value, credit: isRefund ? value : "0.00",
      });
      lines.push({
        date, reference: ref,
        account: NOMINAL.debtors.code, accountName: NOMINAL.debtors.name,
        description: `${isRefund ? "Refund" : "Settlement"} — ${who}`,
        debit: isRefund ? value : "0.00", credit: isRefund ? "0.00" : value,
      });
    }

    const posted = await this.journal.post({ reference, periodStart: from, periodEnd: to, lines });
    if (!posted.ok) {
      // Release everything this batch claimed. A refused export must
      // leave nothing marked as posted, or the rows it touched become
      // invisible to every future run — posted to a ledger that never
      // received them.
      await this.release(batch);
      return posted;
    }

    const debits = lines.reduce((sum, l) => sum + Math.round(Number(l.debit) * 100), 0);
    const credits = lines.reduce((sum, l) => sum + Math.round(Number(l.credit) * 100), 0);

    await this.db.query(
      `UPDATE ledger_exports
          SET line_count = $2, total_debits = $3, total_credits = $4, checksum = $5
        WHERE id = $1`,
      [batch, lines.length, (debits / 100).toFixed(2), (credits / 100).toFixed(2), posted.checksum],
    );

    this.log.log(`${reference}: ${lines.length} lines, ${(debits / 100).toFixed(2)} each side`);
    return {
      ok: true,
      reference, batch,
      lines: lines.length,
      debits: (debits / 100).toFixed(2),
      credits: (credits / 100).toFixed(2),
      checksum: posted.checksum,
      body: posted.body ?? "",
    };
  }

  /** Unstamp everything a batch claimed, then remove the batch. */
  private async release(batch: string): Promise<void> {
    await this.db.query(`UPDATE invoices SET ledger_export = NULL WHERE ledger_export = $1`, [batch]);
    await this.db.query(`UPDATE payments SET ledger_export = NULL WHERE ledger_export = $1`, [batch]);
    await this.db.query(`DELETE FROM ledger_exports WHERE id = $1`, [batch]);
  }
}
