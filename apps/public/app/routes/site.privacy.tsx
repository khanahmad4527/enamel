import { Link } from "react-router";
import type { Route } from "./+types/site.privacy";
import type { Env } from "~/lib/api.server";
import { practice, site } from "~/lib/site.server";
import { absolute, pageMeta } from "~/lib/seo";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const clinic = await practice(env);
  const base = "";
  return {
    clinic,
    base,
    // The periods this practice has actually configured, not a number
    // typed into a page. See below.
    retention: await site.retention(env),
    url: absolute(request, `${base}/privacy`),
  };
}

export function meta({ data }: Route.MetaArgs) {
  if (!data) return [{ title: "Privacy notice" }];
  return pageMeta({
    title: `Privacy notice — ${data.clinic.name}`,
    description:
      `What ${data.clinic.name} records about you, why, how long it is kept and ` +
      `what you can ask for.`,
    url: data.url,
    siteName: data.clinic.name,
  });
}

/**
 * Reading order, which is not the order the database hands them back in.
 *
 * Sorted by `record_type` the table opens with the audit log — the row a
 * patient cares least about — and buries their dental record in the
 * middle. A person reading a retention table wants their record first,
 * then the pictures of it, then the paperwork, then the money, and the
 * log of who looked last.
 */
const ORDER = ["clinical_record", "imaging", "consent", "correspondence", "financial", "audit_log"];

const RECORD_LABEL: Record<string, string> = {
  clinical_record: "Your dental record",
  imaging: "Radiographs and photographs",
  consent: "Consent forms",
  correspondence: "Letters, emails and texts",
  financial: "Invoices and payments",
  audit_log: "The record of who looked at your file",
};

const FROM_LABEL: Record<string, string> = {
  last_contact: "from the last time you were treated here",
  record_date: "from the date of the record",
  age_of_majority: "from your eighteenth birthday",
};

/** Who a complaint goes to, which is not the same authority everywhere. */
const REGULATOR: Record<string, { name: string; note: string }> = {
  NL: {
    name: "the Autoriteit Persoonsgegevens",
    note:
      "the Dutch data protection authority. You may complain to them at any time, " +
      "and you do not have to raise it with the practice first.",
  },
  AE: {
    name: "the UAE Data Office",
    note:
      "and, for anything clinical, to the health authority that licenses this " +
      "practice. This notice is written to the standard of the European GDPR, " +
      "which this practice applies to every record it holds.",
  },
};

/**
 * The privacy notice, and the one thing that makes it worth reading.
 *
 * Most of a notice like this is boilerplate, and boilerplate is exactly
 * what the law is not asking for — Article 13 wants the *specific*
 * periods, not "as long as necessary". So the retention table below is
 * not written here at all: it is read from `retention_rules`, the same
 * rows the practice maintains for its own retention policy.
 *
 * That is the difference between a notice and a promise. If the practice
 * changes how long it keeps radiographs, this page says so the next time
 * somebody loads it, and nobody has to remember to edit it. It is also
 * how two practices on one installation can publish genuinely different
 * periods — twenty years in the Netherlands under the WGBO, twenty-five
 * in the UAE under Federal Law No. 2 of 2019 — without a second template.
 *
 * What this page cannot do is make the practice compliant. It states what
 * has been configured; whether the configuration is right is the
 * practice's decision, and a wrong number here is a wrong number printed
 * faithfully.
 */
