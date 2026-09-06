/**
 * Access-control test suite.
 *
 * A permission model you haven't tried to break is a hope, not a policy.
 * This logs in as each role and asserts both directions: what they must
 * be able to do, and what they must not. It is the file to run after any
 * change to access/policies.ts.
 */

import { URL_BASE, DEMO_PASSWORD } from "./env.js";

const BASE = URL_BASE;

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];

function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  const body = (await res.json()) as { data?: { access_token: string } };
  if (!body.data?.access_token) throw new Error(`cannot log in as ${email}`);
  return body.data.access_token;
}

async function get(token: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as {
    data?: unknown[]; errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  return { status: res.status, data: body.data, errors: body.errors };
}

async function main() {
  console.log(`\n  Access-control checks against ${BASE}\n`);

  /* ---------- front desk: the headline claim ---------------------- */
  const desk = await login("desk@riverside.example.com");

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

  const deskInvoices = await get(desk, "/items/invoices?limit=1");
  check(
    "front desk CAN read invoices (it bills)",
    Array.isArray(deskInvoices.data),
    `HTTP ${deskInvoices.status}`,
  );

  /* ---------- hygienist: clinical yes, money no -------------------- */
  const hyg = await login("hygienist@riverside.example.com");

  const hygPatients = await get(hyg, "/items/patients?limit=1");
  const hygRow = (hygPatients.data?.[0] ?? {}) as Record<string, unknown>;
  check("hygienist CAN see medical_alerts", "medical_alerts" in hygRow);
  check("hygienist CAN read the tooth chart", (await get(hyg, "/items/tooth_conditions?limit=1")).status === 200);

  const hygInvoices = await get(hyg, "/items/invoices?limit=1");
  check("hygienist CANNOT read invoices", hygInvoices.status === 403, `HTTP ${hygInvoices.status}`);

  /* ---------- dentist: clinical write, billing read-only ----------- */
  const dds = await login("dentist@riverside.example.com");
  check("dentist CAN read invoices", (await get(dds, "/items/invoices?limit=1")).status === 200);

  const dentistWrite = await fetch(`${BASE}/items/invoices`, {
    method: "POST",
    headers: { authorization: `Bearer ${dds}`, "content-type": "application/json" },
    body: JSON.stringify({ number: "SHOULD-FAIL", patient: null }),
  });
  check("dentist CANNOT create an invoice", dentistWrite.status === 403, `HTTP ${dentistWrite.status}`);

  /* ---------- tenancy: the leak that matters ---------------------- */
  const marinaOwner = await login("owner@marina.example.com");
  const riversideOwner = await login("owner@riverside.example.com");

  const marinaPatients = await get(marinaOwner, "/items/patients?limit=-1&fields=id,clinic,reference");
  const riversidePatients = await get(riversideOwner, "/items/patients?limit=-1&fields=id,clinic,reference");

  const marinaRefs = new Set(((marinaPatients.data ?? []) as Array<{ reference: string }>).map((p) => p.reference));
  const riversideRefs = new Set(((riversidePatients.data ?? []) as Array<{ reference: string }>).map((p) => p.reference));
  const overlap = [...marinaRefs].filter((r) => riversideRefs.has(r));

  check(
    "each practice sees only its own patients",
    marinaRefs.size > 0 && riversideRefs.size > 0 && overlap.length === 0,
    `riverside ${riversideRefs.size}, marina ${marinaRefs.size}, overlap ${overlap.length}`,
  );

  const marinaClinics = await get(marinaOwner, "/items/clinics?limit=-1&fields=slug");
  check(
    "an owner sees only their own practice record",
    (marinaClinics.data ?? []).length === 1,
    `${(marinaClinics.data ?? []).length} clinics visible`,
  );

  // Fetch a Riverside patient id directly as the Marina owner.
  const target = ((riversidePatients.data ?? []) as Array<{ id: string }>)[0];
  if (target) {
    const crossRead = await get(marinaOwner, `/items/patients/${target.id}`);
    check(
      "direct fetch of another practice's patient by id is refused",
      crossRead.status === 403 || crossRead.status === 404,
      `HTTP ${crossRead.status}`,
    );
  }

  /* ---------- patient portal --------------------------------------- */
  const portal = await login("patient@riverside.example.com");
  const mine = await get(portal, "/items/patients?limit=-1&fields=id,reference");
  check("portal user sees exactly one patient record", (mine.data ?? []).length === 1, `${(mine.data ?? []).length} visible`);

  const portalNotes = await get(portal, "/items/patients?limit=1&fields=id,clinical_notes");
  const portalRow = (portalNotes.data?.[0] ?? {}) as Record<string, unknown>;
  check("portal user CANNOT read clinical notes", !("clinical_notes" in portalRow) || portalRow.clinical_notes === undefined);

  const portalOthers = await get(portal, "/items/appointments?limit=-1&fields=id,patient");
  const patientIds = new Set(((portalOthers.data ?? []) as Array<{ patient: string }>).map((a) => a.patient));
  check("portal user sees only their own appointments", patientIds.size <= 1, `${patientIds.size} distinct patients`);

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
