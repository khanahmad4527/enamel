import type { Integration, IntegrationResult } from "../integration";

/**
 * One side of one journal entry.
 *
 * Debits and credits rather than a signed amount, because that is what
 * every accounting package on the other end expects and translating at
 * the boundary is easier than translating in six places afterwards.
 */
export type JournalLine = {
  date: string;
  reference: string;
  /** The nominal (chart-of-accounts) code this side posts to. */
  account: string;
  accountName: string;
  description: string;
  debit: string;
  credit: string;
};

export type LedgerBatch = {
  reference: string;
  periodStart: string;
  periodEnd: string;
  lines: JournalLine[];
};

export type PostResult = IntegrationResult<{
  /** sha256 of exactly what was handed over. */
  checksum: string;
  /** The bytes, when the adapter produced a file. */
  body?: string;
  contentType?: string;
}>;

export interface LedgerAdapter extends Integration {
  post(batch: LedgerBatch): Promise<PostResult>;
}

/**
 * The chart of accounts this maps onto.
 *
 * Deliberately small and deliberately named after what a dental practice
 * actually recognises rather than after a standard, because there is no
 * single standard: the UK, the Netherlands and the UAE all number their
 * nominals differently, and a practice's accountant will map these four
 * to whatever their package uses in about ten minutes.
 *
 * Four is enough to be a real double entry. Fee income, the debtor
 * balance, the bank, and the VAT the practice is holding on someone
 * else's behalf.
 */
export const NOMINAL = {
  feeIncome: { code: "4000", name: "Fee income" },
  debtors: { code: "1100", name: "Trade debtors" },
  bank: { code: "1200", name: "Bank current account" },
  vat: { code: "2200", name: "VAT control" },
} as const;
