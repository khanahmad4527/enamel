import { Injectable, Logger } from "@nestjs/common";
import { config } from "../config/config";
import { SECTIONS, type Section } from "./sections";

export type SectionResult =
  | { collection: string; describe: string; ok: true; count: number; rows: unknown[] }
  | { collection: string; describe: string; ok: false; refused: string };

export type Export = {
  /** Article 15(1) — the information that has to accompany the copy. */
  about: Record<string, unknown>;
  record: Record<string, unknown[]>;
  sections: Array<{ collection: string; describe: string; count: number }>;
  generated_at: string;
};

export type Incomplete = {
  complete: false;
  refused: Array<{ collection: string; describe: string; reason: string }>;
};

/**
 * A subject access request, answered.
 *
 * GDPR Article 15 is two obligations and most implementations meet one.
 * 15(3) is the copy of the data, which is the part people build. 15(1) is
 * the *information that goes with it* — why it is held, who else sees it,
 * how long it is kept, what the person can ask for next, and whether
 * anything about them is decided automatically. A JSON dump with none of
 * that is not an answer to an Article 15 request; it is a database
 * export with a compliance label on it.
 *
 * ## It runs as the person who asked for it
 *
 * No service credential. Every read below carries the **caller's own
 * Directus token**, which has two consequences and both are the point.
 *
 * The first is that this endpoint cannot become a way around the
 * permission model. A feature that assembles a document from tables the
 * caller is not allowed to read is a privilege escalation wearing a
 * compliance label, and it is the shape a subject access export
 * naturally wants to take.
 *
 * The second is that a receptionist gets a **refusal rather than a
 * partial document**. Reception cannot read clinical notes; an export
 * that quietly omitted them and said nothing would be handed to a patient
 * as their complete record. So any section the caller cannot read stops
 * the export and is named. The person who can produce it is the person
 * who can already see all of it.
 */
@Injectable()
export class SubjectAccessService {
  private readonly log = new Logger(SubjectAccessService.name);

  private async read(
    token: string,
    collection: string,
    query: string,
  ): Promise<{ status: number; rows: unknown[]; message: string }> {
    // `directus_` collections live under their own endpoints; everything
    // here is a project collection, so `/items/` is right for all of them.
    const res = await fetch(`${config.directus.url}/items/${collection}?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: unknown[];
      errors?: Array<{ message?: string }>;
    };
    return {
      status: res.status,
      rows: body.data ?? [],
      message: body.errors?.[0]?.message ?? `HTTP ${res.status}`,
    };
  }

  private async section(token: string, patient: string, section: Section): Promise<SectionResult> {
    /*
     * `fields=*` rather than a list, and deliberately.
     *
     * Directus answers a *named* un-permitted field by refusing the whole
     * query — which reads as "no data" rather than as a permission
     * problem, and has cost this project an afternoon more than once. A
     * star asks for whatever the caller may see and gets exactly that,
     * which is also precisely the semantics this endpoint wants.
     */
    const query =
      `limit=-1&fields=*&filter[${section.via.split(".").join("][")}][_eq]=${patient}`;
    const result = await this.read(token, section.collection, query);

    if (result.status === 403) {
      return {
        collection: section.collection,
        describe: section.describe,
        ok: false,
        refused: result.message,
      };
    }
    if (result.status >= 400) {
      return {
        collection: section.collection,
        describe: section.describe,
        ok: false,
        refused: result.message,
      };
    }
    return {
      collection: section.collection,
      describe: section.describe,
      ok: true,
      count: result.rows.length,
      rows: result.rows,
    };
  }

  /**
   * How long each kind of record is kept, from the practice's own rules.
   *
   * Article 15(1)(d) asks for "the envisaged period for which the
   * personal data will be stored" — the actual period, not "as long as
   * necessary". Read from `retention_rules` for the same reason the
   * privacy notice is generated from them: a period typed into an export
   * template is a period that drifts from the one the practice applies.
   */
  private async retention(token: string): Promise<unknown[]> {
    const result = await this.read(
      token,
      "retention_rules",
      `limit=-1&fields=record_type,years,starts_from,legal_basis`,
    );
    return result.status === 200 ? result.rows : [];
  }

  async build(
    token: string,
    patient: { id: string; name: string },
    practice: Record<string, unknown>,
  ): Promise<Export | Incomplete> {
    const results = await Promise.all(
      SECTIONS.map((section) => this.section(token, patient.id, section)),
    );

    const refused = results
      .filter((r): r is Extract<SectionResult, { ok: false }> => !r.ok)
      .map((r) => ({ collection: r.collection, describe: r.describe, reason: r.refused }));

    if (refused.length) {
      this.log.warn(
        `subject access for ${patient.id} stopped: ${refused.map((r) => r.collection).join(", ")}`,
      );
      return { complete: false, refused };
    }

    const ok = results.filter((r): r is Extract<SectionResult, { ok: true }> => r.ok);
    const record: Record<string, unknown[]> = {};
    for (const r of ok) record[r.collection] = r.rows;

    return {
      about: {
        subject: patient.name,
        controller: {
          name: practice["name"],
          address: [practice["address"], practice["city"], practice["country"]].filter(Boolean).join(", "),
          email: practice["email"],
          telephone: practice["phone"],
          note: "The practice decides what is recorded about you and why. It is the controller.",
        },
        why_it_is_held: [
          "Providing you with dental care, which is why nearly all of it exists.",
          "The contract between you and the practice — appointments, invoices and the messages about them.",
          "Obligations the practice cannot opt out of, including keeping your record for the periods below.",
        ],
        legal_basis: {
          health_data: "GDPR Article 9(2)(h) — medical diagnosis and treatment by a professional bound by confidentiality.",
          the_rest: "GDPR Article 6(1)(b) for the contract, and Article 6(1)(c) for what the law requires.",
          not_consent:
            "Consent is deliberately not the basis for your clinical record. Care that stops if you " +
            "withdraw consent to being recorded is not care, and a basis nobody can actually withdraw " +
            "is not consent. It is used where it genuinely applies — whether the practice may text you.",
        },
        who_else_sees_it: [
          "Clinicians and staff at this practice, and only the parts their job needs.",
          "A dental laboratory, when something is being made for you — the prescription, not your record.",
          "Your insurer or funding scheme, where you asked the practice to claim on your behalf.",
          "Nobody for advertising. Your record is not sold, shared for marketing, or used to train anything.",
        ],
        how_long_it_is_kept: await this.retention(token),
        where_it_came_from:
          "From you, except for what a clinician recorded while treating you and anything a " +
          "laboratory or another practice sent about your care.",
        automated_decisions:
          "None. Nothing about your care or your account is decided by an automated process, and " +
          "there is no profiling.",
        what_you_can_ask_for: [
          "A correction, if something factual is wrong. A clinical opinion you disagree with is not " +
            "corrected, but your disagreement is recorded alongside it.",
          "Deletion — subject to the statutory periods above, which the practice cannot opt out of.",
          "To object to being contacted, at any time, without giving a reason.",
          "To complain to your data protection supervisory authority. You do not have to raise it " +
            "with the practice first.",
        ],
        about_this_file: [
          "JSON, because Article 20 asks for a structured, commonly used, machine-readable format.",
          "Staff are identified by an internal id rather than by name, except where a clinician " +
            "treated you and is named in the record itself.",
          "Files are listed with their type and date. The images themselves are supplied separately.",
        ],
      },
      record,
      sections: ok.map((r) => ({ collection: r.collection, describe: r.describe, count: r.count })),
      generated_at: new Date().toISOString(),
    };
  }
}
