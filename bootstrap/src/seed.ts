import { api, must } from "./client.js";
import { log } from "./log.js";

/**
 * Demo data. Two practices exist on purpose: a single-tenant seed can
 * hide a broken tenancy filter, because everything you can see happens
 * to be yours. With two, a leak is visible immediately — which is what
 * `pnpm verify` checks.
 *
 * Everything here is invented. Never point this at real patients.
 */

import { DEMO_PASSWORD } from "./env.js";

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

/** Adult FDI numbering: quadrants 1–4, positions 1–8. */
const ADULT_TEETH = [11,12,13,14,15,16,17,18,21,22,23,24,25,26,27,28,
                     31,32,33,34,35,36,37,38,41,42,43,44,45,46,47,48] as const;

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
          tooth_fdi: tooth,
          surface: k % 3 === 0 ? "O" : "whole",
          condition: pick(CONDITIONS, pi + k),
          recorded_at: at(-((pi % 20) + 1), 11),
        });
        charted++;
      }
    }
    log.made(`  ${charted} tooth findings`);

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
        tooth_fdi: meta.requires_tooth ? pick(ADULT_TEETH, i * 4) : null,
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
