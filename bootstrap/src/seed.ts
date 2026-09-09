import { api, must, authHeader } from "./client.js";
import { log } from "./log.js";

/**
 * Demo data. Two practices exist on purpose: a single-tenant seed can
 * hide a broken tenancy filter, because everything you can see happens
 * to be yours. With two, a leak is visible immediately — which is what
 * `pnpm verify` checks.
 *
 * Everything here is invented. Never point this at real patients.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEMO_PASSWORD } from "./env.js";

const DEMO_DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "demo", "documents");

/**
 * Uploads a demo document into the practice's file library.
 *
 * `clinic` is passed explicitly here because the seed runs as admin, and
 * the preset that stamps it for staff is attached to *their* create
 * permission, not to an administrator's. Without it every seeded file
 * would land unscoped and be visible to both practices — which is
 * exactly the leak the verify suite now checks for.
 */
async function uploadDemoFile(
  file: string,
  title: string,
  type: string,
  clinic: string,
): Promise<string | null> {
  const existing = await must<Array<{ id: string }>>(
    "find demo file",
    api.get(`/files?limit=1&fields=id&filter[title][_eq]=${encodeURIComponent(title)}`),
  );
  if (existing.length && existing[0]) return existing[0].id;

  const bytes = await readFile(join(DEMO_DOCS, file));
  const form = new FormData();
  form.append("title", title);
  form.append("clinic", clinic);
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), file);
  const res = await fetch(`${api.url}/files`, {
    method: "POST",
    headers: { authorization: authHeader() },
    body: form,
  });
  const body = (await res.json()) as { data?: { id: string }; errors?: unknown };
  if (!res.ok || !body.data) {
    log.fail(`upload ${file}: ${JSON.stringify(body.errors ?? body)}`);
    return null;
  }
  return body.data.id;
}

type Row = { id: string };

const pick = <T>(xs: readonly T[], i: number): T => xs[i % xs.length]!;

