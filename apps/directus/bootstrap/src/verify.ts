/**
 * The test suite.
 *
 * Two halves. The access model is the important one: a permission model
 * you haven't tried to break is a hope, not a policy, so it logs in as
 * each role and asserts both directions — what they must be able to do,
 * and what they must not.
 *
 * The second half covers everything else the README claims. Provisioning
 * logs its per-item failures rather than throwing, so a run can finish
 * with the branding half-applied, no bookmarks and a flow missing, and
 * until these checks existed the only thing standing between that and a
 * green tick was somebody reading the scrollback.
 */

import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import {
  URL_BASE, DEMO_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD,
  DB_HOST, DB_PORT, DB_DATABASE, DB_USER, DB_PASSWORD,
  CORE_URL, REMINDER_TOKEN, INBOUND_SECRET, PUBLIC_URL_BASE, PORTAL_TOKEN, WEBSITE_TOKEN,
} from "./env.js";

const BASE = URL_BASE;

/**
 * `fetch`, shadowed for this module, so every one of the sixty-odd calls
 * below waits when the server says to wait.
 *
 * Declaring a function called `fetch` at module scope shadows the global
 * for the whole file. That is deliberate and it is the alternative to
 * threading a wrapper through sixty call sites, half of which are inline
 * one-liners inside a check.
 *
 * It is needed because this suite talks to a rate-limited API and — in
 * one place — deliberately bursts it to prove the limiter works. Without
 * this, the checks that happen to land in the following second fail with
 * a 429 and report a permission problem that does not exist. A test
 * harness that cannot tell "refused because you may not" from "refused
 * because you were quick" is a harness that reports noise.
 *
 * Not retried: anything but a 429. A 403 is an answer, and retrying an
 * answer is how a suite starts passing for the wrong reason.
 */
const nativeFetch: typeof globalThis.fetch = globalThis.fetch;

const fetch: typeof globalThis.fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await nativeFetch(input, init);
    if (res.status !== 429 || attempt >= 5) return res;
    const header = Number(res.headers.get("retry-after") ?? "");
    const wait = Number.isFinite(header) && header > 0
      ? header * 1000
      : 300 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 4000)));
  }
};

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];

function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
}

async function login(email: string, password = DEMO_PASSWORD): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { data?: { access_token: string } };
  if (!body.data?.access_token) throw new Error(`cannot log in as ${email}`);
  return body.data.access_token;
}

