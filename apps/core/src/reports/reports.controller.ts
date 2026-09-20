import { BadRequestException, Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ReportsService } from "./reports.service";
import { DirectusAuthGuard, type AuthedRequest } from "../auth/directus-auth.guard";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: unknown, fallback: string, label: string): string {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new BadRequestException(`${label} should look like 2026-09-14.`);
  }
  return value;
}

/**
 * The practice's numbers, for the practice asking.
 *
 * No clinic parameter, for the same reason as everywhere else in this
 * service: it comes from the caller's token. A revenue figure is exactly
 * the sort of thing a query parameter must not be able to point at
 * somebody else's business.
 *
 * Aggregates are deliberately not written to the audit log. That log
 * records reads of patient-identifiable data, and a month's revenue names
 * nobody — filling it with "owner viewed a total" would bury the rows that
 * identify a person, which are the rows it exists for.
 */
@Controller("reports")
@UseGuards(DirectusAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("summary")
  async summary(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    // A calendar month back, which is the period a practice reviews.
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

    const from = isoDate(query["from"], monthAgo, "from");
    const to = isoDate(query["to"], today, "to");
    if (from > to) throw new BadRequestException("`from` is after `to`.");

    return this.reports.summary({ from, to });
  }
}