function at(dayOffset: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const FIRST = ["Sofie", "Lars", "Amara", "Tobias", "Meera", "Jonas", "Yasmin", "Pieter",
  "Noor", "Emil", "Fatima", "Daan", "Léa", "Mateo", "Anouk", "Ravi"] as const;
const LAST = ["de Vries", "Bakker", "Okafor", "Meyer", "Nair", "Andersen", "Haddad", "Jansen",
  "Rahman", "Lindqvist", "El Amrani", "Visser", "Moreau", "Silva", "Willems", "Iyer"] as const;

const TREATMENTS = [
  { code: "D0120", name: "Periodic oral evaluation", category: "diagnostic", duration_minutes: 20, default_price: 45, requires_tooth: false },
  { code: "D0274", name: "Bitewing radiographs (four films)", category: "diagnostic", duration_minutes: 15, default_price: 60, requires_tooth: false },
  { code: "D1110", name: "Prophylaxis — adult", category: "preventive", duration_minutes: 45, default_price: 85, requires_tooth: false },
  { code: "D1206", name: "Topical fluoride varnish", category: "preventive", duration_minutes: 15, default_price: 35, requires_tooth: false },
  { code: "D2140", name: "Amalgam restoration — one surface", category: "restorative", duration_minutes: 40, default_price: 120, requires_tooth: true },
  { code: "D2391", name: "Composite restoration — one surface, posterior", category: "restorative", duration_minutes: 45, default_price: 145, requires_tooth: true },
  { code: "D2740", name: "Crown — porcelain/ceramic", category: "prosthodontic", duration_minutes: 90, default_price: 780, requires_tooth: true },
  { code: "D3310", name: "Root canal — anterior", category: "endodontic", duration_minutes: 75, default_price: 520, requires_tooth: true },
  { code: "D4341", name: "Periodontal scaling and root planing", category: "periodontic", duration_minutes: 60, default_price: 210, requires_tooth: false },
  { code: "D7140", name: "Extraction — erupted tooth", category: "surgery", duration_minutes: 30, default_price: 160, requires_tooth: true },
] as const;

/**
 * Permanent teeth in ISO 3950 notation — strings, because a designation
 * is a string now: ISO 10394 numbers supernumerary teeth with letters,
 * so `AB` has to fit the same column as `36`. See ALL_TOOTH_CODES.
 */
const ADULT_TEETH = [
  "11","12","13","14","15","16","17","18","21","22","23","24","25","26","27","28",
  "31","32","33","34","35","36","37","38","41","42","43","44","45","46","47","48",
] as const;

const CONDITIONS = ["healthy","healthy","healthy","caries","filled","filled","crown","root_canal","missing"] as const;

async function findOrCreate<T extends Row>(
  collection: string,
  match: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<T> {
  const q = Object.entries(match)
    .map(([k, v]) => `filter[${k}][_eq]=${encodeURIComponent(v)}`)
    .join("&");
  const found = await must<T[]>(`find ${collection}`, api.get(`/items/${collection}?limit=1&${q}`));
  if (found.length && found[0]) return found[0];
  return must<T>(`create ${collection}`, api.post(`/items/${collection}`, payload));
}

async function findOrCreateUser(
  email: string,
  payload: Record<string, unknown>,
): Promise<Row> {
  const found = await must<Row[]>(
    "find user",
    api.get(`/users?limit=1&fields=id&filter[email][_eq]=${encodeURIComponent(email)}`),
  );
  if (found.length && found[0]) {
    // Reconciled, not skipped — otherwise a change here (a role, a
    // clinic, a UI language) only ever reaches an empty database, and
    // every existing demo instance quietly keeps the old value. The
    // password is deliberately not in the patch: re-seeding should not
    // reset one somebody has changed.
    await must("update user", api.patch(`/users/${found[0].id}`, payload));
    return found[0];
  }
  return must<Row>("create user", api.post("/users", { email, password: DEMO_PASSWORD, ...payload }));
}

export async function seed(roleIds: Map<string, string>): Promise<void> {
  const practices = [
    { name: "Riverside Dental", slug: "riverside", city: "Amsterdam", country: "NL", timezone: "Europe/Amsterdam", currency: "EUR" },
    { name: "Marina Smile Clinic", slug: "marina", city: "Dubai", country: "AE", timezone: "Asia/Dubai", currency: "AED" },
  ];

  for (const [ci, practice] of practices.entries()) {
    const clinic = await findOrCreate<Row>("clinics", { slug: practice.slug }, {
      ...practice,
      status: "active",
      email: `hello@${practice.slug}.example.com`,
      phone: ci === 0 ? "+31 20 555 0142" : "+971 4 555 0177",
      address: ci === 0 ? "Prinsengracht 812" : "Marina Walk, Tower 3",
    });
    log.made(`clinic ${practice.name}`);

    // --- staff, one per role -----------------------------------------
    // `language` is a system field on directus_users, and it is the only
    // thing that makes the German, Dutch and French work visible. Left
    // unset, every account opens in English and 165 translated strings
    // sit there unread.
    //
    // Set per person rather than per practice, because that is how it
    // actually works — a Dutch hygienist in an Amsterdam practice sets
    // her own interface to Dutch, and the English-speaking associate in
    // the next room does not. The two accounts the login screen sends
    // you to stay in English, so the access-model comparison is not also
    // a language lesson.
    const staff = [
      { key: "owner",  role: "Practice owner", first: ci === 0 ? "Hannah" : "Layla", last: ci === 0 ? "Prins" : "Haddad", job: "principal_dentist", lang: ci === 0 ? "nl-NL" : "en-US" },
      { key: "dentist", role: "Dentist",       first: ci === 0 ? "Sam" : "Omar",     last: ci === 0 ? "Okonkwo" : "Rashid", job: "associate_dentist", lang: "en-US" },
      { key: "hygienist", role: "Hygienist",   first: ci === 0 ? "Ilse" : "Priya",   last: ci === 0 ? "Dekker" : "Menon",  job: "hygienist", lang: ci === 0 ? "nl-NL" : "en-US" },
      { key: "desk",   role: "Front desk",     first: ci === 0 ? "Bram" : "Zara",    last: ci === 0 ? "Vos" : "Khalil",    job: "receptionist", lang: "en-US" },
    ];

    const users: Record<string, string> = {};
    for (const s of staff) {
      const email = `${s.key}@${practice.slug}.example.com`;
      const u = await findOrCreateUser(email, {
        first_name: s.first,
        last_name: s.last,
        role: roleIds.get(s.role) ?? null,
        clinic: clinic.id,
        job_title: s.job,
        language: s.lang,
        status: "active",
      });
      users[s.key] = u.id;
    }
    log.made(`  4 staff accounts (password ${DEMO_PASSWORD})`);

    // --- rooms --------------------------------------------------------
    const rooms: Row[] = [];
    for (const [i, name] of ["Surgery 1", "Surgery 2", "Hygiene room"].entries()) {
      rooms.push(await findOrCreate<Row>("rooms", { clinic: clinic.id, name }, {
        clinic: clinic.id, name, chair_number: i + 1, active: true,
      }));
    }

    // --- treatment catalogue -----------------------------------------
    const treatments: Row[] = [];
    for (const t of TREATMENTS) {
      treatments.push(await findOrCreate<Row>("treatments", { clinic: clinic.id, code: t.code }, {
        clinic: clinic.id, ...t, active: true,
      }));
    }
    log.made(`  ${treatments.length} catalogue treatments`);

    // --- patients -----------------------------------------------------
    const patientCount = 12;
    const patients: Row[] = [];
    for (let i = 0; i < patientCount; i++) {
      const seq = ci * 100 + i + 1;
      const reference = `${practice.slug.toUpperCase().slice(0, 3)}-${String(seq).padStart(4, "0")}`;
      const first = pick(FIRST, i + ci * 3);
      const last = pick(LAST, i * 2 + ci);
      const dob = new Date(1955 + ((i * 7) % 55), (i * 5) % 12, ((i * 11) % 27) + 1);
      patients.push(await findOrCreate<Row>("patients", { clinic: clinic.id, reference }, {
        clinic: clinic.id,
        reference,
        first_name: first,
        last_name: last,
        date_of_birth: dob.toISOString().slice(0, 10),
        email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}@example.com`,
        phone: ci === 0 ? `+31 6 1234 ${String(1000 + i).slice(-4)}` : `+971 50 555 ${String(1000 + i).slice(-4)}`,
        address: ci === 0 ? `Keizersgracht ${100 + i * 7}` : `Jumeirah Beach Rd ${20 + i * 3}`,
        preferred_language: ci === 0 ? (i % 3 === 0 ? "nl" : "en") : (i % 4 === 0 ? "ar" : "en"),
        status: "active",
        // Clinical fields — reception must never see these.
        medical_alerts: i % 4 === 0 ? "Anticoagulant therapy — consult before extraction." : (i % 7 === 0 ? "Latex allergy." : null),
        allergies: i % 4 === 0 ? "penicillin" : (i % 7 === 0 ? "latex,ibuprofen" : null),
        clinical_notes: i % 3 === 0 ? "Reports sensitivity to cold on the lower right quadrant." : null,
      }));
    }
    log.made(`  ${patients.length} patients`);

    // --- appointments across last week and next two weeks -------------
    let appts = 0;
    for (let i = 0; i < 26; i++) {
      const patient = pick(patients, i);
      const dayOffset = (i % 13) - 4;
      const hour = 9 + (i % 8);
      const practitioner = i % 3 === 0 ? users.hygienist! : (i % 2 === 0 ? users.dentist! : users.owner!);
      const past = dayOffset < 0;
      const status = past ? (i % 9 === 0 ? "no_show" : "completed") : (i % 4 === 0 ? "confirmed" : "scheduled");
      const starts = at(dayOffset, hour);
      const existing = await must<Row[]>("find appt",
        api.get(`/items/appointments?limit=1&filter[clinic][_eq]=${clinic.id}&filter[patient][_eq]=${patient.id}&filter[starts_at][_eq]=${encodeURIComponent(starts)}`));
      if (existing.length) continue;
      await api.post("/items/appointments", {
        clinic: clinic.id,
        patient: patient.id,
        practitioner,
        room: pick(rooms, i).id,
        starts_at: starts,
        ends_at: at(dayOffset, hour, 45),
        status,
        reason: pick(["checkup", "hygiene", "filling", "consultation", "crown", "emergency"], i),
        reminder_sent: past,
      });
      appts++;
    }
    log.made(`  ${appts} appointments`);

    // --- tooth chart --------------------------------------------------
    let charted = 0;
    for (const [pi, patient] of patients.entries()) {
      const existing = await must<Row[]>("find teeth",
        api.get(`/items/tooth_conditions?limit=1&filter[patient][_eq]=${patient.id}`));
      if (existing.length) continue;
      // A handful of findings each — a real chart is sparse, not 32 rows.
      for (let k = 0; k < 5; k++) {
        const tooth = pick(ADULT_TEETH, pi * 5 + k * 3);
        await api.post("/items/tooth_conditions", {
          clinic: clinic.id,
          patient: patient.id,
          tooth,
          surface: k % 3 === 0 ? "O" : "whole",
          condition: pick(CONDITIONS, pi + k),
          recorded_at: at(-((pi % 20) + 1), 11),
        });
        charted++;
      }
    }
    log.made(`  ${charted} tooth findings`);

    // --- recall ---------------------------------------------------------
    {
      const types = [
        { name: "Examination", special_type: "none", default_interval_months: 12 },
        { name: "Hygiene", special_type: "prophy", default_interval_months: 6 },
        { name: "Child fluoride", special_type: "child_prophy", default_interval_months: 6 },
        { name: "Perio maintenance", special_type: "perio", default_interval_months: 3 },
      ];
      const typeIds: Record<string, string> = {};
      for (const t of types) {
        const row = await findOrCreate<Row>("recall_types", { clinic: clinic.id as string, name: t.name },
          { clinic: clinic.id, ...t });
        typeIds[t.name] = row.id as string;
      }

      // The practice's own vocabulary for the chase — deliberately not an
      // enum in the schema, because no two practices word it the same.
      const statuses = [
        { name: "Mailed postcard", abbreviation: "MP", sort: 1 },
        { name: "Emailed", abbreviation: "EM", sort: 2 },
        { name: "Texted", abbreviation: "TX", sort: 3 },
        { name: "Called, no answer", abbreviation: "CNA", sort: 4 },
      ];
      const statusIds: Record<string, string> = {};
      for (const st of statuses) {
        const row = await findOrCreate<Row>("recall_statuses", { clinic: clinic.id as string, name: st.name },
          { clinic: clinic.id, ...st });
        statusIds[st.name] = row.id as string;
      }

      const addMonths = (iso: string, months: number): string => {
        const d = new Date(iso + "T00:00:00Z");
        d.setUTCMonth(d.getUTCMonth() + months);
        return d.toISOString().slice(0, 10);
      };
      const addDays = (iso: string, days: number): string => {
        const d = new Date(iso + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      };

      // A spread that makes the bookmarks show something: some due soon,
      // some overdue, one seen early on purpose, one suppressed, and one
      // where the patient said no to the interval.
      const plan: Array<{
        i: number; type: string; interval: number; lastVisitDaysAgo: number;
        agreed?: string; status?: string; early?: number; disabled?: boolean;
        until?: number; note?: string;
      }> = [
        { i: 0, type: "Examination", interval: 12, lastVisitDaysAgo: 380, status: "Texted",
          note: "Overdue. Two contact attempts." },
        { i: 1, type: "Hygiene", interval: 6, lastVisitDaysAgo: 200, status: "Mailed postcard" },
        { i: 2, type: "Perio maintenance", interval: 3, lastVisitDaysAgo: 100, status: "Called, no answer",
          note: "Perio maintenance — 3-month interval, not the 6 the patient wanted." },
        { i: 2, type: "Examination", interval: 12, lastVisitDaysAgo: 100, agreed: "disagreed",
          note: "Patient asked for annual; clinician advised 3-monthly. Disagreement recorded per NICE." },
        { i: 3, type: "Child fluoride", interval: 6, lastVisitDaysAgo: 150 },
        { i: 4, type: "Examination", interval: 24, lastVisitDaysAgo: 700, disabled: true,
          note: "Moved abroad. Suppressed, not deleted." },
        { i: 5, type: "Hygiene", interval: 6, lastVisitDaysAgo: 90, early: -21,
          note: "Brought forward three weeks at the patient's request." },
        { i: 6, type: "Examination", interval: 12, lastVisitDaysAgo: 30, until: 90,
          note: "Mid-treatment; recall resumes once the course finishes." },
      ];

      let made = 0;
      for (const r of plan) {
        const patient = patients[r.i];
        if (!patient) continue;
        const existing = await must<Row[]>("find recall",
          api.get(`/items/recalls?limit=1&filter[patient][_eq]=${patient.id}` +
                  `&filter[recall_type][_eq]=${typeIds[r.type]}`));
        if (existing.length) continue;

        const previous = at(-r.lastVisitDaysAgo, 10).slice(0, 10);
        const calculated = addMonths(previous, r.interval);
        const made_ = await api.post("/items/recalls", {
          clinic: clinic.id,
          patient: patient.id,
          recall_type: typeIds[r.type],
          interval_months: r.interval,
          patient_agreed: r.agreed ?? "agreed",
          interval_set_by: users.dentist,
          interval_set_on: previous,
          date_previous: previous,
          date_due_calculated: calculated,
          // The authoritative date defaults to the calculated one and is
          // moved only on purpose — which is the whole reason both exist.
          date_due: r.early ? addDays(calculated, r.early) : calculated,
          recall_status: r.status ? statusIds[r.status] : null,
          is_disabled: r.disabled ?? false,
          disable_until: r.until ? at(r.until, 10).slice(0, 10) : null,
          note: r.note ?? null,
        });
        if (made_.ok) made++;
        else log.fail(`recall ${r.type}: ${made_.error.message}`);
      }
      log.made(`  ${types.length} recall types, ${statuses.length} statuses, ${made} recalls`);
    }

    // --- dentition: the cases a fixed 32-box chart cannot hold --------
    //
    // Four patients, four shapes of mouth. Every one of these is ordinary
    // in a real practice and unrepresentable in a chart derived from the
    // date of birth.
    {
      const hypodontia = patients[1]!;   // both lower second premolars never formed
      const mesiodens  = patients[2]!;   // an extra tooth at the upper midline
      const child      = patients[3]!;   // mixed dentition, mid-transition
      const retained   = patients[4]!;   // a milk tooth still in place at 47

      type Row2 = {
        patient: string; designation: string; dentition_type: string; state: string;
        absence_reason?: string; retained?: boolean; assessed_from?: string; note?: string;
      };
      const rows: Row2[] = [
        // Hypodontia. 35 and 45 are the commonest congenital absentees
        // after the third molars — 29.9% of affected people. Radiographic,
        // because you cannot assert never-formed from looking.
        { patient: hypodontia.id as string, designation: "35", dentition_type: "permanent", state: "absent",
          absence_reason: "congenital", assessed_from: "radiograph",
          note: "No successor visible on the OPG. Second primary molar retained above." },
        { patient: hypodontia.id as string, designation: "45", dentition_type: "permanent", state: "absent",
          absence_reason: "congenital", assessed_from: "radiograph" },
        { patient: hypodontia.id as string, designation: "75", dentition_type: "deciduous", state: "present",
          retained: true, assessed_from: "clinical",
          note: "Retained because 35 never formed. Sound, no infraocclusion." },
        { patient: hypodontia.id as string, designation: "38", dentition_type: "permanent", state: "absent",
          absence_reason: "congenital", assessed_from: "radiograph", note: "Third molar agenesis." },

        // Hyperdontia. A mesiodens is ISO 10394 "AB" — not 11, not 21, and
        // not a flag on a natural tooth. Two of them here, deliberately:
        // ISO 10394 reuses one code for multiple teeth in one location, so
        // this is what a double mesiodens looks like in the data.
        { patient: mesiodens.id as string, designation: "AB", dentition_type: "supernumerary", state: "present",
          assessed_from: "clinical", note: "Palatal to 11/21. For extraction before orthodontics." },
        { patient: mesiodens.id as string, designation: "AB", dentition_type: "supernumerary", state: "unerupted",
          assessed_from: "radiograph", note: "Second mesiodens, unerupted, lying horizontally." },

        // Mixed dentition. Permanent incisors and first molars through,
        // deciduous molars still in place, premolars not yet erupted.
        // Nothing about this is derivable from an age.
        { patient: child.id as string, designation: "11", dentition_type: "permanent", state: "present", assessed_from: "clinical" },
        { patient: child.id as string, designation: "21", dentition_type: "permanent", state: "present", assessed_from: "clinical" },
        { patient: child.id as string, designation: "16", dentition_type: "permanent", state: "present", assessed_from: "clinical" },
        { patient: child.id as string, designation: "26", dentition_type: "permanent", state: "present", assessed_from: "clinical" },
        { patient: child.id as string, designation: "54", dentition_type: "deciduous", state: "present", assessed_from: "clinical" },
        { patient: child.id as string, designation: "55", dentition_type: "deciduous", state: "present", assessed_from: "clinical" },
        { patient: child.id as string, designation: "14", dentition_type: "permanent", state: "unerupted",
          assessed_from: "radiograph", note: "Developing normally, not yet through." },
        { patient: child.id as string, designation: "15", dentition_type: "permanent", state: "unerupted", assessed_from: "radiograph" },
        { patient: child.id as string, designation: "51", dentition_type: "deciduous", state: "absent",
          absence_reason: "exfoliated", assessed_from: "history", note: "Shed normally; 11 in its place." },

        // A retained primary tooth in an adult, which is the case that
        // breaks any model where dentition follows from the patient's age.
        { patient: retained.id as string, designation: "55", dentition_type: "deciduous", state: "present",
          retained: true, assessed_from: "clinical", note: "Still functional at 47. Successor 15 never formed." },
        { patient: retained.id as string, designation: "15", dentition_type: "permanent", state: "absent",
          absence_reason: "congenital", assessed_from: "radiograph" },
      ];

      let teeth = 0;
      for (const [ri, r] of rows.entries()) {
        // Matched on the note as well as the designation, because two AB
        // rows for one patient are legitimate and must both survive.
        const existing = await must<Row[]>("find dentition",
          api.get(`/items/dentition?limit=1&filter[patient][_eq]=${r.patient}` +
                  `&filter[designation][_eq]=${encodeURIComponent(r.designation)}` +
                  `&filter[state][_eq]=${r.state}`));
        if (existing.length) continue;
        const made = await api.post("/items/dentition", {
          clinic: clinic.id,
          assessed_on: at(-((ri % 24) + 1), 9).slice(0, 10),
          ...r,
        });
        if (made.ok) teeth++;
        else log.fail(`dentition ${r.designation}: ${made.error.message}`);
      }
      log.made(`  ${teeth} dentition records across 4 patients`);
    }

    // --- treatment records + invoices ---------------------------------
    let records = 0, invoiced = 0;
    for (let i = 0; i < 10; i++) {
      const patient = pick(patients, i * 3);
      const treatment = pick(treatments, i);
      const meta = pick(TREATMENTS, i);
      const existing = await must<Row[]>("find record",
        api.get(`/items/treatment_records?limit=1&filter[patient][_eq]=${patient.id}&filter[treatment][_eq]=${treatment.id}`));
      if (existing.length) continue;

      const record = await must<Row>("create record", api.post("/items/treatment_records", {
        clinic: clinic.id,
        patient: patient.id,
        treatment: treatment.id,
        practitioner: i % 2 === 0 ? users.dentist! : users.owner!,
        tooth: meta.requires_tooth ? pick(ADULT_TEETH, i * 4) : null,
        surfaces: meta.requires_tooth ? (i % 2 === 0 ? "O" : "M,O") : null,
        performed_at: at(-((i % 12) + 1), 10),
        price: meta.default_price,
        status: i % 5 === 0 ? "planned" : "completed",
      }));
      records++;

      if (i % 5 === 0) continue; // planned work isn't billed yet

      const number = `${practice.slug.toUpperCase().slice(0, 3)}-INV-${String(1000 + i).slice(-4)}`;
      const invoice = await must<Row>("create invoice", api.post("/items/invoices", {
        clinic: clinic.id,
        patient: patient.id,
        number,
        status: i % 3 === 0 ? "paid" : (i % 3 === 1 ? "sent" : "overdue"),
        issued_at: at(-((i % 12) + 1), 12).slice(0, 10),
        due_at: at(-((i % 12) + 1) + 30, 12).slice(0, 10),
        tax_rate: 21,
        subtotal: meta.default_price,
        total: Math.round(meta.default_price * 1.21 * 100) / 100,
        paid_at: i % 3 === 0 ? at(-((i % 12) + 1) + 5, 14) : null,
      }));
      await api.post("/items/invoice_lines", {
        clinic: clinic.id,
        invoice: invoice.id,
        treatment_record: record.id,
        description: `${meta.code} — ${meta.name}`,
        quantity: 1,
        unit_price: meta.default_price,
        amount: meta.default_price,
        sort: 1,
      });
      invoiced++;
    }
    log.made(`  ${records} treatment records, ${invoiced} invoices`);

    // --- one patient-portal login ------------------------------------
    // --- documents ------------------------------------------------------
    // Attached to patients[0], which is also the portal patient — so the
    // consent form below is the one the portal check reads back, and the
    // radiograph beside it is the one the portal must NOT reach.
    {
      const subject = patients[0]!;
      const docs: Array<[file: string, title: string, type: string, kind: string, day: number, note: string]> = [
        ["opg-panoramic.png", `${practice.slug} OPG panoramic`, "image/png", "radiograph", -420,
          "Baseline panoramic taken at the new-patient exam."],
        ["bitewing-right.png", `${practice.slug} bitewing right`, "image/png", "radiograph", -180,
          "Right bitewing, recall interval imaging."],
        ["consent-extraction.txt", `${practice.slug} consent, extraction 46`, "text/plain", "consent", -30,
          "Signed in surgery before the extraction was booked."],
        ["referral-orthodontics.txt", `${practice.slug} orthodontic referral`, "text/plain", "referral", -14,
          "Referred for crowding and a retained deciduous canine."],
      ];
      let filed = 0;
      for (const [file, title, type, kind, day, note] of docs) {
        const fileId = await uploadDemoFile(file, title, type, clinic.id as string);
        if (!fileId) continue;
        // Set here as well as by the flow. The seed is idempotent, so on
        // a re-run the document already exists and no create event fires
        // — the classification would then only ever be right on a first
        // run, which is the sort of thing that works on your machine.
        await must("classify demo file", api.patch(`/files/${fileId}`, { document_kind: kind }));
        await findOrCreate<Row>("documents", { clinic: clinic.id, file: fileId }, {
          clinic: clinic.id,
          patient: subject.id,
          file: fileId,
          kind,
          taken_on: at(day, 10).slice(0, 10),
          note,
          status: "active",
        });
        filed++;
      }
      log.made(`  ${filed} patient documents`);
    }

    const portalPatient = patients[0]!;
    const portalEmail = `patient@${practice.slug}.example.com`;
    const portalUser = await findOrCreateUser(portalEmail, {
      first_name: "Portal",
      last_name: "Demo",
      role: roleIds.get("Patient") ?? null,
      clinic: clinic.id,
      status: "active",
    });
    await api.patch(`/items/patients/${portalPatient.id}`, { portal_user: portalUser.id });
    log.made(`  portal login ${portalEmail}`);
  }

  log.info(`all demo accounts use the password ${DEMO_PASSWORD}`);
}