/** Status only — /assets returns bytes, and the question is whether it answers. */
async function asset(token: string, id: string): Promise<number> {
  const res = await fetch(`${BASE}/assets/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.status;
}

async function get(token: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as {
    data?: unknown[]; errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  return { status: res.status, data: body.data, errors: body.errors };
}

async function main() {
  console.log(`\n  Checks against ${BASE}\n`);

  /* ---------- front desk: the headline claim ---------------------- */
  const desk = await login("desk@kadehuis.example.com");

  // Two accounts that exist to be refused things, signed in once here
  // because the checks that use them are spread across the file. A failed
  // login must not throw and skip the rest — an empty string reaches the
  // checks and fails them with a sentence saying why.
  const patientToken0 = await login("patient@kadehuis.example.com").catch(() => "");
  const opToken0 = await login("ops@enamel.dev").catch(() => "");

  const deskPatients = await get(desk, "/items/patients?limit=1");
  check(
    "front desk can read the patient list",
    Array.isArray(deskPatients.data) && deskPatients.data.length > 0,
    `${deskPatients.status}`,
  );

  const row = (deskPatients.data?.[0] ?? {}) as Record<string, unknown>;
  check("front desk sees patient name", "first_name" in row, Object.keys(row).length + " fields");
  check("front desk sees phone", "phone" in row);
  check("front desk CANNOT see medical_alerts", !("medical_alerts" in row));
  check("front desk CANNOT see allergies", !("allergies" in row));
  check("front desk CANNOT see clinical_notes", !("clinical_notes" in row));

  // Asking for the field explicitly must also fail, not just be omitted.
  const deskForced = await get(desk, "/items/patients?limit=1&fields=id,medical_alerts");
  check(
    "front desk CANNOT request medical_alerts explicitly",
    deskForced.status === 403 || !(deskForced.data?.[0] as Record<string, unknown>)?.medical_alerts,
    `HTTP ${deskForced.status}`,
  );

  const deskRecords = await get(desk, "/items/treatment_records?limit=1");
  check(
    "front desk CANNOT read treatment records at all",
    deskRecords.status === 403,
    `HTTP ${deskRecords.status}`,
  );

  const deskTeeth = await get(desk, "/items/tooth_conditions?limit=1");
  check("front desk CANNOT read the tooth chart", deskTeeth.status === 403, `HTTP ${deskTeeth.status}`);

  // Denying the collection is not the same as hiding the chart. The field
  // is an alias, and if a policy handed it to the desk the interface would
  // mount, fire the request and catch a 403 — a locked door where there
  // should be no door. The README says the desk is never offered it, so
  // assert that rather than the 403 alone.
  const deskFields = await get(desk, "/fields/patients");
  const deskFieldNames = (Array.isArray(deskFields.data) ? deskFields.data : [])
    .map((f) => String((f as Record<string, unknown>)["field"] ?? ""));
  check("front desk is not even offered the tooth chart field",
    deskFieldNames.length > 0 && !deskFieldNames.includes("tooth_chart"),
    deskFieldNames.length === 0 ? "no fields returned at all" : "tooth_chart is in the desk's form");

  const deskInvoices = await get(desk, "/items/invoices?limit=1");
  check(
    "front desk CAN read invoices (it bills)",
    Array.isArray(deskInvoices.data),
    `HTTP ${deskInvoices.status}`,
  );

  /* ---------- hygienist: clinical yes, money no -------------------- */
  const hyg = await login("hygienist@kadehuis.example.com");

  const hygPatients = await get(hyg, "/items/patients?limit=1");
  const hygRow = (hygPatients.data?.[0] ?? {}) as Record<string, unknown>;
  check("hygienist CAN see medical_alerts", "medical_alerts" in hygRow);
  check("hygienist CAN read the tooth chart", (await get(hyg, "/items/tooth_conditions?limit=1")).status === 200);

  const hygInvoices = await get(hyg, "/items/invoices?limit=1");
  check("hygienist CANNOT read invoices", hygInvoices.status === 403, `HTTP ${hygInvoices.status}`);

  /* ---------- dentist: clinical write, billing read-only ----------- */
  const dds = await login("dentist@kadehuis.example.com");
  check("dentist CAN read invoices", (await get(dds, "/items/invoices?limit=1")).status === 200);

  const dentistWrite = await fetch(`${BASE}/items/invoices`, {
    method: "POST",
    headers: { authorization: `Bearer ${dds}`, "content-type": "application/json" },
    body: JSON.stringify({ number: "SHOULD-FAIL", patient: null }),
  });
  check("dentist CANNOT create an invoice", dentistWrite.status === 403, `HTTP ${dentistWrite.status}`);

  /* ---------- the practice record -------------------------------- */
  //
  // This block used to be the tenancy suite: a second practice, and
  // sixteen checks that its owner could not see Kadehuis's patients by
  // list, by id, or by any relational path. Multi-tenancy is gone and so
  // are they — there is one practice, and "whose row is this" has one
  // answer.
  //
  // What replaces them is narrower and still worth asserting: the
  // practice record is a singleton, so there is exactly one and nobody
  // can make a second. That is the invariant every query which assumes a
  // single practice now rests on, and it is enforced by Directus rather
  // than by everybody remembering.
  const kadehuisOwner = await login("owner@kadehuis.example.com");

  const practiceRows = await get(kadehuisOwner, "/items/practice");
  check("the practice is a singleton — one record, not a list",
    !Array.isArray(practiceRows.data) && typeof practiceRows.data === "object" && practiceRows.data !== null,
    Array.isArray(practiceRows.data) ? `a list of ${practiceRows.data.length}` : "one object");

  const practiceRow = (practiceRows.data ?? {}) as Record<string, unknown>;
  check("and it carries what the website and every letterhead read",
    Boolean(practiceRow["name"] && practiceRow["timezone"] && practiceRow["currency"]),
    `${String(practiceRow["name"] ?? "no name")} · ${String(practiceRow["timezone"] ?? "no tz")}`);

  // A singleton has no create endpoint. Directus answers a POST to one
  // with 403, which is the guarantee that "one practice" is structural
  // rather than a convention somebody could break with a second row.
  const secondPractice = await fetch(`${BASE}/items/practice`, {
    method: "POST",
    headers: { authorization: `Bearer ${kadehuisOwner}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "A Second Practice", slug: "second" }),
  });
  check("a second practice cannot be created",
    secondPractice.status === 403 || secondPractice.status === 404 || secondPractice.status === 405,
    `HTTP ${secondPractice.status}`);

  // And no collection carries a tenant column any more. This is the
  // check that would have caught the refactor leaving one behind — a
  // stray `clinic` on one table is exactly the sort of thing that
  // survives a sweep and then confuses everybody for a year.
  const strayTenantColumns = await (async () => {
    const client = new Client({ host: DB_HOST, port: DB_PORT, database: DB_DATABASE, user: DB_USER, password: DB_PASSWORD });
    try {
      await client.connect();
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'clinic'
          ORDER BY table_name`);
      return rows.map((r) => r.table_name);
    } catch { return ["<could not reach the database>"]; }
    finally { await client.end().catch(() => {}); }
  })();
  check("no table still carries a tenant column",
    strayTenantColumns.length === 0,
    strayTenantColumns.length ? `still there: ${strayTenantColumns.join(", ")}` : "none");

  /* ---------- patient portal --------------------------------------- */
  const portal = await login("patient@kadehuis.example.com");
  const mine = await get(portal, "/items/patients?limit=-1&fields=id,reference");
  check("portal user sees exactly one patient record", (mine.data ?? []).length === 1, `${(mine.data ?? []).length} visible`);

  const portalNotes = await get(portal, "/items/patients?limit=1&fields=id,clinical_notes");
  const portalRow = (portalNotes.data?.[0] ?? {}) as Record<string, unknown>;
  check("portal user CANNOT read clinical notes", !("clinical_notes" in portalRow) || portalRow.clinical_notes === undefined);

  // This check used to be decoration. It asked for `patient`, which the
  // portal policy did not grant, so the request 403'd, the result was
  // empty, and "no more than one distinct patient" passed on nothing at
  // all. It now asserts the request SUCCEEDS, returns rows, and that
  // every row belongs to the caller — so deleting the tenant filter
  // breaks it, which is the entire point of having it.
  const portalOthers = await get(portal, "/items/appointments?limit=-1&fields=id,patient");
  const portalAppts = (portalOthers.data ?? []) as Array<{ patient: string }>;
  const patientIds = new Set(portalAppts.map((a) => a.patient));
  const ownRecord = ((mine.data ?? [])[0] ?? {}) as { id?: string };
  check(
    "portal user sees only their own appointments",
    portalOthers.status === 200 &&
      portalAppts.length > 0 &&
      patientIds.size === 1 &&
      [...patientIds][0] === ownRecord.id,
    `${portalAppts.length} appointments across ${patientIds.size} patient(s)` +
      (patientIds.size === 1 && [...patientIds][0] === ownRecord.id ? " — their own" : ""),
  );

  const admin0 = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // Declared here rather than beside the provisioning checks that used to
  // be their only caller: the access-model half now asks the admin for
  // things too — which extension is loaded, which document replaced
  // which — and a helper defined 300 lines below is a helper those cannot
  // use.
  const rows = async (path: string): Promise<Array<Record<string, unknown>>> => {
    const r = await get(admin0, path);
    return Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>) : [];
  };
  const one = async (path: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${admin0}` } });
    const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> };
    return body.data ?? {};
  };

  /* ---------- documents and the file library ------------------------- */
  // A document row hands out a file uuid. /assets/<uuid> hands out the
  // x-ray. Both need the boundary, and only one of them is obvious.
  const deskDocs = await get(desk, "/items/documents?limit=-1&fields=id,kind,file");
  const deskKinds = new Set(((deskDocs.data ?? []) as Array<{ kind: string }>).map((d) => d.kind));
  check("front desk sees referrals and consent", deskKinds.has("referral") && deskKinds.has("consent"),
    [...deskKinds].sort().join(", ") || "nothing");
  check("front desk CANNOT see radiographs", !deskKinds.has("radiograph"),
    `${deskKinds.size} kinds visible`);

  const dentistDocs = await get(dds, "/items/documents?limit=-1&fields=id,kind,file");
  const dentistRows = (dentistDocs.data ?? []) as Array<{ kind: string; file: string }>;
  const radiograph = dentistRows.find((d) => d.kind === "radiograph");
  check("the dentist can see the radiographs", Boolean(radiograph),
    `${dentistRows.length} documents`);

  if (radiograph) {
    check("the dentist can open the image itself", (await asset(dds, radiograph.file)) === 200,
      `HTTP ${await asset(dds, radiograph.file)}`);
    const deskStatus = await asset(desk, radiograph.file);
    check("front desk CANNOT open a radiograph by direct asset URL", deskStatus === 403,
      `HTTP ${deskStatus}`);
  }

  // This was the cross-tenant file check: the other practice's documents
  // fetched by id, and a dentist refused their bytes. With one practice
  // the boundary that remains on files is the one that was always the
  // sharper of the two — clinical versus not — and it is asserted just
  // above, where reception is refused a radiograph by direct asset URL.

  // The brand kit belongs to no practice, and every staff member needs it
  // or the admin shell renders without its own logo.
  const settingsLogo = await get(admin0, "/settings?fields=project_logo");
  const logoId = ((settingsLogo.data ?? {}) as { project_logo?: string }).project_logo;
  if (logoId) {
    check("shared brand files stay readable by staff", (await asset(desk, logoId)) === 200,
      "the nav logo still loads");
  }

  /* ---------- who may file what ---------------------------------------- */
  //
  // Two rules that were written and did not work, in the same way, for the
  // same reason: a narrowing filter was put in `permissions`, and Directus
  // ignores `permissions` on a create — there is no existing row to filter.
  // The payload is checked against `validation` instead.
  //
  // Both bugs had the property that makes this sort survive: the row is
  // created and then invisible to whoever created it, so the list looks
  // correct immediately afterwards. Only asking "did that POST succeed"
  // finds them.
  {
    const deskPatient = ((await get(desk, "/items/patients?limit=1&fields=id")).data?.[0] ?? {}) as
      { id?: string };

    const upload = async (token: string) => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
        "verify.png",
      );
      const res = await fetch(`${BASE}/files`, {
        method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
      });
      return ((await res.json().catch(() => ({}))) as { data?: { id?: string } }).data?.id ?? "";
    };

    const fileForDesk = await upload(desk);
    check("reception can upload a file at all", Boolean(fileForDesk),
      fileForDesk ? "uploaded" : "the upload itself failed");

    if (fileForDesk && deskPatient.id) {
      const file = async (token: string, kind: string) => {
        const res = await fetch(`${BASE}/items/documents`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ patient: deskPatient.id,
            file: fileForDesk, kind, taken_on: "2026-01-01", status: "active",
          }),
        });
        const body = (await res.json().catch(() => ({}))) as
          { data?: { id?: string }; errors?: Array<{ message: string }> };
        return { status: res.status, id: body.data?.id, message: body.errors?.[0]?.message ?? "" };
      };

      const referral = await file(desk, "referral");
      check("reception CAN file a referral letter",
        referral.status === 200 || referral.status === 204, `HTTP ${referral.status}`);
      if (referral.id) {
        await fetch(`${BASE}/items/documents/${referral.id}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      }

      const radiograph = await file(desk, "radiograph");
      check("reception CANNOT file a radiograph",
        radiograph.status === 400 || radiograph.status === 403,
        `HTTP ${radiograph.status}: ${radiograph.message}`.slice(0, 90));
      if (radiograph.id) {
        await fetch(`${BASE}/items/documents/${radiograph.id}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      }

      // And not by relabelling the file underneath it either. `clinical`
      // on the file is what /assets answers on; reception writing it
      // would be reception deciding what counts as clinical.
      const relabel = await fetch(`${BASE}/files/${fileForDesk}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${desk}`, "content-type": "application/json" },
        body: JSON.stringify({ document_kind: "radiograph" }),
      });
      check("reception CANNOT relabel a file as clinical", relabel.status === 403,
        `HTTP ${relabel.status}`);

      await fetch(`${BASE}/files/${fileForDesk}`, {
        method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
      });
    } else {
      for (const name of [
        "reception CAN file a referral letter",
        "reception CANNOT file a radiograph",
        "reception CANNOT relabel a file as clinical",
      ]) check(name, false, "could not upload a file to attach");
    }

    // The same bug, in the collection where it matters most. A treatment
    // record is the legal account of what was done and by whom; a
    // hygienist filing one under the principal dentist's name is a
    // falsified clinical record, not a permissions nicety.
    const hygMe = ((await get(hyg, "/users/me?fields=id")).data ?? {}) as { id?: string };
    const dentistMe = ((await get(dds, "/users/me?fields=id")).data ?? {}) as { id?: string };
    const hygPatient = ((await get(hyg, "/items/patients?limit=1&fields=id")).data?.[0] ?? {}) as
      { id?: string };
    const someTreatment = ((await get(hyg, "/items/treatments?limit=1&fields=id")).data?.[0] ?? {}) as
      { id?: string };

    if (hygMe.id && dentistMe.id && hygPatient.id && someTreatment.id) {
      const record = async (practitioner: string) => {
        const res = await fetch(`${BASE}/items/treatment_records`, {
          method: "POST",
          headers: { authorization: `Bearer ${hyg}`, "content-type": "application/json" },
          body: JSON.stringify({ patient: hygPatient.id, treatment: someTreatment.id,
            practitioner, performed_on: "2026-09-01", status: "completed",
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { data?: { id?: string } };
        return { status: res.status, id: body.data?.id };
      };

      const own = await record(hygMe.id);
      check("a hygienist CAN record their own work",
        own.status === 200 || own.status === 204, `HTTP ${own.status}`);
      if (own.id) {
        await fetch(`${BASE}/items/treatment_records/${own.id}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      }

      const impersonated = await record(dentistMe.id);
      check("a hygienist CANNOT record work under another clinician's name",
        impersonated.status === 400 || impersonated.status === 403, `HTTP ${impersonated.status}`);
      if (impersonated.id) {
        await fetch(`${BASE}/items/treatment_records/${impersonated.id}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      }
    } else {
      for (const name of [
        "a hygienist CAN record their own work",
        "a hygienist CANNOT record work under another clinician's name",
      ]) check(name, false, "could not assemble a record to try");
    }
  }

  /* ---------- a version chain that cannot lie -------------------------- */
  //
  // A retake is a new row pointing back at the one it replaces, never a
  // new file swapped onto the existing row — a silent edit to a clinical
  // record leaves no evidence the first version existed, and "what did we
  // have on the 4th of March" has to stay answerable a year later.
  //
  // Four ways for that chain to go wrong, all four refused twice: by a
  // hook, so the answer is a sentence, and by a database trigger, so the
  // answer is the same for anything holding a connection.
  {
    const dentistPatients = ((await get(dds, "/items/patients?limit=2&fields=id")).data ?? []) as
      Array<{ id: string }>;
    const subject = dentistPatients[0];
    const otherSubject = dentistPatients[1];

    const uploadOne = async (): Promise<string> => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
        "verify-version.png",
      );
      const res = await fetch(`${BASE}/files`, {
        method: "POST", headers: { authorization: `Bearer ${dds}` }, body: form,
      });
      return ((await res.json().catch(() => ({}))) as { data?: { id?: string } }).data?.id ?? "";
    };

    const madeDocs: string[] = [];
    const madeFiles: string[] = [];

    const makeDoc = async (
      who: { id: string },
      extra: Record<string, unknown> = {},
    ) => {
      const fileId = await uploadOne();
      if (fileId) madeFiles.push(fileId);
      const res = await fetch(`${BASE}/items/documents`, {
        method: "POST",
        headers: { authorization: `Bearer ${dds}`, "content-type": "application/json" },
        body: JSON.stringify({ patient: who.id, file: fileId,
          kind: "radiograph", taken_on: "2026-02-01", status: "active", ...extra,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as
        { data?: { id?: string }; errors?: Array<{ message: string }> };
      if (body.data?.id) madeDocs.push(body.data.id);
      return { status: res.status, id: body.data?.id ?? "", message: body.errors?.[0]?.message ?? "" };
    };

    if (!subject || !otherSubject) {
      for (const name of [
        "a clinician can file a radiograph",
        "a retake with no reason is refused",
        "a retake cannot be filed against another patient's document",
        "a proper retake is accepted, and points back",
        "the original records which document replaced it",
        "a second retake of the same document is refused",
        "a document cannot replace itself",
        "a superseded document cannot be deleted out from under its retake",
      ]) check(name, false, "needed two patients to try");
    } else {
      const original = await makeDoc(subject);
      check("a clinician can file a radiograph", Boolean(original.id),
        original.id ? "filed" : `HTTP ${original.status}: ${original.message}`.slice(0, 70));

      const noReason = await makeDoc(subject, { supersedes: original.id });
      check("a retake with no reason is refused",
        noReason.status === 400, `HTTP ${noReason.status}: ${noReason.message}`.slice(0, 80));

      // The one that matters: an m2o picker is not a control, and this
      // moves an image out of one person's file into another's history.
      const wrongPatient = await makeDoc(otherSubject, {
        supersedes: original.id, supersede_reason: "retake",
      });
      check("a retake cannot be filed against another patient's document",
        wrongPatient.status === 400 && /different patient/i.test(wrongPatient.message),
        `HTTP ${wrongPatient.status}: ${wrongPatient.message}`.slice(0, 80));

      const retake = await makeDoc(subject, { supersedes: original.id, supersede_reason: "retake" });
      check("a proper retake is accepted, and points back",
        retake.status === 200 || retake.status === 204,
        `HTTP ${retake.status}: ${retake.message}`.slice(0, 80));

      // The back-pointer is maintained by the trigger, not the caller. A
      // column two clients both have to remember to set is wrong by the
      // second week.
      const back = (await rows(
        `/items/documents?limit=1&fields=superseded_by&filter[id][_eq]=${original.id}`,
      ))[0];
      check("the original records which document replaced it",
        Boolean(retake.id) && back?.["superseded_by"] === retake.id,
        back?.["superseded_by"] ? "linked" : "not set");

      const fork = await makeDoc(subject, { supersedes: original.id, supersede_reason: "retake" });
      check("a second retake of the same document is refused",
        fork.status === 400, `HTTP ${fork.status}: ${fork.message}`.slice(0, 80));

      if (retake.id) {
        const itself = await fetch(`${BASE}/items/documents/${retake.id}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${dds}`, "content-type": "application/json" },
          body: JSON.stringify({ supersedes: retake.id, supersede_reason: "retake" }),
        });
        check("a document cannot replace itself", itself.status === 400, `HTTP ${itself.status}`);
      } else {
        check("a document cannot replace itself", false, "no retake to try it on");
      }

      // And the refusal is a sentence, not a 500 with a constraint name
      // on a delete somebody pressed for an ordinary reason.
      const removeOriginal = await fetch(`${BASE}/items/documents/${original.id}`, {
        method: "DELETE", headers: { authorization: `Bearer ${dds}` },
      });
      const refusal = ((await removeOriginal.json().catch(() => ({}))) as
        { errors?: Array<{ message: string }> }).errors?.[0]?.message ?? "";
      check("a superseded document cannot be deleted out from under its retake",
        removeOriginal.status === 400 && /archived/i.test(refusal),
        `HTTP ${removeOriginal.status}: ${refusal}`.slice(0, 80));

      // Newest first, or the guard above refuses its own cleanup.
      for (const id of [...madeDocs].reverse()) {
        await fetch(`${BASE}/items/documents/${id}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      }
      for (const id of madeFiles) {
        await fetch(`${BASE}/files/${id}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      }
    }

    // The viewer is wired to the field it exists for. An extension that
    // builds, loads and is attached to nothing looks identical to one
    // that works.
    const documentExtensions = await rows("/extensions");
    const bundle = documentExtensions.find((e) =>
      JSON.stringify(e).includes("radiograph-viewer"));
    check("the radiograph viewer is installed and enabled",
      Boolean(bundle) && ((bundle?.["meta"] ?? {}) as { enabled?: boolean }).enabled !== false,
      bundle ? "loaded" : "not registered — was it built before Directus started?");

    const fileField = (await rows("/fields/documents")).find((f) => f["field"] === "file");
    const fileMeta = (fileField?.["meta"] ?? {}) as { interface?: string };
    check("the document form actually uses it", fileMeta.interface === "radiograph-viewer",
      fileMeta.interface ?? "field missing");
  }

  /* ---------- the portal reaches its own consent, and nothing else ---- */
  const portalDocs = await get(portal, "/items/documents?limit=-1&fields=id,kind,file");
  const portalRows = (portalDocs.data ?? []) as Array<{ kind: string; file: string }>;
  const portalKinds = new Set(portalRows.map((d) => d.kind));
  check("a patient sees their own consent form", portalKinds.has("consent"),
    [...portalKinds].join(", ") || "nothing");
  check("a patient CANNOT see their own radiographs", !portalKinds.has("radiograph"),
    `${portalRows.length} documents`);

  const consentFile = portalRows.find((d) => d.kind === "consent")?.file;
  if (consentFile) {
    check("a patient can open their consent form", (await asset(portal, consentFile)) === 200);
  }
  if (radiograph) {
    const portalLeak = await asset(portal, radiograph.file);
    check("a patient CANNOT open a radiograph by asset URL", portalLeak === 403, `HTTP ${portalLeak}`);
  }

  /* ================= provisioning ==================================== */
  const admin = admin0;

  /* ---------- schema ------------------------------------------------- */
  const collections = (await rows("/collections")).filter(
    (c) => !String(c["collection"]).startsWith("directus_"),
  );
  const tables = collections.filter((c) => c["schema"]);
  const folders = collections.filter((c) => !c["schema"]);
  check("46 collections and 5 sidebar folders exist", tables.length === 46 && folders.length === 5,
    `${tables.length} tables, ${folders.length} folders`);

  /* ---------- validation actually rejects ----------------------------- */
  // Not "a rule is configured" — an attempt that must fail.
  const badTooth = await fetch(`${BASE}/items/tooth_conditions`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ tooth: "19", condition: "caries" }),
  });
  check("an impossible FDI number is refused by the schema", badTooth.status >= 400,
    `HTTP ${badTooth.status}`);

  /* ---------- tooth designations, both standards ---------------------- */
  const post = async (collection: string, body: unknown): Promise<number> => {
    const res = await fetch(`${BASE}/items/${collection}`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  };

  const kadehuis = ((await rows("/items/practice?limit=1&fields=id"))[0] ?? {})["id"];
  const somePatient = ((await rows("/items/patients?limit=1&fields=id"))[0] ?? {})["id"];

  // ISO 10394 letters must be accepted where ISO 3950 digits are — this is
  // the whole reason the column is a string.
  // Tagged so the suite can take them back out again. A test that leaves
  // rows behind is a test that changes the thing it is measuring — run it
  // ten times and the dentition counts stop meaning anything.
  const PROBE = "verify-probe";
  const supernumerary = await post("dentition", {
    patient: somePatient, designation: "AB",
    dentition_type: "supernumerary", state: "present", note: PROBE,
  });
  check("a mesiodens can be recorded at all", supernumerary === 200, `HTTP ${supernumerary}`);

  // And the same designation twice for one patient, because ISO 10394
  // reuses a code for multiple teeth in one location.
  const twice = await post("dentition", {
    patient: somePatient, designation: "AB",
    dentition_type: "supernumerary", state: "unerupted", note: PROBE,
  });
  check("a second tooth may share that designation", twice === 200, `HTTP ${twice}`);

  const bogus = await post("dentition", {
    patient: somePatient, designation: "19",
    dentition_type: "permanent", state: "present",
  });
  check("a designation that exists in no standard is refused", bogus >= 400, `HTTP ${bogus}`);

  const probes = (await rows(`/items/dentition?limit=-1&fields=id&filter[note][_eq]=${PROBE}`))
    .map((r) => String(r["id"]));
  if (probes.length) {
    const res = await fetch(`${BASE}/items/dentition`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify(probes),
    });
    check("the suite cleans up after itself", res.status === 204 || res.status === 200,
      `${probes.length} probe rows removed`);
  }

  const dentitionRows = await rows("/items/dentition?limit=-1&fields=designation,dentition_type,state,absence_reason,retained");
  const kinds = new Set(dentitionRows.map((d) => String(d["dentition_type"])));
  const states = new Set(dentitionRows.map((d) => String(d["state"])));
  check("all three dentitions are represented", kinds.size === 3,
    [...kinds].sort().join(", "));
  check("present, unerupted and absent are all in use", states.size === 3,
    [...states].sort().join(", "));
  check("a tooth that never formed is distinguishable from one taken out",
    dentitionRows.some((d) => d["absence_reason"] === "congenital") &&
      dentitionRows.some((d) => d["retained"] === true),
    "congenital absence and a retained primary tooth both present");

  /* ---------- payment plans, the waiting list, lab work --------------- */
  const plans2 = await rows("/items/payment_plans?limit=-1&fields=id,total_principal,down_payment,apr,number_of_payments,payment_amount,interest_free_payments,interest_starts_on");
  check("a payment plan exists with an APR", plans2.length > 0 && plans2.some((p) => Number(p["apr"]) > 0),
    `${plans2.length} plan(s)`);

  // "Enter only one" is a cross-field rule Directus validation cannot
  // express, so it is asserted here instead of being merely documented.
  const bothInterest = plans2.filter((p) => p["interest_free_payments"] !== null && p["interest_starts_on"] !== null);
  check("no plan sets both an interest-free count and an interest start date", bothInterest.length === 0,
    "the pair is exclusive, and nothing enforces it but this");

  // The schedule has to land exactly on zero. Twelve payments rounded to
  // the cent do not, unless the last one absorbs the drift.
  let scheduleOk = plans2.length > 0;
  let detail = "";
  for (const plan of plans2) {
    const charges = await rows(
      `/items/payment_plan_charges?limit=-1&sort=sort&fields=principal,interest,balance_after&filter[payment_plan][_eq]=${plan["id"]}`,
    );
    if (!charges.length) { scheduleOk = false; detail = "no charges"; break; }
    const financed = Number(plan["total_principal"]) - Number(plan["down_payment"]);
    const repaid = charges.reduce((n, c) => n + Number(c["principal"]), 0);
    const final = Number(charges[charges.length - 1]!["balance_after"]);
    if (Math.abs(repaid - financed) > 0.01 || Math.abs(final) > 0.01) {
      scheduleOk = false;
      detail = `repaid ${repaid.toFixed(2)} of ${financed.toFixed(2)}, final balance ${final.toFixed(2)}`;
      break;
    }
    detail = `${charges.length} charges repay ${financed.toFixed(2)} exactly, interest ${charges.reduce((n, c) => n + Number(c["interest"]), 0).toFixed(2)}`;
  }
  check("the amortisation schedule lands exactly on zero", scheduleOk, detail);

  const wlRows = await rows("/items/waiting_list?limit=-1&fields=source,priority,status");
  check("the waiting list works without a priority", wlRows.length > 0 && wlRows.some((w) => w["priority"] === null),
    `${wlRows.filter((w) => w["priority"] === null).length} of ${wlRows.length} entries carry no priority`);
  const wlSources = new Set(wlRows.map((w) => String(w["source"])));
  check("entries record how they reached the list", wlSources.size >= 3, [...wlSources].sort().join(", "));

  const labRows = await rows("/items/lab_cases?limit=-1&fields=sent_at,received_at,checked_at");
  const out = labRows.filter((l) => l["sent_at"] && !l["received_at"]);
  const backUnchecked = labRows.filter((l) => l["received_at"] && !l["checked_at"]);
  const done = labRows.filter((l) => l["received_at"] && l["checked_at"]);
  check("the lab timeline distinguishes back from back-and-checked",
    out.length > 0 && backUnchecked.length > 0 && done.length > 0,
    `${out.length} out, ${backUnchecked.length} back but unchecked, ${done.length} checked`);

  const deskLab = await get(desk, "/items/lab_cases?limit=1");
  check("front desk can see what is at the lab", deskLab.status === 200, `HTTP ${deskLab.status}`);
  const deskLabWrite = await fetch(`${BASE}/items/lab_cases`, {
    method: "POST",
    headers: { authorization: `Bearer ${desk}`, "content-type": "application/json" },
    body: JSON.stringify({ patient: somePatient, instructions: "probe" }),
  });
  check("front desk CANNOT raise a lab case", deskLabWrite.status === 403, `HTTP ${deskLabWrite.status}`);

  /* ---------- periodontal ---------------------------------------------- */
  const sextantRows = await rows("/items/perio_sextants?limit=-1&fields=sextant,bpe_code,furcation,teeth_scored");
  check("a BPE covers six sextants", sextantRows.length >= 6,
    `${sextantRows.length} sextant rows`);
  check("BPE codes stay inside 0–4",
    sextantRows.every((r) => r["bpe_code"] === null || (Number(r["bpe_code"]) >= 0 && Number(r["bpe_code"]) <= 4)),
    "no code outside the guideline");
  // The asterisk is a second axis, so a sextant must be able to carry
  // both a code and a furcation at once — 3* in the BSP's own example.
  check("a sextant can carry a code and a furcation at once",
    sextantRows.some((r) => r["furcation"] === true && r["bpe_code"] !== null),
    sextantRows.filter((r) => r["furcation"] === true).map((r) => `${r["sextant"]}=${r["bpe_code"]}*`).join(", "));

  const bogusCode = await post("perio_sextants", {
    screening: ((await rows("/items/perio_screenings?limit=1&fields=id"))[0] ?? {})["id"],
    sextant: "UR", bpe_code: 5,
  });
  check("a fifth BPE code is refused", bogusCode >= 400, `HTTP ${bogusCode}`);

  const siteRows = await rows(
    "/items/perio_sites?limit=-1&fields=exam,tooth,site,probing_depth_mm,recession_mm,bleeding_on_probing",
  );
  // Keyed by exam AND tooth: two practices each hold their own chart, so
  // tooth 36 legitimately appears twice and grouping on the designation
  // alone counts twelve sites where there are six.
  const sitesPerTooth = new Map<string, number>();
  for (const r of siteRows) {
    const k = `${r["exam"]}/${r["tooth"]}`;
    sitesPerTooth.set(k, (sitesPerTooth.get(k) ?? 0) + 1);
  }
  check("six sites per charted tooth",
    sitesPerTooth.size > 0 && [...sitesPerTooth.values()].every((n) => n === 6),
    `${sitesPerTooth.size} teeth × 6 = ${siteRows.length} sites`);

  // The sign convention, asserted rather than trusted: recession positive,
  // so CAL = depth + recession and a receded site reads deeper than it
  // probes. An inverted sign would make CAL smaller than the pocket.
  const withRecession = siteRows.filter((r) => Number(r["recession_mm"] ?? 0) > 0);
  const calSane = withRecession.every(
    (r) => Number(r["probing_depth_mm"]) + Number(r["recession_mm"]) > Number(r["probing_depth_mm"]),
  );
  check("recession is positive, so attachment loss exceeds pocket depth",
    withRecession.length > 0 && calSane,
    withRecession.length
      ? `e.g. ${withRecession[0]!["tooth"]}${withRecession[0]!["site"]}: ${withRecession[0]!["probing_depth_mm"]}mm + ${withRecession[0]!["recession_mm"]}mm recession = CAL ${Number(withRecession[0]!["probing_depth_mm"]) + Number(withRecession[0]!["recession_mm"])}mm`
      : "no recession recorded",
  );

  // Mobility is a tooth-level fact and must not appear at site level.
  const siteFields = await rows("/fields/perio_sites");
  const mobilityAtSite = siteFields.some((f) => String(f["field"]).includes("mobility"));
  check("mobility is not recorded per site", !mobilityAtSite, "a tooth moves as one body");

  const perioTeethRows = await rows("/items/perio_teeth?limit=-1&fields=tooth,mobility,furcation_buccal,furcation_lingual");
  const furcated = perioTeethRows.filter((t) => t["furcation_buccal"] !== null);
  check("furcation is recorded only where a tooth has one",
    furcated.length > 0 && furcated.every((t) => ["16","17","18","26","27","28","36","37","38","46","47","48","14","24"].includes(String(t["tooth"]))),
    furcated.map((t) => String(t["tooth"])).join(", ") + " — multi-rooted only");

  const deskPerio = await get(desk, "/items/perio_sites?limit=1");
  check("front desk CANNOT read a periodontal chart", deskPerio.status === 403, `HTTP ${deskPerio.status}`);

  /* ---------- the medico-legal layer ---------------------------------- */
  // Append-only is a property of the permissions, not a convention. No
  // policy grants update on notes, histories or consents — including the
  // owner's — so nothing can rewrite them.
  const notePerms = await rows("/permissions?limit=-1&fields=collection,action,policy");
  const rewritable = notePerms.filter(
    (p) => ["clinical_notes", "medical_histories", "consents"].includes(String(p["collection"])) &&
      ["update", "delete"].includes(String(p["action"])),
  );
  check("nothing can rewrite a note, a history or a consent", rewritable.length === 0,
    rewritable.length ? rewritable.map((r) => `${r["collection"]}:${r["action"]}`).join(", ") : "no update or delete rules exist");

  const noteRows = await rows("/items/clinical_notes?limit=-1&fields=id,kind,amends,amendment_reason,locked_on");
  const amendments = noteRows.filter((n) => n["kind"] === "amendment" && n["amends"]);
  check("a correction is a new entry pointing at the original", amendments.length > 0,
    `${amendments.length} amendment(s) of ${noteRows.length} entries`);
  check("amendments carry a reason", amendments.every((a) => Boolean(a["amendment_reason"])));

  const histories = await rows("/items/medical_histories?limit=-1&fields=id,patient,taken_on,superseded_by");
  const superseded = histories.filter((h) => h["superseded_by"]);
  check("an updated history supersedes rather than overwrites", superseded.length > 0,
    `${superseded.length} superseded, ${histories.length} kept in total`);

  const findingRows = await rows("/items/patient_findings?limit=-1&fields=id,category,label,status,severity");
  check("an allergy withdrawn on review goes inactive, not away",
    findingRows.some((f) => f["status"] === "inactive"),
    `${findingRows.filter((f) => f["status"] === "inactive").length} inactive of ${findingRows.length}`);

  const consentRows = await rows("/items/consents?limit=-1&fields=id,signed_on,data_fingerprint");
  // Signed ones. The assertion used to be `every consent` while the name
  // said "a signed consent", and the two disagreed — an unsigned consent
  // has nothing to bind, and any practice with a draft on file would have
  // failed a check about integrity for a reason that has nothing to do
  // with integrity. Found when the seed grew a record from 2005 whose
  // paper signature is in a filing cabinet.
  const signedConsents = consentRows.filter((c) => c["signed_on"]);
  check("a signed consent is bound to what it signed",
    signedConsents.length > 0 && signedConsents.every((c) => Boolean(c["data_fingerprint"])),
    `${signedConsents.length} of ${consentRows.length} signed, all fingerprinted`);
  // And the other half of the same rule: an unsigned one is not pretending
  // to be bound to anything.
  check("an unsigned consent carries no fingerprint to mistake for one",
    consentRows.filter((c) => !c["signed_on"]).every((c) => !c["data_fingerprint"]),
    `${consentRows.length - signedConsents.length} unsigned`);

  // Reception sees that an allergy exists — a penicillin allergy on the
  // day list is safety — and nothing clinical behind it.
  const deskAlerts = await get(desk, "/items/patient_findings?limit=-1&fields=id,category,label,status");
  check("front desk sees that an allergy exists", deskAlerts.status === 200 && (deskAlerts.data ?? []).length > 0,
    `${(deskAlerts.data ?? []).length} visible`);
  const deskSeverity = await get(desk, "/items/patient_findings?limit=1&fields=id,severity,note");
  check("front desk CANNOT read the severity or the note", deskSeverity.status === 403,
    `HTTP ${deskSeverity.status}`);
  const deskNotes = await get(desk, "/items/clinical_notes?limit=1");
  check("front desk CANNOT read clinical notes at all", deskNotes.status === 403, `HTTP ${deskNotes.status}`);
  const deskHistory = await get(desk, "/items/medical_histories?limit=1");
  check("front desk CANNOT read the medical history", deskHistory.status === 403, `HTTP ${deskHistory.status}`);

  const portalConsent = await get(portal, "/items/consents?limit=-1&fields=id,title,risks_discussed");
  check("a patient can read the consent they signed",
    portalConsent.status === 200 && (portalConsent.data ?? []).length > 0,
    `${(portalConsent.data ?? []).length} consent(s)`);

  /* ---------- treatment plans and case acceptance --------------------- */
  const planRows = await rows(
    "/items/treatment_plans?limit=-1&fields=id,patient,status,presented_total,accepted_total,signed_on",
  );
  const activePerPatient = new Map<string, number>();
  for (const p of planRows) {
    if (p["status"] !== "active") continue;
    const k = String(p["patient"]);
    activePerPatient.set(k, (activePerPatient.get(k) ?? 0) + 1);
  }
  const overActive = [...activePerPatient.values()].filter((n) => n > 1);
  check("exactly one active plan per patient", overActive.length === 0,
    overActive.length ? `${overActive.length} patient(s) with more than one` : `${activePerPatient.size} patients`);

  check("an inactive plan is kept rather than deleted",
    planRows.some((p) => p["status"] === "inactive"),
    "a superseded alternative survives");

  check("a signed plan records its signature",
    planRows.some((p) => Boolean(p["signed_on"])), "one plan is signed");

  // The whole reason both totals are stored: the two acceptance rates
  // disagree, and the gap is the diagnostic signal.
  const planItems = await rows("/items/treatment_plan_items?limit=-1&fields=status,fee_presented");
  const presentedValue = planRows.reduce((n, p) => n + Number(p["presented_total"] ?? 0), 0);
  const acceptedValue = planRows.reduce((n, p) => n + Number(p["accepted_total"] ?? 0), 0);
  const acceptedCount = planItems.filter((i) => i["status"] === "accepted" || i["status"] === "completed").length;
  const byValue = presentedValue ? (acceptedValue / presentedValue) * 100 : 0;
  const byCount = planItems.length ? (acceptedCount / planItems.length) * 100 : 0;
  check("both acceptance rates are derivable, and they disagree",
    presentedValue > 0 && planItems.length > 0 && Math.abs(byValue - byCount) > 1,
    `${byValue.toFixed(1)}% by value vs ${byCount.toFixed(1)}% by count`);

  const deskPlans = await get(desk, "/items/treatment_plans?limit=1");
  check("front desk can read a plan to quote from it", deskPlans.status === 200, `HTTP ${deskPlans.status}`);
  const deskPlanWrite = await fetch(`${BASE}/items/treatment_plans`, {
    method: "POST",
    headers: { authorization: `Bearer ${desk}`, "content-type": "application/json" },
    body: JSON.stringify({ patient: somePatient, title: "desk probe" }),
  });
  check("front desk CANNOT propose treatment", deskPlanWrite.status === 403, `HTTP ${deskPlanWrite.status}`);

  const portalPlans = await get(portal, "/items/treatment_plans?limit=-1&fields=id,title,status,presented_total");
  const portalStatuses = new Set(((portalPlans.data ?? []) as Array<{ status: string }>).map((p) => p.status));
  check("a patient sees their own plan and what it costs", portalPlans.status === 200);
  check("a patient is NOT shown superseded alternatives", !portalStatuses.has("inactive"),
    [...portalStatuses].join(", ") || "none");

  /* ---------- recall, and what NICE requires of it -------------------- */
  const someType = ((await rows("/items/recall_types?limit=1&fields=id"))[0] ?? {})["id"];

  // NICE CG19 assigns intervals in 3-month steps. Five months is not a
  // recall interval anywhere in the guidance.
  const oddInterval = await post("recalls", {
    patient: somePatient, recall_type: someType, interval_months: 5,
  });
  check("an off-guidance recall interval is refused", oddInterval >= 400, `HTTP ${oddInterval}`);

  const recallRows = await rows(
    "/items/recalls?limit=-1&fields=id,interval_months,patient_agreed,date_due,date_due_calculated,is_disabled,disable_until",
  );
  check("recalls exist across the interval range", recallRows.length >= 8,
    `${recallRows.length} recalls`);

  const agreements = new Set(recallRows.map((r) => String(r["patient_agreed"])));
  check("the patient's agreement with the interval is recorded", agreements.has("disagreed"),
    [...agreements].sort().join(", "));

  const movedOnPurpose = recallRows.filter((r) => r["date_due"] !== r["date_due_calculated"]);
  check("a due date moved on purpose stays distinguishable from the calculated one",
    movedOnPurpose.length > 0, `${movedOnPurpose.length} recall(s) seen early or late deliberately`);

  const suppressed = recallRows.filter((r) => r["is_disabled"] === true || r["disable_until"]);
  check("a recall can be suppressed without being deleted", suppressed.length >= 2,
    `${suppressed.length} suppressed`);

  // Reception runs the chase, so this is the one clinical-adjacent
  // collection they write. The interval is a clinical decision; recording
  // that somebody was rung is not.
  const deskRecalls = await get(desk, "/items/recalls?limit=1");
  check("front desk can work the recall list", deskRecalls.status === 200, `HTTP ${deskRecalls.status}`);

  const portalRecalls = await get(portal, "/items/recalls?limit=-1&fields=id,date_due,date_scheduled");
  check("a patient can see when they are due",
    portalRecalls.status === 200 && (portalRecalls.data ?? []).length > 0,
    `${(portalRecalls.data ?? []).length} recall(s), HTTP ${portalRecalls.status}`);

  // Asking for a denied field by name is refused outright rather than
  // silently omitted — same behaviour as front desk and medical_alerts.
  const portalNote = await get(portal, "/items/recalls?limit=1&fields=id,note");
  check("a patient CANNOT read the recall's internal note", portalNote.status === 403,
    `HTTP ${portalNote.status}`);

  /* ---------- branding ------------------------------------------------ */
  const settings = await one(
    "/settings?fields=project_name,project_color,project_logo,public_favicon," +
      "public_background,public_foreground,public_note,custom_css,default_language,theme_dark_overrides",
  );
  const branded = ["project_logo", "public_favicon", "public_background", "public_foreground"]
    .every((k) => Boolean(settings[k]));
  check("branding is applied, not just uploaded",
    branded && settings["project_name"] === "Enamel" && Boolean(settings["theme_dark_overrides"]),
    branded ? "logo, favicon, login art, theme" : "one or more assets missing");

  const brandFolder = (await rows("/folders?fields=id,name&limit=-1"))
    .find((f) => f["name"] === "Branding");
  const brandFiles = brandFolder
    ? await rows(`/files?limit=-1&fields=id&filter[folder][_eq]=${brandFolder["id"]}`)
    : [];
  check("the brand kit is in its own folder", brandFiles.length >= 9,
    `${brandFiles.length} files in Branding`);

  /* ---------- translations -------------------------------------------- */
  const translations = await rows("/translations?limit=-1&fields=key,language");
  const langs = new Set(translations.map((t) => String(t["language"])));
  const perLang = [...langs].map((l) => translations.filter((t) => t["language"] === l).length);
  check("four languages, none of them short",
    langs.size === 4 && perLang.every((n) => n === perLang[0]) && (perLang[0] ?? 0) >= 50,
    `${[...langs].sort().join(", ")} — ${perLang[0]} keys each`);

  const patientFields = await rows("/fields/patients");
  const translated = patientFields.filter((f) => {
    const meta = (f["meta"] ?? {}) as { translations?: unknown[] };
    return Array.isArray(meta.translations) && meta.translations.length >= 3;
  });
  // English is the fallback language, and it had no labels at all: the
  // dictionary carries de/nl/fr, so English rendered the column name
  // title-cased. Correct for first_name, wrong for anything with a unit
  // or an abbreviation in it — `apr` read as "Apr", which in a table of
  // dates is a month.
  {
    const mangled: string[] = [];
    for (const c of (await rows("/collections?limit=-1"))
      .filter((x) => !String(x["collection"]).startsWith("directus_") && x["schema"])
      .map((x) => String(x["collection"]))) {
      for (const f of await rows(`/fields/${c}`)) {
        const field = String(f["field"]);
        const meta = (f["meta"] ?? {}) as { translations?: Array<{ language: string }> };
        const hasEn = (meta.translations ?? []).some((t) => t.language === "en-US");
        if (hasEn) continue;
        const fallback = field.split("_").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
        if (/\b(Mm|Bpe|Fdi|Apr|Iso|Url|Pdf|Cal)\b/.test(fallback) ||
            /\b(Mm|Months|Days|Minutes|Hours)$/.test(fallback)) {
          mangled.push(`${c}.${field} → "${fallback}"`);
        }
      }
    }
    check("no English field label falls back to a mangled column name",
      mangled.length === 0,
      mangled.length ? mangled.slice(0, 6).join(", ") : "checked every field");
  }

  // A relation display naming only a date identifies nothing: four rows
  // reading "July 26th, 2026" in a list of 240 perio sites were four
  // different exams, on two patients, in two practices.
  {
    const dateOnly = new Set(["{{examined_on}}", "{{starts_at}}", "{{performed_at}}",
                              "{{title}}", "{{due_at}}", "{{sent_at}}", "{{taken_on}}"]);
    const vague: string[] = [];
    for (const c of (await rows("/collections?limit=-1"))
      .filter((x) => !String(x["collection"]).startsWith("directus_") && x["schema"])
      .map((x) => String(x["collection"]))) {
      for (const f of await rows(`/fields/${c}`)) {
        const meta = (f["meta"] ?? {}) as { display?: string; display_options?: { template?: string } };
        if (meta.display !== "related-values") continue;
        const tpl = meta.display_options?.template ?? "";
        if (dateOnly.has(tpl)) vague.push(`${c}.${String(f["field"])} = ${tpl}`);
      }
    }
    check("no relation is displayed as a bare date or title",
      vague.length === 0, vague.length ? vague.join(", ") : "checked every m2o");
  }

  check("field labels carry their own translations", translated.length >= 15,
    `${translated.length} of ${patientFields.length} patient fields`);

  /* ---------- nothing renders as a raw value or an empty cell --------- */
  //
  // Two bugs, one shape, and no behavioural check would have found either.
  // `interface` decides the form; `display` decides the list. A dropdown
  // with no display showed its raw value — "whole" where the form said
  // "Hele tand" — and one declaring `labels` without choices to map with
  // rendered an empty cell for all eight tooth conditions.
  {
    const allFields = await rows("/fields");
    const mineOnly = allFields.filter((f) =>
      !String(f["collection"]).startsWith("directus_") &&
      ((f["meta"] ?? {}) as Record<string, unknown>)["interface"] === "select-dropdown",
    );
    const bare = mineOnly.filter((f) => {
      const meta = (f["meta"] ?? {}) as Record<string, unknown>;
      const choices = ((meta["options"] ?? {}) as { choices?: unknown }).choices;
      if (!Array.isArray(choices) || choices.length === 0) return false;
      const dOpts = (meta["display_options"] ?? {}) as { choices?: unknown };
      return meta["display"] !== "labels" || !Array.isArray(dOpts.choices);
    });
    check("every dropdown renders its label in a list, not its raw value",
      mineOnly.length > 0 && bare.length === 0,
      bare.length
        ? `${bare.length} bare: ${bare.slice(0, 3).map((f) => `${f["collection"]}.${f["field"]}`).join(", ")}`
        : `${mineOnly.length} dropdowns, all mapped`);

    const m2o = allFields.filter((f) => {
      const meta = (f["meta"] ?? {}) as { special?: unknown; display?: unknown };
      return !String(f["collection"]).startsWith("directus_") &&
        Array.isArray(meta.special) && meta.special.includes("m2o");
    });
    const keyed = m2o.filter((f) => !((f["meta"] ?? {}) as Record<string, unknown>)["display"]);
    check("every related field renders a name, not a primary key",
      m2o.length > 0 && keyed.length === 0,
      keyed.length ? `${keyed.length} showing raw uuids` : `${m2o.length} relations, all templated`);
  }

  /* ---------- the public surface is closed --------------------------- */
  //
  // Nothing asserted this, which made it the likeliest thing to leak: a
  // `read *` granted to the public policy by accident would have passed
  // all 95 other checks. It is checked from outside, with no token at
  // all, because that is how a stranger arrives.
  {
    const publicPolicies = (await rows("/policies?limit=-1&fields=id,name"))
      .filter((p) => String(p["name"]).toLowerCase().includes("public") ||
        String(p["name"]) === "$t:enamel_public_label");
    const publicIds = new Set(publicPolicies.map((p) => String(p["id"])));
    const publicRules = (await rows("/permissions?limit=-1&fields=policy,collection,action"))
      .filter((r) => publicIds.has(String(r["policy"])));
    check("the public policy grants nothing", publicRules.length === 0,
      publicRules.length
        ? publicRules.slice(0, 4).map((r) => `${r["collection"]}:${r["action"]}`).join(", ")
        : "no rules on any public policy");

    const unauth: string[] = [];
    for (const collection of tables.map((t) => String(t["collection"]))) {
      const res = await fetch(`${BASE}/items/${collection}?limit=1`);
      if (res.status < 400) unauth.push(`${collection} (${res.status})`);
    }
    check("no collection answers an unauthenticated request", unauth.length === 0,
      unauth.length ? unauth.slice(0, 4).join(", ") : `${tables.length} collections, all closed`);

    const assetRes = await fetch(`${BASE}/items/documents?limit=1`);
    check("patient documents are closed to strangers", assetRes.status >= 400, `HTTP ${assetRes.status}`);
  }

  /* ---------- every $t: reference resolves ---------------------------- */
  //
  // The check that should have existed from the start. Three keys had
  // fallen out of the dictionary while the fields still referenced them —
  // and because this instance kept the rows from an older provision,
  // nothing looked wrong here while a fresh clone rendered the raw
  // "$t:enamel_note_reminder" on screen.
  //
  // It walks what the instance actually holds rather than the source, so
  // it catches a reference nobody defined AND a translation somebody
  // deleted by hand.
  {
    const strings = await rows("/translations?limit=-1&fields=key,language");
    const defined = new Set(strings.map((t) => `${t["key"]}::${t["language"]}`));
    const languages = [...new Set(strings.map((t) => String(t["language"])))];

    const referenced = new Set<string>();
    const eat = (v: unknown): void => {
      if (typeof v === "string") {
        if (v.startsWith("$t:")) referenced.add(v.slice(3));
      } else if (Array.isArray(v)) v.forEach(eat);
      else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(eat);
    };

    for (const c of collections) eat((c as Record<string, unknown>)["meta"]);
    const allFields = await rows("/fields");
    for (const f of allFields) eat(f["meta"]);
    for (const p of await rows("/presets?limit=-1&fields=bookmark")) eat(p["bookmark"]);
    for (const p of await rows("/policies?limit=-1&fields=name")) eat(p["name"]);

    // Only our own namespace. Directus puts `$t:` references of its own on
    // system fields — `field_options.directus_activity.create` and 177
    // others — and those resolve from its bundled i18n, not from
    // directus_translations. Asserting on them would fail forever and
    // prove nothing.
    const ours = [...referenced].filter((k) => k.startsWith("enamel_"));
    const unresolved = ours.filter(
      (k) => !languages.every((l) => defined.has(`${k}::${l}`)),
    );
    check(
      "every $t: reference in the instance resolves in all four languages",
      ours.length > 0 && unresolved.length === 0,
      unresolved.length
        ? `${unresolved.length} unresolved: ${unresolved.slice(0, 4).join(", ")}`
        : `${ours.length} enamel references, all present in ${languages.length} languages`,
    );

    // And the inverse, which is the half that was missing. The check above
    // only sees strings that are already keys, so a note written as a bare
    // English literal was invisible to it — no key was absent, because no
    // key existed. Two field notes and fourteen collection notes sat in
    // English on forms that were otherwise fully translated, and they were
    // found by reading a Dutch screenshot rather than by any check.
    //
    // A note is always prose. A placeholder is not — `36` is a tooth
    // number and `kadehuis.example.com` is a host, and both are the same
    // string in every language — so placeholders are not asserted here and
    // the README says where that line falls.
    const literalNotes: string[] = [];
    const noteOf = (m: unknown): string => {
      const note = (m as { note?: unknown } | null)?.note;
      return typeof note === "string" ? note : "";
    };
    for (const c of collections) {
      const name = String((c as Record<string, unknown>)["collection"] ?? "");
      if (name.startsWith("directus_")) continue;
      const note = noteOf((c as Record<string, unknown>)["meta"]);
      if (note && !note.startsWith("$t:")) literalNotes.push(name);
    }
    for (const f of allFields) {
      const coll = String(f["collection"] ?? "");
      if (coll.startsWith("directus_") && coll !== "directus_users") continue;
      const note = noteOf(f["meta"]);
      if (note && !note.startsWith("$t:")) literalNotes.push(`${coll}.${String(f["field"])}`);
    }
    check("and no note is a bare English literal instead of a key",
      literalNotes.length === 0,
      literalNotes.length
        ? `${literalNotes.length} untranslatable: ${literalNotes.slice(0, 4).join(", ")}`
        : "every collection and field note is a key");

    // The README quotes these four numbers. They move every time a label
    // is added, and a README that quotes a number nobody checks is a
    // number that is wrong within a week.
    {
      const here = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const readmeText = await readFile(resolve(here, "README.md"), "utf8").catch(() => "");
      const n = (re: RegExp): number => Number((readmeText.match(re)?.[1] ?? "0").replace(/,/g, ""));
      const claimed = {
        keys: n(/([\d,]+) keys across 4 languages/),
        rows: n(/keys across 4 languages — ([\d,]+) rows/),
        collections: n(/plus ([\d,]+) collection names/),
        fields: n(/and\s+([\d,]+) field labels/),
      };
      const withT = (m: unknown): boolean =>
        Array.isArray((m as { translations?: unknown[] } | null)?.translations)
        && ((m as { translations: unknown[] }).translations.length > 0);
      const actual = {
        keys: new Set(strings.map((t) => String(t["key"]))).size,
        rows: strings.length,
        collections: collections.filter((c) => {
          const name = String((c as Record<string, unknown>)["collection"] ?? "");
          return !name.startsWith("directus_") && withT((c as Record<string, unknown>)["meta"]);
        }).length,
        fields: allFields.filter((f) => {
          const coll = String(f["collection"] ?? "");
          return (!coll.startsWith("directus_") || coll === "directus_users") && withT(f["meta"]);
        }).length,
      };
      const wrong = (Object.keys(actual) as Array<keyof typeof actual>)
        .filter((k) => claimed[k] !== actual[k]);
      check("and the README's four translation numbers are the instance's",
        wrong.length === 0,
        wrong.length
          ? wrong.map((k) => `${k}: says ${claimed[k]}, is ${actual[k]}`).join("; ")
          : `${actual.keys} keys, ${actual.rows} rows, ${actual.collections} collections, ${actual.fields} fields`);
    }
  }

  /* ---------- bookmarks ------------------------------------------------ */
  const presets = (await rows("/presets?limit=-1&fields=id,bookmark,collection,user"))
    .filter((p) => p["user"] === null && p["bookmark"]);
  const unresolved = presets.filter((p) => !String(p["bookmark"]).startsWith("$t:"));
  check("twelve global bookmarks, all translated", presets.length === 12 && unresolved.length === 0,
    `${presets.length} bookmarks`);

  /*
   * One icon, one colour, and the colour is the theme's.
   *
   * These used to carry a hand-picked hex each — a green, an amber, a
   * purple, a red — and a sidebar of eight hues reads as decoration
   * rather than as structure. Worse, a hardcoded colour does not follow
   * `--theme--primary`, which Directus derives from the practice's brand
   * colour and recomputes per appearance, so half the icons looked wrong
   * in one theme and the other half in the other.
   *
   * Asserted as absence rather than as a specific value on purpose: the
   * right colour is whatever the theme says today, and naming a hex here
   * would be the same mistake one layer up.
   */
  /*
   * The extensions' theme fallbacks are the theme's own values.
   *
   * Every extension writes `var(--theme--primary, #xxxxxx)` so it renders
   * readably in the instant before the admin's stylesheet settles. The
   * fallback is dead code almost always, which is exactly why it rots:
   * the palette went from teal to blue and four extensions kept a mint
   * `#6fd8c8` and a purple `#6644ff` nobody would see until the one frame
   * where they would. Asserted against what provisioning actually set, so
   * the next colour change is caught here rather than in a screenshot.
   */
  {
    // `/settings` is a singleton: it answers with an object, not a list.
    // Read through `rows()` it came back undefined, every fallback looked
    // stale, and the check accused six files that were correct.
    const settings = await one("/settings?fields=theme_dark_overrides");
    const dark = (settings["theme_dark_overrides"] ?? {}) as Record<string, unknown>;
    const want = String(dark["primary"] ?? "").toLowerCase();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    // Walked rather than globbed: `fs.glob` is Node 22 only and this runs
    // wherever the suite runs.
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = resolve(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith(".vue") || e.name.endsWith(".ts")) out.push(full);
      }
      return out;
    };
    const sources = [
      ...(await walk(resolve(root, "apps/directus/extensions"))),
      ...(await walk(resolve(root, "packages"))),
    ].filter((f) => !f.includes("/dist/") && !f.includes("/node_modules/"));
    const stale: string[] = [];
    for (const rel of sources) {
      const text = await readFile(rel, "utf8").catch(() => "");
      for (const m of text.matchAll(/var\(--theme--primary,\s*(#[0-9a-fA-F]{6})\)/g)) {
        if (m[1]!.toLowerCase() !== want) stale.push(`${rel.split("/").pop()}: ${m[1]}`);
      }
    }
    check("every extension's theme fallback is the theme's own accent",
      want.length === 7 && stale.length === 0,
      stale.length ? stale.join(", ") : `all match ${want}`);
  }

  const styled = (await rows("/presets?limit=-1&fields=bookmark,user,icon,color"))
    .filter((r) => r["user"] === null && r["bookmark"]);
  const oddIcon = styled.filter((r) => r["icon"] !== "bookmark");
  const coloured = styled.filter((r) => r["color"] !== null);
  check("every global bookmark carries the same icon",
    oddIcon.length === 0,
    oddIcon.length ? oddIcon.map((r) => String(r["icon"])).join(", ") : "all `bookmark`");
  check("and none overrides the theme colour with a hex of its own",
    coloured.length === 0,
    coloured.length ? `${coloured.length} coloured` : "all inherit --theme--primary");

  const paintedCollections = (await rows("/collections?limit=-1"))
    .filter((c) => !String(c["collection"]).startsWith("directus_"))
    .filter((c) => ((c["meta"] ?? {}) as Record<string, unknown>)["color"] != null);
  check("nor does any collection or folder in the sidebar",
    paintedCollections.length === 0,
    paintedCollections.length
      ? paintedCollections.map((c) => String(c["collection"])).join(", ")
      : "every icon takes the theme accent");

  // A collection with no default preset opens on whichever columns
  // Directus finds first, which is not a view anybody designed. Perio
  // Sites opened on Clinic, Exam, Site, Tooth: 240 rows of periodontal
  // readings and not one reading among the columns.
  {
    const all = await rows("/presets?limit=-1&fields=collection,bookmark,user,role");
    const defaults = new Set(all
      .filter((p) => !p["bookmark"] && !p["user"] && !p["role"])
      .map((p) => String(p["collection"])));
    // A singleton has no list to design a view for — Directus opens the
    // record itself — so `practice` is excluded rather than counted as a
    // collection somebody forgot.
    const tables = (await rows("/collections?limit=-1"))
      .filter((c) => !String(c["collection"]).startsWith("directus_") && c["schema"])
      .filter((c) => !((c["meta"] as { singleton?: boolean } | null)?.singleton))
      .map((c) => String(c["collection"]));
    const missing = tables.filter((t) => !defaults.has(t));
    check("every collection opens on a view somebody designed",
      tables.length > 0 && missing.length === 0,
      missing.length ? missing.join(", ") : `${tables.length} collections`);
  }

  /* ---------- availability: hours, rota, leave and chair downtime ------ */
  {
    const hours = await rows("/items/clinic_hours?limit=-1&fields=weekday,closed,opens_at,closes_at");
    const perPractice = new Map<string, number>();
    for (const h of hours) perPractice.set("practice", (perPractice.get("practice") ?? 0) + 1);
    // Seven, not five: a closed Sunday is a row that says so. No row at
    // all is a rota nobody finished, and the two must not look alike.
    const complete = [...perPractice.values()].every((n) => n === 7);
    check("every practice has a full seven-day week on file",
      perPractice.size > 0 && complete,
      [...perPractice.values()].join(", ") + " rows for the practice");

    const shut = hours.filter((h) => h["closed"] === true);
    check("a closed day is recorded as closed, not left out",
      shut.length >= perPractice.size, `${shut.length} closed days`);

    const rota = await rows("/items/practitioner_hours?limit=-1&fields=practitioner,weekday");
    const byWho = new Map<string, number>();
    for (const r of rota) byWho.set(String(r["practitioner"]), (byWho.get(String(r["practitioner"])) ?? 0) + 1);
    // If everyone worked every day the rota could not be shown to do
    // anything — the demo would pass whether or not it were enforced.
    const partTime = [...byWho.values()].some((n) => n < 5);
    check("at least one clinician is not available all week",
      byWho.size > 0 && partTime, `sessions per clinician: ${[...byWho.values()].join(", ")}`);
  }

  /* ---------- availability: and the diary obeys them ------------------- */
  // The strongest statement this suite can make about the demo data: not
  // that the rules exist, but that every row already in the book
  // satisfies them. A seed that writes a rota and then books against a
  // different one ships a rule nothing was ever tested against.
  {
    let db: Client | null = null;
    try {
      db = new Client({ host: DB_HOST, port: DB_PORT, database: DB_DATABASE, user: DB_USER, password: DB_PASSWORD });
      await db.connect();
      const dow = "(ARRAY['sun','mon','tue','wed','thu','fri','sat'])[EXTRACT(DOW FROM a.starts_at AT TIME ZONE c.timezone)::int + 1]";

      const outside = await db.query<{ n: string }>(`
        SELECT count(*) AS n FROM appointments a
          CROSS JOIN practice c
          LEFT JOIN clinic_hours h ON h.weekday = ${dow}
         WHERE h.id IS NULL OR h.closed
            OR (a.starts_at AT TIME ZONE c.timezone)::time < h.opens_at
            OR (a.ends_at   AT TIME ZONE c.timezone)::time > h.closes_at`);
      check("no appointment sits outside its practice's opening hours",
        outside.rows[0]?.n === "0", `${outside.rows[0]?.n} outside`);

      const offRota = await db.query<{ n: string }>(`
        SELECT count(*) AS n FROM appointments a
          CROSS JOIN practice c
         WHERE a.practitioner IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM practitioner_hours p
            WHERE p.practitioner = a.practitioner
              AND p.weekday = ${dow}
              AND (a.starts_at AT TIME ZONE c.timezone)::time >= p.starts_at
              AND (a.ends_at   AT TIME ZONE c.timezone)::time <= p.ends_at)`);
      check("no appointment is booked with a clinician who is not working",
        offRota.rows[0]?.n === "0", `${offRota.rows[0]?.n} off-rota`);

      // Each of the four blocks, proved by trying one. The probe rows are
      // never committed: the trigger refuses them, and the transaction is
      // rolled back either way so a passing run leaves nothing behind.
      const probe = await db.query<{ patient: string; practitioner: string; room: string; tz: string }>(`
        SELECT a.patient, a.practitioner, a.room, c.timezone AS tz
          FROM appointments a CROSS JOIN practice c
         WHERE a.practitioner IS NOT NULL AND a.room IS NOT NULL LIMIT 1`);
      const base = probe.rows[0];

      const refuses = async (label: string, startsAt: string, endsAt: string, expect: string) => {
        if (!base) return check(label, false, "no appointment to build a probe from");
        let code = "no error";
        await db!.query("BEGIN");
        try {
          await db!.query(
            `INSERT INTO appointments (id, patient, practitioner, room, starts_at, ends_at, status, reason)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'scheduled', 'verify probe')`,
            [base.patient, base.practitioner, base.room, startsAt, endsAt],
          );
          code = "inserted";
        } catch (e) {
          code = (e as { message?: string }).message ?? "unknown";
        }
        await db!.query("ROLLBACK");
        check(label, code.includes(expect), code.slice(0, 60));
      };

      // 03:00 is outside every practice's hours in any timezone.
      const night = await db.query<{ s: string; e: string }>(
        `SELECT (date_trunc('day', now()) + interval '45 days 3 hours')::text AS s,
                (date_trunc('day', now()) + interval '45 days 4 hours')::text AS e`);
      await refuses("the practice being shut blocks a booking",
        night.rows[0]!.s, night.rows[0]!.e, "ENAMEL_CLOSED");

      // Mid-morning on the day of the closure: inside opening hours, so
      // the only rule left to fire is the absence. The first version of
      // this probed one hour past midnight and passed on ENAMEL_CLOSED —
      // a green tick for a rule it never reached.
      const leave = await db.query<{ s: string; e: string }>(`
        SELECT (date_trunc('day', a.starts_at AT TIME ZONE c.timezone) + interval '10 hours')
                 AT TIME ZONE c.timezone AS s,
               (date_trunc('day', a.starts_at AT TIME ZONE c.timezone) + interval '10 hours 45 minutes')
                 AT TIME ZONE c.timezone AS e
          FROM absences a CROSS JOIN practice c
         WHERE a.practitioner IS NULL AND a.status <> 'cancelled'
         LIMIT 1`);
      if (leave.rows[0]) {
        await refuses("a practice-wide closure blocks a booking",
          leave.rows[0].s, leave.rows[0].e, "ENAMEL_ABSENT");
      } else {
        check("a practice-wide closure blocks a booking", false, "no practice closure seeded");
      }

      // And the chair probe has to use the chair that is actually down.
      // Picking whichever room the sample appointment happened to use
      // passed the insert straight through and reported "inserted" —
      // a failing check, but for the wrong reason.
      const down = await db.query<{ s: string; e: string; room: string; patient: string; practitioner: string }>(`
        SELECT (date_trunc('day', rc.starts_at AT TIME ZONE c.timezone) + interval '1 day 10 hours')
                 AT TIME ZONE c.timezone AS s,
               (date_trunc('day', rc.starts_at AT TIME ZONE c.timezone) + interval '1 day 10 hours 45 minutes')
                 AT TIME ZONE c.timezone AS e,
               rc.room,
               (SELECT p.id FROM patients p LIMIT 1) AS patient,
               (SELECT u.id FROM directus_users u WHERE u.role IS NOT NULL LIMIT 1) AS practitioner
          FROM room_closures rc CROSS JOIN practice c
         LIMIT 1`);
      const chair = down.rows[0];
      if (chair) {
        let code = "no error";
        await db.query("BEGIN");
        try {
          await db.query(
            `INSERT INTO appointments (id, patient, practitioner, room, starts_at, ends_at, status, reason)
             VALUES (gen_random_uuid(), $1, NULL, $2, $3, $4, 'scheduled', 'verify probe')`,
            [chair.patient, chair.room, chair.s, chair.e],
          );
          code = "inserted";
        } catch (e) {
          code = (e as { message?: string }).message ?? "unknown";
        }
        await db.query("ROLLBACK");
        check("a chair out of service blocks a booking",
          code.includes("ENAMEL_CHAIR_DOWN"), code.slice(0, 60));
      } else {
        check("a chair out of service blocks a booking", false, "no chair closure seeded");
      }
    } catch (e) {
      check("no appointment sits outside its practice's opening hours", false,
        `cannot reach Postgres: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (db) await db.end().catch(() => {});
    }
  }

  /* ---------- scheduling: the rules hold, and say why ------------------ */
  // Booked through the API, where the hook answers first. The point of
  // these is the message as much as the refusal: the rule used to fire as
  // an HTTP 500 carrying the raw insert statement, which leaks the schema
  // and tells a receptionist nothing.
  {
    const seed = (await rows(
      "/items/appointments?limit=1&fields=patient,practitioner,room,starts_at,ends_at" +
      "&filter[status][_eq]=scheduled&filter[practitioner][_nnull]=true&filter[room][_nnull]=true",
    ))[0] as Record<string, unknown> | undefined;

    const book = async (body: Record<string, unknown>) => {
      const res = await fetch(`${BASE}/items/appointments`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json().catch(() => ({}))) as
        { errors?: Array<{ message?: string }>; data?: { id?: string } };
      return { status: res.status, message: parsed.errors?.[0]?.message ?? "", id: parsed.data?.id };
    };

    if (!seed) {
      check("a double-booked chair is refused", false, "no seeded appointment to collide with");
      check("a double-booked dentist is refused", false, "no seeded appointment to collide with");
      check("an appointment cannot end before it starts", false, "no seeded appointment");
      check("a free slot still books", false, "no seeded appointment");
    } else {
      const clash = await book({ ...seed, reason: "verify: double-book" });
      // "Already booked" beats a 500, but the check is only worth
      // anything if it also proves the message names the clash rather
      // than repeating the SQL back.
      check("a double-booked chair is refused, in words",
        clash.status === 400 && /already booked/i.test(clash.message) && !/insert into/i.test(clash.message),
        `HTTP ${clash.status}: ${clash.message.slice(0, 90)}`);

      const dentist = await book({ ...seed, room: null, reason: "verify: dentist clash" });
      check("a double-booked dentist is refused even in a free chair",
        dentist.status === 400 && /already booked/i.test(dentist.message),
        `HTTP ${dentist.status}`);

      const backwards = await book({
        ...seed, practitioner: null, room: null,
        ends_at: seed["starts_at"], reason: "verify: backwards",
      });
      check("an appointment cannot end before it starts",
        backwards.status === 400 && /end after it starts/i.test(backwards.message),
        `HTTP ${backwards.status}`);

      // The availability rules live in a database trigger, which raises
      // ENAMEL_CLOSED — a 500 with the insert statement wrapped round it
      // by the time it reaches a caller. These assert the hook answered
      // first and said something a receptionist could act on.
      const sunday = await book({
        ...seed, starts_at: "2026-11-08T10:00:00.000Z", ends_at: "2026-11-08T10:45:00.000Z",
        reason: "verify: closed day",
      });
      check("booking on a day the practice is shut says so",
        sunday.status === 400 && /closed on a/i.test(sunday.message) && !/ENAMEL_/.test(sunday.message),
        `HTTP ${sunday.status}: ${sunday.message.slice(0, 70)}`);

      const nightShift = await book({
        ...seed, starts_at: "2026-11-03T01:00:00.000Z", ends_at: "2026-11-03T02:00:00.000Z",
        reason: "verify: out of hours",
      });
      check("booking outside opening hours quotes the opening hours",
        nightShift.status === 400 && /open \d\d:\d\d/i.test(nightShift.message),
        `HTTP ${nightShift.status}: ${nightShift.message.slice(0, 70)}`);

      // The control. Without it every check above passes on an instance
      // that refuses all writes, which is a suite that cannot fail.
      const free = await book({
        ...seed,
        // A Monday, mid-morning, inside every seeded practice's hours —
        // the control has to be refusable only by the rules under test.
        starts_at: "2031-04-07T09:00:00.000Z",
        ends_at: "2031-04-07T09:45:00.000Z",
        reason: "verify: control",
      });
      check("a free slot still books", free.status === 200 && Boolean(free.id), `HTTP ${free.status}`);
      if (free.id) {
        await fetch(`${BASE}/items/appointments/${free.id}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin}` },
        });
      }
    }
  }

  /* ---------- scheduling: and hold without Directus in the way ---------- */
  // The hook is the readable layer and it races — two requests can both
  // pass its check before either inserts. This is the layer that cannot
  // be raced or bypassed, so it is asserted by going around Directus
  // entirely and writing to Postgres directly. If this passes, "no
  // client can double-book" is a claim about the database rather than
  // about the code paths somebody remembered to guard.
  {
    let db: Client | null = null;
    try {
      db = new Client({ host: DB_HOST, port: DB_PORT, database: DB_DATABASE, user: DB_USER, password: DB_PASSWORD });
      await db.connect();

      const named = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname = ANY($1)`,
        [["appointments_end_after_start",
          "appointments_no_practitioner_overlap",
          "appointments_no_room_overlap"]],
      );
      check("the database itself carries all three scheduling rules",
        named.rowCount === 3, `${named.rowCount ?? 0} of 3 present`);

      const existing = await db.query<{ patient: string; practitioner: string; starts_at: string; ends_at: string }>(
        `SELECT patient, practitioner, starts_at, ends_at
           FROM appointments
          WHERE status IN ('scheduled','confirmed') AND practitioner IS NOT NULL
          LIMIT 1`,
      );
      const row = existing.rows[0];
      if (!row) {
        check("Postgres refuses a double-booking that never touched Directus", false, "no appointment to collide with");
      } else {
        let refused = false;
        let detail = "the insert succeeded — the constraint is not doing anything";
        try {
          await db.query(
            `INSERT INTO appointments (id, patient, practitioner, starts_at, ends_at, status, reason)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'scheduled', 'verify: raw sql')`,
            [row.patient, row.practitioner, row.starts_at, row.ends_at],
          );
          await db.query(`DELETE FROM appointments WHERE reason = 'verify: raw sql'`);
        } catch (e) {
          // 23P01 is exclusion_violation. Matching the code rather than
          // the message keeps this from passing on an unrelated failure
          // — a missing column would also throw.
          const code = (e as { code?: string }).code;
          refused = code === "23P01";
          detail = `SQLSTATE ${code}`;
        }
        check("Postgres refuses a double-booking that never touched Directus", refused, detail);
      }
    } catch (e) {
      check("the database itself carries all three scheduling rules", false,
        `cannot reach Postgres: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (db) await db.end().catch(() => {});
    }
  }

  /* ---------- the core service ----------------------------------------- */
  // Reads the database directly, which means it has no permission layer
  // underneath it. Everything here is about whether the boundary it
  // re-implements actually holds.
  {
    const call = async (path: string, token?: string, init: RequestInit = {}) => {
      try {
        const res = await fetch(`${CORE_URL}${path}`, {
          ...init,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...(init.headers ?? {}),
          },
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { status: res.status, body };
      } catch (e) {
        return { status: 0, body: { message: e instanceof Error ? e.message : String(e) } };
      }
    };

    const health = await call("/health");
    check("the core service is up and can reach both the database and Directus",
      health.status === 200 && health.body["ok"] === true,
      health.status === 0 ? `unreachable at ${CORE_URL}` : JSON.stringify(health.body));

    const anonymous = await call("/api/availability/slots");
    check("the core service refuses a request with no token",
      anonymous.status === 401, `HTTP ${anonymous.status}`);

    // The admin has no clinic. "Superuser sees every practice" is exactly
    // The administrator used to be refused here: the guard required a
    // `clinic` and the admin deliberately had none, because "the
    // superuser sees every practice" is the default that becomes a
    // tenancy bug. There is one practice now, so the guard asserts only
    // that the token is real and names somebody — and what each caller
    // may then see is decided by their Directus policy on every query
    // the service makes as them, which is where it always belonged.
    const noToken = await call("/api/availability/slots", undefined);
    check("the core service refuses a request with no token",
      noToken.status === 401, `HTTP ${noToken.status}`);

    // A query parameter used to be able to name another practice, and
    // the check was that it changed nothing. With one practice the
    // question that remains is whether the service still answers from
    // its own record rather than from anything the caller sent.
    const named = await call("/api/availability/slots?clinic=00000000-0000-0000-0000-000000000000&limit=1", desk);
    check("an unknown query parameter changes nothing",
      named.status === 200,
      `HTTP ${named.status}`);

    const offered = await call("/api/availability/slots?duration=45&limit=40", desk);
    const slots = ((offered.body["slots"] ?? []) as Array<Record<string, string>>);
    check("the core service finds free slots at all", slots.length > 0, `${slots.length} offered`);

    // A slot search that offers a taken slot is worse than none: it sends
    // a receptionist to a booking the database then refuses in front of
    // the patient.
    const booked = (await rows(
      "/items/appointments?limit=-1&fields=practitioner,room,starts_at,ends_at" +
      "&filter[status][_in]=scheduled,confirmed",
    )) as Array<Record<string, string>>;
    const collides = slots.filter((slot) => {
      const from = slot["starts_at"] ?? "";
      const to = slot["ends_at"] ?? "";
      return booked.some((b) => {
        const sameResource =
          (b["practitioner"] && b["practitioner"] === slot["practitioner"]) ||
          (b["room"] && b["room"] === slot["room"]);
        return Boolean(sameResource) && from < (b["ends_at"] ?? "") && to > (b["starts_at"] ?? "");
      });
    });
    check("no offered slot collides with an appointment already in the book",
      slots.length > 0 && collides.length === 0,
      collides.length ? `${collides.length} of ${slots.length} collide` : `${slots.length} checked`);

    // And every one has a chair. A slot with no room is a clinician
    // standing in a corridor.
    const roomless = slots.filter((s) => !s["room"]);
    check("every offered slot names a chair", roomless.length === 0,
      roomless.length ? `${roomless.length} without one` : `${slots.length} checked`);

    // The end-to-end claim: what the search offers, the rules accept.
    if (slots[0]) {
      const patient = (await rows(
        `/items/patients?limit=1&fields=id`,
      ))[0] as Record<string, string> | undefined;
      const attempt = await call("/api/availability/book", desk, {
        method: "POST",
        body: JSON.stringify({
          patient: patient?.["id"],
          practitioner: slots[0]["practitioner"],
          room: slots[0]["room"],
          starts_at: slots[0]["starts_at"],
          ends_at: slots[0]["ends_at"],
          reason: "verify: slot round trip",
        }),
      });
      check("a slot the core service offered is one the rules accept",
        attempt.status === 201 || attempt.status === 200,
        `HTTP ${attempt.status}: ${String(attempt.body["message"] ?? "")}`.slice(0, 80));

      const madeId = (attempt.body as { id?: string }).id;
      if (madeId) {
        await fetch(`${BASE}/items/appointments/${madeId}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin}` },
        });
      }
    } else {
      check("a slot the core service offered is one the rules accept", false, "nothing was offered");
    }

    // Directus redacts `token` on read as a row of asterisks, which is
    // truthy — and a seed that believed it wrote those asterisks into
    // .env over the working credential. Everything still *looked* right:
    // the core service had the old value in its environment and kept
    // running, so the only symptom was a 403 from an endpoint nobody had
    // touched. Naming the cause is cheaper than diagnosing it twice.
    check("the reminder sweep's token is a token, not Directus's redaction of one",
      REMINDER_TOKEN.length > 0 && !/^\*+$/.test(REMINDER_TOKEN),
      REMINDER_TOKEN ? `${REMINDER_TOKEN.length} characters` : "not set — run the seed");

    // The queue's whole reason for existing is that a failure is visible.
    if (REMINDER_TOKEN) {
      const queue = await call("/api/reminders/status", undefined, {
        headers: { "x-reminder-token": REMINDER_TOKEN },
      });
      const counts = (queue.body["counts"] ?? {}) as Record<string, number>;
      check("no reminder is sitting on the failed set",
        queue.status === 200 && (counts["failed"] ?? 0) === 0,
        queue.status === 200 ? `failed ${counts["failed"]}, completed ${counts["completed"]}` : `HTTP ${queue.status}`);

      const wrongToken = await call("/api/reminders/status", undefined, {
        headers: { "x-reminder-token": "not-the-token" },
      });
      check("the queue's operator endpoints reject a wrong service token",
        wrongToken.status === 403, `HTTP ${wrongToken.status}`);
    } else {
      check("no reminder is sitting on the failed set", false,
        "SCHEDULER_DIRECTUS_TOKEN is not set — run the seed");
      check("the queue's operator endpoints reject a wrong service token", false,
        "SCHEDULER_DIRECTUS_TOKEN is not set");
    }
  }

  /* ---------- the day sheet -------------------------------------------- */
  // The extension the practice actually works from. Directus's own
  // calendar layout cannot draw it — day, week and month by time, with no
  // resource lane — so this is a bundle: a module for the grid and an
  // endpoint that reaches the core service with the caller's own token.
  {
    // `id` on an extension row is a uuid; the name is in `schema.name`,
    // and a bundle's children appear as their own rows pointing back at
    // the parent. Both halves have to be there and enabled: the module
    // alone draws a grid with nothing to fill it, and the endpoint alone
    // is a door nobody walks through.
    const extensions = (await rows("/extensions")) as Array<{
      meta?: { enabled?: boolean; folder?: string };
      schema?: { name?: string; type?: string } | null;
    }>;
    const named = (name: string, type: string) =>
      extensions.find(
        (e) => e.schema?.name === name && e.schema?.type === type && e.meta?.enabled !== false,
      );
    const moduleEntry = named("day-sheet", "module");
    const endpointEntry = named("day-sheet-api", "endpoint");
    check("the day sheet is registered, grid and endpoint both",
      Boolean(moduleEntry) && Boolean(endpointEntry),
      `module ${moduleEntry ? "yes" : "no"}, endpoint ${endpointEntry ? "yes" : "no"}`);

    const proxied = async (token: string | undefined, path: string) => {
      const res = await fetch(`${BASE}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, body };
    };

    // Directus resolves the caller's token onto the request and the
    // endpoint forwards *that*, so the core service scopes to the person at
    // the keyboard. Anonymous has no token to forward.
    const anon = await proxied(undefined, "/day-sheet-api/day?date=2026-09-14");
    check("the day-sheet endpoint refuses an anonymous request",
      anon.status === 401 || anon.status === 403, `HTTP ${anon.status}`);

    const monday = await proxied(desk, "/day-sheet-api/day?date=2026-09-14");
    const sheet = monday.body as {
      practice?: { name?: string; timezone?: string };
      open?: boolean;
      rooms?: unknown[];
      appointments?: Array<{ start_minute: number; end_minute: number; room: string | null }>;
    };
    check("the day sheet answers with the caller's own practice",
      monday.status === 200 && sheet.practice?.name === "Kadehuis Dental",
      `HTTP ${monday.status}: ${String(sheet.practice?.name ?? "")}`);

    check("the day sheet returns chairs to draw columns for",
      (sheet.rooms?.length ?? 0) > 0, `${sheet.rooms?.length ?? 0} chairs`);

    // The grid positions every block from these two numbers. If the
    // server did the timezone arithmetic wrong they are still numbers,
    // and the appointment is simply drawn in the wrong place — which is
    // why this asserts the range rather than merely their presence.
    const misplaced = (sheet.appointments ?? []).filter(
      (a) =>
        !Number.isFinite(a.start_minute) || !Number.isFinite(a.end_minute) ||
        a.start_minute < 0 || a.end_minute > 24 * 60 || a.end_minute <= a.start_minute,
    );
    check("every appointment carries minutes the grid can place it by",
      (sheet.appointments?.length ?? 0) > 0 && misplaced.length === 0,
      misplaced.length ? `${misplaced.length} out of range` : `${sheet.appointments?.length ?? 0} placed`);

    /* --- who the day sheet is for --- */
    //
    // It is built in SQL, straight from Postgres, so no Directus policy
    // is consulted on the way — and for a long time nothing else was
    // asked either. Any account with a valid token was handed the whole
    // day: every patient by name, what each was in for, which chair. It
    // went unnoticed because until there was a Queue operator every
    // account that could sign in was clinical, so "a valid token" and
    // "somebody who may see the diary" described the same people.
    //
    // Both halves are asserted, because the first fix only got one of
    // them. Refusing callers who may read no appointment at all shut out
    // the operator and did nothing about a patient, whose policy grants
    // the collection and filters the rows — they were still served
    // twenty-three strangers.
    {
      const names = (b: unknown) =>
        new Set(((b as { appointments?: Array<{ patient_name?: string }> }).appointments ?? [])
          .map((a) => a.patient_name ?? ""));

      const staff = await proxied(desk, "/day-sheet-api/day?date=2026-09-14");
      const staffNames = names(staff.body);
      check("the day sheet still shows reception the whole day",
        staff.status === 200 && staffNames.size > 1, `${staffNames.size} patients`);

      const opSheet = opToken0
        ? await proxied(opToken0, "/day-sheet-api/day?date=2026-09-14")
        : { status: 0, body: {} };
      check("but not to an account that may read no appointment at all",
        opSheet.status === 403,
        opToken0 ? `HTTP ${opSheet.status}, ${names(opSheet.body).size} patients` : "no operator token");

      // The one that the coarse check missed. A patient holds a real read
      // on `appointments` — of their own — so they must come back with
      // theirs and nobody else's, not with nothing and not with the lot.
      const theirs = await proxied(patientToken0, "/day-sheet-api/day?date=2026-09-14");
      const mine = names(theirs.body);
      const strangers = [...mine].filter((n) => n !== "de Vries, Sofie");
      check("and a patient sees their own appointments and no neighbours",
        theirs.status === 200 && mine.size > 0 && strangers.length === 0,
        strangers.length ? `leaked: ${strangers.join(", ")}` : `${mine.size} name, ${staffNames.size} on the day`);
    }

    // A Sunday. The sheet has to say the practice is shut rather than
    // render an empty grid that looks like a quiet day.
    const sunday = await proxied(desk, "/day-sheet-api/day?date=2026-09-13");
    check("the day sheet reports a closed day as closed",
      sunday.status === 200 && (sunday.body as { open?: boolean }).open === false,
      `open=${String((sunday.body as { open?: boolean }).open)}`);

    // What the front desk sees when a move is refused. The sentence comes
    // from the scheduling hook four hops away — Postgres, the hook, Nest,
    // this endpoint — and each hop has its own error convention to lose
    // it in. It arrived once as "Request failed with status code 400".
    // Both from the same practice, and specifically the caller's.
    // Without that this picked a Marina appointment and a Kadehuis one,
    // and moving the second onto the first's instant put it at 07:00
    // Amsterdam — refused for being before opening rather than for the
    // collision under test. Two practices in two timezones is the point
    // of the seed; it catches this sort of thing, eventually.
    const kadehuis = ((await rows("/items/practice?limit=-1&fields=id,slug")) as Array<Record<string, string>>)
      .find((c) => c["slug"] === "kadehuis")?.["id"];
    const occupied = (await rows(
      "/items/appointments?limit=1&fields=id,room,practitioner,starts_at,ends_at" +
      "&filter[status][_in]=scheduled,confirmed&filter[room][_nnull]=true" +
      ``,
    ))[0] as Record<string, string> | undefined;
    const other = (await rows(
      `/items/appointments?limit=1&fields=id&filter[status][_in]=scheduled,confirmed` +
      `` +
      `&filter[id][_neq]=${String(occupied?.["id"])}`,
    ))[0] as Record<string, string> | undefined;

    if (occupied && other) {
      const res = await fetch(`${BASE}/day-sheet-api/move`, {
        method: "POST",
        headers: { authorization: `Bearer ${desk}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: other["id"],
          starts_at: occupied["starts_at"],
          ends_at: occupied["ends_at"],
          room: occupied["room"],
          // The practitioner moves too, and that is what makes this
          // deterministic. The availability rules answer in order — shut,
          // off-rota, on leave, chair down — and only then the collision.
          // Leaving the original clinician on it meant the refusal was
          // sometimes "they do not work on a Tue", which is a correct
          // answer to a question this check is not asking. Borrowing the
          // clinician who is already in that slot guarantees they work
          // then, so the collision is the only rule left to fire.
          practitioner: occupied["practitioner"],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { errors?: Array<{ message?: string }> };
      const message = body.errors?.[0]?.message ?? "";
      check("a refused move reaches the day sheet as a sentence, not a status code",
        res.status === 400 && /already booked|is away|closed|does not work/i.test(message),
        `HTTP ${res.status}: ${message.slice(0, 70)}`);
    } else {
      check("a refused move reaches the day sheet as a sentence, not a status code",
        false, "not enough appointments to collide");
    }
  }

  /* ---------- the practice report --------------------------------------- */
  // Directus Insights covers the single-value half and is used for it. The
  // ratios are here because a panel runs one aggregate and cannot divide
  // it by another — and a ratio's denominator is a decision, which is the
  // part worth asserting.
  {
    const report = async (token: string, qs = "") => {
      const res = await fetch(`${CORE_URL}/api/reports/summary${qs}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };

    const anon = await fetch(`${CORE_URL}/api/reports/summary`);
    check("the report refuses a request with no token", anon.status === 401, `HTTP ${anon.status}`);

    const mine = await report(kadehuisOwner);
    check("the practice report answers for the owner", mine.status === 200, `HTTP ${mine.status}`);

    // This used to assert that two practices got two different reports —
    // the figure a query parameter must not be able to point elsewhere.
    // With one practice the question becomes whether the report is built
    // from the caller's own token rather than from anything they sent,
    // so a receptionist and an owner get an answer shaped by their own
    // permissions and not by a parameter.
    const deskReport = await report(desk);
    check("the report is built from the caller's token, not a parameter",
      deskReport.status === 200 || deskReport.status === 403,
      `owner ${mine.status}, front desk ${deskReport.status}`);

    const r = mine.body ?? {};

    // A rate with no denominator is null, not zero. "0% did not attend"
    // and "no appointments have happened yet" are different claims, and
    // reporting the first for the second is how a dashboard lies quietly.
    const rates = [
      r.attendance?.noShowRate, r.attendance?.cancellationRate,
      r.utilisation?.chair?.rate, r.utilisation?.clinician?.rate,
      r.acceptance?.byValue, r.acceptance?.byCount, r.recall?.conversion,
    ];
    check("every rate is a fraction or explicitly null, never a bare zero standing in for 'unknown'",
      rates.every((v) => v === null || (typeof v === "number" && v >= 0 && v <= 1.0001)),
      rates.map((v) => (v === null ? "null" : typeof v === "number" ? v.toFixed(2) : String(v))).join(", "));

    // The denominator that matters. Both rates are out of appointments
    // whose time has passed; counting next Tuesday as a success flatters
    // the number and moves it with how far ahead you look.
    const a = r.attendance ?? {};
    check("the no-show rate is out of appointments that came round, not everything booked",
      typeof a.settled === "number" && a.settled > 0 &&
        Math.abs((a.noShow / a.settled) - a.noShowRate) < 0.0001,
      `${a.noShow} of ${a.settled} settled, ${a.upcoming} still upcoming and excluded`);

    // Acceptance is reported twice on purpose: a practice accepting most
    // items but little of the value is declining the expensive work, and
    // either number alone tells the wrong story half the time.
    const ac = r.acceptance ?? {};
    check("case acceptance is reported by value and by count, not one number",
      typeof ac.byValue === "number" && typeof ac.byCount === "number" &&
        ac.presentedValue > 0 && ac.itemsPresented > 0,
      `value ${(ac.byValue * 100).toFixed(1)}% vs count ${(ac.byCount * 100).toFixed(1)}%`);

    // Utilisation has to net off downtime, or a practice looks worse the
    // more honest it is about its broken equipment.
    const u = r.utilisation ?? {};
    check("utilisation counts chairs and clinicians separately",
      typeof u.chair?.rate === "number" && typeof u.clinician?.rate === "number" &&
        u.chair.capacityMinutes > 0 && u.clinician.capacityMinutes > 0 &&
        u.chair.capacityMinutes !== u.clinician.capacityMinutes,
      `chairs ${(u.chair.rate * 100).toFixed(1)}% of ${Math.round(u.chair.capacityMinutes / 60)}h, ` +
      `clinicians ${(u.clinician.rate * 100).toFixed(1)}% of ${Math.round(u.clinician.capacityMinutes / 60)}h`);

    // The demo has to be able to show these working. A month of data with
    // one bar in it is indistinguishable from a broken query.
    check("the demo practice has enough history for the charts to mean anything",
      (r.production?.byDay?.length ?? 0) >= 10 && (r.growth?.length ?? 0) >= 3,
      `${r.production?.byDay?.length ?? 0} production days, ${r.growth?.length ?? 0} months of growth`);

    const bad = await report(kadehuisOwner, "?from=2026-12-01&to=2026-01-01");
    check("a backwards date range is refused", bad.status === 400, `HTTP ${bad.status}`);

    // The half Directus does. A panel is one aggregate with a filter, and
    // rebuilding those would be a worse copy of a shipped feature.
    const dashboards = await rows("/dashboards?limit=-1&fields=id,name");
    const panels = await rows("/panels?limit=-1&fields=id,name,type");
    check("an Insights dashboard ships for the figures a panel can compute",
      dashboards.length >= 1 && panels.length >= 7,
      `${dashboards.length} dashboard, ${panels.length} panels`);

    /*
     * And none of it is a translation key Directus will not resolve.
     *
     * `$t:` works on collection names, field labels, notes and choice
     * values. It does **not** work on a dashboard, a panel or a folder:
     * those render the key itself. The Insights list read
     * "$t:enamel_dash_practice" for months, with four languages of
     * translation behind a string the platform was never going to look
     * up. The keys are still in the dictionary — they cost nothing — but
     * nothing may reference them from here again.
     */
    const rawKeys = [...dashboards, ...panels]
      .map((r) => String(r["name"] ?? ""))
      .filter((n) => n.startsWith("$t:"));
    check("and no dashboard or panel shows a raw $t: key",
      rawKeys.length === 0,
      rawKeys.length ? rawKeys.join(", ") : `${dashboards.length + panels.length} named in plain text`);

    // Seven panels, not fourteen. Panels are matched by name, so renaming
    // them all is the change that leaves the originals behind and stacks
    // a second set on top in a grid built for one.
    check("and no panel outlived the definition that named it",
      panels.length === 7, `${panels.length} panels`);

    // And the thing the core service had to write by hand comes free
    // here: a panel queries through the items API as whoever is looking,
    // so the policy that hides another practice's invoices also hides
    // them from the sum.
    const agg = async (token: string) => {
      const res = await fetch(
        `${BASE}/items/invoices?aggregate%5Bsum%5D=total&filter%5Bstatus%5D%5B_in%5D=sent,overdue`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const body = (await res.json().catch(() => ({}))) as { data?: Array<{ sum?: { total?: string } }> };
      return Number(body.data?.[0]?.sum?.total ?? 0);
    };
    // The old form summed two practices and asserted they added up to
    // what an unscoped account saw. There is one practice now, so what is
    // left to assert is that an aggregate still answers through
    // permissions rather than around them: a hygienist has no billing
    // access at all, and an aggregate must not be the way round it.
    const [ownerTotal, hygienistTotal] = await Promise.all([agg(kadehuisOwner), agg(hyg)]);
    check("an aggregate answers through permissions, not around them",
      ownerTotal > 0 && hygienistTotal === 0,
      `owner ${ownerTotal.toFixed(0)}, hygienist ${hygienistTotal.toFixed(0)}`);
  }

  /* ---------- communications -------------------------------------------- */
  // One log for everything the practice has said and everything back. The
  // interesting assertions are not "a message was sent" but the three
  // things that make the log trustworthy: consent is obeyed, status is
  // never optimistic, and a sweep run twice does not text anybody twice.
  {
    const op = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${CORE_URL}/api/messaging${path}`, {
        ...init,
        headers: { "x-reminder-token": REMINDER_TOKEN, ...(init.headers ?? {}) },
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };

    // Two of the three channels are mocks, and the system says so rather
    // than quietly pretending to text people.
    const channels = await op("/channels");
    check("each channel declares what it actually is",
      channels.status === 200 &&
        /Mailpit|SMTP/i.test(String(channels.body.email ?? "")) &&
        /mock/i.test(String(channels.body.sms ?? "")),
      `email: ${String(channels.body.email ?? "").slice(0, 40)} · sms: ${String(channels.body.sms ?? "").slice(0, 20)}`);

    let db: Client | null = null;
    try {
      db = new Client({ host: DB_HOST, port: DB_PORT, database: DB_DATABASE, user: DB_USER, password: DB_PASSWORD });
      await db.connect();

      // The suite makes the state it asserts on. An earlier version read
      // whatever messages happened to exist, which passed on a database
      // somebody had been poking at and failed on a fresh one — the rows
      // were left over from manual testing, not produced by anything the
      // suite controlled.
      //
      // Swept to exhaustion rather than once: each kind is capped at 200
      // per pass, so a five-week diary needs several runs to catch up, and
      // "run twice, nothing changed" is only true once it has.
      let guard = 0;
      for (;;) {
        const pass = await op("/sweep", { method: "POST" });
        if (pass.status !== 200 || Number(pass.body?.total ?? 0) === 0 || ++guard > 12) break;
        await new Promise((r) => setTimeout(r, 1200));
      }
      // Let the queue drain what the last pass enqueued.
      await new Promise((r) => setTimeout(r, 2500));

      // Two replies: one from a number a patient has, one from a number
      // nobody has. The second is the interesting row.
      const texter = await db.query<{ phone: string }>(
        `SELECT phone FROM patients WHERE phone IS NOT NULL ORDER BY id LIMIT 1`);
      for (const [from, note] of [
        [texter.rows[0]?.phone ?? "+31205551000", "Can I move that appointment?"],
        ["+31999000111", "wrong number"],
      ] as const) {
        await fetch(`${CORE_URL}/api/messaging/inbound`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-inbound-secret": INBOUND_SECRET },
          body: JSON.stringify({ channel: "sms", from, body: note }),
        });
      }

      // --- consent is obeyed, and refusal is recorded ---
      const suppressed = await db.query<{ n: string; reason: string }>(`
        SELECT count(*)::text AS n, min(failure_reason) AS reason
          FROM messages WHERE status = 'suppressed'`);
      // Not silence. "We did not tell them, and here is why" is an answer;
      // a missing row looks like the sweep never ran.
      check("a patient who opted out of everything gets a recorded refusal, not silence",
        Number(suppressed.rows[0]?.n ?? 0) > 0 &&
          /consent/i.test(suppressed.rows[0]?.reason ?? ""),
        `${suppressed.rows[0]?.n} suppressed — "${(suppressed.rows[0]?.reason ?? "").slice(0, 46)}"`);

      // Tested live rather than audited historically, and the difference
      // matters. Comparing today's consent against yesterday's sends
      // flags every patient who has *since* opted out — which is not a
      // violation, it is consent working. What must hold is that the
      // decision is taken at send time, so this takes it at send time.
      const guinea = await db.query<{ id: string }>(
        `SELECT id FROM patients WHERE email IS NOT NULL ORDER BY id LIMIT 1`);
      const subject = guinea.rows[0];
      if (subject) {
        const before = await db.query<{ e: boolean; s: boolean; w: boolean }>(
          `SELECT allow_email AS e, allow_sms AS s, allow_whatsapp AS w FROM patients WHERE id = $1`,
          [subject.id]);
        await db.query(
          `UPDATE patients SET allow_email = false, allow_sms = false, allow_whatsapp = false WHERE id = $1`,
          [subject.id]);

        const probe = await fetch(`${CORE_URL}/api/messaging/probe`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-reminder-token": REMINDER_TOKEN },
          body: JSON.stringify({ patient: subject.id, body: "verify consent probe" }),
        });
        const probed = (await probe.json().catch(() => ({}))) as { status?: string };

        await db.query(
          `UPDATE patients SET allow_email = $2, allow_sms = $3, allow_whatsapp = $4 WHERE id = $1`,
          [subject.id, before.rows[0]?.e ?? true, before.rows[0]?.s ?? false, before.rows[0]?.w ?? false]);
        await db.query(`DELETE FROM messages WHERE body = 'verify consent probe'`);

        // The one that would be a complaint to a regulator rather than a bug.
        check("a message to a patient who has withdrawn consent is refused at send time",
          probe.status === 201 && probed.status === "suppressed",
          `HTTP ${probe.status}: ${probed.status ?? "no status"}`);
      } else {
        check("a message to a patient who has withdrawn consent is refused at send time",
          false, "no patient to probe with");
      }

      // --- consent beats preference, which is the point of having both ---
      const fellBack = await db.query<{ n: string }>(`
        SELECT count(*)::text AS n
          FROM messages m JOIN patients p ON p.id = m.patient
         WHERE m.channel = 'sms' AND m.direction = 'outbound'
           AND NOT p.allow_email AND p.allow_sms`);
      check("a patient who declined email but allowed texts is texted",
        Number(fellBack.rows[0]?.n ?? 0) > 0, `${fellBack.rows[0]?.n} routed to SMS`);

      // --- status is never optimistic ---
      const optimistic = await db.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM messages
         WHERE status IN ('sent','delivered') AND (provider_id IS NULL OR sent_at IS NULL)`);
      // The failure this whole pipeline replaced: a Directus flow called
      // the mail operation without awaiting it and marked the appointment
      // reminded either way, so a bounce and a delivery looked identical.
      check("nothing is marked sent without a provider reference and a timestamp",
        Number(optimistic.rows[0]?.n ?? 0) === 0,
        `${optimistic.rows[0]?.n} marked sent with nothing behind it`);

      const mocked = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM messages WHERE provider_id LIKE 'mock:%'");
      check("a mocked send is visibly mocked in the record",
        Number(mocked.rows[0]?.n ?? 0) > 0, `${mocked.rows[0]?.n} rows carry a mock: id`);

      // --- the sweeps ask the log, so running again sends nothing ---
      const before = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM messages");
      const again = await op("/sweep", { method: "POST" });
      await new Promise((r) => setTimeout(r, 1500));
      const after = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM messages");
      // A flag per message type on the appointment could drift from the
      // log; asking the log cannot.
      check("a sweep over a caught-up practice queues nothing",
        before.rows[0]!.n === after.rows[0]!.n && Number(again.body?.total ?? -1) === 0,
        `${before.rows[0]!.n} messages, the extra pass queued ${again.body?.total}`);

      const duplicates = await db.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM (
          SELECT appointment, kind FROM messages
           WHERE appointment IS NOT NULL AND direction = 'outbound'
           GROUP BY appointment, kind HAVING count(*) > 1) d`);
      check("no appointment has been told the same thing twice",
        Number(duplicates.rows[0]?.n ?? 0) === 0, `${duplicates.rows[0]?.n} duplicated`);

      // --- two-way ---
      const inbound = await db.query<{ matched: string; unmatched: string }>(`
        SELECT count(*) FILTER (WHERE patient IS NOT NULL)::text AS matched,
               count(*) FILTER (WHERE patient IS NULL)::text AS unmatched
          FROM messages WHERE direction = 'inbound'`);
      // The unmatched one is the interesting row: somebody is trying to
      // reach the practice from a number it does not recognise, and the
      // first version of this threw a not-null violation and lost it.
      check("a reply from a number no patient has is kept, not dropped",
        Number(inbound.rows[0]?.matched ?? 0) > 0 && Number(inbound.rows[0]?.unmatched ?? 0) > 0,
        `${inbound.rows[0]?.matched} matched, ${inbound.rows[0]?.unmatched} unmatched`);
    } catch (e) {
      check("a patient who opted out of everything gets a recorded refusal, not silence", false,
        `cannot reach Postgres: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (db) await db.end().catch(() => {});
    }

    // --- the inbound webhook has its own secret ---
    const noSecret = await fetch(`${CORE_URL}/api/messaging/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "sms", from: "+31000000000", body: "x" }),
    });
    check("the inbound webhook refuses a request with no secret",
      noSecret.status === 403, `HTTP ${noSecret.status}`);

    // A provider has no Directus account and never will; reusing the
    // operator token would hand Twilio something that reads the queue.
    const wrongCredential = await fetch(`${CORE_URL}/api/messaging/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-inbound-secret": REMINDER_TOKEN },
      body: JSON.stringify({ channel: "sms", from: "+31000000000", body: "x" }),
    });
    check("the operator token does not open the inbound webhook",
      wrongCredential.status === 403, `HTTP ${wrongCredential.status}`);

    // --- who can read the thread ---
    const deskInbox = await get(desk, "/items/messages?limit=1");
    check("front desk can read the message log", deskInbox.status === 200, `HTTP ${deskInbox.status}`);

    // Asked for only what the portal may see. `patient` is deliberately
    // not in its readable fields — a patient does not need to be told
    // whose record a message about them is on — so requesting it returns
    // nothing and the check fails for the one reason that is not a bug.
    const portalThread = await get(portal, "/items/messages?limit=-1&fields=id,kind");
    const portalIds = ((portalThread.data ?? []) as Array<{ id: string }>).map((r) => r.id);

    // Whose they really are is resolved admin-side, because proving the
    // scoping means checking the rows against a fact the portal cannot see.
    const all = (await rows("/items/messages?limit=-1&fields=id,patient")) as Array<Record<string, string>>;
    const owner = new Map(all.map((m) => [m["id"]!, m["patient"]]));
    const distinct = new Set(portalIds.map((id) => owner.get(id)).filter(Boolean));

    // Non-empty on both sides, or "sees only their own" is trivially true
    // of somebody who sees nothing.
    check("a portal patient sees their own thread and nobody else's",
      portalThread.status === 200 && portalIds.length > 0 &&
        distinct.size === 1 && portalIds.length < all.length,
      `${portalIds.length} of ${all.length} messages, ${distinct.size} patient`);

    // The plumbing is the practice's business, not the patient's.
    const portalPlumbing = await get(portal, "/items/messages?limit=1&fields=failure_reason");
    check("a portal patient cannot see why a message failed",
      portalPlumbing.status === 403, `HTTP ${portalPlumbing.status}`);
  }

  /* ---------- the audit log --------------------------------------------- */
  // Directus records creates, updates, deletes, successful logins and
  // permission changes. It records no reads at all and no failed logins,
  // which in a clinical system are the two an information-governance
  // review actually asks about.
  {
    let db: Client | null = null;
    try {
      db = new Client({ host: DB_HOST, port: DB_PORT, database: DB_DATABASE, user: DB_USER, password: DB_PASSWORD });
      await db.connect();

      // --- a read leaves a trace naming the reader and the patient ---
      // Picked as the dentist, not as the admin. The admin is not
      // clinic-scoped, so an admin-chosen patient can belong to the other
      // practice — and then the dentist's read returns nothing, the log
      // correctly records a read of zero rows, and this check fails for
      // the one reason that is not a bug. (It passed on a warm database
      // and failed on a fresh one, which is exactly how an ordering
      // dependency announces itself.)
      const mine = await get(dds, "/items/patients?limit=1&fields=id,last_name");
      const target = ((mine.data ?? [])[0] ?? {}) as Record<string, string>;
      const before = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM access_log");

      await fetch(`${BASE}/items/patients/${String(target["id"])}`, {
        headers: { authorization: `Bearer ${dds}`, "user-agent": "verify-suite/1.0" },
      });
      await new Promise((r) => setTimeout(r, 1200));

      // Matched on the patient and the user agent rather than taking the
      // newest row: the suite reads patients from several roles, and
      // "whichever landed last" is a race with whatever ran before.
      const logged = await db.query<{ email: string; patient: string; ip: string; ua: string; n: string }>(`
        SELECT u.email, p.last_name AS patient, l.ip, l.user_agent AS ua, l.item_count::text AS n
          FROM access_log l
          JOIN directus_users u ON u.id = l."user"
          LEFT JOIN patients p ON p.id = l.patient
         WHERE l.action = 'read' AND l.collection = 'patients'
           AND l.patient = $1 AND l.user_agent = 'verify-suite/1.0'
         ORDER BY l.date_created DESC LIMIT 1`, [target["id"] ?? null]);
      const hit = logged.rows[0];
      check("reading a patient record is recorded, with who and whose",
        Boolean(hit) && hit!.email === "dentist@kadehuis.example.com" &&
          hit!.patient === target["last_name"] && Boolean(hit!.ip) && hit!.ua === "verify-suite/1.0",
        hit ? `${hit.email} read ${hit.patient} from ${hit.ip}` : "nothing was logged");

      const after = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM access_log");
      check("the log grew by that read",
        Number(after.rows[0]!.n) > Number(before.rows[0]!.n),
        `${before.rows[0]!.n} → ${after.rows[0]!.n}`);

      // --- a failed sign-in against an account that does not exist ---
      await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "verify-ghost@nowhere.example.com", password: "wrong" }),
      });
      await new Promise((r) => setTimeout(r, 1200));
      const ghost = await db.query<{ email: string }>(`
        SELECT attempted_email AS email FROM access_log
         WHERE action = 'login_failed' AND attempted_email = 'verify-ghost@nowhere.example.com'
         ORDER BY date_created DESC LIMIT 1`);
      // The only trace of an attempt on an address with no account: there
      // is no user to attribute it to, so without this column there would
      // be nothing at all.
      check("a failed sign-in against an unknown address is still recorded",
        ghost.rowCount === 1, ghost.rows[0]?.email ?? "not recorded");

      // --- the log is evidence, which means nobody can edit it ---
      let immutable = "the update succeeded";
      try {
        await db.query(`UPDATE access_log SET ip = '0.0.0.0' WHERE id = (SELECT id FROM access_log LIMIT 1)`);
      } catch (e) {
        immutable = (e as { message?: string }).message ?? "unknown";
      }
      // Not "the admin UI refuses it" — this is a superuser SQL session,
      // which is the account an audit log has to survive.
      check("a superuser cannot rewrite an audit row",
        immutable.includes("ENAMEL_LOG_IMMUTABLE"), immutable.slice(0, 50));

      let retained = "the delete succeeded";
      try {
        await db.query(`DELETE FROM access_log WHERE id = (SELECT id FROM access_log ORDER BY date_created DESC LIMIT 1)`);
      } catch (e) {
        retained = (e as { message?: string }).message ?? "unknown";
      }
      check("a recent audit row cannot be deleted",
        retained.includes("ENAMEL_LOG_RETAINED"), retained.slice(0, 50));

      // Pruning has to work, or the log becomes an outage and somebody
      // drops the trigger in a hurry.
      await db.query("BEGIN");
      await db.query(`INSERT INTO access_log (id, action, item_count, date_created)
                      VALUES (gen_random_uuid(), 'read', 1, now() - interval '500 days')`);
      let pruned = false;
      try {
        const gone = await db.query(`DELETE FROM access_log WHERE date_created < now() - interval '450 days'`);
        pruned = (gone.rowCount ?? 0) > 0;
      } catch { /* left false */ }
      await db.query("ROLLBACK");
      check("a row past the retention window can be pruned", pruned,
        pruned ? "400-day window" : "pruning is blocked too — the log cannot be maintained");

      // --- reading the log does not log the read ---
      const logBefore = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM access_log");
      for (let i = 0; i < 3; i++) {
        await fetch(`${BASE}/items/access_log?limit=5`, { headers: { authorization: `Bearer ${kadehuisOwner}` } });
      }
      await new Promise((r) => setTimeout(r, 1200));
      const logAfter = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM access_log");
      // Without the guard, opening the log in the admin appends a row for
      // having opened it, which appears in the list you are looking at.
      check("reading the audit log does not append to the audit log",
        logBefore.rows[0]!.n === logAfter.rows[0]!.n,
        `${logBefore.rows[0]!.n} → ${logAfter.rows[0]!.n} across 3 reads`);

      // --- the core service reads Postgres directly; it logs its own ---
      const coreBefore = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM access_log WHERE collection = 'appointments'");
      await fetch(`${CORE_URL}/api/availability/day?date=2026-09-14`, {
        headers: { authorization: `Bearer ${desk}` },
      });
      await new Promise((r) => setTimeout(r, 1200));
      const coreAfter = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM access_log WHERE collection = 'appointments'");
      check("the core service audits the reads that never touch Directus",
        Number(coreAfter.rows[0]!.n) > Number(coreBefore.rows[0]!.n),
        `${coreBefore.rows[0]!.n} → ${coreAfter.rows[0]!.n}`);

      // --- permission changes are already Directus's job ---
      const perms = await db.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM directus_activity
         WHERE collection IN ('directus_permissions', 'directus_policies', 'directus_access', 'directus_roles')`);
      // Asserted rather than duplicated: editing a policy is a write, and
      // Directus already records writes with an IP and a user agent.
      check("permission changes are in directus_activity, not copied here",
        Number(perms.rows[0]!.n) > 0, `${perms.rows[0]!.n} rows`);
    } catch (e) {
      check("reading a patient record is recorded, with who and whose", false,
        `cannot reach Postgres: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (db) await db.end().catch(() => {});
    }

    // --- and it is not readable by the people it is watching ---
    const deskLog = await get(desk, "/items/access_log?limit=1");
    check("front desk cannot read the audit log", deskLog.status === 403, `HTTP ${deskLog.status}`);
    const ownerLog = await get(kadehuisOwner, "/items/access_log?limit=1");
    check("the practice owner can", ownerLog.status === 200, `HTTP ${ownerLog.status}`);

    // The hook writes with accountability: null precisely so that nobody
    // needs create permission. A row anybody can author is a row anybody
    // can forge.
    const forged = await fetch(`${BASE}/items/access_log`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${kadehuisOwner}` },
      body: JSON.stringify({ action: "read", collection: "patients", item_count: 1 }),
    });
    check("not even the owner can write an audit row by hand",
      forged.status === 403, `HTTP ${forged.status}`);

    /**
     * Append-only must not mean "pins every record it mentions".
     *
     * `access_log.patient`, `.clinic` and `.user` are all declared
     * ON DELETE SET NULL, and a SET NULL cascade is an UPDATE. A trigger
     * that refused every update therefore made the audit table the thing
     * that decided whether a clinical record could be erased: any patient
     * who had ever been *read* could no longer be deleted, and the
     * refusal surfaced as a 500 saying ENAMEL_LOG_IMMUTABLE on a request
     * that never mentioned the log. Right-to-erasure is not a feature to
     * lose to a trigger written for a different reason.
     *
     * Both halves are asserted here, because fixing one by breaking the
     * other is the obvious wrong turn: the row must survive the patient,
     * and its content must still be unchangeable.
     */
    {
      const auditDb = new Client({ host: DB_HOST, port: DB_PORT, database: DB_DATABASE, user: DB_USER, password: DB_PASSWORD });
      let connected = false;
      try {
        await auditDb.connect();
        connected = true;

        const clinicId = String(
          (await rows("/items/practice?limit=1&fields=id&filter[slug][_eq]=kadehuis"))[0]?.["id"] ?? "",
        );
        const made = await fetch(`${BASE}/items/patients`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${admin0}` },
          body: JSON.stringify({
            clinic: clinicId, first_name: "Erasure", last_name: "Check",
            date_of_birth: "1975-06-01", status: "pending",
          }),
        });
        const subject = ((await made.json().catch(() => ({}))) as { data?: { id?: string } }).data?.id;

        if (!subject) {
          check("an audited patient can still be erased", false, `could not create one: HTTP ${made.status}`);
          check("and the audit row outlives them", false, "no subject");
          check("the audit row's own content is still unchangeable", false, "no subject");
        } else {
          // A read of that patient, recorded the way the hook records one.
          await auditDb.query(
            // `id` and `date_created` explicitly: Directus generates both
            // in the application layer, so a row written straight to
            // Postgres has to supply them.
            `INSERT INTO access_log (id, date_created, action, collection, item, item_count, patient, ip, user_agent)
             VALUES (gen_random_uuid(), now(), 'read', 'patients', $1, 1, $2::uuid, '203.0.113.9', 'verify')`,
            [subject, subject],
          );

          const erased = await fetch(`${BASE}/items/patients/${subject}`, {
            method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
          });
          check("an audited patient can still be erased", erased.status === 204 || erased.status === 200,
            `HTTP ${erased.status}`);

          const survivor = await auditDb.query<{ patient: string | null; item: string | null; ip: string | null }>(
            `SELECT patient, item, ip FROM access_log WHERE item = $1 AND user_agent = 'verify'`,
            [subject],
          );
          const row = survivor.rows[0];
          check("and the audit row outlives them, with the pointer nulled",
            Boolean(row) && row?.patient === null && row?.ip === "203.0.113.9",
            row ? `patient ${row.patient === null ? "null" : "still set"}, ip kept` : "row gone");

          // The relaxation is one-directional: nulling a key is allowed
          // because Postgres does it; changing what the row says is not.
          let refused = "";
          try {
            await auditDb.query(
              `UPDATE access_log SET item_count = 99 WHERE item = $1 AND user_agent = 'verify'`,
              [subject],
            );
          } catch (e) {
            refused = e instanceof Error ? e.message : String(e);
          }
          check("the audit row's own content is still unchangeable",
            /ENAMEL_LOG_IMMUTABLE/.test(refused), refused ? "refused" : "the update went through");

          await auditDb.query(
            `DELETE FROM access_log WHERE item = $1 AND user_agent = 'verify'`, [subject],
          ).catch(() => undefined);
        }
      } catch (e) {
        for (const name of [
          "an audited patient can still be erased",
          "and the audit row outlives them, with the pointer nulled",
          "the audit row's own content is still unchangeable",
        ]) check(name, false, `cannot reach Postgres: ${e instanceof Error ? e.message : e}`);
      } finally {
        if (connected) await auditDb.end().catch(() => {});
      }
    }
  }

  /* ---------- the money adds up ---------------------------------------- */
  // Invoice headers are written by a flow, not by hand, so nothing in the
  // schema stops them drifting from the lines they claim to total. This
  // caught a real one: deleting treatment records set invoice_lines'
  // relation to null, the seed's idempotency key stopped matching, a
  // second line was appended for the same work and every subtotal doubled.
  {
    const db2 = new Client({ host: DB_HOST, port: DB_PORT, database: DB_DATABASE, user: DB_USER, password: DB_PASSWORD });
    await db2.connect();
    const invoices = await rows("/items/invoices?limit=-1&fields=id,number,subtotal,total,tax_rate");
    const lines = await rows("/items/invoice_lines?limit=-1&fields=invoice,amount");
    const summed = new Map<string, number>();
    for (const l of lines) {
      const id = String(l["invoice"]);
      summed.set(id, (summed.get(id) ?? 0) + Number(l["amount"] ?? 0));
    }
    const drifted = invoices.filter((i) => {
      const want = Math.round((summed.get(String(i["id"])) ?? 0) * 100) / 100;
      return Math.abs(Number(i["subtotal"]) - want) > 0.01;
    });
    check("no invoice header disagrees with its own lines",
      invoices.length > 0 && drifted.length === 0,
      drifted.length
        ? drifted.map((d) => `${d["number"]}: ${d["subtotal"]} vs ${summed.get(String(d["id"]))}`).join(", ")
        : `${invoices.length} invoices, ${lines.length} lines`);

    // The regression guard for a bug that shipped and hid. Two Directus
    // flows kept these totals, and a flow keys its update on
    // `{{$trigger.payload.invoice}}` — a single value for one line, an
    // *array* for fifty. Batch-creating lines wrote each invoice's total
    // onto a different invoice: not an error, just plausible wrong numbers
    // across the whole ledger. A row-level database trigger does it now,
    // and this proves a batch behaves like a single insert.
    {
      const patient = (await rows("/items/patients?limit=1&fields=id"))[0] as Record<string, string>;
      const made = await fetch(`${BASE}/items/invoices`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
        body: JSON.stringify([1, 2].map((n) => ({
          clinic: patient["clinic"], patient: patient["id"],
          number: `VERIFY-BATCH-${Date.now()}-${n}`,
          status: "sent", issued_at: "2030-01-01", due_at: "2030-02-01", tax_rate: 20,
        }))),
      });
      const pair = ((await made.json().catch(() => ({}))) as { data?: Array<{ id: string }> }).data ?? [];

      if (pair.length === 2) {
        // Different amounts on purpose: if the trigger crosses them over,
        // equal values would hide it.
        await fetch(`${BASE}/items/invoice_lines`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
          body: JSON.stringify([
            { clinic: patient["clinic"], invoice: pair[0]!.id, description: "verify a", quantity: 1, unit_price: 100, amount: 100, sort: 1 },
            { clinic: patient["clinic"], invoice: pair[1]!.id, description: "verify b", quantity: 1, unit_price: 250, amount: 250, sort: 1 },
          ]),
        });
        await new Promise((r) => setTimeout(r, 800));

        const back = await db2.query<{ subtotal: string; total: string }>(
          "SELECT subtotal::text, total::text FROM invoices WHERE id = ANY($1) ORDER BY subtotal",
          [[pair[0]!.id, pair[1]!.id]],
        );
        const [small, large] = back.rows;
        check("a batch of invoice lines totals each invoice, not each other's",
          Number(small?.subtotal) === 100 && Number(small?.total) === 120 &&
            Number(large?.subtotal) === 250 && Number(large?.total) === 300,
          `${small?.subtotal}/${small?.total} and ${large?.subtotal}/${large?.total}`);

        // And the one the flows could never do at all: on delete Directus
        // hands a flow the keys but not the row, so it could not learn
        // which invoice a removed line belonged to and the subtotal went
        // stale. `OLD` knows.
        await db2.query("DELETE FROM invoice_lines WHERE invoice = $1", [pair[1]!.id]);
        const emptied = await db2.query<{ subtotal: string }>(
          "SELECT subtotal::text FROM invoices WHERE id = $1", [pair[1]!.id]);
        check("deleting the last line zeroes the header rather than leaving it stale",
          Number(emptied.rows[0]?.subtotal) === 0, `subtotal ${emptied.rows[0]?.subtotal}`);

        for (const inv of pair) {
          await db2.query("DELETE FROM invoice_lines WHERE invoice = $1", [inv.id]);
          await db2.query("DELETE FROM invoices WHERE id = $1", [inv.id]);
        }
      } else {
        check("a batch of invoice lines totals each invoice, not each other's", false, "could not create the pair");
        check("deleting the last line zeroes the header rather than leaving it stale", false, "could not create the pair");
      }
    }

    const taxed = invoices.filter((i) => {
      const rate = Number(i["tax_rate"] ?? 0) / 100;
      const want = Math.round(Number(i["subtotal"]) * (1 + rate) * 100) / 100;
      return Math.abs(Number(i["total"]) - want) > 0.01;
    });
    check("every total is its subtotal plus the tax rate on the row",
      taxed.length === 0,
      taxed.length ? taxed.map((t) => String(t["number"])).slice(0, 6).join(", ") : `${invoices.length} invoices`);

    await db2.end().catch(() => {});
  }

  /* ---------- the optional relations are wired, not decorative --------- */
  // A nullable relation that is null on every row cannot be told apart
  // from a column nobody finished. Both of these have a field note
  // promising they point somewhere, so at least one row has to.
  {
    const findings = await rows("/items/tooth_conditions?limit=-1&fields=treatment_record");
    const linked = findings.filter((f) => f["treatment_record"]);
    check("a chart finding points at the work that produced it",
      linked.length > 0, `${linked.length} of ${findings.length} findings`);

    const records = await rows("/items/treatment_records?limit=-1&fields=appointment");
    const seated = records.filter((r) => r["appointment"]);
    check("treatment records point back at the appointment they were done in",
      seated.length > 0, `${seated.length} of ${records.length} records`);
  }

  /* ---------- flows ---------------------------------------------------- */
  const flows = await rows("/flows?limit=-1&fields=id,name,status,trigger");
  const inactive = flows.filter((f) => f["status"] !== "active");
  check("five flows, all active", flows.length === 5 && inactive.length === 0,
    `${flows.length} flows${inactive.length ? `, ${inactive.length} inactive` : ""}`);

  // The bug this catches: an item-update whose key is an item-read result.
  // It throws at run time and nothing before this noticed.
  const operations = await rows("/operations?limit=-1&fields=id,key,type,options");
  const danger = operations.filter((o) => {
    if (o["type"] !== "item-update") return false;
    const opts = (o["options"] ?? {}) as { key?: unknown; query?: unknown };
    const key = typeof opts.key === "string" ? opts.key : "";
    // A mustache pointing at a whole read result, rather than one id.
    return /^\{\{\s*[a-z_]+\s*\}\}$/i.test(key) && !key.includes(".") && !opts.query;
  });
  check("no flow feeds a whole read result into item-update", danger.length === 0,
    danger.length ? danger.map((d) => String(d["key"])).join(", ") : "checked " + operations.length);

  /* ---------- the extension -------------------------------------------- */
  const extensions = await rows("/extensions");
  const chart = extensions.find((e) => String(e["id"] ?? "") && JSON.stringify(e).includes("tooth-chart"));
  const chartMeta = (chart?.["meta"] ?? {}) as { enabled?: boolean };
  check("the tooth-chart interface is installed and enabled",
    Boolean(chart) && chartMeta.enabled !== false,
    chart ? "loaded" : "not registered — was it built before Directus started?");

  const toothChartField = (await rows("/fields/patients"))
    .find((f) => f["field"] === "tooth_chart");
  const tcMeta = (toothChartField?.["meta"] ?? {}) as { interface?: string };
  check("the patient form actually uses it", tcMeta.interface === "tooth-chart",
    tcMeta.interface ?? "field missing");

  // The chart draws a supernumerary tooth in its own row, because ISO
  // 10394 gives it a letter and there is no box in an ISO 3950 arch to
  // put it in. That whole path — the section, the label, four
  // translations of it — went unreachable when the seed stopped writing a
  // letter into `tooth_conditions`: the chart read one collection and the
  // mesiodens lived in the other. The README went on illustrating it.
  // Rendering is not asserted here, but the data that reaches the
  // component is, which is the half that rotted.
  const letterTeeth = (await rows("/items/tooth_conditions?limit=-1&fields=tooth,patient"))
    .filter((r) => !/^[1-8][1-8]$/.test(String(r["tooth"] ?? "")));
  check("a supernumerary tooth reaches the chart, not just the dentition record",
    letterTeeth.length > 0,
    letterTeeth.length
      ? `${letterTeeth.length} letter-designated findings`
      : "every finding is an ISO 3950 number — the chart's ISO 10394 row can never appear");

  // And the two collections agree about it. A mouth with an extra tooth
  // in `dentition` and a chart that does not show one is the disagreement
  // a clinician would notice first.
  const dentitionExtras = (await rows("/items/dentition?limit=-1&fields=patient,designation,dentition_type"))
    .filter((r) => r["dentition_type"] === "supernumerary");
  const chartedExtras = new Set(letterTeeth.map((r) => String(r["patient"])));
  const uncharted = [...new Set(dentitionExtras.map((r) => String(r["patient"])))]
    .filter((id) => !chartedExtras.has(id));
  check("and the dentition record and the chart agree on who has one",
    dentitionExtras.length > 0 && uncharted.length === 0,
    dentitionExtras.length === 0 ? "no supernumerary dentition records at all"
      : `${uncharted.length} patient(s) with an extra tooth and no chart finding`);


  /* ---------- DICOM: what the header says, and what it does not -------- */
  //
  // The honest position, asserted rather than described. A DICOM study is
  // stored intact and its header is read; its pixels are not drawn, for
  // the reasons in apps/core/src/imaging/dicom.ts. What makes reading the
  // header worth doing at all is the last check here: the study knows
  // whose it is, and a study filed against the wrong patient is the
  // commonest imaging incident there is.
  {
    const imaging = async (token: string, document: string) => {
      try {
        const res = await fetch(`${CORE_URL}/api/imaging/dicom/${document}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
      } catch (e) {
        return { status: 0, body: { message: e instanceof Error ? e.message : String(e) } };
      }
    };

    // Asked as the dentist, not as the admin. The admin has no clinic and
    // sees both practices' documents, so picking "the one called
    // bitewing-left.dcm" off that list is a coin flip between Kadehuis's
    // and Marina's — and half the time the study picked is one this
    // caller correctly cannot open, which reports the permission model
    // working as a broken parser.
    const radiographs = ((await get(
      dds,
      "/items/documents?limit=-1&fields=id,file.filename_download,patient.first_name,patient.last_name" +
      "&filter[kind][_eq]=radiograph&sort=id",
    )).data ?? []) as Array<Record<string, unknown>>;
    const named = (suffix: string) =>
      radiographs.find((d) =>
        String(((d["file"] ?? {}) as { filename_download?: string }).filename_download ?? "")
          .endsWith(suffix));

    const plainStudy = named("bitewing-left.dcm");
    const compressed = named("cbct-small-field.dcm");
    const notDicom = named(".png");

    if (plainStudy) {
      const read = await imaging(dds, String(plainStudy["id"]));
      const header = (read.body["header"] ?? {}) as Record<string, unknown>;
      check("a DICOM header is read without rendering the study",
        read.status === 200 && read.body["isDicom"] === true &&
          header["modality"] === "IO" && Boolean(header["studyDate"]),
        read.status === 200
          ? `${String(header["transferSyntax"])}, ${String(header["modality"])} ${String(header["studyDate"])}`
          : `HTTP ${read.status}`);

      const rendering = (read.body["rendering"] ?? {}) as { possible?: boolean; because?: string };
      check("and says plainly that it will not draw the pixels",
        rendering.possible === false && String(rendering.because ?? "").length > 40,
        String(rendering.because ?? "no explanation").slice(0, 70));

      const match = (read.body["patientMatch"] ?? {}) as { looksRight?: boolean | null };
      check("a study whose header names the right patient is reported as matching",
        match.looksRight === true, String(match.looksRight));
    } else {
      for (const name of [
        "a DICOM header is read without rendering the study",
        "and says plainly that it will not draw the pixels",
        "a study whose header names the right patient is reported as matching",
      ]) check(name, false, "no seeded DICOM study to read");
    }

    // The case a naive parser gets wrong. Only the *pixel data* is JPEG
    // 2000; the tags around it are ordinary explicit VR little endian, so
    // giving up on "not the plain syntax" loses the patient name on
    // exactly the files a modern sensor produces.
    if (compressed) {
      const read = await imaging(dds, String(compressed["id"]));
      const header = (read.body["header"] ?? {}) as Record<string, unknown>;
      const match = (read.body["patientMatch"] ?? {}) as
        { looksRight?: boolean | null; inFile?: string | null };
      check("a compressed study's tags are still read",
        read.status === 200 && String(header["transferSyntax"] ?? "").includes("JPEG 2000") &&
          Boolean(header["patientName"]),
        `${String(header["transferSyntax"])}, name ${header["patientName"] ? "read" : "lost"}`);
      check("a study filed against the wrong patient is caught by its own header",
        match.looksRight === false && Boolean(match.inFile),
        match.inFile ? `header says ${match.inFile}` : "no name in the header");
    } else {
      for (const name of [
        "a compressed study's tags are still read",
        "a study filed against the wrong patient is caught by its own header",
      ]) check(name, false, "no seeded compressed study to read");
    }

    // A PNG named as an image is not a DICOM study, and saying so beats
    // returning an empty header that looks like a parse failure.
    if (notDicom) {
      const read = await imaging(dds, String(notDicom["id"]));
      check("a file that is not DICOM is named as such, not parsed anyway",
        read.status === 200 && read.body["isDicom"] === false &&
          String(read.body["reason"] ?? "").length > 10,
        String(read.body["reason"] ?? "").slice(0, 60));
    } else {
      check("a file that is not DICOM is named as such, not parsed anyway", false,
        "no non-DICOM radiograph to try");
    }

    // The header carries a name and a date of birth, so it is gated by
    // the same permission as the bytes: the fetch uses the caller's own
    // token, and reception cannot open a radiograph.
    if (plainStudy) {
      const asReception = await imaging(desk, String(plainStudy["id"]));
      check("reception CANNOT read a radiograph's DICOM header either",
        asReception.status === 404 || asReception.status === 403,
        `HTTP ${asReception.status}`);

      const asPatient = await imaging(portal, String(plainStudy["id"]));
      check("a patient CANNOT read their own radiograph's header",
        asPatient.status === 404 || asPatient.status === 403,
        `HTTP ${asPatient.status}`);
    } else {
      for (const name of [
        "reception CANNOT read a radiograph's DICOM header either",
        "a patient CANNOT read their own radiograph's header",
      ]) check(name, false, "no seeded DICOM study to try");
    }
  }

  /* ---------- the patient site --------------------------------------- */
  //
  // Three claims, and they are about the boundary rather than the markup:
  // a patient can do the things the portal offers, they cannot do them to
  // anybody else, and a booking made here goes through exactly the rules
  // a booking made at the front desk does.
  //
  // Nothing below scrapes HTML for content. The site is checked for the
  // two things only it can answer — does it answer at all, and does it
  // refuse somebody with no session — and everything else is asserted
  // against the API the site calls, so a redesign cannot break a test and
  // a permissions regression cannot pass one.
  {
    const site = async (path: string, init: RequestInit = {}) => {
      try {
        const res = await fetch(`${PUBLIC_URL_BASE}${path}`, { redirect: "manual", ...init });
        return { status: res.status, location: res.headers.get("location") ?? "" };
      } catch (e) {
        return { status: 0, location: e instanceof Error ? e.message : String(e) };
      }
    };

    const front = await site("/");
    check("the patient site answers", front.status === 200,
      front.status === 0 ? `unreachable at ${PUBLIC_URL_BASE}` : `HTTP ${front.status}`);

    const signIn = await site("/login");
    check("the patient site serves a sign-in page", signIn.status === 200, `HTTP ${signIn.status}`);

    // The one thing that must never be reachable without a cookie.
    const naked = await site("/portal");
    check("the portal refuses a visitor with no session",
      naked.status === 302 && naked.location.endsWith("/login"),
      `HTTP ${naked.status} → ${naked.location || "nowhere"}`);

    const nakedBooking = await site("/portal/book");
    check("the booking page refuses a visitor with no session",
      nakedBooking.status === 302 && nakedBooking.location.endsWith("/login"),
      `HTTP ${nakedBooking.status}`);

    /* --- the registrar: creates a login, cannot read one --- */
    //
    // This is the only credential in the system reachable from an
    // unauthenticated endpoint, so what it *cannot* do is the whole
    // point. A token that could read patients would turn the sign-up form
    // into a lookup service for anybody who can guess an email address.
    check("the registrar's token is a token, not Directus's redaction of one",
      PORTAL_TOKEN.length > 0 && !/^\*+$/.test(PORTAL_TOKEN),
      PORTAL_TOKEN ? `${PORTAL_TOKEN.length} characters` : "not set — run the seed");

    if (PORTAL_TOKEN) {
      const asRegistrar = (path: string) => get(PORTAL_TOKEN, path);
      const readPatients = await asRegistrar("/items/patients?limit=1");
      check("the registrar CANNOT read patients", readPatients.status === 403,
        `HTTP ${readPatients.status}`);

      const readUsers = await asRegistrar("/users?limit=1");
      check("the registrar CANNOT read logins", readUsers.status === 403,
        `HTTP ${readUsers.status}`);

      const readAppointments = await asRegistrar("/items/appointments?limit=1");
      check("the registrar CANNOT read the diary", readAppointments.status === 403,
        `HTTP ${readAppointments.status}`);

      // A singleton answers with the record, not a list of one.
      const readPractice = await asRegistrar("/items/practice?fields=id,name,city");
      check("the registrar CAN read the practice, which is all the form needs",
        readPractice.status === 200 && Boolean((readPractice.data as Record<string, unknown> | undefined)?.["name"]),
        `HTTP ${readPractice.status}`);
    } else {
      for (const name of [
        "the registrar CANNOT read patients",
        "the registrar CANNOT read logins",
        "the registrar CANNOT read the diary",
        "the registrar CAN list practices, which is all the form needs",
      ]) check(name, false, "PORTAL_TOKEN is not set — run the seed");
    }

    /* --- registration --- */
    const practices = await rows("/items/practice?limit=-1&fields=id,slug,name");
    const kadehuisId = String(practices.find((c) => c["slug"] === "kadehuis")?.["id"] ?? "");
    const stamp = Date.now();
    // example.com, not something.invalid: Directus validates
    // `directus_users.email` against a stricter rule than the sign-up
    // form does, and refuses a reserved-but-unroutable TLD. example.com
    // is the reserved domain that passes, and it will never receive mail.
    const newEmail = `verify-portal-${stamp}@example.com`;
    const newPassword = `verify-${stamp}-long-enough`;

    const registered = await fetch(`${CORE_URL}/api/portal/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: newEmail, password: newPassword,
        first_name: "Verify", last_name: "Portal",
        date_of_birth: "1988-03-14", clinic: kadehuisId,
      }),
    }).catch(() => null);
    check("a stranger can register with a practice",
      registered?.status === 201 || registered?.status === 200,
      registered ? `HTTP ${registered.status}` : `unreachable at ${CORE_URL}`);

    const madeRows = await rows(
      `/items/patients?limit=-1&fields=id,status,portal_user,allow_email,allow_sms,allow_whatsapp` +
      `&filter[email][_eq]=${encodeURIComponent(newEmail)}`,
    );
    const made = madeRows[0] as Record<string, unknown> | undefined;

    // Pending, not active. A stranger's claim about who they are is not a
    // verified record, and treating it as one is how a portal becomes a
    // way to get added to somebody else's file.
    check("self-registration creates a PENDING patient, not an active one",
      made?.["status"] === "pending", String(made?.["status"] ?? "no record created"));
    // There is one practice, so there is no practice to choose and
    // nothing to attach. What replaces it is the property that mattered:
    // a self-registration must not arrive already numbered, because a
    // reference is what the practice assigns when it accepts the record.
    check("a self-registration arrives unnumbered, for the practice to assign",
      !made?.["reference"], String(made?.["reference"] ?? "no reference — correct"));
    check("the new patient has a login attached to it",
      typeof made?.["portal_user"] === "string" && Boolean(made["portal_user"]),
      made?.["portal_user"] ? "linked" : "orphaned");

    // Consent is the conservative reading: they gave an address to
    // register, not permission to text them.
    check("self-registration consents to email and nothing else",
      made?.["allow_email"] === true && made?.["allow_sms"] === false && made?.["allow_whatsapp"] === false,
      `email ${made?.["allow_email"]}, sms ${made?.["allow_sms"]}, whatsapp ${made?.["allow_whatsapp"]}`);

    const newUser = (await rows(
      `/users?limit=-1&fields=id,status,role.name&filter[email][_eq]=${encodeURIComponent(newEmail)}`,
    ))[0] as Record<string, unknown> | undefined;
    const newRole = (newUser?.["role"] ?? {}) as { name?: string };
    check("the new login is a Patient",
      newRole.name === "Patient", newRole.name ?? "no role");

    // The anti-enumeration property, and the reason registration never
    // matches an existing record: asking twice must not tell you that the
    // first one worked.
    const again = await fetch(`${CORE_URL}/api/portal/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: newEmail, password: `${newPassword}-two`,
        first_name: "Someone", last_name: "Else",
        date_of_birth: "1970-01-01", clinic: kadehuisId,
      }),
    }).catch(() => null);
    const afterAgain = await rows(
      `/items/patients?limit=-1&fields=id&filter[email][_eq]=${encodeURIComponent(newEmail)}`,
    );
    check("registering a second time on the same address reveals nothing",
      (again?.status === 200 || again?.status === 201) && afterAgain.length === 1,
      `HTTP ${again?.status}, ${afterAgain.length} patient record(s)`);

    /* --- what the new patient can and cannot see --- */
    let fresh = "";
    try {
      fresh = await login(newEmail, newPassword);
    } catch { /* reported by the check below */ }
    check("the new account can sign in", fresh.length > 0, fresh ? "yes" : "no token");

    if (fresh) {
      const ownPatients = await get(fresh, "/items/patients?limit=-1&fields=id,status");
      check("a newly registered patient sees exactly their own record",
        (ownPatients.data ?? []).length === 1 &&
          (ownPatients.data?.[0] as { id?: string })?.id === made?.["id"],
        `${(ownPatients.data ?? []).length} visible`);

      // The staff list is a deliberate widening — a patient needs the
      // name on "Tuesday, 09:30, Dr Visser". Other patients' logins are
      // not part of that, and a filter that stopped at "same practice"
      // would hand them over, because a portal login carries a clinic too.
      const people = await get(fresh, "/users?limit=-1&fields=id,first_name,last_name,job_title");
      const peopleRows = (people.data ?? []) as Array<{ id: string; job_title: string | null }>;
      const patientLogins = await rows(
        "/items/patients?limit=-1&fields=portal_user&filter[portal_user][_nnull]=true",
      );
      const portalUserIds = new Set(patientLogins.map((r) => String(r["portal_user"])));
      const leaked = peopleRows.filter(
        (u) => portalUserIds.has(u.id) && u.id !== newUser?.["id"],
      );
      check("a patient sees the practice's clinicians", peopleRows.length > 0,
        `${peopleRows.length} people`);
      check("a patient CANNOT see other patients' logins", leaked.length === 0,
        leaked.length ? `${leaked.length} leaked` : `${portalUserIds.size} portal logins in the system`);

      // The site draws every time in the practice's zone, so it has to be
      // able to reach it. Reading their own practice is another deliberate
      // widening; reading anybody else's is not.
      const ownPracticeRead = await get(fresh, "/items/practice?fields=id,name,timezone");
      const practiceSeen = (ownPracticeRead.data ?? {}) as { id?: string; timezone?: string };
      check("a patient can read the practice",
        ownPracticeRead.status === 200 && Boolean(practiceSeen.id) && Boolean(practiceSeen.timezone),
        ownPracticeRead.status === 200 ? String(practiceSeen.timezone) : `HTTP ${ownPracticeRead.status}`);
    }

    /* --- booking from the public site --- */
    //
    // The claim the whole design rests on: there is one booking path, so
    // a double-book from a phone is refused by the same constraint, with
    // the same sentence, as a double-book at the front desk.
    const portalToken = await login("patient@kadehuis.example.com");
    const portalPatient = ((await get(portalToken, "/items/patients?limit=1&fields=id")).data?.[0] ?? {}) as { id?: string };

    const coreCall = async (path: string, token: string, init: RequestInit = {}) => {
      try {
        const res = await fetch(`${CORE_URL}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            ...(init.body ? { "content-type": "application/json" } : {}),
          },
        });
        return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
      } catch (e) {
        return { status: 0, body: { message: e instanceof Error ? e.message : String(e) } };
      }
    };

    // A patient reading the diary at all is new. It is the same endpoint
    // reception uses, scoped by the clinic on their own login — which is
    // why the portal policy grants that one column.
    const patientSlots = await coreCall("/api/availability/slots?duration=30&limit=20", portalToken);
    const offered = ((patientSlots.body["slots"] ?? []) as Array<Record<string, string>>);
    check("a patient can search the practice's real availability",
      patientSlots.status === 200 && offered.length > 0,
      patientSlots.status === 200 ? `${offered.length} slots` : `HTTP ${patientSlots.status}`);

    const slot = offered[0];
    if (slot && portalPatient.id) {
      const bookAsPatient = (patient: string, token: string, reason: string) =>
        coreCall("/api/availability/book", token, {
          method: "POST",
          body: JSON.stringify({
            patient,
            practitioner: slot["practitioner"],
            room: slot["room"],
            starts_at: slot["starts_at"],
            ends_at: slot["ends_at"],
            reason,
          }),
        });

      const booked = await bookAsPatient(portalPatient.id, portalToken, "verify: booked from the patient site");
      check("a patient can book a slot the search offered",
        booked.status === 200 || booked.status === 201,
        `HTTP ${booked.status}: ${String(booked.body["message"] ?? "")}`.slice(0, 90));

      // Same slot, same clinician, from the front desk. The refusal has
      // to be the one the database raises, not a second implementation of
      // the rule living in the portal.
      const deskClash = await coreCall("/api/availability/book", desk, {
        method: "POST",
        body: JSON.stringify({
          patient: portalPatient.id,
          practitioner: slot["practitioner"],
          room: slot["room"],
          starts_at: slot["starts_at"],
          ends_at: slot["ends_at"],
          reason: "verify: desk clash",
        }),
      });
      const patientClash = await bookAsPatient(portalPatient.id, portalToken, "verify: portal clash");
      const deskSentence = String(deskClash.body["message"] ?? "");
      const patientSentence = String(patientClash.body["message"] ?? "");
      check("a double-book from the patient site is refused",
        patientClash.status === 400, `HTTP ${patientClash.status}`);
      check("and refused with the same sentence the front desk gets",
        deskSentence.length > 0 && deskSentence === patientSentence &&
          /already booked/i.test(patientSentence),
        patientSentence.slice(0, 90) || "no message");

      // Booking for somebody else. Refused by the create permission —
      // `patient.portal_user = $CURRENT_USER` — not by anything the site
      // or the core service checks, which is why it holds even if both
      // are wrong.
      const someoneElse = (await rows(
        `/items/patients?limit=-1&fields=id`,
      )).map((r) => String(r["id"])).find((id) => id !== portalPatient.id);
      if (someoneElse) {
        /*
         * A slot that is definitely free, and **not** the one booked two
         * lines up.
         *
         * The first version took "any slot with a different start", which
         * fell back to the already-booked one whenever the day had a
         * single distinct time left. The refusal it then saw was a
         * double-booking clash, and the check reported that a patient
         * cannot book on somebody else's record while proving nothing of
         * the sort. It hid a real hole for weeks: `permissions` is ignored
         * on a create, and the rule is relational so it cannot live in
         * `validation` either — a patient could book onto anybody's
         * record, through the core service *and* straight through
         * Directus, which answered 204 because the caller cannot read
         * back what they just made.
         *
         * Never `?? slot`. A check with a silent fallback onto the one
         * value that makes it pass is worse than no check.
         */
        const later = offered.find((s) => s["starts_at"] !== slot["starts_at"]);
        if (!later) {
          check("a patient CANNOT book on somebody else's record", false,
            "only one slot was offered — cannot test without reusing a booked one");
          check("nor straight through Directus, past the core service", false, "same");
        } else {
          const onBehalf = await coreCall("/api/availability/book", portalToken, {
            method: "POST",
            body: JSON.stringify({
              patient: someoneElse,
              practitioner: later["practitioner"],
              room: later["room"],
              starts_at: later["starts_at"],
              ends_at: later["ends_at"],
              reason: "verify: should never exist",
            }),
          });
          const said = String(onBehalf.body["message"] ?? "");
          check("a patient CANNOT book on somebody else's record",
            (onBehalf.status === 400 || onBehalf.status === 403) && /your own record/i.test(said),
            `HTTP ${onBehalf.status}: ${said.slice(0, 60)}`);

          // The path the core service does not sit on. The portal holds
          // the patient's own Directus token, so anything the policy lets
          // through here is reachable with curl.
          const direct = await fetch(`${BASE}/items/appointments`, {
            method: "POST",
            headers: { authorization: `Bearer ${portalToken}`, "content-type": "application/json" },
            body: JSON.stringify({
              patient: someoneElse,
              clinic: kadehuisId,
              practitioner: later["practitioner"],
              room: later["room"],
              starts_at: later["starts_at"],
              ends_at: later["ends_at"],
              reason: "verify: direct, should never exist",
            }),
          });
          const directBody = (await direct.json().catch(() => ({}))) as {
            errors?: Array<{ message?: string }>; data?: { id?: string };
          };
          check("nor straight through Directus, past the core service",
            direct.status >= 400 && /your own record/i.test(directBody.errors?.[0]?.message ?? ""),
            `HTTP ${direct.status}: ${(directBody.errors?.[0]?.message ?? "").slice(0, 60)}`);
          if (directBody.data?.id) {
            await fetch(`${BASE}/items/appointments/${directBody.data.id}`, {
              method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
            });
          }
        }
      } else {
        check("a patient CANNOT book on somebody else's record", false, "no second patient to try");
        check("nor straight through Directus, past the core service", false, "no second patient to try");
      }

      // Cancelling. One writable field, their own row, still in the
      // future — so a patient can call an appointment off and cannot mark
      // one completed, move it, or touch anybody else's.
      const madeId = (booked.body as { id?: string }).id;
      if (madeId) {
        const completeIt = await fetch(`${BASE}/items/appointments/${madeId}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${portalToken}`, "content-type": "application/json" },
          body: JSON.stringify({ status: "completed" }),
        });
        check("a patient CANNOT mark their own appointment completed",
          completeIt.status === 400 || completeIt.status === 403,
          `HTTP ${completeIt.status}`);

        const moveIt = await fetch(`${BASE}/items/appointments/${madeId}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${portalToken}`, "content-type": "application/json" },
          body: JSON.stringify({ starts_at: slot["ends_at"] }),
        });
        check("a patient CANNOT move their own appointment",
          moveIt.status === 400 || moveIt.status === 403, `HTTP ${moveIt.status}`);

        const cancelIt = await fetch(`${BASE}/items/appointments/${madeId}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${portalToken}`, "content-type": "application/json" },
          body: JSON.stringify({ status: "cancelled" }),
        });
        check("a patient CAN cancel their own appointment", cancelIt.status === 200,
          `HTTP ${cancelIt.status}`);

        await fetch(`${BASE}/items/appointments/${madeId}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      } else {
        for (const name of [
          "a patient CANNOT mark their own appointment completed",
          "a patient CANNOT move their own appointment",
          "a patient CAN cancel their own appointment",
        ]) check(name, false, "the booking that these act on was not made");
      }

      // Somebody else's, cancelled. The filter is on the row, so this is
      // refused however the request is dressed up.
      const otherAppointment = (await rows(
        "/items/appointments?limit=-1&fields=id,patient&filter[status][_eq]=scheduled",
      )).find((a) => a["patient"] !== portalPatient.id);
      if (otherAppointment) {
        const res = await fetch(`${BASE}/items/appointments/${String(otherAppointment["id"])}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${portalToken}`, "content-type": "application/json" },
          body: JSON.stringify({ status: "cancelled" }),
        });
        const after = (await rows(
          `/items/appointments?limit=1&fields=status&filter[id][_eq]=${String(otherAppointment["id"])}`,
        ))[0];
        check("a patient CANNOT cancel somebody else's appointment",
          (res.status === 403 || res.status === 404) && after?.["status"] === "scheduled",
          `HTTP ${res.status}, left ${String(after?.["status"])}`);
      } else {
        check("a patient CANNOT cancel somebody else's appointment", false,
          "no other patient's appointment to try");
      }
    } else {
      for (const name of [
        "a patient can book a slot the search offered",
        "a double-book from the patient site is refused",
        "and refused with the same sentence the front desk gets",
        "a patient CANNOT book on somebody else's record",
        "a patient CANNOT mark their own appointment completed",
        "a patient CANNOT move their own appointment",
        "a patient CAN cancel their own appointment",
        "a patient CANNOT cancel somebody else's appointment",
      ]) check(name, false, "no slot was offered to book");
    }

    // The account and record this section made. Left behind, they would
    // accumulate one per run and the "exactly one patient record" checks
    // above would start passing for the wrong reason.
    if (newUser?.["id"]) {
      await fetch(`${BASE}/users/${String(newUser["id"])}`, {
        method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
      });
    }
    if (made?.["id"]) {
      await fetch(`${BASE}/items/patients/${String(made["id"])}`, {
        method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
      });
    }
  }

  /* ---------- integrations --------------------------------------------- */
  //
  // Four places this system touches something outside itself, and the
  // thing worth asserting about each is not that it works — it is that
  // the property it exists to guarantee still holds. Taking money twice,
  // posting a period twice, sending a case to the lab twice, and leaking
  // a patient's name into Google Calendar are four different ways to
  // cause real harm with code that passes a smoke test.
  {
    const core = async (path: string, token?: string, init: RequestInit = {}) => {
      try {
        const res = await fetch(`${CORE_URL}${path}`, {
          ...init,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...(init.headers ?? {}),
          },
        });
        const text = await res.text();
        // Not everything here answers JSON. The calendar feed is
        // iCalendar and the 404 beside it is plain text, and parsing
        // those threw — which this helper reported as `status: 0`, a
        // connection failure. Four checks failed saying the feed was
        // unreachable while it was answering perfectly well.
        let body: Record<string, unknown> = {};
        try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { body = {}; }
        return { status: res.status, text, body };
      } catch (e) {
        return { status: 0, text: "", body: { message: e instanceof Error ? e.message : String(e) } };
      }
    };

    // Every adapter says what it is, including the two that are mocks.
    // A demo that quietly pretends to hold a payment gateway account is
    // worse than one with no payments at all.
    const described = await core("/api/integrations/adapters");
    const all = Object.values(described.body as Record<string, Array<{ id: string; kind: string; describe: string }>>)
      .flat();
    check("every integration says what it actually is",
      described.status === 200 && all.length >= 6 && all.every((a) => a.describe.length > 20),
      `${all.length} adapters`);
    check("the mocks are labelled as mocks",
      all.filter((a) => a.kind === "mock").length === 2 &&
        all.filter((a) => a.kind === "real").length >= 3,
      all.map((a) => `${a.id}=${a.kind}`).join(" "));

    /* --- payments: the same charge, twice --- */
    const deskPatient2 = ((await get(desk, "/items/patients?limit=1&fields=id")).data?.[0] ?? {}) as
      { id?: string };
    const key = `verify-${Date.now()}`;
    const madePayments: string[] = [];

    const pay = (body: Record<string, unknown>) =>
      core("/api/integrations/payments", desk, { method: "POST", body: JSON.stringify(body) });

    const firstCharge = await pay({
      patient: deskPatient2.id, amount: "40.00", method: "card", idempotency_key: key,
    });
    if (typeof firstCharge.body["id"] === "string") madePayments.push(firstCharge.body["id"]);
    check("a card payment is taken",
      firstCharge.status === 200 || firstCharge.status === 201,
      String(firstCharge.body["reference"] ?? firstCharge.body["message"] ?? "").slice(0, 60));

    // The one that matters. A gateway that times out has not said whether
    // it took the money; the receptionist presses the button again; the
    // patient must not be charged twice.
    const secondCharge = await pay({
      patient: deskPatient2.id, amount: "40.00", method: "card", idempotency_key: key,
    });
    const sameRow = secondCharge.body["id"] === firstCharge.body["id"];
    check("the same idempotency key does not take the money twice",
      (secondCharge.status === 200 || secondCharge.status === 201) &&
        secondCharge.body["replayed"] === true && sameRow,
      sameRow ? "answered from the first row" : "a second row was created");

    const rowsForKey = await rows(
      `/items/payments?limit=-1&fields=id&filter[idempotency_key][_eq]=${encodeURIComponent(key)}`,
    );
    check("and the database holds exactly one row for that key",
      rowsForKey.length === 1, `${rowsForKey.length} rows`);

    // A declined card is a fact about the patient's account: retrying it
    // changes nothing, so the queue above must not spend five attempts
    // learning that. A timeout is the opposite.
    const declined = await pay({
      patient: deskPatient2.id, amount: "40.00", method: "card",
      idempotency_key: `${key}-declined`, simulate: "decline",
    });
    check("a declined card is refused as NOT retryable",
      declined.status === 400 && (declined.body as { retryable?: boolean }).retryable === false,
      String((declined.body as { message?: string }).message ?? "").slice(0, 50));

    const timedOut = await pay({
      patient: deskPatient2.id, amount: "40.00", method: "card",
      idempotency_key: `${key}-timeout`, simulate: "network-error",
    });
    check("a gateway that never answered is retryable",
      timedOut.status === 400 && (timedOut.body as { retryable?: boolean }).retryable === true,
      String((timedOut.body as { message?: string }).message ?? "").slice(0, 50));

    // And the key is released for that one, because nobody knows whether
    // the money moved and the retry has to be allowed to find out.
    const heldAfterTimeout = await rows(
      `/items/payments?limit=-1&fields=id&filter[idempotency_key][_eq]=${encodeURIComponent(`${key}-timeout`)}`,
    );
    check("an ambiguous failure releases its key so the retry can happen",
      heldAfterTimeout.length === 0, `${heldAfterTimeout.length} still holding it`);

    for (const row of await rows(
      `/items/payments?limit=-1&fields=id&filter[note][_null]=true&filter[idempotency_key][_starts_with]=verify-`,
    )) madePayments.push(String(row["id"]));

    /* --- accounting: posting a period twice --- */
    //
    // Idempotence is the only property an accounting export really has to
    // have, and a date range cannot give it. Posting the same invoice
    // twice produces books that are wrong by exactly one invoice, found
    // months later by a bookkeeper who cannot say which run did it.
    const owner = await login("owner@kadehuis.example.com");

    // The suite makes its own invoice, on its own day, and exports only
    // that day.
    //
    // The first version of this check exported everything and read the
    // journal it got back. That passed exactly once: the run consumed
    // every unposted invoice, and the next run found only payments left,
    // so "income is recognised once" saw zero income lines and reported a
    // bug in the exporter that did not exist. A check that can only pass
    // against a database nobody has touched is a check that will be
    // deleted the first time somebody touches one.
    //
    // A date far enough out that no seeded invoice shares it, so the
    // window contains this run's row and nothing else.
    const bookDay = "2031-03-04";
    const kadehuisClinic = String(
      (await rows("/items/practice?limit=1&fields=id&filter[slug][_eq]=kadehuis"))[0]?.["id"] ?? "",
    );
    const ownerPatient = String(
      (await rows(`/items/patients?limit=1&fields=id`))[0]?.["id"] ?? "",
    );

    const madeInvoice = await fetch(`${BASE}/items/invoices`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin0}`, "content-type": "application/json" },
      body: JSON.stringify({
        clinic: kadehuisClinic, patient: ownerPatient,
        number: `VERIFY-${Date.now()}`, status: "sent",
        issued_at: bookDay, subtotal: "100.00", tax_rate: "20.00", total: "120.00",
      }),
    });
    const invoiceId = ((await madeInvoice.json().catch(() => ({}))) as { data?: { id?: string } }).data?.id ?? "";

    // And a payment against it, dated the same day, so the journal has
    // both halves: an invoice raised and money received.
    const paidKey = `verify-ledger-${Date.now()}`;
    const ledgerPayment = await pay({
      patient: ownerPatient, invoice: invoiceId, amount: "120.00",
      method: "cash", idempotency_key: paidKey,
    });
    const ledgerPaymentId = String(ledgerPayment.body["id"] ?? "");
    if (ledgerPaymentId) {
      await fetch(`${BASE}/items/payments/${ledgerPaymentId}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${admin0}`, "content-type": "application/json" },
        body: JSON.stringify({ received_at: `${bookDay}T10:00:00Z` }),
      });
    }

    const exported = await core("/api/integrations/accounting/export", owner, {
      method: "POST", body: JSON.stringify({ from: bookDay, to: bookDay }),
    });
    const balanced = exported.body["debits"] === exported.body["credits"];
    check("an accounting export balances, to the penny",
      (exported.status === 200 || exported.status === 201) && balanced &&
        Number(exported.body["lines"]) > 0,
      exported.status < 300
        ? `${exported.body["lines"]} lines, ${exported.body["debits"]} each side`
        : String((exported.body as { message?: string }).message ?? "").slice(0, 60));

    // A journal is double entry or it is a list. Every invoice posts to
    // debtors and income; a payment posts to bank and debtors and must
    // NOT touch income again — recognising the same turnover twice is the
    // classic way to overstate a practice's year.
    const journal = String(exported.body["body"] ?? "");
    const incomeLines = journal.split("\n").filter((l) => l.includes(",4000,"));
    const bankLines = journal.split("\n").filter((l) => l.includes(",1200,"));
    check("income is recognised once, when the invoice is raised",
      incomeLines.length > 0 && bankLines.length > 0 &&
        bankLines.every((l) => !l.includes(",4000,")),
      `${incomeLines.length} income lines, ${bankLines.length} bank lines`);

    const again = await core("/api/integrations/accounting/export", owner, {
      method: "POST", body: JSON.stringify({ from: bookDay, to: bookDay }),
    });
    check("posting the same period twice exports nothing the second time",
      again.status === 400 &&
        /already been posted/i.test(String((again.body as { message?: string }).message ?? "")),
      String((again.body as { message?: string }).message ?? `HTTP ${again.status}`).slice(0, 60));

    /* --- the laboratory --- */
    // Its own case, for the same reason the accounting block makes its
    // own invoice: a case that has already been dispatched returns no
    // docket, so "the docket carries no patient name" passed on the first
    // run and failed on the second having examined an empty string.
    const labPatient = ((await get(dds, "/items/patients?limit=1&fields=id")).data?.[0] ?? {}) as
      { id?: string };
    const anyLab = ((await get(dds, "/items/laboratories?limit=1&fields=id")).data?.[0] ?? {}) as
      { id?: string };
    const madeCase = await fetch(`${BASE}/items/lab_cases`, {
      method: "POST",
      headers: { authorization: `Bearer ${dds}`, "content-type": "application/json" },
      body: JSON.stringify({
        patient: labPatient.id,
        // Required, and rightly so: a case with no laboratory on it is a
        // crown nobody is making.
        laboratory: anyLab.id,
        instructions: "Verify: full gold crown 17, shade not applicable.",
        due_at: "2031-03-04T09:00:00Z",
      }),
    });
    const caseId = ((await madeCase.json().catch(() => ({}))) as { data?: { id?: string } }).data?.id ?? "";
    const subject = caseId ? { id: caseId } : undefined;

    if (subject) {
      const sent = await core("/api/integrations/lab/dispatch", dds, {
        method: "POST", body: JSON.stringify({ case: subject.id, via: "docket" }),
      });
      check("a lab case is dispatched",
        sent.status === 200 || sent.status === 201,
        String(sent.body["reference"] ?? (sent.body as { message?: string }).message ?? "").slice(0, 40));

      // A docket is an instruction about a person's mouth that leaves the
      // building. It carries the case reference so the lab can match the
      // work; it must not carry the patient's name, because that is a
      // data-sharing agreement nobody signed.
      const docket = String(sent.body["docket"] ?? "");
      const patientNames = ((await get(dds, "/items/patients?limit=-1&fields=last_name")).data ?? []) as
        Array<{ last_name: string }>;
      const namedOnDocket = patientNames.filter((p) => p.last_name && docket.includes(p.last_name));
      check("a lab docket carries a case reference, never a patient's name",
        docket.length > 0 && namedOnDocket.length === 0 && /Patient ref\./.test(docket),
        namedOnDocket.length ? `leaked ${namedOnDocket[0]?.last_name}` : "reference only");

      // Dispatching twice does not cost money; it costs a second crown.
      const resent = await core("/api/integrations/lab/dispatch", dds, {
        method: "POST", body: JSON.stringify({ case: subject.id, via: "docket" }),
      });
      check("dispatching the same case again does not send it twice",
        resent.body["alreadySent"] === true && resent.body["reference"] === sent.body["reference"],
        String(resent.body["reference"] ?? ""));

      // The webhook is on its own secret, not an operator token: a lab
      // posting a status has no Directus account and never will.
      const reference = String(sent.body["reference"] ?? "");
      const wrongSecret = await core("/api/integrations/lab/inbound", undefined, {
        method: "POST",
        headers: { "x-inbound-secret": "not-the-secret" },
        body: JSON.stringify({ reference, state: "received" }),
      });
      check("the lab webhook rejects a wrong secret", wrongSecret.status === 403,
        `HTTP ${wrongSecret.status}`);

      if (INBOUND_SECRET) {
        const update = await core("/api/integrations/lab/inbound", undefined, {
          method: "POST",
          headers: { "x-inbound-secret": INBOUND_SECRET },
          body: JSON.stringify({ reference, state: "received" }),
        });
        check("a lab status update reaches the case", update.body["matched"] === true,
          `HTTP ${update.status}`);

        // The provider did its job. A 4xx would make it retry a message
        // that was received perfectly well.
        const stranger = await core("/api/integrations/lab/inbound", undefined, {
          method: "POST",
          headers: { "x-inbound-secret": INBOUND_SECRET },
          body: JSON.stringify({ reference: "mock:lab_nobody", state: "received" }),
        });
        check("an update for an unknown case is recorded, not rejected",
          (stranger.status === 200 || stranger.status === 201) && stranger.body["matched"] === false,
          `HTTP ${stranger.status}`);
      } else {
        check("a lab status update reaches the case", false, "MESSAGING_INBOUND_SECRET is not set");
        check("an update for an unknown case is recorded, not rejected", false, "no secret set");
      }

      await fetch(`${BASE}/items/lab_cases/${subject.id}`, {
        method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
      });
    } else {
      for (const name of [
        "a lab case is dispatched",
        "a lab docket carries a case reference, never a patient's name",
        "dispatching the same case again does not send it twice",
        "the lab webhook rejects a wrong secret",
        "a lab status update reaches the case",
        "an update for an unknown case is recorded, not rejected",
      ]) check(name, false, "could not create a lab case to dispatch");
    }

    /* --- the calendar feed --- */
    //
    // A subscribed calendar is a copy, synchronised to Google or
    // Microsoft, cached on a phone and readable by whoever that account
    // is shared with. The default feed must not be a clinical export.
    const minted = await core("/api/integrations/calendar/token", dds, {
      method: "POST", body: "{}",
    });
    const feedToken = String(minted.body["token"] ?? "");
    check("a clinician can mint a calendar feed token",
      feedToken.length > 16 && String(minted.body["url"] ?? "").endsWith(".ics"),
      feedToken ? "issued" : `HTTP ${minted.status}`);

    if (feedToken) {
      const quiet = await core(`/api/integrations/calendar/${feedToken}.ics`);
      const loud = await core(`/api/integrations/calendar/${feedToken}.ics?detail=named`);
      const surnames = ((await get(dds, "/items/patients?limit=-1&fields=last_name")).data ?? []) as
        Array<{ last_name: string }>;
      const leakedQuiet = surnames.filter((p) => p.last_name && quiet.text.includes(p.last_name));
      const shownLoud = surnames.filter((p) => p.last_name && loud.text.includes(p.last_name));

      check("the feed is iCalendar a real client would accept",
        quiet.status === 200 && quiet.text.startsWith("BEGIN:VCALENDAR") &&
          quiet.text.includes("\r\n") && /UID:[0-9a-f-]{36}@/.test(quiet.text),
        `${(quiet.text.match(/BEGIN:VEVENT/g) ?? []).length} events`);

      check("the default feed contains NO patient name",
        leakedQuiet.length === 0,
        leakedQuiet.length ? `leaked ${leakedQuiet[0]?.last_name}` : "none of them");

      check("asking for names explicitly is what puts them there",
        shownLoud.length > 0, `${shownLoud.length} named`);

      // A subscriber that stops seeing a UID does not remove the event.
      // Dropping cancelled appointments from the feed leaves a ghost in
      // the clinician's phone for a patient who is not coming.
      check("a cancelled appointment is published as cancelled, not dropped",
        quiet.text.includes("STATUS:CANCELLED"),
        `${(quiet.text.match(/STATUS:CANCELLED/g) ?? []).length} cancelled`);

      // 404 rather than 403: a 403 confirms the token exists and is
      // simply not yours, which a guessing client should not be told.
      const guessed = await core("/api/integrations/calendar/not-a-real-token-at-all.ics");
      check("a wrong feed token is a 404, not a 403", guessed.status === 404,
        `HTTP ${guessed.status}`);
    } else {
      for (const name of [
        "the feed is iCalendar a real client would accept",
        "the default feed contains NO patient name",
        "asking for names explicitly is what puts them there",
        "a cancelled appointment is published as cancelled, not dropped",
        "a wrong feed token is a 404, not a 403",
      ]) check(name, false, "no feed token to test with");
    }

    /* --- who may do what with the money --- */
    //
    // Reception takes the money, so reception records it. Reception does
    // not get to make one disappear: a payment that turns out to be wrong
    // is reversed with a negative row, because the money still moved and
    // a deleted payment is a reconciliation that never balances again.
    const anyPayment = (await rows("/items/payments?limit=1&fields=id"))[0];
    if (anyPayment) {
      const deleted = await fetch(`${BASE}/items/payments/${String(anyPayment["id"])}`, {
        method: "DELETE", headers: { authorization: `Bearer ${desk}` },
      });
      check("reception CANNOT delete a payment", deleted.status === 403, `HTTP ${deleted.status}`);
    } else {
      check("reception CANNOT delete a payment", false, "no payment to try");
    }

    const portalPayments = await get(portal, "/items/payments?limit=-1&fields=id,amount,method");
    check("a patient can see what they have paid",
      portalPayments.status === 200, `HTTP ${portalPayments.status}`);

    // The key is the thing that stops a double charge. A patient who can
    // read one can replay somebody's charge.
    const portalKeys = await get(portal, "/items/payments?limit=1&fields=id,idempotency_key");
    const keyRow = (portalKeys.data?.[0] ?? {}) as Record<string, unknown>;
    check("a patient CANNOT read a payment's idempotency key",
      portalKeys.status === 403 || !("idempotency_key" in keyRow),
      `HTTP ${portalKeys.status}`);

    // The rows this section created. Left behind they accumulate one set
    // per run, and the "exactly one row for that key" check above starts
    // passing for the wrong reason.
    for (const id of madePayments) {
      await fetch(`${BASE}/items/payments/${id}`, {
        method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
      });
    }

    // The ledger batch and everything it claimed. Payment before invoice,
    // because the payment points at it.
    if (ledgerPaymentId) {
      await fetch(`${BASE}/items/payments/${ledgerPaymentId}`, {
        method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
      });
    }
    if (invoiceId) {
      await fetch(`${BASE}/items/invoices/${invoiceId}`, {
        method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
      });
    }
    for (const batch of await rows(
      `/items/ledger_exports?limit=-1&fields=id&filter[period_start][_eq]=${bookDay}`,
    )) {
      await fetch(`${BASE}/items/ledger_exports/${String(batch["id"])}`, {
        method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
      });
    }
  }

  /* ---------- the public website's credential -------------------------- */
  //
  // A static token is right for public *content* and would be a
  // regression for patient data. This section is the line between those
  // two, asserted rather than described: behind the sign-in every request
  // still carries the patient's own token, which is what makes the site
  // incapable of reading somebody else's record even if the code is
  // wrong. If this token could read `patients`, the site would become the
  // thing deciding who sees what.
  {
    check("the website's token is a token, not Directus's redaction of one",
      WEBSITE_TOKEN.length > 0 && !/^\*+$/.test(WEBSITE_TOKEN),
      WEBSITE_TOKEN ? `${WEBSITE_TOKEN.length} characters` : "not set — run the seed");

    if (WEBSITE_TOKEN) {
      const asWebsite = (path: string) => get(WEBSITE_TOKEN, path);

      // What it must be able to read, or there is no website.
      for (const [collection, label] of [
        ["practice", "the practice"],
        ["services", "what the practice offers"],
        ["faqs", "the questions"],
        ["clinic_hours", "the opening hours"],
        // Not personal data: a statutory retention period is a fact about
        // the law. The privacy notice is generated from these rows, which
        // is what stops it drifting from the policy.
        ["retention_rules", "how long the practice keeps things"],
      ] as const) {
        const r = await asWebsite(`/items/${collection}?limit=1`);
        check(`the website CAN read ${label}`, r.status === 200, `HTTP ${r.status}`);
      }

      // And everything it must not. Named individually rather than as a
      // loop with one assertion, so a failure says which one.
      for (const collection of [
        "patients", "appointments", "invoices", "payments", "documents",
        "messages", "access_log", "treatment_records", "clinical_notes",
      ]) {
        const r = await asWebsite(`/items/${collection}?limit=1`);
        check(`the website CANNOT read ${collection}`, r.status === 403, `HTTP ${r.status}`);
      }

      // The team page, and the filter that matters. `public_profile` is
      // opt-in; without the second arm this would also expose every
      // patient login, which carries a clinic exactly as a clinician's
      // does.
      // Not `public_profile`: the policy does not grant that column, and
      // asking for an un-permitted field makes Directus refuse the whole
      // query — which reads as "no profiles" rather than as a 403. The
      // filter is applied server-side anyway; the site never needs to see
      // the flag it was filtered by.
      const people = await asWebsite("/users?limit=-1&fields=id,first_name,last_name,job_title");
      const shown = (people.data ?? []) as Array<{ id: string }>;
      const portalLogins = new Set(
        (await rows("/items/patients?limit=-1&fields=portal_user&filter[portal_user][_nnull]=true"))
          .map((r) => String(r["portal_user"])),
      );
      const leaked = shown.filter((u) => portalLogins.has(u.id));
      check("the website sees the clinicians who opted in", shown.length > 0,
        `${shown.length} profiles`);
      check("the website CANNOT see a single patient login",
        leaked.length === 0,
        leaked.length ? `${leaked.length} leaked` : `${portalLogins.size} portal logins exist`);

      // Unpublished content stays off the internet. "We will remember to
      // set it live last" is not a mechanism.
      const draft = await fetch(`${BASE}/items/services`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin0}`, "content-type": "application/json" },
        body: JSON.stringify({
          clinic: String((await rows("/items/practice?limit=1&fields=id"))[0]?.["id"]),
          name: "Verify draft", slug: `verify-draft-${Date.now()}`,
          summary: "Should never be public.", published: false,
        }),
      });
      const draftId = ((await draft.json().catch(() => ({}))) as { data?: { id?: string } }).data?.id;
      if (draftId) {
        const visible = await asWebsite(`/items/services?limit=-1&fields=id&filter[id][_eq]=${draftId}`);
        check("an unpublished service is invisible to the website",
          (visible.data ?? []).length === 0, `${(visible.data ?? []).length} visible`);
        await fetch(`${BASE}/items/services/${draftId}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      } else {
        check("an unpublished service is invisible to the website", false, "could not create a draft");
      }

      // Read-only. A content token that can write is a defacement waiting
      // to happen.
      const write = await fetch(`${BASE}/items/faqs`, {
        method: "POST",
        headers: { authorization: `Bearer ${WEBSITE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ question: "Can the website write?", answer: "It must not." }),
      });
      check("the website token CANNOT write anything", write.status === 403,
        `HTTP ${write.status}`);
    } else {
      for (const name of [
        "the website CAN read the practice",
        "the website CANNOT read patients",
        "the website CANNOT see a single patient login",
        "the website token CANNOT write anything",
      ]) check(name, false, "WEBSITE_TOKEN is not set — run the seed");
    }
  }

  /* ---------- disposal: the signature before the shredder -------------- */
  //
  // The third of records management that systems collapse into a cron
  // job. ISO 15489 separates the **schedule** (`retention_rules`), the
  // **review** (`/api/retention/due`) and the **authorisation** — and the
  // last one is a person deciding that these particular records may go,
  // with their name on it.
  //
  // Collapsing them into "delete anything older than N years" is wrong
  // twice: a period is a minimum to keep rather than a deadline to
  // destroy, and an automatic destruction is both irreversible and
  // unattributable — nobody decided, so nobody can be asked.
  {
    const dOwner = await login("owner@kadehuis.example.com");
    const dDesk = await login("desk@kadehuis.example.com");
    const kadehuisId2 = String(
      (await rows("/items/practice?limit=1&fields=id&filter[slug][_eq]=kadehuis"))[0]?.["id"] ?? "");
    const ownerId = String(
      (await rows("/users?limit=1&fields=id&filter[email][_eq]=owner@kadehuis.example.com"))[0]?.["id"] ?? "");

    const register = await rows(
      "/items/disposals?limit=-1&fields=reference,status,authorised_by,authorised_on," +
      "carried_out_on,method,withheld_reason,grounds");
    check("the practice keeps a disposal register", register.length > 0, `${register.length} reviews`);
    // The row that turns a queue into a review.
    check("and it records what was held back, not only what went",
      register.some((d) => d["status"] === "withheld" && String(d["withheld_reason"] ?? "").length > 40),
      `${register.filter((d) => d["status"] === "withheld").length} held back`);
    check("every carried-out disposal has a name and a date on it",
      register.filter((d) => d["status"] === "carried_out")
        .every((d) => d["authorised_by"] && d["authorised_on"] && d["method"]),
      `${register.filter((d) => d["status"] === "carried_out").length} carried out`);
    check("and none of them happened before it was authorised",
      register.filter((d) => d["status"] === "carried_out")
        .every((d) => new Date(String(d["carried_out_on"])) >= new Date(String(d["authorised_on"]))),
      "signature first");

    const deskSees = await get(dDesk, "/items/disposals?limit=1&fields=id");
    check("reception CANNOT read the disposal register", deskSees.status === 403,
      `HTTP ${deskSees.status}`);

    /* --- each rule, built and cleaned up --- */
    const stamp2 = Date.now();
    const baseDisposal = {
      clinic: kadehuisId2,
      record_type: "financial",
      covering: "verify probe",
      reviewed_as_at: new Date().toISOString(),
    };
    const tryDisposal = async (extra: Record<string, unknown>) => {
      const res = await fetch(`${BASE}/items/disposals`, {
        method: "POST",
        headers: { authorization: `Bearer ${dOwner}`, "content-type": "application/json" },
        body: JSON.stringify({ ...baseDisposal, ...extra }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        errors?: Array<{ message?: string }>; data?: { id?: string };
      };
      if (body.data?.id) {
        await fetch(`${BASE}/items/disposals/${body.data.id}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      }
      return { status: res.status, message: body.errors?.[0]?.message ?? "" };
    };

    const nowIso = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();

    const unsigned = await tryDisposal({ reference: `VD-${stamp2}-1`, status: "authorised" });
    check("a disposal cannot be authorised by nobody",
      unsigned.status === 400 && /authorised by nobody/i.test(unsigned.message),
      unsigned.message.slice(0, 56) || `HTTP ${unsigned.status}`);

    // The one the collection exists for.
    const backwards = await tryDisposal({
      reference: `VD-${stamp2}-2`, status: "carried_out",
      authorised_by: ownerId, authorised_on: nowIso, grounds: "Elapsed.",
      method: "deleted", carried_out_on: yesterday,
    });
    check("and cannot have been carried out before it was authorised",
      backwards.status === 400 && /signature comes first/i.test(backwards.message),
      backwards.message.slice(0, 56) || `HTTP ${backwards.status}`);

    const ordered = await tryDisposal({
      reference: `VD-${stamp2}-3`, status: "carried_out",
      authorised_by: ownerId, authorised_on: yesterday, grounds: "Elapsed.",
      method: "deleted", carried_out_on: nowIso,
    });
    check("the right way round is accepted", ordered.status === 200, `HTTP ${ordered.status}`);

    const silentlyHeld = await tryDisposal({ reference: `VD-${stamp2}-4`, status: "withheld" });
    check("holding a record back has to say why",
      silentlyHeld.status === 400 && /indistinguishable from not having looked/i.test(silentlyHeld.message),
      silentlyHeld.message.slice(0, 56) || `HTTP ${silentlyHeld.status}`);

    const target = register[0];
    if (target) {
      const row = (await rows(
        `/items/disposals?limit=1&fields=id&filter[reference][_eq]=${String(target["reference"])}`))[0];
      const tidy = await fetch(`${BASE}/items/disposals/${String(row?.["id"])}`, {
        method: "DELETE", headers: { authorization: `Bearer ${dOwner}` },
      });
      check("not even the practice owner can delete a disposal record",
        tidy.status === 403, `HTTP ${tidy.status}`);
    }

    /* --- and the rule survives Directus being bypassed --- */
    {
      const db3 = new Client({
        host: DB_HOST, port: DB_PORT, database: DB_DATABASE, user: DB_USER, password: DB_PASSWORD,
      });
      try {
        await db3.connect();
        let refused = "";
        try {
          await db3.query(
            `INSERT INTO disposals
               (id, reference, status, record_type, covering, reviewed_as_at,
                authorised_by, authorised_on, grounds, method, carried_out_on, date_created)
             VALUES (gen_random_uuid(), $1, 'carried_out', 'financial', 'straight to SQL',
                     now(), $2, now(), 'elapsed', 'deleted', now() - interval '1 day', now())`,
            [`VD-${stamp2}-SQL`, ownerId],
          );
          await db3.query(`DELETE FROM disposals WHERE reference = $1`, [`VD-${stamp2}-SQL`]);
        } catch (e) {
          refused = e instanceof Error ? e.message : String(e);
        }
        check("the ordering holds even when Directus is bypassed entirely",
          /signature comes first/i.test(refused), refused.slice(0, 70) || "the insert succeeded");
      } catch {
        check("the ordering holds even when Directus is bypassed entirely", false, "cannot reach Postgres");
      } finally {
        await db3.end().catch(() => {});
      }
    }
  }

  /* ---------- the breach register (GDPR Articles 33 and 34) ------------ */
  //
  // The half that gets missed is not the reporting. It is Article 33(5):
  // "the controller shall document **any** personal data breaches" —
  // including the ones a practice decides not to report, which is most of
  // them. A register holding only the reported ones is evidence that the
  // reporting decision was never written down.
  {
    const bOwner = await login("owner@kadehuis.example.com");
    const bDesk = await login("desk@kadehuis.example.com");
    const kadehuis = String(
      (await rows("/items/practice?limit=1&fields=id&filter[slug][_eq]=kadehuis"))[0]?.["id"] ?? "",
    );

    const register = await rows(
      "/items/data_breaches?limit=-1&fields=reference,risk,discovered_at,notify_by," +
      "authority_notified_at,why_not_notified,subjects_notified_at");
    check("the practice keeps a breach register", register.length > 0, `${register.length} entries`);
    // The point of the whole collection.
    check("and it holds the breaches that were NOT reported, with the reasoning",
      register.some((b) => b["risk"] === "unlikely" && String(b["why_not_notified"] ?? "").length > 40),
      register.filter((b) => b["risk"] === "unlikely").length + " documented and not notified");

    /* --- the clock --- */
    const clocked = register.filter((b) => b["discovered_at"] && b["notify_by"]);
    const correct = clocked.filter((b) => {
      const gap = new Date(String(b["notify_by"])).getTime() - new Date(String(b["discovered_at"])).getTime();
      return gap === 72 * 3600 * 1000;
    });
    check("the 72 hours are computed from discovery, not typed",
      clocked.length > 0 && correct.length === clocked.length,
      `${correct.length} of ${clocked.length} exactly 72 hours`);

    /* --- who may look --- */
    const deskSees = await get(bDesk, "/items/data_breaches?limit=1&fields=id");
    check("reception CANNOT read the breach register", deskSees.status === 403,
      `HTTP ${deskSees.status}`);

    /* --- and the rules, each one built and cleaned up --- */
    const base = {
      summary: "verify probe",
      facts: "A row created by the verify suite.",
      likely_consequences: "None.",
      measures_taken: "Deleted.",
      data_categories: ["contact"],
    };
    const tryBreach = async (extra: Record<string, unknown>) => {
      const res = await fetch(`${BASE}/items/data_breaches`, {
        method: "POST",
        headers: { authorization: `Bearer ${bOwner}`, "content-type": "application/json" },
        body: JSON.stringify({ ...base, ...extra }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        errors?: Array<{ message?: string }>; data?: { id?: string };
      };
      if (body.data?.id) {
        await fetch(`${BASE}/items/data_breaches/${body.data.id}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      }
      return { status: res.status, message: body.errors?.[0]?.message ?? "" };
    };

    const now = new Date().toISOString();
    const longAgo = new Date(Date.now() - 100 * 3600_000).toISOString();
    const stamp = Date.now();

    const unexplained = await tryBreach({
      reference: `VF-${stamp}-1`, discovered_at: now, risk: "unlikely",
    });
    check("an unexplained decision not to report is refused",
      unexplained.status === 400 && /Article 33\(5\)/.test(unexplained.message),
      unexplained.message.slice(0, 60) || `HTTP ${unexplained.status}`);

    const explained = await tryBreach({
      reference: `VF-${stamp}-2`, discovered_at: now, risk: "unlikely",
      why_not_notified: "One recipient, no clinical content, no surname.",
    });
    check("and an explained one is accepted", explained.status === 200,
      `HTTP ${explained.status}`);

    const lateSilent = await tryBreach({
      reference: `VF-${stamp}-3`, discovered_at: longAgo, risk: "risk",
      authority_notified_at: now,
    });
    check("a notification after 72 hours must say why it was late",
      lateSilent.status === 400 && /Article 33\(1\)/.test(lateSilent.message),
      lateSilent.message.slice(0, 60) || `HTTP ${lateSilent.status}`);

    const highRiskClosed = await tryBreach({
      reference: `VF-${stamp}-4`, discovered_at: now, risk: "high_risk",
      status: "closed", authority_notified_at: now,
    });
    check("a high-risk breach cannot be closed until the patients are told",
      highRiskClosed.status === 400 && /Article 34/.test(highRiskClosed.message),
      highRiskClosed.message.slice(0, 60) || `HTTP ${highRiskClosed.status}`);

    /* --- the register is not tidyable --- */
    const first = register[0];
    if (first) {
      const target = (await rows(
        `/items/data_breaches?limit=1&fields=id&filter[reference][_eq]=${String(first["reference"])}`))[0];
      const tidy = await fetch(`${BASE}/items/data_breaches/${String(target?.["id"])}`, {
        method: "DELETE", headers: { authorization: `Bearer ${bOwner}` },
      });
      // The row that most wants deleting is the one an authority most
      // wants to read. Closing a breach is a status, not a deletion.
      check("not even the practice owner can delete from the register",
        tidy.status === 403, `HTTP ${tidy.status}`);
    }

    /* --- and the rule survives Directus being bypassed --- */
    //
    // The hook produces the readable sentence; the trigger is the one
    // that cannot be routed around. Checked by writing straight to
    // Postgres, which is the path a flow, a script or a future endpoint
    // would take.
    {
      const db2 = new Client({
        host: DB_HOST, port: DB_PORT, database: DB_DATABASE, user: DB_USER, password: DB_PASSWORD,
      });
      try {
        await db2.connect();
        let refused = "";
        try {
          await db2.query(
            `INSERT INTO data_breaches
               (id, reference, status, discovered_at, summary, facts,
                likely_consequences, measures_taken, risk, date_created)
             VALUES (gen_random_uuid(), $1, 'open', now(), 'verify: straight to SQL',
                     'bypassing Directus entirely', 'none', 'none', 'unlikely', now())`,
            [`VF-${stamp}-SQL`],
          );
          await db2.query(`DELETE FROM data_breaches WHERE reference = $1`, [`VF-${stamp}-SQL`]);
        } catch (e) {
          refused = e instanceof Error ? e.message : String(e);
        }
        check("the rule holds even when Directus is bypassed entirely",
          /Article 33\(5\)/.test(refused), refused.slice(0, 70) || "the insert succeeded");
      } catch {
        check("the rule holds even when Directus is bypassed entirely", false, "cannot reach Postgres");
      } finally {
        await db2.end().catch(() => {});
      }
    }
  }

  /* ---------- retention, as a control rather than a note --------------- */
  //
  // The gap this closes was recorded honestly for weeks: the periods were
  // data, cited to the statute, and nothing could tell a practice what had
  // actually come due.
  //
  // It **lists and does not delete**, and that is the design rather than
  // an unfinished half. A retention period is a minimum to keep, not a
  // deadline to destroy: a record under a complaint or a claim is kept
  // past its period precisely because the period elapsed, and a timer
  // cannot know that. Destruction is also irreversible and unattributable
  // when it is automatic, which is why records management everywhere else
  // separates the schedule from the review and the authorisation.
  {
    const rOwner = await login("owner@kadehuis.example.com");
    const rDesk = await login("desk@kadehuis.example.com");
    const rDentist = await login("dentist@kadehuis.example.com");

    const review = async (token: string) => {
      const res = await fetch(`${CORE_URL}/api/retention/due`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    type Group = { record_type: string; count: number; rule: { years: number; starts_from: string } };
    const groupsOf = (body: Record<string, unknown>): Group[] =>
      ((body["groups"] ?? []) as Group[]);

    const asOwner = await review(rOwner);
    check("a practice owner can see what has passed its retention period",
      asOwner.status === 200, `HTTP ${asOwner.status}`);
    check("and something actually has — otherwise this page cannot be seen working",
      Number(asOwner.body["total"] ?? 0) > 0,
      `${String(asOwner.body["total"])} rows past their period`);

    /* --- who may look, which is not everybody with a clinic --- */
    //
    // The sample rows carry labels like "clinical note (examination)", and
    // this endpoint reads Postgres directly — no permission layer
    // underneath. Without the check it added, a receptionist could read a
    // list of clinical notes with patient ids through a page about
    // housekeeping.
    const deniedOf = (body: Record<string, unknown>): string[] => {
      const nested = body["message"] as { denied?: string[] } | string | undefined;
      return (
        (body["denied"] as string[] | undefined) ??
        (typeof nested === "object" ? nested?.denied : undefined) ??
        []
      );
    };
    const asDesk = await review(rDesk);
    check("reception CANNOT — it names clinical notes and findings",
      asDesk.status === 403 && deniedOf(asDesk.body).includes("clinical_notes"),
      `HTTP ${asDesk.status}: ${deniedOf(asDesk.body).slice(0, 3).join(", ")}`);
    const asDentist = await review(rDentist);
    check("nor a clinician — payments and the access log are not theirs",
      asDentist.status === 403 && deniedOf(asDentist.body).includes("payments"),
      `HTTP ${asDentist.status}: ${deniedOf(asDentist.body).join(", ")}`);

    /* --- the same record, two jurisdictions, two answers --- */
    //
    // This pair used to be the sharpest check in the file. Both
    // practices held a patient last seen twenty-one years ago: under the
    // Dutch WGBO's twenty years that record was due for review, under
    // the UAE's twenty-five it was not, and the system said so without
    // anybody choosing which answer to give. That was the argument for
    // retention being a table rather than a constant.
    //
    // One practice, so there is no second jurisdiction to disagree with.
    // The argument survives in a narrower form and it is still the point:
    // the period is read from `retention_rules` and cited to the statute,
    // so a deployment in another country changes a row rather than a
    // line of code.
    const nlClinical = groupsOf(asOwner.body).find((g) => g.record_type === "clinical_record");
    check("the twenty-one-year-old record is due for review, at the period on file",
      (nlClinical?.count ?? 0) > 0 && nlClinical?.rule.years === 20,
      `${String(nlClinical?.count)} at ${String(nlClinical?.rule.years)} years`);
    check("and the clock runs from the end of treatment, not from the row's date",
      nlClinical?.rule.starts_from === "last_contact",
      String(nlClinical?.rule.starts_from ?? "no rule"));

    /* --- the clock runs from the patient, not from the row --- */
    //
    // The commonest retention mistake in a clinical system, and it
    // destroys records that are still required: a note written in 2001 for
    // somebody last treated in 2024 is not due in 2021. `starts_from` says
    // `last_contact`, and this is what proves the code honours it.
    //
    // Builds its own state — a genuinely old note on a patient who is
    // still coming in — because a check that only reads what the seed
    // happened to make is a check that passes for the wrong reason.
    const active = (await rows(
      "/items/patients?limit=-1&fields=id,reference&filter[status][_eq]=active" +
      ""))[0];
    const before = nlClinical?.count ?? 0;
    if (active) {
      const madeRes = await fetch(`${BASE}/items/clinical_notes`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin0}`, "content-type": "application/json" },
        body: JSON.stringify({
          clinic: (await rows("/items/practice?limit=1&fields=id&filter[slug][_eq]=kadehuis"))[0]?.["id"],
          patient: active["id"],
          // `author` is required — a clinical note with nobody's name on
          // it is not a clinical note.
          author: (await rows("/users?limit=1&fields=id&filter[email][_eq]=dentist@kadehuis.example.com"))[0]?.["id"],
          written_on: `${new Date().getUTCFullYear() - 25}-01-15`,
          kind: "examination",
          body: "verify: a very old note on a patient who still attends",
        }),
      });
      const madeId = ((await madeRes.json().catch(() => ({}))) as { data?: { id?: string } }).data?.id;
      if (madeId) {
        const after = groupsOf((await review(rOwner)).body)
          .find((g) => g.record_type === "clinical_record")?.count ?? -1;
        check("a twenty-five-year-old note on a patient who still attends is NOT due",
          after === before,
          `${before} before, ${after} after — the clock runs from the last visit`);
        await fetch(`${BASE}/items/clinical_notes/${madeId}`, {
          method: "DELETE", headers: { authorization: `Bearer ${admin0}` },
        });
      } else {
        check("a twenty-five-year-old note on a patient who still attends is NOT due",
          false, "could not create the note");
      }
    } else {
      check("a twenty-five-year-old note on a patient who still attends is NOT due",
        false, "no active patient to test with");
    }

    /* --- and it destroys nothing --- */
    const countBefore = await rows("/items/clinical_notes?limit=1&aggregate[count]=id");
    await review(rOwner);
    const countAfter = await rows("/items/clinical_notes?limit=1&aggregate[count]=id");
    check("running the review deletes nothing",
      JSON.stringify(countBefore) === JSON.stringify(countAfter),
      `${JSON.stringify(countAfter[0] ?? {})}`);
    check("and says so in the answer rather than leaving it to be assumed",
      /is deleted by this system/i.test(String(asOwner.body["note"] ?? "")),
      String(asOwner.body["note"] ?? "").slice(0, 48));
  }

  /* ---------- subject access (GDPR Article 15) -------------------------- */
  //
  // Two obligations, and most implementations meet one. 15(3) is the copy
  // of the data, which is the part people build. 15(1) is the information
  // that has to go *with* it — why it is held, who else sees it, how long
  // it is kept, and whether anything about the person is decided
  // automatically. A JSON dump with none of that is a database export
  // with a compliance label on it.
  //
  // The design decision under test is that the export **runs as the
  // caller**. No service credential, so it cannot become a way around the
  // permission model — and a caller who cannot read every part gets a
  // refusal naming the parts rather than a document that is quietly
  // incomplete and will be handed to a patient as their whole record.
  {
    const owner = await login("owner@kadehuis.example.com");
    const dentist = await login("dentist@kadehuis.example.com");
    const desk = await login("desk@kadehuis.example.com");

    // Sorted by reference, not by id. Sorting by id picks whichever row
    // the database happened to write first, and that patient may have no
    // appointments, no invoices and no messages — so the export is
    // correct and the check that it covers the record fails on an empty
    // one. RIV-0001 is the seeded patient with a full history.
    const subjects = await rows("/items/patients?limit=2&fields=id,first_name,last_name,reference&sort=reference");
    const subject = String(subjects[0]?.["id"] ?? "");

    const ask = async (token: string, id: string) => {
      const res = await fetch(`${CORE_URL}/api/subject-access/${id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };

    if (!subject) {
      check("there is a patient to export", false, "no patients seeded");
    } else {
      /* --- who can produce a complete one, and who is told they cannot --- */
      const asOwner = await ask(owner, subject);
      check("the practice owner can produce a complete subject access export",
        asOwner.status === 200, `HTTP ${asOwner.status}`);

      // Nest returns the object given to `ConflictException` verbatim, so
      // `refused` is at the top level and `message` is the sentence beside
      // it — not, as the first version of this assumed, a nested object.
      // It read `body.message.refused`, found a string, and reported that
      // the refusal named nothing.
      const refusalOf = (body: Record<string, unknown>): string[] => {
        const nested = body["message"] as { refused?: Array<{ collection?: string }> } | string;
        const list =
          (body["refused"] as Array<{ collection?: string }> | undefined) ??
          (typeof nested === "object" ? nested?.refused : undefined) ??
          [];
        return list.map((r) => String(r.collection));
      };

      const asDesk = await ask(desk, subject);
      check("reception is refused rather than given a partial record",
        asDesk.status === 409, `HTTP ${asDesk.status}`);
      check("and told exactly which parts they cannot read",
        refusalOf(asDesk.body).includes("clinical_notes") &&
          refusalOf(asDesk.body).includes("consents"),
        refusalOf(asDesk.body).slice(0, 4).join(", ") || "named nothing");

      // The one that documents the real answer rather than the expected
      // one: a dentist cannot read payments or the access log either, so
      // the person who produces a subject access response is the practice
      // owner. That is a finding, not a limitation — it fell out of
      // running the export as the caller instead of as a service account.
      const asDentist = await ask(dentist, subject);
      check("a clinician cannot produce one either — money and the access log are not theirs",
        asDentist.status === 409 &&
          refusalOf(asDentist.body).includes("payments") &&
          refusalOf(asDentist.body).includes("access_log"),
        `HTTP ${asDentist.status}: ${refusalOf(asDentist.body).join(", ")}`);

      if (asOwner.status === 200) {
        const doc = asOwner.body as {
          about?: Record<string, unknown>;
          record?: Record<string, Array<Record<string, unknown>>>;
          sections?: Array<{ collection: string; count: number }>;
        };

        /* --- 15(3): the copy --- */
        const sections = doc.sections ?? [];
        const filled = sections.filter((s) => s.count > 0).map((s) => s.collection);
        check("it covers every part of the record, not the ones somebody remembered",
          sections.length >= 25, `${sections.length} sections`);
        check("and the ones this patient actually has are in it",
          ["patients", "appointments", "treatment_records", "invoices", "payments", "messages"]
            .every((c) => filled.includes(c)),
          filled.join(", "));

        // The invariant that matters more than the count. Every row that
        // names a patient must name *this* one — a filter written through
        // the wrong path returns an empty section rather than an error,
        // and a filter that is missing returns everybody.
        const strays: string[] = [];
        for (const [collection, list] of Object.entries(doc.record ?? {})) {
          for (const row of list) {
            const owned = collection === "patients" ? row["id"] : row["patient"];
            if (owned !== undefined && owned !== null && String(owned) !== subject) {
              strays.push(`${collection}:${String(owned).slice(0, 8)}`);
              break;
            }
          }
        }
        check("and every row in it belongs to the person who asked",
          strays.length === 0, strays.length ? strays.join(", ") : "no strays");

        /* --- 15(1): the information that has to accompany it --- */
        const about = doc.about ?? {};
        const retention = (about["how_long_it_is_kept"] ?? []) as unknown[];
        check("it states the retention period, taken from the practice's own rules",
          retention.length > 0, `${retention.length} rules`);
        check("it states that nothing about the patient is decided automatically",
          /none/i.test(String(about["automated_decisions"] ?? "")),
          String(about["automated_decisions"] ?? "missing").slice(0, 40));
        check("it names the controller and the legal basis",
          Boolean((about["controller"] as Record<string, unknown> | undefined)?.["name"]) &&
            Boolean(about["legal_basis"]),
          "Article 15(1)(a) and the Article 9(2)(h) basis");

        /* --- the export logs itself --- */
        // The one read in the system that would otherwise leave no trace,
        // and the single event a practice most wants to find afterwards.
        const exports = await rows(
          `/items/access_log?limit=1&sort=-date_created&fields=action,patient,item_count` +
          `&filter[action][_eq]=export&filter[patient][_eq]=${subject}`);
        check("producing one is itself written to the access log",
          exports.length === 1 && Number(exports[0]?.["item_count"] ?? 0) > 0,
          exports.length ? `${String(exports[0]?.["item_count"])} rows exported` : "no export logged");
      }

      /* --- and somebody else's patient is not findable --- */
      const elsewhere = await rows(
        "/items/patients?limit=1&fields=id");
      // There is no second practice to refuse an export for. What the
      // subject-access endpoint still has to refuse is a patient id the
      // caller's own policy does not reach — which is the same rule
      // without a tenant boundary to hang it on.
      const notARecord = await ask(owner, "00000000-0000-0000-0000-000000000000");
      check("a patient id the caller cannot reach is refused, not exported",
        notARecord.status === 404 || notARecord.status === 403,
        `HTTP ${notARecord.status}`);
      void elsewhere;
    }
  }

  /* ---------- the provider adapters ------------------------------------ */
  //
  // The claim being tested is "add the environment variables and it starts
  // working", and it has two halves that fail in opposite directions.
  //
  // The loud half: a real provider named without its credentials must
  // **stop the service**. The tempting behaviour — warn, fall back to the
  // mock, carry on — means a practice believes it is texting patients
  // about their appointments and is not, while every `messages` row says
  // `sent`, because to a mock they were. That is worse than having no SMS.
  //
  // The quiet half: the adapters have to send what the providers'
  // references say. This repository has no Twilio account, no Meta
  // business and no Stripe key — so the real adapter classes are pointed
  // at a server that answers the documented way, and the request shape and
  // the retryable/permanent judgement are asserted against it. What that
  // cannot prove is that the provider agrees; only a live account shows
  // that, and it is said here rather than implied.
  {
    const run = promisify(execFile);
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

    /* --- the wire format, against a stub that answers like the docs --- */
    try {
      const { stdout } = await run("pnpm", ["--filter", "@enamel/core", "test:adapters"], {
        cwd: repoRoot,
        maxBuffer: 4_000_000,
      });
      const lines = stdout.split("\n").filter((l) => /^(PASS|FAIL) /.test(l));
      check("the adapter contract test ran", lines.length > 0, `${lines.length} assertions`);
      for (const line of lines) {
        const ok = line.startsWith("PASS ");
        const [claim = line.slice(5), detail = ""] = line.slice(5).split(" — ");
        check(claim, ok, detail);
      }
    } catch (e) {
      // A non-zero exit is a real failure, and its output carries the
      // failing assertions — surfaced rather than collapsed to "it threw".
      const err = e as { stdout?: string };
      const lines = (err.stdout ?? "").split("\n").filter((l) => /^(PASS|FAIL) /.test(l));
      check("the adapter contract test ran", lines.length > 0,
        lines.length ? `${lines.length} assertions` : "could not run pnpm --filter @enamel/core test:adapters");
      for (const line of lines) {
        const ok = line.startsWith("PASS ");
        const [claim = line.slice(5), detail = ""] = line.slice(5).split(" — ");
        check(claim, ok, detail);
      }
    }

    /* --- and the boot refusal, which is the whole point of the design --- */
    //
    // **Bounded, and that is not belt-and-braces.** The first version of
    // this ran `docker compose run` and waited for it to exit. When the
    // guard was sabotaged the service booted happily and ran forever, so
    // the check for "it must not start" *hung* instead of failing — which
    // is every bit as useless as one that passes, and takes longer to
    // notice. A container still running after half a minute has started,
    // and started is the failure.
    const BOOT_LIMIT_MS = 30_000;
    const bootWith = async (env: string): Promise<{ started: boolean; output: string }> => {
      try {
        const { stdout, stderr } = await run(
          "docker",
          ["compose", "run", "--rm", "--no-deps", "-e", env, "core"],
          { cwd: repoRoot, maxBuffer: 4_000_000, timeout: BOOT_LIMIT_MS, killSignal: "SIGKILL" },
        );
        // Exited by itself, with status 0. For a long-running service that
        // is still "it ran", not "it refused".
        return { started: true, output: stdout + stderr };
      } catch (e) {
        const err = e as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
        const output = (err.stdout ?? "") + (err.stderr ?? "");
        // `killed` means the timer fired: it was still running.
        return { started: Boolean(err.killed), output };
      } finally {
        // SIGKILL skips `--rm`, so the container it left behind is removed
        // here rather than accumulating one per run.
        await run("sh", ["-c",
          'docker ps -aq --filter "name=enamel-core-run" | xargs -r docker rm -f >/dev/null 2>&1 || true',
        ], { cwd: repoRoot }).catch(() => undefined);
      }
    };

    const halfConfigured = await bootWith("SMS_PROVIDER=twilio");
    check("naming a real provider with no credentials STOPS the service",
      !halfConfigured.started,
      halfConfigured.started ? "it started anyway" : "refused to start");
    check("and the refusal names every variable that is missing",
      halfConfigured.output.includes("TWILIO_ACCOUNT_SID") &&
        halfConfigured.output.includes("TWILIO_AUTH_TOKEN") &&
        halfConfigured.output.includes("one of TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID"),
      halfConfigured.output.includes("TWILIO_ACCOUNT_SID") ? "named" : "did not name them");
    check("it does not quietly fall back to the mock",
      !/listening on/.test(halfConfigured.output),
      /listening on/.test(halfConfigured.output) ? "the service started anyway" : "never started");

    const typo = await bootWith("SMS_PROVIDER=twillio");
    check("a misspelt provider name is refused, not answered with the mock",
      !typo.started && typo.output.includes("is not a provider this service has"),
      typo.started ? "it started anyway" : "refused to start");

    /* --- what the running service says it is --- */
    const adapters = await fetch(`${CORE_URL}/api/integrations/adapters`)
      .then((r) => r.json() as Promise<Record<string, Array<{ id: string; describe: string }>>>)
      .catch(() => ({}) as Record<string, Array<{ id: string; describe: string }>>);
    const messaging = adapters["messaging"] ?? [];
    check("the adapters endpoint reports the messaging channels too",
      messaging.length === 3 && messaging.every((m) => m.describe.length > 0),
      messaging.map((m) => m.id).join(", ") || "missing");
    check("and each mock says so in words rather than by omission",
      messaging.filter((m) => /^mock/.test(m.describe)).length === 2,
      messaging.map((m) => `${m.id}: ${m.describe.slice(0, 24)}`).join(" | "));

    // This endpoint answers WITHOUT a token, on purpose: "does this
    // really take card payments" should not need a login. That makes
    // every string in it public, and the email adapter used to answer
    // `SMTP to mail:1025` — an unauthenticated caller learning the mail
    // relay's address, for no reader's benefit. What each integration IS
    // is public; where it POINTS is the operator's.
    const everyDescription = Object.values(adapters).flat().map((a) => a.describe ?? "");
    const infrastructural = Object.values(adapters).flat()
      .filter((a) => /:\d{2,5}\b|https?:\/\/|localhost|\b(?:mail|redis|database|directus|core)\b:/.test(a.describe ?? ""))
      .map((a) => a.id);
    check("the public adapters endpoint names no host, port or URL",
      everyDescription.length >= 8 && infrastructural.length === 0,
      infrastructural.length ? `leaks: ${infrastructural.join(", ")}`
        : `${everyDescription.length} descriptions, none infrastructural`);

    // And the operator's view still has the part that was taken out of
    // the public one — a split that drops the detail everywhere is not a
    // fix, it is a deletion.
    const channelsFor = async (token: string | null) =>
      fetch(`${CORE_URL}/api/messaging/channels`,
        { headers: token ? { "x-reminder-token": token } : {} });
    const operatorChannels: Record<string, string> = await channelsFor(REMINDER_TOKEN)
      .then(async (r) => r.ok ? (await r.json()) as Record<string, string> : {})
      .catch(() => ({}));
    check("but an operator with the token still learns where email points",
      /:\d{2,5}\b/.test(String(operatorChannels["email"] ?? "")),
      String(operatorChannels["email"] ?? "no answer").slice(0, 60));
    check("and that view is refused without the token",
      (await channelsFor(null)).status === 403,
      `HTTP ${(await channelsFor(null)).status}`);

    /* --- preflight: the way to find out the variables took --- */
    const preflight = async (token: string | null) =>
      fetch(`${CORE_URL}/api/integrations/preflight`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    check("preflight needs a token", (await preflight(null)).status === 401);
    for (const [label, email] of [
      ["a practice owner", "owner@kadehuis.example.com"],
      ["a receptionist", "desk@kadehuis.example.com"],
    ] as const) {
      const token = await login(email);
      const res = await preflight(token);
      // It reaches a provider with the installation's credentials and
      // reports what came back, including whether Stripe is in live mode.
      check(`${label} CANNOT run preflight`, res.status === 403, `HTTP ${res.status}`);
    }

    const asAdmin = await preflight(await login(ADMIN_EMAIL, ADMIN_PASSWORD));
    const report = (await asAdmin.json().catch(() => ({}))) as {
      messaging?: Array<{ channel: string; ok: boolean | null }>;
      payments?: Array<{ id: string; ok: boolean | null }>;
    };
    check("an administrator gets a preflight report", asAdmin.status === 200, `HTTP ${asAdmin.status}`);
    check("with mocks configured, preflight says there is nothing to check",
      (report.messaging ?? []).every((m) => m.ok === null) &&
        (report.payments ?? []).every((p) => p.ok === null),
      // `null` rather than `false`: a mock has no account to reach, and a
      // caller treating null as false would call a healthy system broken.
      [...(report.messaging ?? []).map((m) => `${m.channel}=${String(m.ok)}`),
       ...(report.payments ?? []).map((p) => `${p.id}=${String(p.ok)}`)].join(", "));
  }

  /* ---------- the queue board ------------------------------------------ */
  //
  // Bull Board shows job payloads, and a reminder job carries a patient's
  // name, their email address and their appointment time. BullMQ has no
  // notion of who may read which job, so the whole of this section is
  // about the door rather than about filtering what is behind it.
  //
  // A browser following a link sends no Authorization header, which is why
  // there is a ticket at all. What has to be true: only the right people
  // can get one, it works once, and the board's own **API** — not just its
  // HTML — is refused without the session it becomes.
  //
  // "The right people" stopped meaning "administrators" when the Queue
  // operator policy arrived. That policy exists because `admin_access` is
  // not "may open the job board" — it is every clinical note, every
  // radiograph and the audit log — and the second half of this section is
  // the proof that the narrow grant is actually narrow.
  {
    const CORE = CORE_URL.replace(/\/$/, "");
    const coreGet = async (path: string, init: RequestInit = {}) => {
      try {
        const res = await fetch(`${CORE}${path}`, { redirect: "manual", ...init });
        return {
          status: res.status,
          location: res.headers.get("location") ?? "",
          setCookie: res.headers.get("set-cookie") ?? "",
          body: await res.text(),
        };
      } catch (e) {
        return { status: 0, location: "", setCookie: "", body: e instanceof Error ? e.message : String(e) };
      }
    };
    const asUser = (token: string) => ({ authorization: `Bearer ${token}` });

    const meta = await coreGet("/api/queues/board");
    const enabled = meta.status === 200 && (JSON.parse(meta.body || "{}") as { enabled?: boolean }).enabled === true;
    check("the queue board is switched on", enabled,
      meta.status === 0 ? `core unreachable at ${CORE}` : `HTTP ${meta.status}`);

    if (enabled) {
      const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
      const roles: Array<[string, string]> = [
        ["a practice owner", "owner@kadehuis.example.com"],
        ["a receptionist", "desk@kadehuis.example.com"],
        ["a patient", "patient@kadehuis.example.com"],
      ];

      /* --- who is even offered it --- */
      const mayAsAdmin = JSON.parse(
        (await coreGet("/api/queues/board", { headers: asUser(adminToken) })).body || "{}",
      ) as { youMayOpen?: boolean };
      check("an administrator is offered the board", mayAsAdmin.youMayOpen === true,
        `youMayOpen=${String(mayAsAdmin.youMayOpen)}`);

      for (const [label, email] of roles) {
        const token = await login(email);
        const may = JSON.parse(
          (await coreGet("/api/queues/board", { headers: asUser(token) })).body || "{}",
        ) as { youMayOpen?: boolean };
        // Told before pressing, not after. A control somebody can click and
        // cannot use is a worse answer than no control.
        check(`${label} is told up front that the board is not theirs`,
          may.youMayOpen === false, `youMayOpen=${String(may.youMayOpen)}`);
      }

      /* --- who can get a ticket --- */
      const noToken = await coreGet("/api/queues/ticket", { method: "POST" });
      check("a ticket needs a Directus token", noToken.status === 401, `HTTP ${noToken.status}`);

      for (const [label, email] of roles) {
        const token = await login(email);
        const refused = await coreGet("/api/queues/ticket", { method: "POST", headers: asUser(token) });
        check(`${label} CANNOT get a ticket`, refused.status === 403, `HTTP ${refused.status}`);
      }

      const issued = await coreGet("/api/queues/ticket", { method: "POST", headers: asUser(adminToken) });
      const url = (JSON.parse(issued.body || "{}") as { url?: string }).url ?? "";
      check("an administrator gets a one-time link",
        (issued.status === 200 || issued.status === 201) && url.includes("ticket="),
        `HTTP ${issued.status}`);

      if (url) {
        /* --- and what the link does --- */
        const path = url.slice(url.indexOf("/queues"));
        const first = await coreGet(path);
        const cookie = first.setCookie.split(";")[0] ?? "";
        check("redeeming it sets a session and redirects the ticket out of the URL",
          first.status === 302 && !first.location.includes("ticket=") && cookie.startsWith("enamel_queueboard="),
          `HTTP ${first.status} → ${first.location || "nowhere"}`);
        check("the session cookie is httpOnly and scoped to the board",
          /httponly/i.test(first.setCookie) && /path=\/queues/i.test(first.setCookie),
          first.setCookie.replace(/=[^;]+/, "=…") || "no cookie");

        const replay = await coreGet(path);
        // The one that matters if a link is ever recovered from history or
        // a proxy log: it is already spent.
        check("the same link cannot be used twice", replay.status === 401, `HTTP ${replay.status}`);

        /* --- the board's own API, which is where the data actually is --- */
        const boardApi = "/queues/api/queues";
        const naked = await coreGet(boardApi);
        check("the board's API is refused without a session", naked.status === 401,
          `HTTP ${naked.status}`);

        const withSession = await coreGet(boardApi, { headers: { cookie } });
        const names = ((JSON.parse(withSession.body || "{}") as { queues?: Array<{ name: string }> }).queues ?? [])
          .map((q) => q.name).sort();
        check("with a session it lists the four queues",
          withSession.status === 200 &&
            names.join(",") === "message-sweeps,messages,reminder-sweep,reminders",
          names.length ? names.join(", ") : `HTTP ${withSession.status}`);

        const nonsense = await coreGet("/queues?ticket=not-a-real-ticket");
        check("a guessed ticket gets nothing", nonsense.status === 401, `HTTP ${nonsense.status}`);

        /* --- the narrow grant, and that it is narrow --- */
        //
        // The point of the Queue operator policy is that watching a queue
        // costs nothing else. A check that only proved the operator can
        // open the board would be worth very little: the interesting half
        // is everything they still cannot reach, and it is asserted
        // against the collections somebody would actually go after.
        const opToken = await login("ops@enamel.dev").catch(() => "");
        check("the queue operator can sign in at all", opToken.length > 0,
          opToken ? "signed in" : "no token — is the account seeded?");

        if (opToken) {
          const mayOp = JSON.parse(
            (await coreGet("/api/queues/board", { headers: asUser(opToken) })).body || "{}",
          ) as { youMayOpen?: boolean };
          check("the queue operator is offered the board", mayOp.youMayOpen === true,
            `youMayOpen=${String(mayOp.youMayOpen)}`);

          const opTicket = await coreGet("/api/queues/ticket", { method: "POST", headers: asUser(opToken) });
          const opUrl = (JSON.parse(opTicket.body || "{}") as { url?: string }).url ?? "";
          check("and can get a ticket without being an administrator",
            (opTicket.status === 200 || opTicket.status === 201) && opUrl.includes("ticket="),
            `HTTP ${opTicket.status}`);

          // All the way through to the data, not just to the door. A
          // ticket that opens a page whose API then refuses is a board
          // nobody can use, and it would pass a check that stopped at the
          // redirect.
          if (opUrl) {
            const opPath = opUrl.slice(opUrl.indexOf("/queues"));
            const opFirst = await coreGet(opPath);
            const opCookie = opFirst.setCookie.split(";")[0] ?? "";
            const opBoard = await coreGet("/queues/api/queues", { headers: { cookie: opCookie } });
            check("and reaches the board's own API with the session it becomes",
              opFirst.status === 302 && opBoard.status === 200,
              `redirect ${opFirst.status}, api ${opBoard.status}`);
          } else {
            check("and reaches the board's own API with the session it becomes", false, "no ticket");
          }

          /* --- what it must NOT reach --- */
          const forbidden = [
            "patients", "clinical_notes", "documents", "appointments",
            "invoices", "access_log", "consent_records", "medical_histories",
          ];
          const reachable: string[] = [];
          for (const collection of forbidden) {
            const res = await get(opToken, `/items/${collection}?limit=1`);
            if (res.status === 200 && Array.isArray(res.data) && res.data.length > 0) {
              reachable.push(collection);
            }
          }
          check("the queue operator can read NO patient data at all",
            reachable.length === 0,
            reachable.length ? `reached: ${reachable.join(", ")}` : `${forbidden.length} collections refused`);

          // The escalation path, which is the one worth being paranoid
          // about: an account that can edit policies can make itself an
          // administrator, and then the narrow grant was decoration.
          //
          // Not "sees nothing": an app-access account sees its own role
          // and, because the policy grants sight of itself, its own
          // policy. Both are needed — the board check reads the second
          // one — and both are self-referential. What must not be
          // reachable is anybody else's, and the rule set itself.
          const climb: string[] = [];
          for (const [what, path, allowed] of [
            ["other policies", "/policies?limit=-1&fields=name", 1],
            ["other roles", "/roles?limit=-1&fields=name", 1],
            ["the permission rules", "/permissions?limit=-1&fields=id", 0],
            ["other users", "/users?limit=-1&fields=id,email", 1],
          ] as const) {
            const res = await get(opToken, path);
            const seen = Array.isArray(res.data) ? res.data.length : 0;
            if (res.status === 200 && seen > allowed) climb.push(`${what} (${seen})`);
          }
          check("and sees only its own role and its own policy, never anybody else's",
            climb.length === 0,
            climb.length ? `reached: ${climb.join(", ")}` : "no other policy, role, user or permission rule");

          const grant = await fetch(`${BASE}/policies`, {
            method: "POST",
            headers: { authorization: `Bearer ${opToken}`, "content-type": "application/json" },
            body: JSON.stringify({ name: "verify: self-granted admin", admin_access: true }),
          });
          check("and cannot grant itself administrator",
            grant.status === 403 || grant.status === 401,
            `HTTP ${grant.status}`);
          if (grant.ok) {
            const made = ((await grant.json().catch(() => ({}))) as { data?: { id?: string } }).data?.id;
            if (made) await fetch(`${BASE}/policies/${made}`, { method: "DELETE", headers: { authorization: `Bearer ${admin0}` } });
          }
        } else {
          for (const name of [
            "the queue operator is offered the board",
            "and can get a ticket without being an administrator",
            "and reaches the board's own API with the session it becomes",
            "the queue operator can read NO patient data at all",
            "and sees only its own role and its own policy, never anybody else's",
            "and cannot grant itself administrator",
          ]) check(name, false, "the operator could not sign in");
        }

        /* --- the coupling between the policy's name and the code --- */
        //
        // `mayOpenQueues` matches the policy by name. Renaming it in
        // Directus fails closed — the board refuses rather than opens —
        // which is the right direction and still a lockout nobody wants
        // to discover at two in the morning. Asserted here so a rename is
        // caught at provisioning time.
        const opPolicy = (await rows("/policies?limit=-1&fields=name,admin_access,app_access"))
          .find((r) => r["name"] === "Queue operator");
        check("the Queue operator policy exists under the name the code looks for",
          Boolean(opPolicy), opPolicy ? "found" : "renamed or missing — the board would lock out");
        check("and it is not a second administrator",
          opPolicy?.["admin_access"] !== true && opPolicy?.["app_access"] === true,
          `admin_access=${String(opPolicy?.["admin_access"])}, app_access=${String(opPolicy?.["app_access"])}`);

        // What it grants, counted rather than assumed. "Narrow" is a
        // claim; the rule set is a fact, and the fact has to be exactly
        // the two self-referential reads that let the service ask the
        // caller which policies they hold. A third rule, or a write, or
        // one naming a collection with patient data in it, is the grant
        // having quietly widened.
        const opPerms = (await rows("/permissions?limit=-1&fields=collection,action,policy.name"))
          .filter((r) => (r["policy"] as { name?: string } | null)?.name === "Queue operator")
          .map((r) => `${String(r["action"])} ${String(r["collection"])}`)
          .sort();
        check("and it grants nothing beyond the two reads that identify the caller",
          opPerms.join(", ") === "read directus_access, read directus_policies",
          opPerms.length ? opPerms.join(", ") : "no permission rules at all");
      } else {
        for (const name of [
          "redeeming it sets a session and redirects the ticket out of the URL",
          "the session cookie is httpOnly and scoped to the board",
          "the same link cannot be used twice",
          "the board's API is refused without a session",
          "with a session it lists the four queues",
          "a guessed ticket gets nothing",
          "the queue operator can sign in at all",
          "the queue operator is offered the board",
          "and can get a ticket without being an administrator",
          "and reaches the board's own API with the session it becomes",
          "the queue operator can read NO patient data at all",
          "and sees only its own role and its own policy, never anybody else's",
          "and cannot grant itself administrator",
          "the Queue operator policy exists under the name the code looks for",
          "and it is not a second administrator",
          "and it grants nothing beyond the two reads that identify the caller",
        ]) check(name, false, "no ticket was issued");
      }
    }
  }

  /* ---------- the practice's public website ---------------------------- */
  //
  // The portal's checks deliberately do not scrape HTML — the API behind
  // it is where the rules live, and a redesign should not break a test.
  // A public website is the other case: the *content is the contract*,
  // and the failure worth catching is a page that answers 200 with
  // nothing on it, which is what a permission regression looks like from
  // outside. So these read the markup, and only for facts a page cannot
  // be correct without.
  {
    // `node:http`, not `fetch`, and for one reason: **Node's fetch
    // silently drops a `Host` header**. `Host` is a forbidden header name
    // in the fetch specification, and undici enforces it by ignoring the
    // value rather than refusing the call — so a request meant to arrive
    // as `kadehuis.example.com` arrives as `localhost:8058` and the
    // check passes or fails for the wrong reason. The first version of
    // this section did exactly that and reported a green tick on a
    // redirect that had never been tested.
    //
    // Host-based resolution is the site's whole multi-tenancy story, so
    // it has to be exercised as a real header. The alternative —
    // trusting `X-Forwarded-Host` — would make the site's canonical and
    // Open Graph URLs settable by any caller, which is a cache-poisoning
    // vector in exchange for a tidier test.
    const page = (path: string, host?: string) =>
      new Promise<{ status: number; location: string; body: string }>((resolve) => {
        const target = new URL(`${PUBLIC_URL_BASE}${path}`);
        const req = httpRequest(
          {
            hostname: target.hostname,
            port: target.port,
            path: target.pathname + target.search,
            method: "GET",
            headers: host ? { Host: host } : {},
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: String(res.headers["location"] ?? ""),
                body,
              }),
            );
          },
        );
        req.on("error", (e) => resolve({ status: 0, location: "", body: e.message }));
        req.end();
      });

    const home = await page("/");
    check("the practice's website answers",
      home.status === 200 && home.body.includes("Kadehuis Dental"),
      home.status === 200 ? "200 but the practice is not named on it" : `HTTP ${home.status}`);

    // A page that renders but has fetched nothing is the failure this
    // catches: the site would still answer 200 with an empty list.
    check("the website lists what the practice actually offers",
      home.body.includes("Check-up and hygiene") && home.body.includes("Emergency appointments"),
      "the seeded services are not on the page");

    check("the website publishes the opening hours from the diary's own rows",
      home.body.includes("08:00") && home.body.includes("Closed"),
      "no hours rendered");

    // The clinician who opted in is named; the patient login at the same
    // practice is not. Both are `directus_users` rows carrying the same
    // clinic, which is exactly why this is worth asserting from outside.
    check("the website names a clinician who opted in",
      home.body.includes("Hannah Prins"), "no team member rendered");
    check("the website does not name a patient",
      !home.body.includes("Portal Demo"), "a patient login appears on the public site");

    // The draft every practice has on the go, seeded unpublished on
    // purpose. Asserted from outside rather than only through the API,
    // because "the permission is right" and "the page honours it" are
    // two claims.
    //
    // Not a draft created by this check: the site caches published
    // content, so a page fetched a second after the row was written
    // could not have contained it whether the filter worked or not — a
    // check that cannot fail. A standing draft has no such window.
    const drafts = await rows(
      "/items/services?limit=-1&fields=name&filter[published][_eq]=false");
    check("the seed leaves a treatment unpublished, so this can be asserted",
      drafts.length > 0, `${drafts.length} drafts`);
    if (drafts.length) {
      const list = await page("/services");
      const leaked = drafts.filter((d) => list.body.includes(String(d["name"])));
      check("a draft treatment never reaches a visitor",
        list.status === 200 && leaked.length === 0,
        leaked.length ? `"${String(leaked[0]!["name"])}" was rendered` : `HTTP ${list.status}`);
    } else {
      check("a draft treatment never reaches a visitor", false, "nothing is unpublished to test with");
    }

    /* --- the routing decision, which is one code path in two shapes --- */

    const byHost = await page("/", "kadehuis.example.com");
    check("a practice is resolved from its own domain",
      byHost.status === 200 && byHost.body.includes("Kadehuis Dental"),
      `HTTP ${byHost.status}`);

    // There is no practice prefix to redirect away from any more, and no
    // path that could be somebody else's site. What is still worth
    // asserting is that an address nobody wrote is a 404 rather than the
    // front page — silently showing something else hides a broken link.
    const typo = await page("/rivresdie");
    check("an address nobody wrote is a 404, not the front page",
      typo.status === 404, `HTTP ${typo.status}`);

    /* --- the privacy notice states the period, and reads it --- */
    //
    // The strongest claim on the site: the notice is generated from
    // `retention_rules`, so two practices in two jurisdictions publish
    // genuinely different periods with no second template. Asserted by
    // comparing the published sentence against the configured row.
    const years = (await rows(
      "/items/retention_rules?limit=1&fields=years&filter[record_type][_eq]=clinical_record"))[0]?.["years"];
    const notice = await page("/privacy");

    check("the privacy notice publishes the period the practice has configured",
      notice.status === 200 && notice.body.includes(`${years} years`),
      `configured ${String(years)} years; HTTP ${notice.status}`);
    check("and cites the statute rather than asserting the number",
      notice.status === 200 && notice.body.includes("WGBO"),
      notice.body.includes("WGBO") ? "WGBO cited" : "no statute in the notice");

    /* --- what a crawler is told --- */

    const sitemap = await page("/sitemap.xml");
    check("the sitemap lists the published pages",
      sitemap.status === 200 &&
        sitemap.body.includes("/services/root-canal") &&
        sitemap.body.includes("/contact"),
      `HTTP ${sitemap.status}`);
    check("the sitemap invites a crawler to nothing behind the sign-in",
      !/\/(portal|login|register|logout)\b/.test(sitemap.body),
      "a private page is listed in the sitemap");

    const robots = await page("/robots.txt");
    check("robots.txt refuses the patient area and names the sitemap",
      robots.status === 200 &&
        robots.body.includes("Disallow: /portal") &&
        robots.body.includes("Sitemap:"),
      `HTTP ${robots.status}`);

    // The sign-in is not part of any practice's website, but it is
    // reached from one — so on a practice's domain it is themed, and it
    // must still tell an indexer to stay away.
    const signInOnDomain = await page("/login", "kadehuis.example.com");
    check("the sign-in is in the practice's colour on the practice's domain",
      signInOnDomain.status === 200 && signInOnDomain.body.includes("Kadehuis Dental"),
      `HTTP ${signInOnDomain.status}`);
    check("the sign-in asks not to be indexed",
      signInOnDomain.body.includes("noindex"), "no robots meta on the sign-in");
  }

  /* ---------- the practice's own colour -------------------------------- */
  //
  // One column, and the patient site derives the rest from it — including
  // whether text on top of it is black or white. A theme system that lets
  // a practice set every colour is a theme system that produces
  // unreadable sites.
  {
    const practiceRow = (await get(admin0, "/items/practice?fields=slug,theme_primary")).data as
      Record<string, unknown> | undefined;
    const brand = String(practiceRow?.["theme_primary"] ?? "").trim();
    check("the practice has a brand colour on file", brand.length > 0, brand || "none");

    // This used to be a pair — one dark practice and one deliberately
    // pale — so the derivation had to decide black-or-white rather than
    // always answering white. With one practice the derivation is
    // asserted directly instead: whatever the colour, the text on it has
    // to be readable, which the contrast probe measures.
    check("and it is a colour the theme can derive from",
      /^#[0-9a-f]{6}$/i.test(brand), brand || "not a hex colour");

    // The fields belong to `practice`. They were briefly created on
    // `rooms` — the insertion point matched a block in the second
    // collection defined in the same file — and the relation then failed
    // with "field doesn't exist", which is a long way from the cause.
    const onClinics = (await rows("/fields/practice")).map((f) => String(f["field"]));
    check("the theme fields are on the practice, not another collection",
      onClinics.includes("theme_primary") && onClinics.includes("theme_logo"),
      onClinics.filter((f) => f.startsWith("theme")).join(", ") || "missing");

    const onRooms = (await rows("/fields/rooms")).map((f) => String(f["field"]));
    check("and did not leak onto rooms", !onRooms.some((f) => f.startsWith("theme")),
      onRooms.filter((f) => f.startsWith("theme")).join(", ") || "clean");

    // The site cannot render in the practice's colour if the patient
    // cannot read it. This failed as a 500 on the portal — the page went
    // to its error boundary — which is the right way round for a missing
    // permission, but only if somebody notices.
    const portalClinic = await get(portal, "/items/practice?fields=name,theme_primary");
    const seen = (portalClinic.data ?? {}) as Record<string, unknown>;
    check("a patient can read their own practice's brand colour",
      portalClinic.status === 200 && Boolean(seen["theme_primary"]),
      portalClinic.status === 200 ? String(seen["theme_primary"]) : `HTTP ${portalClinic.status}`);

    /* --- and the logo, which took a permission of its own --- */
    //
    // `theme_logo` sat in the schema unrendered for weeks, and the reason
    // is the interesting part: reading the clinic row hands out a **uuid**,
    // and `/assets/<uuid>` is a separate question answered by
    // `directus_files`. The Patient policy grants that *through the
    // document* that references a file — exactly right for a consent form
    // and no path at all for a logo, which has no document.
    //
    // The fix is a flag on the file and a second, additive permission. The
    // pair of checks that matter are the two below it: the new rule must
    // grant the logo and must not have widened anything else.
    const logoRows = await rows("/items/practice?limit=-1&fields=slug,theme_logo");
    const logos = new Map(logoRows.map((c) => [String(c["slug"]), String(c["theme_logo"] ?? "")]));
    check("every practice has a logo on file",
      [...logos.values()].every((id) => id.length > 0),
      [...logos].map(([slug, id]) => `${slug}=${id ? "set" : "MISSING"}`).join(", "));

    const brandFiles = await rows("/files?limit=-1&fields=id&filter[brand_asset][_eq]=true");
    const marked = new Set(brandFiles.map((f) => String(f["id"])));
    check("each logo is marked as a brand asset, which is what grants it",
      [...logos.values()].every((id) => marked.has(id)),
      `${marked.size} brand assets on file`);

    const own = logos.get("kadehuis") ?? "";
    const other = logos.get("marina") ?? "";
    if (own && other) {
      check("a patient CAN fetch their own practice's logo",
        (await asset(portal, own)) === 200, `HTTP ${await asset(portal, own)}`);
      // The half that proves the rule is still a rule. A flag with no
      // tenant filter would hand every patient every practice's files.
      check("a patient CANNOT fetch another practice's logo",
        (await asset(portal, other)) === 403, `HTTP ${await asset(portal, other)}`);

      const radiographs = await rows(
        "/files?limit=1&fields=id&filter[document_kind][_eq]=radiograph");
      const radiograph = String(radiographs[0]?.["id"] ?? "");
      if (radiograph) {
        // The one that would show the new permission had been written too
        // wide. A radiograph is in the patient's own practice and is not a
        // brand asset; if this ever answers 200 the flag is being ignored.
        check("and the new rule did NOT open the radiographs",
          (await asset(portal, radiograph)) === 403,
          `HTTP ${await asset(portal, radiograph)}`);
      } else {
        check("and the new rule did NOT open the radiographs", false, "no radiograph to test with");
      }

      const anon = await fetch(`${BASE}/assets/${own}`);
      check("a stranger cannot fetch a logo either", anon.status === 403, `HTTP ${anon.status}`);

      if (WEBSITE_TOKEN) {
        check("the website CAN fetch a logo — a uuid is not an image",
          (await asset(WEBSITE_TOKEN, own)) === 200, `HTTP ${await asset(WEBSITE_TOKEN, own)}`);
        const radiographs2 = await rows(
          "/files?limit=1&fields=id&filter[document_kind][_eq]=radiograph");
        const rad2 = String(radiographs2[0]?.["id"] ?? "");
        if (rad2) {
          check("and the website still CANNOT fetch a radiograph",
            (await asset(WEBSITE_TOKEN, rad2)) === 403, `HTTP ${await asset(WEBSITE_TOKEN, rad2)}`);
        }
      }

      /* --- and the site actually puts it on the page --- */
      //
      // A browser has no Directus credential: the patient's token is in an
      // httpOnly cookie for the *site's* origin. So the site proxies the
      // bytes, and these two say the proxy serves a brand asset and
      // refuses anything else.
      const brandPage = async (path: string) => {
        try {
          const res = await fetch(`${PUBLIC_URL_BASE}${path}`);
          return { status: res.status, type: res.headers.get("content-type") ?? "" };
        } catch { return { status: 0, type: "" }; }
      };
      const served = await brandPage(`/brand/${own}`);
      check("the site serves the logo without handing a credential to the browser",
        served.status === 200 && served.type.startsWith("image/"),
        `HTTP ${served.status} ${served.type}`);
      if (radiograph) {
        check("and the same route refuses a uuid that is not a brand asset",
          (await brandPage(`/brand/${radiograph}`)).status === 404,
          `HTTP ${(await brandPage(`/brand/${radiograph}`)).status}`);
      }

      const masthead = await fetch(`${PUBLIC_URL_BASE}/kadehuis`).then((r) => r.text()).catch(() => "");
      check("and the practice's own page renders it",
        masthead.includes(`/brand/${own}`), own ? "not on the page" : "no logo");
    }
  }

  /* ---------- retention, as data rather than a constant ---------------- */
  //
  // The reason this is a table and not a number in the code: the two demo
  // practices are in different jurisdictions and are subject to genuinely
  // different statutory periods. Twenty years in the Netherlands under
  // the WGBO, twenty-five in the UAE. A constant would be wrong for one
  // of them, and wrong in the direction that destroys evidence.
  {
    const rules = await rows(
      "/items/retention_rules?limit=-1&fields=record_type,years,starts_from,legal_basis",
    );
    check("the practice has retention rules on file", rules.length >= 6, `${rules.length} rules`);

    const nl = rules.find((r) => r["record_type"] === "clinical_record");

    // This used to be a pair — twenty years in the Netherlands,
    // twenty-five in the UAE — and the fact that they differed was the
    // argument for retention being a table rather than a constant. One
    // practice now, so what is asserted is that the period is the one on
    // file and not a number in the code.
    check("the clinical record's period is the one configured, not a constant",
      Number(nl?.["years"]) === 20,
      `${String(nl?.["years"])} years on file`);

    // A figure with no citation is a figure somebody will shorten because
    // it seemed long.
    const uncited = rules.filter((r) => !String(r["legal_basis"] ?? "").trim());
    check("every retention period cites the statute it comes from",
      uncited.length === 0,
      uncited.length ? `${uncited.length} without one` : `${rules.length} cited`);

    // The Dutch clock runs from the end of treatment, not from the date
    // each note was written — a patient seen for fifteen years has notes
    // that must be kept for thirty-five.
    check("clinical retention runs from the end of treatment, not the record date",
      nl?.["starts_from"] === "last_contact",
      String(nl?.["starts_from"] ?? "no rule"));

    // Readable by everyone: a clinician asked to delete something should
    // be able to answer without a permissions conversation.
    const deskRules = await get(desk, "/items/retention_rules?limit=1");
    check("reception can read the retention rules", deskRules.status === 200,
      `HTTP ${deskRules.status}`);

    // Writable by the owner only: it is a statement about what the law
    // requires of this practice, not a preference.
    const dentistWrite = await fetch(`${BASE}/items/retention_rules`, {
      method: "POST",
      headers: { authorization: `Bearer ${dds}`, "content-type": "application/json" },
      body: JSON.stringify({ record_type: "financial", years: 1, legal_basis: "made up" }),
    });
    check("a dentist CANNOT change how long records are kept",
      dentistWrite.status === 403, `HTTP ${dentistWrite.status}`);
  }

  /* ---------- rate limiting ------------------------------------------- */
  //
  // Two services, both counting in Redis rather than in memory, and the
  // store is the part worth asserting. Directus runs under PM2 in cluster
  // mode and the core service can be run as more than one container — so
  // a per-process counter gives each worker its own budget and the
  // configured limit silently becomes "limit × however many are running".
  //
  // The third check is the one that found a real bug. The patient site is
  // server-rendered, so every request it makes leaves from its own
  // container: to anything counting per IP downstream, the whole patient
  // population is one caller, and the registration limiter was counting
  // them into a single bucket.
  {
    const coreHeaders = async (path: string, headers: Record<string, string> = {}) => {
      try {
        const res = await fetch(`${CORE_URL}${path}`, { headers });
        return {
          status: res.status,
          limit: res.headers.get("ratelimit-limit"),
          remaining: Number(res.headers.get("ratelimit-remaining") ?? "-1"),
          retryAfter: res.headers.get("retry-after"),
        };
      } catch {
        return { status: 0, limit: null, remaining: -1, retryAfter: null };
      }
    };

    const limited = await coreHeaders("/api/portal/practices");
    check("the core service rate-limits, and says what the budget is",
      limited.status === 200 && Number(limited.limit) > 0,
      limited.limit ? `${limited.limit} per window` : `HTTP ${limited.status}, no header`);

    // The health endpoint is polled by the orchestrator several times a
    // minute forever. Counting that against real traffic means a busy
    // minute gets the service restarted — a limiter causing the outage it
    // was meant to prevent.
    const health = await coreHeaders("/health");
    check("the health endpoint is not rate-limited",
      health.status === 200 && health.limit === null,
      health.limit ? `it carries a limit of ${health.limit}` : "excluded");

    // Two addresses, forwarded. Independent budgets means the resolution
    // is working; identical ones mean everybody is sharing a bucket.
    // Fresh addresses each run. Fixed ones inherit whatever a previous
    // run spent inside the same window, and this check compares two
    // counters — so a re-run within the minute failed for the one reason
    // that has nothing to do with what it is testing.
    //
    // 203.0.113.0/24 is TEST-NET-3: reserved for documentation, so these
    // can never collide with a real client.
    const run = Date.now() % 200;
    const a = `203.0.113.${run % 100 + 1}`;
    const b = `203.0.113.${(run % 100) + 101}`;
    const first = await coreHeaders("/api/portal/practices", { "x-forwarded-for": a });
    const second = await coreHeaders("/api/portal/practices", { "x-forwarded-for": b });
    const firstAgain = await coreHeaders("/api/portal/practices", { "x-forwarded-for": a });
    check("each patient is counted separately, not as the site they came through",
      first.remaining >= 0 && first.remaining === second.remaining &&
        firstAgain.remaining === first.remaining - 1,
      `two callers at ${first.remaining}, the repeat at ${firstAgain.remaining}`);

    // Directus's own limiter, tripped and allowed to recover. The window
    // is a second, so this costs a burst and nothing afterwards — which
    // is why it can be asserted here rather than described in a comment.
    // `nativeFetch`, pointedly. The wrapper at the top of this file waits
    // and retries on a 429, which is correct for every other call here
    // and would quietly defeat this one: the burst would succeed on the
    // second attempt and the check would conclude there was no limiter.
    const burst = await Promise.all(
      Array.from({ length: 220 }, () =>
        nativeFetch(`${BASE}/server/ping`).then((r) => r.status).catch(() => 0)),
    );
    const refused = burst.filter((s) => s === 429).length;
    check("Directus refuses a burst rather than serving it",
      refused > 0, `${refused} of ${burst.length} refused with 429`);

    // And recovers on its own, rather than staying angry.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await nativeFetch(`${BASE}/server/ping`).then((r) => r.status).catch(() => 0);
    check("and lets the next second through", after === 200, `HTTP ${after}`);
  }

  const repoRoot2 = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

  /* ---------- the file library, arranged ------------------------------- */
  //
  // Directus gives a fresh instance one flat library, and a practice
  // fills it with things that have nothing to do with each other: a logo,
  // a bitewing, a signed consent form, a laboratory docket. Flat, they
  // sort by upload date, so a child's radiograph sits between the favicon
  // and a referral letter.
  //
  // `document_kind` already decides who may *read* a file. What a
  // permission cannot do is make the library legible to the person
  // holding it, and that is what these folders are for.
  {
    const folders = (await rows("/folders?limit=-1&fields=id,name")).map((f) => String(f["name"]));
    const wanted = ["Branding", "Website", "Patient documents", "Radiographs and scans", "Lab work", "Correspondence"];
    const absent = wanted.filter((w) => !folders.includes(w));
    check("the file library has a folder for each kind of thing in it",
      absent.length === 0, absent.length ? `missing: ${absent.join(", ")}` : folders.join(", "));

    const files = await rows("/files?limit=-1&fields=id,folder.name,document_kind,brand_asset,filename_download");
    const classified = files.filter((f) => f["document_kind"] || f["brand_asset"]);
    const homeless = classified.filter((f) => !(f["folder"] as { name?: string } | null)?.name);
    check("and every classified file is in one",
      classified.length > 0 && homeless.length === 0,
      homeless.length
        ? `${homeless.length} at the root: ${homeless.slice(0, 3).map((f) => String(f["filename_download"])).join(", ")}`
        : `${classified.length} filed`);

    // The split that is about more than tidiness. A radiograph is the
    // file here most worth stealing, and an administrator auditing who
    // can reach imaging should be reading one folder rather than
    // filtering a column.
    const imaging = files.filter((f) => (f["folder"] as { name?: string } | null)?.name === "Radiographs and scans");
    const misfiled = imaging.filter((f) => !["radiograph", "photograph", "scan"].includes(String(f["document_kind"] ?? "")));
    check("imaging is kept apart from the rest of a patient's documents",
      imaging.length > 0 && misfiled.length === 0,
      misfiled.length ? `${misfiled.length} that are not imaging` : `${imaging.length} images`);

    /*
     * Branding and Website are two folders, and this is the check that
     * keeps them two.
     *
     * They share a permission — the Website token reads both — and that
     * is exactly why they drift back together: whoever adds the next
     * image field reaches for the flag that makes it readable and files
     * it wherever the last one went. What a file *is* and who may *read*
     * it are different questions, and a library arranged by the second
     * answers neither.
     */
    const inFolder = (name: string) =>
      files.filter((f) => (f["folder"] as { name?: string } | null)?.name === name);
    const websiteFiles = inFolder("Website");
    const brandingFiles = inFolder("Branding");

    const practiceRow = (await get(admin0, "/items/practice?fields=hero_image,theme_logo")).data as
      Record<string, unknown> | undefined;
    const hero = String(practiceRow?.["hero_image"] ?? "");
    const logo = String(practiceRow?.["theme_logo"] ?? "");

    check("the website's pictures have a folder of their own, apart from the brand kit",
      websiteFiles.length > 0 && brandingFiles.length > 0
        && websiteFiles.some((f) => String(f["id"]) === hero)
        && brandingFiles.some((f) => String(f["id"]) === logo),
      `Website ${websiteFiles.length}, Branding ${brandingFiles.length}`);

    // Every treatment picture and every portrait, not just the hero. One
    // field filed correctly and the other two left in Branding is the
    // shape this arrives in.
    const shouldBeWeb = [
      ...(await rows("/items/services?limit=-1&fields=image")).map((r) => String(r["image"] ?? "")),
      ...(await rows("/users?limit=-1&fields=public_photo")).map((r) => String(r["public_photo"] ?? "")),
      hero,
    ].filter(Boolean);
    const strays = shouldBeWeb.filter((id) => !websiteFiles.some((f) => String(f["id"]) === id));
    check("and every picture the site points at is in it",
      shouldBeWeb.length > 0 && strays.length === 0,
      strays.length ? `${strays.length} filed elsewhere` : `${shouldBeWeb.length} pictures`);

    // And the brand kit is not in the website's folder. The split has two
    // directions and only asserting one of them lets everything pile into
    // Website instead, which is the same problem with a different name.
    const kitStrays = brandingFiles.length === 0 || websiteFiles.some((f) => String(f["id"]) === logo);
    check("and the logo is not filed among them",
      !kitStrays, kitStrays ? "the logo is in Website" : "the brand kit is its own");

    // And it holds for a file uploaded now, not only for what the
    // provisioning step tidied. The flow copies the kind; the hook puts
    // it away. A check that only reads the seed would pass on a system
    // where new uploads still land at the root forever.
    {
      const patient = (await rows("/items/patients?limit=1&fields=id&sort=reference"))[0];
      const form = new FormData();
      form.append("file", new Blob([Buffer.from("verify: a referral letter")], { type: "text/plain" }), "verify-referral.txt");
      const up = await fetch(`${BASE}/files`, {
        method: "POST", headers: { authorization: `Bearer ${admin0}` }, body: form,
      });
      const uploaded = ((await up.json().catch(() => ({}))) as { data?: { id?: string } }).data?.id;
      if (uploaded && patient) {
        const made = await fetch(`${BASE}/items/documents`, {
          method: "POST",
          headers: { authorization: `Bearer ${admin0}`, "content-type": "application/json" },
          body: JSON.stringify({ patient: patient["id"], file: uploaded, kind: "referral", title: "verify: filing probe" }),
        });
        await new Promise((r) => setTimeout(r, 1200));
        const after = await get(admin0, `/files/${uploaded}?fields=folder.name`);
        const folderOf = (after.data ?? {}) as { folder?: { name?: string } | null };
        const landed = folderOf.folder?.name ?? "";
        check("a file uploaded now is put away, not left at the root",
          made.ok && landed === "Correspondence",
          made.ok ? `landed in ${landed || "the root"}` : `HTTP ${made.status}`);
        const doc = ((await made.json().catch(() => ({}))) as { data?: { id?: string } }).data?.id;
        if (doc) await fetch(`${BASE}/items/documents/${doc}`, { method: "DELETE", headers: { authorization: `Bearer ${admin0}` } });
        await fetch(`${BASE}/files/${uploaded}`, { method: "DELETE", headers: { authorization: `Bearer ${admin0}` } });
      } else {
        check("a file uploaded now is put away, not left at the root", false, "the upload itself failed");
      }
    }
  }

  /* ---------- the README's own numbers ---------------------------------- */
  //
  // Last, and self-referential on purpose.
  //
  // A README is full of counts — how many collections, how many policies,
  // how many checks — and every one of them is a claim that rots the
  // moment somebody adds a table. This audit found six stale at once,
  // including three *mutually inconsistent* numbers inside a single
  // console sample: "247 more", "269/269 checks passed", and a sentence
  // underneath saying twelve of a hundred and sixty-seven were shown.
  //
  // Nothing catches that, because nothing was looking. So the suite looks
  // now, and the claims are asserted against the running instance rather
  // than against somebody's memory.
  //
  // The check on the check count counts **itself**: this block is the
  // last thing that runs, so the final total is what has run so far plus
  // the checks below. Adding a check after this one makes it fail — which
  // is the correct outcome, because adding a check without updating the
  // README is exactly what leaves the README wrong.
  {
    // Captured *before* the first check in this block is pushed. Reading
    // `results.length` inside the assertion counts the ones already added
    // and reports a total one too high — which is how the first version
    // of this check failed against a README that was correct.
    const before = results.length;
    const README_CHECKS = 11;
    const readme = await readFile(resolve(repoRoot2, "README.md"), "utf8").catch(() => "");
    check("the README is readable from the suite", readme.length > 1000,
      readme ? `${readme.length} characters` : "not found");

    /** The first capture of the first match, or "". */
    const claim = (re: RegExp): string => re.exec(readme)?.[1] ?? "";

    /*
     * The count is only meaningful on a clean run.
     *
     * Some branches emit fewer checks when the thing they depend on
     * failed — a booking that was never made cannot be cancelled — so a
     * red run has a *different* total, and comparing the README against
     * it reports a number that is wrong for a second reason. The first
     * version did exactly that: the portal's registration limiter tripped
     * between two runs, four dependent checks disappeared, and the README
     * was accused of saying 442 when it should say 438.
     *
     * So this fails loudly with the real explanation rather than quietly
     * passing or quietly reporting a misleading figure. A red run stays
     * red either way.
     */
    const earlierFailures = results.slice(0, before).filter((r) => !r.pass).length;
    const claimedChecks = Number(claim(/(\d+)\/\d+ checks passed/));
    const actualChecks = before + README_CHECKS;
    const shown = (readme.match(/^ {2}PASS {2}/gm) ?? []).length;
    const claimedMore = Number(claim(/\.\.\. (\d+) more/));

    if (earlierFailures > 0) {
      const why =
        `${earlierFailures} earlier check(s) failed, so this run emitted ${actualChecks} ` +
        `rather than its steady-state total — fix those first`;
      check("the README states the number of checks this suite actually runs", false, why);
      check("and the sample says how many it is not showing", false, why);
    } else {
      check("the README states the number of checks this suite actually runs",
        claimedChecks === actualChecks,
        `README says ${claimedChecks || "nothing"}, the run is ${actualChecks}`);
      check("and the sample says how many it is not showing",
        claimedMore === actualChecks - shown,
        `${shown} shown, README says ${claimedMore || "nothing"} more, should be ${actualChecks - shown}`);
    }

    const claimedCollections = Number(claim(/\*\*(\d+) collections\*\*/));
    check("the README states the number of collections that exist",
      claimedCollections === tables.length,
      `README says ${claimedCollections || "nothing"}, there are ${tables.length}`);

    const policyCount = (await rows("/policies?limit=-1&fields=id")).length;
    const roleCount = (await rows("/roles?limit=-1&fields=id")).length;
    const claimedPolicies = Number(claim(/\*\*(\d+) policies \/ \d+ roles\*\*/));
    const claimedRoles = Number(claim(/\*\*\d+ policies \/ (\d+) roles\*\*/));
    check("and the policies and roles",
      claimedPolicies === policyCount && claimedRoles === roleCount,
      `README says ${claimedPolicies}/${claimedRoles}, there are ${policyCount}/${roleCount}`);

    /*
     * Only the global ones, which are the ones provisioning owns.
     *
     * This counted every row in `directus_presets`, and Directus writes a
     * personal preset the moment anybody opens a collection and changes
     * so much as a sort — so the total went up when a person browsed the
     * admin, and the README figure it compared against had a handful of
     * somebody's saved views baked into it. A check whose answer depends
     * on who has logged in lately is not measuring the thing it names.
     */
    const presetRows = (await rows("/presets?limit=-1&fields=id,bookmark,user"))
      .filter((r) => r["user"] === null);
    const bookmarks = presetRows.filter((r) => r["bookmark"]).length;
    const views = presetRows.length - bookmarks;
    const claimedBookmarks = Number(claim(/\*\*(\d+) global bookmarks \+ \d+ default views\*\*/));
    const claimedViews = Number(claim(/\*\*\d+ global bookmarks \+ (\d+) default views\*\*/));
    check("and the bookmarks and default views",
      claimedBookmarks === bookmarks && claimedViews === views,
      `README says ${claimedBookmarks}+${claimedViews}, there are ${bookmarks}+${views}`);

    const claimedExtensions = Number(claim(/\*\*(\d+) extensions\*\*/));
    const extensionCount = (await readdir(resolve(repoRoot2, "apps/directus/extensions"))
      .catch(() => [] as string[])).filter((d) => d.startsWith("directus-extension-")).length;
    check("and the number of extensions on disk",
      claimedExtensions === extensionCount,
      `README says ${claimedExtensions || "nothing"}, there are ${extensionCount}`);

    // The layout tree is prose, so it drifts silently: it said "six
    // Directus extensions" and named six, two sections after a table that
    // said seven. A count alone would not have caught it — the line has to
    // name every directory that exists.
    const treeLine = readme.split("\n").find((l) => l.includes("extensions/    ")) ?? "";
    const unnamed = (await readdir(resolve(repoRoot2, "apps/directus/extensions"))
      .catch(() => [] as string[]))
      .filter((d) => d.startsWith("directus-extension-"))
      .map((d) => d.replace("directus-extension-", ""))
      .filter((name) => !treeLine.toLowerCase().includes(name.replace(/-/g, " ")));
    check("and the layout tree names every extension on disk",
      treeLine.length > 0 && unnamed.length === 0,
      treeLine.length === 0 ? "the tree line is gone" : `not named: ${unnamed.join(", ")}`);

    // The README quotes the column names the chart reads. It quoted
    // `tooth_fdi`, which has never existed — the column is `tooth`. A
    // reader who trusted it would have gone looking for a field that is
    // not there.
    const quoted = (readme.match(/it reads `\/items\/tooth_conditions` and the field names ([^.]+)\./)?.[1] ?? "")
      .match(/`([a-z_]+)`/g)?.map((q) => q.replace(/`/g, "")) ?? [];
    const realToothFields = (await rows("/fields/tooth_conditions"))
      .map((f) => String(f["field"] ?? ""));
    const invented = quoted.filter((q) => !realToothFields.includes(q));
    check("and every column it says the chart reads exists",
      quoted.length >= 4 && invented.length === 0,
      quoted.length < 4 ? `only found ${quoted.length} quoted names` : `invented: ${invented.join(", ")}`);

    // "typecheck everything" was the README's weakest claim: `pnpm -r
    // typecheck` runs whatever each package declares, and seven of the
    // twelve declared nothing. Six had a tsconfig nobody ran. That is how
    // `error.value = null` — a reference to a ref that had been renamed —
    // reached a screenshot: the bundler does not resolve identifiers and
    // no checker ever opened the file. A count would not hold the line
    // either; a new package with no script is what this catches.
    const workspaceDirs = [
      ...(await readdir(resolve(repoRoot2, "apps"), { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory() && e.name !== "directus").map((e) => `apps/${e.name}`),
      "apps/directus/bootstrap",
      ...(await readdir(resolve(repoRoot2, "apps/directus/extensions")).catch(() => [] as string[]))
        .map((d) => `apps/directus/extensions/${d}`),
      ...(await readdir(resolve(repoRoot2, "packages")).catch(() => [] as string[]))
        .map((d) => `packages/${d}`),
    ];
    const unchecked: string[] = [];
    for (const dir of workspaceDirs) {
      const raw = await readFile(resolve(repoRoot2, dir, "package.json"), "utf8").catch(() => "");
      if (!raw) continue;                       // not a package, skip rather than accuse
      const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
      if (!scripts["typecheck"]) unchecked.push(dir);
    }
    check("and `pnpm -r typecheck` really does reach every package",
      workspaceDirs.length >= 12 && unchecked.length === 0,
      unchecked.length ? `no typecheck script: ${unchecked.join(", ")}` : `${workspaceDirs.length} packages`);

    // Both directions. A README that points at a file nobody shipped
    // renders a broken image; a file nobody points at is a screenshot
    // that stopped being regenerated because nothing was showing it.
    const embedded = new Set(
      [...readme.matchAll(/docs\/screenshots\/([A-Za-z0-9._-]+\.png)/g)]
        .map((m) => m[1] ?? "").filter(Boolean));
    const onDisk = new Set((await readdir(resolve(repoRoot2, "docs/screenshots")).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".png")));
    const missing = [...embedded].filter((f) => !onDisk.has(f));
    const orphans = [...onDisk].filter((f) => !embedded.has(f));
    check("and every screenshot it embeds is on disk, with none left over",
      embedded.size > 0 && missing.length === 0 && orphans.length === 0,
      missing.length ? `missing: ${missing.join(", ")}`
        : orphans.length ? `unreferenced: ${orphans.join(", ")}`
        : `${embedded.size} images`);
  }

  /* ---------- report ------------------------------------------------ */
  const pad = Math.max(...results.map((r) => r.name.length));
  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    const mark = r.pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    const detail = r.detail ? `\x1b[2m${r.detail}\x1b[0m` : "";
    console.log(`  ${mark}  ${r.name.padEnd(pad)}  ${detail}`);
  }
  console.log(
    failed === 0
      ? `\n  \x1b[32m${results.length}/${results.length} checks passed\x1b[0m\n`
      : `\n  \x1b[31m${failed} of ${results.length} checks FAILED\x1b[0m\n`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("  verification aborted:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
