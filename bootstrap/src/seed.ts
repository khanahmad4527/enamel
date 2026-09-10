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

// What a completed treatment leaves on the chart. Restorative and surgical
// work changes the recorded state of the tooth it was done on, which is the
// whole reason `tooth_conditions.treatment_record` exists: a chart entry
// reading "crown" should be able to answer "placed when, by whom, for how
// much". Diagnostic and preventive codes are absent on purpose — a check-up
// does not restore anything.
const TREATMENT_OUTCOME: Record<string, string> = {
  D2140: "filled",     // amalgam restoration
  D2391: "filled",     // composite restoration
  D2740: "crown",      // porcelain crown
  D3310: "root_canal", // endodontic treatment
  D7140: "missing",    // extraction
};

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

    // --- payment plan, waiting list, lab work ---------------------------
    {
      // A plan with an APR, so the schedule shows interest rather than a
      // flat division. Computed here because a flow cannot do arithmetic.
      const payer = patients[7] ?? patients[0]!;
      const existingPlan = await must<Row[]>("find payment plan",
        api.get(`/items/payment_plans?limit=1&filter[patient][_eq]=${payer.id}`));
      let charges = 0;
      if (!existingPlan.length) {
        const principal = 1930, down = 300, apr = 6.9, months = 12;
        const financed = principal - down;
        const monthlyRate = apr / 100 / 12;
        // Standard amortisation: the payment that clears the balance in
        // `months` at `monthlyRate`.
        const payment = monthlyRate === 0
          ? financed / months
          : (financed * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
        const agreed = at(-20, 10).slice(0, 10);
        const plan = await must<Row>("create payment plan", api.post("/items/payment_plans", {
          clinic: clinic.id, patient: payer.id, plan_type: "payment_plan",
          agreed_on: agreed, total_principal: principal, down_payment: down,
          first_payment_on: at(10, 10).slice(0, 10),
          apr, interest_free_payments: null, interest_starts_on: null,
          number_of_payments: months, payment_amount: Math.round(payment * 100) / 100,
          charge_frequency: "monthly", handle_treatment_planned: "await_completion",
          permanent_lock: false,
          note: "Full mouth rehabilitation, spread over a year. Down payment taken on the day.",
        }));

        let balance = financed;
        for (let n = 1; n <= months; n++) {
          const interest = Math.round(balance * monthlyRate * 100) / 100;
          // The final instalment absorbs the rounding drift, which is what
          // a real plan does: twelve payments rounded to the cent leave a
          // few cents outstanding, and a schedule that does not land
          // exactly on zero is a schedule that will be argued about.
          const principalPart = n === months
            ? balance
            : Math.round((payment - interest) * 100) / 100;
          balance = Math.round((balance - principalPart) * 100) / 100;
          const due = new Date(agreed + "T00:00:00Z");
          due.setUTCMonth(due.getUTCMonth() + n);
          const r = await api.post("/items/payment_plan_charges", {
            clinic: clinic.id, payment_plan: plan.id,
            due_on: due.toISOString().slice(0, 10),
            principal: principalPart, interest,
            balance_after: Math.max(balance, 0),
            status: n === 1 ? "paid" : "due",
            sort: n,
          });
          if (r.ok) charges++;
        }
      }

      // The cancellation list. Deliberately a plain list with a source and
      // a status — the priority tier is left empty on most of them,
      // because it is one product's idea and not a standard.
      const wl: Array<[number, string, string | null, string | null]> = [
        [3, "unscheduled", null, "Toothache, will take anything this week."],
        [5, "scheduled_appointment", "high", "In pain. Booked for March, wants sooner."],
        [9, "recall", null, null],
        [11, "planned_appointment", "low", "Happy to wait, but asked to be on the list."],
      ];
      let waiting = 0;
      for (const [idx, source, priority, note] of wl) {
        const patient = patients[idx];
        if (!patient) continue;
        const existing = await must<Row[]>("find waiting",
          api.get(`/items/waiting_list?limit=1&filter[patient][_eq]=${patient.id}`));
        if (existing.length) continue;
        const r = await api.post("/items/waiting_list", {
          clinic: clinic.id, patient: patient.id,
          added_on: at(-(idx + 2), 10).slice(0, 10),
          source, priority,
          wanted_from: at(1, 10).slice(0, 10),
          wait_target_days: priority ? 14 : null,
          status: idx === 5 ? "offered" : "waiting",
          note,
        });
        if (r.ok) waiting++;
      }

      // Lab work, with the timeline that a status enum cannot express: one
      // case out and overdue, one back and checked, one back and NOT yet
      // checked — which is the one that matters before the patient sits.
      const lab = await findOrCreate<Row>("laboratories",
        { clinic: clinic.id as string, name: "Meridian Dental Laboratory" },
        {
          clinic: clinic.id, name: "Meridian Dental Laboratory",
          phone: "+31 20 555 0199", email: "cases@meridian-lab.example.com",
          turnaround_days: 10,
        });
      const cases: Array<[number, string, number, number | null, number | null, number | null]> = [
        // patient, instructions, due days, sent, received, checked (days offset)
        [5, "PFM crown 46. Shade A2. Please return the model.", 4, -9, null, null],
        [6, "Upper acrylic partial denture, teeth 14 and 16. Shade A1.", -6, -21, -8, -7],
        [7, "Zirconia crown 26. Shade B1.", 2, -6, -1, null],
      ];
      let labCases = 0;
      for (const [idx, instructions, dueIn, sent, received, checked] of cases) {
        const patient = patients[idx];
        if (!patient) continue;
        const existing = await must<Row[]>("find lab case",
          api.get(`/items/lab_cases?limit=1&filter[patient][_eq]=${patient.id}` +
                  `&filter[instructions][_eq]=${encodeURIComponent(instructions)}`));
        if (existing.length) continue;
        const r = await api.post("/items/lab_cases", {
          clinic: clinic.id, patient: patient.id, laboratory: lab.id,
          instructions,
          due_at: at(dueIn, 12),
          sent_at: sent === null ? null : at(sent, 9),
          received_at: received === null ? null : at(received, 14),
          checked_at: checked === null ? null : at(checked, 15),
        });
        if (r.ok) labCases++;
      }
      log.made(`  payment plan (${charges} charges), ${waiting} on the waiting list, ${labCases} lab cases`);
    }

    // --- periodontal: a screen, then the chart it triggered -------------
    {
      const subject = patients[1]!;

      // A BPE with a code 4 and a furcation, which is exactly the finding
      // that obliges a full chart — BSP: a code 4 means "assess the need
      // for more complex treatment".
      const screening = await findOrCreate<Row>("perio_screenings",
        { patient: subject.id as string, examined_on: at(-45, 10).slice(0, 10) },
        {
          clinic: clinic.id, patient: subject.id, examiner: users.hygienist,
          examined_on: at(-45, 10).slice(0, 10),
          instrument: "BPE", guideline_version: "BSP_BPE_2019",
          note: "Code 4 lower left with a furcation. Full chart taken the same visit.",
        });

      const sextants: Array<[string, number | null, boolean, string | null, number | null]> = [
        // sextant, code, furcation, not-scored reason, teeth scored
        ["UR", 2, false, null, 4],
        ["UA", 1, false, null, 6],
        ["UL", 3, false, null, 4],
        ["LR", 3, false, null, 4],
        ["LA", 2, false, null, 6],
        ["LL", 4, true, null, 4],
      ];
      let sx = 0;
      for (const [sextant, code, furcation, reason, teeth] of sextants) {
        const existing = await must<Row[]>("find sextant",
          api.get(`/items/perio_sextants?limit=1&filter[screening][_eq]=${screening.id}` +
                  `&filter[sextant][_eq]=${sextant}`));
        if (existing.length) continue;
        const r = await api.post("/items/perio_sextants", {
          clinic: clinic.id, screening: screening.id, sextant,
          bpe_code: code, furcation, not_scored_reason: reason, teeth_scored: teeth,
          third_molar_included: false,
        });
        if (r.ok) sx++;
      }

      // The full chart the code 4 triggered. Two sextants of it — a real
      // chart is not always 192 sites, and pretending otherwise is the
      // mistake this model exists to avoid.
      const exam = await findOrCreate<Row>("perio_exams",
        { patient: subject.id as string, examined_on: at(-45, 11).slice(0, 10) },
        {
          clinic: clinic.id, patient: subject.id, examiner: users.hygienist,
          examined_on: at(-45, 11).slice(0, 10),
          probe_type: "who", charts_third_molars: false,
          assessed_recession: true, assessed_bleeding: true, assessed_plaque: true,
          assessed_calculus: false, assessed_mobility: true, assessed_furcation: true,
          note: "Lower left and lower anterior charted in full following the BPE.",
        });

      const CHART_TEETH = ["34", "35", "36", "37", "43", "42", "41", "31", "32", "33"];
      const SITES = ["MB", "B", "DB", "ML", "L", "DL"];
      // Deterministic, and shaped like a real mouth: deep pockets around
      // the lower left molars, healthy anteriors, recession where you
      // would expect it.
      const depthFor = (tooth: string, site: string): number => {
        const molar = tooth === "36" || tooth === "37";
        const interproximal = site !== "B" && site !== "L";
        if (molar) return interproximal ? 6 : 5;
        if (tooth === "34" || tooth === "35") return interproximal ? 4 : 3;
        return interproximal ? 3 : 2;
      };
      const recessionFor = (tooth: string, site: string): number => {
        if ((tooth === "36" || tooth === "37") && site === "B") return 2;
        if (tooth === "43" || tooth === "33") return site === "B" ? 1 : 0;
        return 0;
      };

      let teethRows = 0, siteRows = 0;
      for (const tooth of CHART_TEETH) {
        const existingTooth = await must<Row[]>("find perio tooth",
          api.get(`/items/perio_teeth?limit=1&filter[exam][_eq]=${exam.id}&filter[tooth][_eq]=${tooth}`));
        if (!existingTooth.length) {
          const molar = tooth === "36" || tooth === "37";
          const r = await api.post("/items/perio_teeth", {
            clinic: clinic.id, exam: exam.id, tooth, is_present: true,
            mobility: molar ? 2 : 0,
            mobility_index: "miller_lindhe_nyman",
            // Mandibular molars have two entrances, buccal and lingual —
            // and only they do, of the teeth charted here.
            furcation_buccal: molar ? 2 : null,
            furcation_lingual: tooth === "36" ? 1 : null,
          });
          if (r.ok) teethRows++;
        }

        for (const site of SITES) {
          const existingSite = await must<Row[]>("find perio site",
            api.get(`/items/perio_sites?limit=1&filter[exam][_eq]=${exam.id}` +
                    `&filter[tooth][_eq]=${tooth}&filter[site][_eq]=${site}`));
          if (existingSite.length) continue;
          const depth = depthFor(tooth, site);
          const r = await api.post("/items/perio_sites", {
            clinic: clinic.id, exam: exam.id, tooth, site,
            probing_depth_mm: depth,
            recession_mm: recessionFor(tooth, site),
            bleeding_on_probing: depth >= 4,
            suppuration: depth >= 6 && site === "MB",
            plaque: depth >= 4,
            calculus: false,
          });
          if (r.ok) siteRows++;
        }
      }
      log.made(`  BPE screening (${sx} sextants), chart of ${teethRows} teeth and ${siteRows} sites`);
    }

    // --- the medico-legal layer -----------------------------------------
    {
      const subject = patients[0]!;   // also the portal patient
      const other = patients[8] ?? patients[1]!;

      // Two histories for one patient, the older superseded by the newer,
      // because the point of the model is that the first one survives.
      const h1 = await findOrCreate<Row>("medical_histories",
        { patient: subject.id as string, taken_on: at(-400, 10).slice(0, 10) },
        {
          clinic: clinic.id, patient: subject.id, taken_on: at(-400, 10).slice(0, 10),
          pregnant: "no", smoker: "yes", anticoagulants: "no",
          summary: "Well. Smokes 10/day. No regular medication.",
          signed_on: at(-400, 11),
        });
      const h2 = await findOrCreate<Row>("medical_histories",
        { patient: subject.id as string, taken_on: at(-30, 10).slice(0, 10) },
        {
          clinic: clinic.id, patient: subject.id, taken_on: at(-30, 10).slice(0, 10),
          pregnant: "no", smoker: "no", anticoagulants: "yes",
          summary: "Stopped smoking. Started apixaban after an AF diagnosis — bleeding risk noted.",
          signed_on: at(-30, 11),
        });
      if (!(h1 as Record<string, unknown>)["superseded_by"]) {
        await api.patch(`/items/medical_histories/${h1.id}`, { superseded_by: h2.id });
      }

      // Current-state findings, including one that turned out to be wrong
      // and is inactive rather than gone.
      const findings = [
        { patient: subject.id, category: "allergy", label: "Penicillin", status: "active",
          severity: "severe", note: "Facial swelling as a child. Avoid all penicillins." },
        { patient: subject.id, category: "medication", label: "Apixaban 5mg twice daily", status: "active",
          note: "Started after AF diagnosis. Liaise before extractions." },
        { patient: subject.id, category: "problem", label: "Atrial fibrillation", status: "active" },
        { patient: subject.id, category: "allergy", label: "Latex", status: "inactive",
          severity: "mild", note: "Reported in 2019, not reproducible on review. Kept for the record." },
        { patient: other.id, category: "allergy", label: "Articaine", status: "active", severity: "moderate" },
      ];
      let found = 0;
      for (const f of findings) {
        const existing = await must<Row[]>("find finding",
          api.get(`/items/patient_findings?limit=1&filter[patient][_eq]=${f.patient}` +
                  `&filter[label][_eq]=${encodeURIComponent(f.label)}`));
        if (existing.length) continue;
        const r = await api.post("/items/patient_findings", {
          clinic: clinic.id, noted_on: at(-120, 10).slice(0, 10), ...f,
        });
        if (r.ok) found++;
      }

      // Notes, including an amendment that corrects an earlier entry
      // rather than editing it.
      const original = await findOrCreate<Row>("clinical_notes",
        { patient: subject.id as string, written_on: at(-30, 11) },
        {
          clinic: clinic.id, patient: subject.id, author: users.dentist,
          written_on: at(-30, 11), kind: "examination",
          body: "Routine examination. BPE 1/1/1 upper, 2/1/2 lower. Advised on interdental cleaning. " +
                "Amalgam 36 sound. No caries detected.",
          locked_on: at(-30, 12),
        });
      const amendment = await must<Row[]>("find amendment",
        api.get(`/items/clinical_notes?limit=1&filter[amends][_eq]=${original.id}`));
      if (!amendment.length) {
        await api.post("/items/clinical_notes", {
          clinic: clinic.id, patient: subject.id, author: users.dentist,
          written_on: at(-29, 9), kind: "amendment", amends: original.id,
          amendment_reason: "Tooth number transposed in the entry above",
          body: "Correction to the entry of the previous day: the sound amalgam is 46, not 36. " +
                "36 is unrestored. The original entry stands as written.",
          locked_on: at(-29, 10),
        });
      }

      // Consent, with the fingerprint that ties the signature to the text.
      const consentExists = await must<Row[]>("find consent",
        api.get(`/items/consents?limit=1&filter[patient][_eq]=${subject.id}`));
      let consents = 0;
      if (!consentExists.length) {
        const risks = "Post-operative swelling, bruising and bleeding — the latter raised by apixaban, " +
          "which was discussed with the patient's GP. Dry socket. Temporary altered sensation of the " +
          "lower lip in a small number of cases.";
        const alternatives = "Root canal treatment and a crown. No treatment, with the likely course explained.";
        // A cheap deterministic stand-in for a real hash: enough to make
        // the point that the signature is bound to the text it signed.
        let hash = 0;
        for (const ch of risks + alternatives) hash = (hash * 31 + ch.charCodeAt(0)) % 2147483647;
        const r = await api.post("/items/consents", {
          clinic: clinic.id, patient: subject.id,
          title: "Surgical extraction, lower right first molar (46)",
          risks_discussed: risks,
          alternatives_discussed: alternatives,
          signed_on: at(-28, 10),
          witnessed_by: users.hygienist,
          data_fingerprint: `sha-stub:${hash.toString(16)}`,
        });
        if (r.ok) consents++;
      }
      log.made(`  2 medical histories, ${found} findings, notes with an amendment, ${consents} consent`);
    }

    // --- treatment plans ------------------------------------------------
    //
    // Four plans that make the acceptance arithmetic visible: one accepted
    // in full, one where the patient took the cheap half and declined the
    // crown, one still awaiting an answer, and a superseded alternative
    // left inactive rather than deleted.
    {
      const plans: Array<{
        i: number; title: string; status: string; presentedDaysAgo: number | null;
        acceptedDaysAgo?: number; signed?: boolean;
        items: Array<{ t: number; tooth: string | null; priority: string; fee: number; status: string }>;
        note?: string;
      }> = [
        {
          i: 5, title: "Upper right quadrant, phase 1", status: "active",
          presentedDaysAgo: 40, acceptedDaysAgo: 38, signed: true,
          items: [
            { t: 3, tooth: "16", priority: "1", fee: 210, status: "accepted" },
            { t: 4, tooth: "16", priority: "1", fee: 520, status: "accepted" },
            { t: 1, tooth: null, priority: "2", fee: 75, status: "accepted" },
          ],
          note: "Accepted in full and signed on the tablet in surgery.",
        },
        {
          i: 6, title: "Lower left restorations", status: "active",
          presentedDaysAgo: 25, acceptedDaysAgo: 25,
          items: [
            { t: 3, tooth: "36", priority: "1", fee: 210, status: "accepted" },
            { t: 3, tooth: "37", priority: "1", fee: 210, status: "accepted" },
            // The expensive one is the one that gets declined, which is
            // exactly why a value-based acceptance rate reads lower than a
            // count-based one.
            { t: 4, tooth: "36", priority: "2", fee: 520, status: "declined" },
          ],
          note: "Fillings accepted, crown declined on cost. Reviewing in six months.",
        },
        {
          i: 7, title: "Full mouth rehabilitation", status: "active",
          presentedDaysAgo: 6,
          items: [
            { t: 4, tooth: "11", priority: "1", fee: 520, status: "proposed" },
            { t: 4, tooth: "21", priority: "1", fee: 520, status: "proposed" },
            { t: 5, tooth: "46", priority: "2", fee: 890, status: "proposed" },
          ],
          note: "Presented; patient is considering it and has asked about payment options.",
        },
        // patients[0] is also the portal patient, so these two are what
        // the portal checks read: an active plan they may see, and an
        // inactive alternative they must not. Without them the portal
        // assertion passes because there is nothing to show, which is not
        // the same as passing.
        {
          i: 0, title: "Two fillings and a scale", status: "active",
          presentedDaysAgo: 12, acceptedDaysAgo: 11,
          items: [
            { t: 3, tooth: "24", priority: "1", fee: 210, status: "accepted" },
            { t: 3, tooth: "25", priority: "1", fee: 210, status: "accepted" },
            { t: 1, tooth: null, priority: "2", fee: 75, status: "proposed" },
          ],
          note: "Accepted the fillings; hygiene visit still to book.",
        },
        {
          i: 0, title: "Whitening and veneers", status: "inactive",
          presentedDaysAgo: 60,
          items: [
            { t: 4, tooth: "11", priority: "1", fee: 520, status: "declined" },
            { t: 4, tooth: "21", priority: "1", fee: 520, status: "declined" },
          ],
          note: "Cosmetic option the patient declined. Kept, not deleted.",
        },
        {
          i: 6, title: "Lower left — crown alternative", status: "inactive",
          presentedDaysAgo: 25,
          items: [
            { t: 4, tooth: "36", priority: "1", fee: 520, status: "declined" },
            { t: 5, tooth: "36", priority: "1", fee: 890, status: "declined" },
          ],
          note: "The costlier option, kept because the patient may come back to it.",
        },
      ];

      let plansMade = 0, itemsMade = 0;
      for (const p of plans) {
        const patient = patients[p.i];
        if (!patient) continue;
        const existing = await must<Row[]>("find plan",
          api.get(`/items/treatment_plans?limit=1&filter[patient][_eq]=${patient.id}` +
                  `&filter[title][_eq]=${encodeURIComponent(p.title)}`));
        if (existing.length) continue;

        // Frozen totals: the sum of what was quoted, and the sum of what
        // was accepted. Computed here rather than by a flow because a flow
        // cannot add two numbers together.
        const presented = p.items.reduce((n, it) => n + it.fee, 0);
        const accepted = p.items
          .filter((it) => it.status === "accepted" || it.status === "completed")
          .reduce((n, it) => n + it.fee, 0);

        const plan = await must<Row>("create plan", api.post("/items/treatment_plans", {
          clinic: clinic.id,
          patient: patient.id,
          title: p.title,
          status: p.status,
          presented_on: p.presentedDaysAgo === null ? null : at(-p.presentedDaysAgo, 10).slice(0, 10),
          presented_total: presented,
          accepted_on: p.acceptedDaysAgo ? at(-p.acceptedDaysAgo, 10).slice(0, 10) : null,
          accepted_total: accepted,
          signed_on: p.signed ? at(-(p.acceptedDaysAgo ?? 1), 11) : null,
          signed_by: p.signed ? "Signed in surgery on the tablet" : null,
          note: p.note ?? null,
        }));
        plansMade++;

        for (const [si, it] of p.items.entries()) {
          const treatment = treatments[it.t % treatments.length];
          const r = await api.post("/items/treatment_plan_items", {
            clinic: clinic.id,
            plan: plan.id,
            treatment: treatment?.id,
            tooth: it.tooth,
            priority: it.priority,
            fee_presented: it.fee,
            status: it.status,
            sort: si + 1,
          });
          if (r.ok) itemsMade++;
          else log.fail(`plan item ${it.tooth ?? "-"}: ${r.error.message}`);
        }
      }
      log.made(`  ${plansMade} treatment plans, ${itemsMade} items`);
    }

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
    let records = 0, invoiced = 0, recharted = 0;
    for (let i = 0; i < 10; i++) {
      const patient = pick(patients, i * 3);
      const treatment = pick(treatments, i);
      const meta = pick(TREATMENTS, i);
      const existing = await must<Row[]>("find record",
        api.get(`/items/treatment_records?limit=1&fields=id,appointment&filter[patient][_eq]=${patient.id}&filter[treatment][_eq]=${treatment.id}`));

      // Link the record to a real appointment for that patient where one
      // exists. The relation was always nullable and always null, which
      // makes it look decorative rather than optional.
      const theirAppointments = await must<Row[]>("find appointment",
        api.get(`/items/appointments?limit=1&sort=-starts_at&fields=id` +
                `&filter[patient][_eq]=${patient.id}&filter[status][_eq]=completed`));

      const tooth = meta.requires_tooth ? pick(ADULT_TEETH, i * 4) : null;
      const status = i % 5 === 0 ? "planned" : "completed";

      let record: Row;
      if (existing[0]) {
        record = existing[0];
        const linkedTo = (record as Row & { appointment?: string | null }).appointment;
        // Reconcile the appointment link rather than only setting it at
        // creation. Setting a relation once, on insert, means every
        // instance that predates the relation keeps it null forever and
        // the field looks decorative — which is how it looked here.
        if (!linkedTo && theirAppointments[0]) {
          await must("link record to appointment",
            api.patch(`/items/treatment_records/${record.id}`, { appointment: theirAppointments[0].id }));
        }
      } else {
        record = await must<Row>("create record", api.post("/items/treatment_records", {
          clinic: clinic.id,
          patient: patient.id,
          appointment: theirAppointments[0]?.id ?? null,
          treatment: treatment.id,
          practitioner: i % 2 === 0 ? users.dentist! : users.owner!,
          tooth,
          surfaces: meta.requires_tooth ? (i % 2 === 0 ? "O" : "M,O") : null,
          // Two of the ten are done today, so "Work completed today" opens
          // on something. A bookmark that is empty on the day you seed the
          // database reads as broken rather than as accurate.
          performed_at: i < 2 ? at(0, 9 + i) : at(-((i % 12) + 1), 10),
          price: meta.default_price,
          status,
        }));
        records++;
      }

      // Completed work writes itself onto the chart. The finding for that
      // tooth is created if the patient has none, updated if they do —
      // either way it points back at the record that produced it, which is
      // what the field note on `treatment_record` promises. Planned work
      // changes nothing: nobody has picked up a handpiece yet.
      const outcome = tooth && status === "completed" ? TREATMENT_OUTCOME[meta.code] : undefined;
      if (tooth && outcome) {
        const finding = await must<Row[]>("find finding",
          api.get(`/items/tooth_conditions?limit=1&fields=id` +
                  `&filter[patient][_eq]=${patient.id}&filter[tooth][_eq]=${tooth}`));
        const chart = {
          condition: outcome,
          treatment_record: record.id,
          recorded_at: i < 2 ? at(0, 9 + i) : at(-((i % 12) + 1), 10),
        };
        if (finding[0]) await must("chart the outcome", api.patch(`/items/tooth_conditions/${finding[0].id}`, chart));
        else await must("chart the outcome", api.post("/items/tooth_conditions", {
          clinic: clinic.id, patient: patient.id, tooth,
          surface: outcome === "missing" ? "whole" : (meta.code === "D2740" ? "whole" : "O"),
          ...chart,
        }));
        recharted++;
      }

      if (i % 5 === 0) continue; // planned work isn't billed yet

      // findOrCreate rather than post, keyed on the number. The number is
      // derived from a counter, so a re-run over data that has invoices
      // but no treatment records — which is what you get if somebody
      // clears one collection and not the other — collided on the unique
      // constraint and aborted the seed. "Re-running is safe" is a claim
      // this repo makes; it has to survive a half-tidied database.
      const number = `${practice.slug.toUpperCase().slice(0, 3)}-INV-${String(1000 + i).slice(-4)}`;
      const invoice = await findOrCreate<Row>("invoices", { number }, {
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
      });
      // Keyed on invoice + description, because the line is what the totals
      // flow sums: posting it twice doubles the invoice. Not keyed on the
      // treatment record, which is exactly the mistake worth recording —
      // deleting treatment records sets this column to null (a charge that
      // has been billed outlives the clinical row), so a key on it stops
      // matching and the next run appends a second line for the same work.
      const description = `${meta.code} — ${meta.name}`;
      await findOrCreate<Row>("invoice_lines", { invoice: invoice.id, description }, {
        clinic: clinic.id,
        invoice: invoice.id,
        treatment_record: record.id,
        description,
        quantity: 1,
        unit_price: meta.default_price,
        amount: meta.default_price,
        sort: 1,
      });
      invoiced++;
    }
    log.made(`  ${records} new treatment records, ${invoiced} invoices, ${recharted} charted outcomes`);

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
