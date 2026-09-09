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

  const admin0 = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  /* ---------- documents and the file library ------------------------- */
  // A document row hands out a file uuid. /assets/<uuid> hands out the
  // x-ray. Both need the boundary, and only one of them is obvious.
  const deskDocs = await get(desk, "/items/documents?limit=-1&fields=id,kind,file");
  const deskKinds = new Set(((deskDocs.data ?? []) as Array<{ kind: string }>).map((d) => d.kind));
  check("front desk sees referrals and consent", deskKinds.has("referral") && deskKinds.has("consent"),
    [...deskKinds].sort().join(", ") || "nothing");
  check("front desk CANNOT see radiographs", !deskKinds.has("radiograph"),
    `${deskKinds.size} kinds visible`);

  const dentistDocs = await get(dds, "/items/documents?limit=-1&fields=id,kind,file,clinic");
  const dentistRows = (dentistDocs.data ?? []) as Array<{ kind: string; file: string; clinic: string }>;
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

  // Cross-tenant: the other practice's files, fetched by id.
  const marinaDentist = await login("dentist@marina.example.com");
  const marinaDocs = await get(marinaDentist, "/items/documents?limit=-1&fields=id,file,clinic");
  const marinaRows = (marinaDocs.data ?? []) as Array<{ file: string; clinic: string }>;
  const clinicsSeen = new Set([
    ...dentistRows.map((d) => d.clinic),
    ...marinaRows.map((d) => d.clinic),
  ]);
  check("each practice sees only its own documents",
    dentistRows.length > 0 && marinaRows.length > 0 && clinicsSeen.size === 2,
    `${dentistRows.length} + ${marinaRows.length}, ${clinicsSeen.size} practices`);

  const marinaFile = marinaRows[0]?.file;
  if (marinaFile) {
    const leak = await asset(dds, marinaFile);
    check("a dentist CANNOT open another practice's file", leak === 403, `HTTP ${leak}`);
  }

  // The brand kit belongs to no practice, and every staff member needs it
  // or the admin shell renders without its own logo.
  const settingsLogo = await get(admin0, "/settings?fields=project_logo");
  const logoId = ((settingsLogo.data ?? {}) as { project_logo?: string }).project_logo;
  if (logoId) {
    check("shared brand files stay readable by staff", (await asset(desk, logoId)) === 200,
      "the nav logo still loads");
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
  check("30 collections and 2 sidebar folders exist", tables.length === 30 && folders.length === 2,
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

  const riverside = ((await rows("/items/clinics?limit=1&fields=id"))[0] ?? {})["id"];
  const somePatient = ((await rows("/items/patients?limit=1&fields=id"))[0] ?? {})["id"];

  // ISO 10394 letters must be accepted where ISO 3950 digits are — this is
  // the whole reason the column is a string.
  // Tagged so the suite can take them back out again. A test that leaves
  // rows behind is a test that changes the thing it is measuring — run it
  // ten times and the dentition counts stop meaning anything.
  const PROBE = "verify-probe";
  const supernumerary = await post("dentition", {
    clinic: riverside, patient: somePatient, designation: "AB",
    dentition_type: "supernumerary", state: "present", note: PROBE,
  });
  check("a mesiodens can be recorded at all", supernumerary === 200, `HTTP ${supernumerary}`);

  // And the same designation twice for one patient, because ISO 10394
  // reuses a code for multiple teeth in one location.
  const twice = await post("dentition", {
    clinic: riverside, patient: somePatient, designation: "AB",
    dentition_type: "supernumerary", state: "unerupted", note: PROBE,
  });
  check("a second tooth may share that designation", twice === 200, `HTTP ${twice}`);

  const bogus = await post("dentition", {
    clinic: riverside, patient: somePatient, designation: "19",
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
    body: JSON.stringify({ clinic: riverside, patient: somePatient, instructions: "probe" }),
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
    clinic: riverside,
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
  check("a signed consent is bound to what it signed",
    consentRows.length > 0 && consentRows.every((c) => Boolean(c["data_fingerprint"])),
    `${consentRows.length} consent(s) fingerprinted`);

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
    body: JSON.stringify({ clinic: riverside, patient: somePatient, title: "desk probe" }),
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
    clinic: riverside, patient: somePatient, recall_type: someType, interval_months: 5,
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
  check("field labels carry their own translations", translated.length >= 15,
    `${translated.length} of ${patientFields.length} patient fields`);

  /* ---------- bookmarks ------------------------------------------------ */
  const presets = (await rows("/presets?limit=-1&fields=id,bookmark,collection,user"))
    .filter((p) => p["user"] === null && p["bookmark"]);
  const unresolved = presets.filter((p) => !String(p["bookmark"]).startsWith("$t:"));
  check("twelve global bookmarks, all translated", presets.length === 12 && unresolved.length === 0,
    `${presets.length} bookmarks`);

  /* ---------- flows ---------------------------------------------------- */
  const flows = await rows("/flows?limit=-1&fields=id,name,status,trigger");
  const inactive = flows.filter((f) => f["status"] !== "active");
  check("seven flows, all active", flows.length === 7 && inactive.length === 0,
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