export default function Privacy({ loaderData }: Route.ComponentProps) {
  const { clinic, base, retention } = loaderData;
  const regulator = REGULATOR[clinic.country ?? ""] ?? REGULATOR["NL"]!;
  const inEu = clinic.country === "NL";

  return (
    <main className="wrap wrap--page wrap--read" id="main">
      <header className="pagehead">
        <p className="eyebrow">{clinic.name}</p>
        <h1 className="h1">Privacy notice</h1>
        <p className="lede">
          What this practice records about you, why it is allowed to, how long it
          keeps it, and what you can ask it to do. Written to be read rather than
          to be agreed to.
        </p>
      </header>

      <div className="prose prose--legal">
        <h2>Who holds your record</h2>
        <p>
          {clinic.name}
          {clinic.address ? `, ${clinic.address}` : ""}
          {clinic.city ? `, ${clinic.city}` : ""} is the controller of your personal
          data — it decides what is recorded and why.
          {clinic.email ? (
            <>
              {" "}
              Write to <a href={`mailto:${clinic.email}`}>{clinic.email}</a> about
              anything on this page.
            </>
          ) : null}
        </p>

        <h2>What is recorded, and why</h2>
        <p>
          Your name, date of birth, address and contact details, so the practice
          knows who you are and can reach you. Your dental record — what was found,
          what was done, what was advised, and the radiographs taken along the way.
          What you were charged and what you paid. And the messages sent to you
          about appointments.
        </p>
        <p>
          A dental record is <strong>health data</strong>, which the law treats as a
          special category and protects more tightly than an address or a telephone
          number. That is why it is kept apart from everything else in this system
          and why access to it is recorded.
        </p>

        {inEu ? (
          <>
            <h2>What allows the practice to hold it</h2>
            <ul>
              <li>
                <strong>Providing you with care.</strong> Article 9(2)(h) of the GDPR
                permits health data to be processed for medical diagnosis and
                treatment by a professional bound by confidentiality.
              </li>
              <li>
                <strong>The contract between you and the practice</strong> — Article
                6(1)(b) — for appointments, invoices and the practical side of being
                a patient here.
              </li>
              <li>
                <strong>Obligations the practice cannot opt out of</strong> — Article
                6(1)(c) — including keeping your record for the period set out below,
                which is required by law and is not something the practice chooses.
              </li>
            </ul>
            <p>
              Consent is deliberately <em>not</em> on that list for your clinical
              record. Care that stops if you withdraw consent to being recorded is
              not care, and a legal basis nobody can actually withdraw is not
              consent. Consent is used where it genuinely applies — whether you are
              texted rather than emailed, for instance — and you can change that
              whenever you like in the <Link to="/portal/profile">patient area</Link>.
            </p>
          </>
        ) : (
          <>
            <h2>What allows the practice to hold it</h2>
            <p>
              Providing you with dental care, meeting the record-keeping obligations
              that apply to a licensed practice, and the practical side of being a
              patient here — appointments, invoices and the messages about them.
            </p>
            <p>
              Your consent is asked for separately where it genuinely applies, such
              as whether the practice may text you rather than email you. You can
              change that whenever you like in the{" "}
              <Link to="/portal/profile">patient area</Link>. It is not the basis on
              which your clinical record is kept: that is a legal obligation, and
              the practice could not delete it at your request even if it wanted to.
            </p>
          </>
        )}

        <h2>How long it is kept</h2>
        <p>
          These are the periods this practice has set, and they are the periods this
          page is generated from — not a separate statement that has to be kept in
          step with the policy.
        </p>
      </div>

      <div className="scroll-x">
        <table className="table table--ruled">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Kept for</th>
              <th scope="col">Counted</th>
              <th scope="col">Because</th>
            </tr>
          </thead>
          <tbody>
            {[...retention]
              .sort((a, b) => {
                const ai = ORDER.indexOf(a.record_type);
                const bi = ORDER.indexOf(b.record_type);
                // Anything a practice added that this page has no opinion
                // about goes last, in its own order, rather than first.
                return (ai < 0 ? ORDER.length : ai) - (bi < 0 ? ORDER.length : bi);
              })
              .map((r) => (
              <tr key={r.id}>
                <th scope="row">{RECORD_LABEL[r.record_type] ?? r.record_type}</th>
                {/* One expression, not two with a space between them.
                    React's server renderer separates adjacent text
                    expressions with an HTML comment, so `{n} {"years"}`
                    reaches the page as `20<!-- --> years` — invisible to
                    a reader and invisible to anything matching on the
                    sentence, which is how this went unnoticed. */}
                <td className="nowrap">{`${r.years} ${r.years === 1 ? "year" : "years"}`}</td>
                <td>{FROM_LABEL[r.starts_from] ?? r.starts_from}</td>
                <td className="small">{r.legal_basis}</td>
              </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="prose prose--legal">
        <p className="hint">
          Nothing is deleted automatically when a period ends. A record leaving the
          practice's care is a decision somebody makes and signs for, and a system
          that quietly destroyed clinical records on a timer would be a worse system
          than one that does not.
        </p>

        <h2>Who else sees it</h2>
        <ul>
          <li>
            The clinicians and staff at this practice, and only the parts their job
            needs. A receptionist can see that you have an appointment; they cannot
            open your clinical notes.
          </li>
          <li>
            A dental laboratory, when something is being made for you — the
            prescription and the impression, not your record.
          </li>
          <li>
            Your insurer or funding scheme, where you have asked the practice to
            claim on your behalf.
          </li>
          <li>
            Nobody for advertising. Your record is not sold, shared for marketing,
            or used to train anything.
          </li>
        </ul>

        <h2>What you can ask for</h2>
        <ul>
          <li>
            <strong>A copy of everything held about you</strong>, free, within a
            month.
          </li>
          <li>
            <strong>A correction</strong>, if something factual is wrong. A clinical
            opinion you disagree with is not corrected but your disagreement is
            recorded alongside it, which is the honest version.
          </li>
          <li>
            <strong>Deletion</strong> — with the limit above. While the statutory
            period runs, the practice is obliged to keep your record and cannot
            delete it on request.
          </li>
          <li>
            <strong>To object to being contacted</strong>, at any time, without
            giving a reason.
          </li>
        </ul>

        <h2>A record of who looked</h2>
        <p>
          Every time somebody at this practice opens your file, that is recorded —
          who, when, and which record. You may ask to see that log.
          {inEu
            ? " Keeping it is required of health systems in the Netherlands by NEN 7513, and the reason it exists is that it is the only way to tell a proper clinical interest from a nosy one."
            : " The reason it exists is that it is the only way to tell a proper clinical interest from a nosy one."}
        </p>

        <h2>If you are unhappy</h2>
        <p>
          Say so to the practice first if you would like to — most of this is settled
          in a conversation. You can also complain to {regulator.name}, {regulator.note}
        </p>

        <hr />
        <p className="hint">
          This is a demonstration practice. The people, the records and the
          appointments behind this site are invented, and no real patient data
          exists anywhere in it.
        </p>
      </div>
    </main>
  );
}
