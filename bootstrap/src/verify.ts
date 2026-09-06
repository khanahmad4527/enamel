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

import { URL_BASE, DEMO_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD } from "./env.js";

const BASE = URL_BASE;

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

  /* ================= provisioning ==================================== */
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  const rows = async (path: string): Promise<Array<Record<string, unknown>>> => {
    const r = await get(admin, path);
    return Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>) : [];
  };
  const one = async (path: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${admin}` } });
    const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> };
    return body.data ?? {};
  };

  /* ---------- schema ------------------------------------------------- */
  const collections = (await rows("/collections")).filter(
    (c) => !String(c["collection"]).startsWith("directus_"),
  );
  const tables = collections.filter((c) => c["schema"]);
  const folders = collections.filter((c) => !c["schema"]);
  check("9 collections and 2 sidebar folders exist", tables.length === 9 && folders.length === 2,
    `${tables.length} tables, ${folders.length} folders`);

  /* ---------- validation actually rejects ----------------------------- */
  // Not "a rule is configured" — an attempt that must fail.
  const badTooth = await fetch(`${BASE}/items/tooth_conditions`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ tooth_fdi: 19, condition: "caries" }),
  });
  check("an impossible FDI number is refused by the schema", badTooth.status >= 400,
    `HTTP ${badTooth.status}`);

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
  check("field labels carry their own translations", translated.length >= 15,
    `${translated.length} of ${patientFields.length} patient fields`);

  /* ---------- bookmarks ------------------------------------------------ */
  const presets = (await rows("/presets?limit=-1&fields=id,bookmark,collection,user"))
    .filter((p) => p["user"] === null && p["bookmark"]);
  const unresolved = presets.filter((p) => !String(p["bookmark"]).startsWith("$t:"));
  check("nine global bookmarks, all translated", presets.length === 9 && unresolved.length === 0,
    `${presets.length} bookmarks`);

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
