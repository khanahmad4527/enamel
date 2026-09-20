import { fromRoot } from "./root.js";
import { heroSvg, serviceSvg, portraitSvg } from "./imagery.js";
import { websitePhoto, portraitSlug } from "./photos.js";
import { instantFromToday, weekdayFromToday } from "@enamel/time";
import { api, must, postFile } from "./client.js";
import { spreadDemoHistory } from "./demo-history.js";
import { log } from "./log.js";

/**
 * Demo data. Two practices exist on purpose: a single-tenant seed can
 * hide a broken tenancy filter, because everything you can see happens
 * to be yours. With two, a leak is visible immediately — which is what
 * `pnpm verify` checks.
 *
 * Everything here is invented. Never point this at real patients.
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEMO_PASSWORD } from "./env.js";

const DEMO_DOCS = fromRoot("demo", "documents");

/**
 * Uploads a demo document into the practice's file library.
 *
 * `clinic` is passed explicitly here because the seed runs as admin, and
 * the preset that stamps it for staff is attached to *their* create
 * permission, not to an administrator's. Without it every seeded file
 * would land unscoped and be visible to both practices — which is
 * exactly the leak the verify suite now checks for.
 */
/**
 * A logo for a practice that does not have one.
 *
 * Generated rather than shipped, for the same reason the radiographs are
 * drawn rather than downloaded: a demo that carries somebody else's
 * artwork is a demo with a licensing problem in it.
 *
 * It used to be the practice's initials on a rounded square, and that
 * read as exactly what it was — a placeholder where a logo should be.
 * Two letters in a box say "nobody has done this bit yet"; a tooth says
 * "dental practice" before the name beside it is read. So it is a mark
 * now, in whichever of black or white is readable on the brand colour,
 * and the initials are gone because the name already sits next to it in
 * the masthead and did not need saying twice.
 *
 * Still a placeholder, and still meant to be replaced: uploading a real
 * logo and picking it in `theme_logo` is the whole handover, with no
 * code change and no redeploy.
 *
 * SVG, and by hand. It is four elements; a dependency to emit four
 * elements is a dependency to maintain. And SVG rather than a raster so
 * it stays sharp at every size a masthead might ask for, with no second
 * file at 2x.
 */
function monogramSvg(name: string, colour: string): string {
  // The same rule the patient site uses: black or white, whichever is
  // readable on the practice's colour, rather than assuming white. A pale
  // brand with white letters on it is a logo nobody can read, and the
  // practice that picked the colour is the last to find out.
  const hex = colour.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const luminance = 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  // The dark option is the site's own ink, so a pale brand's monogram
  // matches the headings beside it rather than being a second near-black.
  const onColour = (1.05) / (luminance + 0.05) >= (luminance + 0.05) / 0.05 ? "#ffffff" : "#16303a";

  // A crown and two roots, drawn as one closed path so it stays a single
  // silhouette at 44px in the masthead as well as at 512 on a tab.
  const tooth =
    "M48 20c-13 0-22 7-22 19 0 9 3 15 5 25 1.5 8 2.5 14 7 14 4 0 5-6 6.5-14 " +
    "1-5 6-5 7 0 1.5 8 2.5 14 6.5 14 4.5 0 5.5-6 7-14 2-10 5-16 5-25 0-12-9-19-22-19z";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label="${name}">`,
    `<title>${name}</title>`,
    `<rect width="96" height="96" rx="22" fill="${colour}"/>`,
    `<path d="${tooth}" fill="${onColour}"/>`,
    `</svg>`,
  ].join("");
}

/**
 * Upload something this process generated, marked as a brand asset.
 *
 * `brand_asset` is the flag that makes `/assets/<id>` answer for a
 * patient at all — see the note on the field. Set here at upload rather
 * than patched afterwards, because a logo that is briefly unmarked is a
 * logo that briefly 404s in the masthead.
 */
/** A `Uint8Array` is not a `BlobPart` under this lib target; its buffer is. */
function blobPart(body: string | Uint8Array): BlobPart {
  return typeof body === "string" ? body : new Uint8Array(body).buffer;
}

async function uploadBrandAsset(
  title: string,
  filename: string,
  type: string,
  /**
   * Bytes, or the text of an SVG.
   *
   * Widened from `string` when the generated placeholders were joined by
   * real photographs — a JPEG put through a string is a corrupted JPEG.
   */
  body: string | Uint8Array,
  /**
   * Replace the bytes if the file is already there.
   *
   * Off by default, because the usual case is a logo somebody uploaded
   * and re-uploading it on every seed would undo their work. On for the
   * generated placeholders: they are drawn from code, so when the code
   * that draws them changes the stored copy is stale, and a placeholder
   * nobody can refresh is worse than no placeholder.
   */
  redraw = false,
  /**
   * Where the picture came from and under what licence.
   *
   * CC BY and CC BY-SA oblige whoever publishes the image to credit it,
   * and a credit that lives only in a markdown file next to the source
   * is a credit that goes missing the moment somebody copies the asset
   * out. Written onto the file in Directus so it travels with the bytes.
   */
  description: string | null = null,
): Promise<string | null> {
  const existing = await must<Array<{ id: string }>>(
    "find brand asset",
    api.get(`/files?limit=1&fields=id&filter[title][_eq]=${encodeURIComponent(title)}`),
  );
  if (existing.length && existing[0] && redraw) {
    const res = await postFile(() => {
      const form = new FormData();
      form.append("title", title);
      form.append("file", new Blob([blobPart(body)], { type }), filename);
      return form;
    }, `/files/${existing[0].id}`, "PATCH");
    if (!res.ok) log.fail(`redraw ${title}: HTTP ${res.status}`);
    await must("mark the brand asset", api.patch(`/files/${existing[0].id}`, {
      brand_asset: true, ...(description ? { description } : {}),
    }));
    return existing[0].id;
  }
  if (existing.length && existing[0]) {
    // Reconciled rather than skipped: the flag was added after the first
    // seed, so a database seeded before it would keep a logo no patient
    // can fetch — the exact shape of bug the brand colour had.
    await must("mark the brand asset", api.patch(`/files/${existing[0].id}`, {
      brand_asset: true, ...(description ? { description } : {}),
    }));
    return existing[0].id;
  }

  const res = await postFile(() => {
    const form = new FormData();
    form.append("title", title);
    form.append("brand_asset", "true");
    form.append("file", new Blob([blobPart(body)], { type }), filename);
    return form;
  });
  const created = (await res.json()) as { data?: { id: string }; errors?: unknown };
  if (!res.ok || !created.data) {
    log.fail(`upload ${filename}: ${JSON.stringify(created.errors ?? created)}`);
    return null;
  }
  // The multipart upload does not always carry a custom field through, so
  // it is set explicitly rather than hoped for.
  await must("mark the brand asset", api.patch(`/files/${created.data.id}`, {
    brand_asset: true, ...(description ? { description } : {}),
  }));
  return created.data.id;
}

async function uploadDemoFile(
  file: string,
  title: string,
  type: string,
): Promise<string | null> {
  const existing = await must<Array<{ id: string }>>(
    "find demo file",
    api.get(`/files?limit=1&fields=id&filter[title][_eq]=${encodeURIComponent(title)}`),
  );
  if (existing.length && existing[0]) return existing[0].id;

  const bytes = await readFile(join(DEMO_DOCS, file));
  // Shares the branding step's upload helper, which handles the 429 a
  // rate-limited Directus returns when a loop pushes files at it.
  const res = await postFile(() => {
    const form = new FormData();
    form.append("title", title);
    form.append("file", new Blob([new Uint8Array(bytes)], { type }), file);
    return form;
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

/**
 * The practice week, and who works it.
 *
 * Declared once and used twice: these rows become `clinic_hours` and
 * `practitioner_hours`, and the same values drive the demo diary. Two
 * copies would drift, and the drift would show up as a seed that writes a
 * rota and then books against a different one — which the availability
 * trigger would refuse, one appointment at a time, for reasons nobody
 * could see from either list on its own.
 */
const WEEK: Array<{ day: string; opens: string | null; closes: string | null; note?: string }> = [
  { day: "mon", opens: "08:00:00", closes: "19:00:00" },
  { day: "tue", opens: "08:00:00", closes: "19:00:00" },
  { day: "wed", opens: "08:00:00", closes: "19:00:00" },
  { day: "thu", opens: "08:00:00", closes: "19:00:00" },
  { day: "fri", opens: "08:00:00", closes: "18:00:00", note: "Closes an hour early for lab collection" },
  { day: "sat", opens: "09:00:00", closes: "14:00:00" },
  { day: "sun", opens: null, closes: null },
];

/**
 * Deliberately not everybody, all week.
 *
 * The hygienist works three days and the dentist does not work Fridays.
 * A demo where every clinician is always available cannot show the rota
 * doing anything, and "we modelled working hours" is only a claim until
 * something is refused for being outside them.
 */
const ROTA: Array<{ who: string; days: string[]; from: string; to: string }> = [
  { who: "owner",     days: ["mon", "tue", "wed", "thu", "fri"], from: "08:00:00", to: "18:00:00" },
  { who: "dentist",   days: ["mon", "tue", "wed", "thu"],        from: "08:30:00", to: "17:30:00" },
  { who: "dentist",   days: ["sat"],                             from: "09:00:00", to: "14:00:00" },
  { who: "hygienist", days: ["mon", "wed", "fri"],               from: "09:00:00", to: "17:00:00" },
];

/** "08:30:00" -> 8.5, so a session boundary can be compared against an hour slot. */
const hourOf = (t: string): number => {
  const [h, m] = t.split(":");
  return Number(h) + Number(m) / 60;
};

/**
 * Nine o'clock in the *clinic's* town, as an ISO string.
 *
 * The arithmetic lives in `@enamel/time` — it was written three times
 * before that package existed, and a calculation whose failure mode is
 * every appointment being an hour out deserves one home.
 */
const atClinicISO = (tz: string, dayOffset: number, hour: number, minute = 0): string =>
  instantFromToday(tz, dayOffset, hour, minute).toISOString();

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
  // One practice, because the product serves one. This used to be two,
  // and the second existed to prove a tenant boundary that no longer
  // exists — every row it seeded was there to be invisible to the other.
  const practices = [
    { name: "Kadehuis Dental", slug: "kadehuis", city: "Amsterdam", country: "NL", timezone: "Europe/Amsterdam", currency: "EUR" },
  ];

  for (const [ci, practice] of practices.entries()) {
    // A singleton is PATCHed, never created: Directus makes the row the
    // first time it is read and there is no "find or create" to do.
    await must("the practice", api.patch("/items/practice", {
      ...practice,
      email: `hello@${practice.slug}.example.com`,
      phone: "+31 20 555 0142",
      phone_note: "Same-day for pain where we can",
      address: "Prinsengracht 812",
    }));

    // Patched, not passed to `findOrCreate`, because that helper *skips*
    // a row that already exists — so anything added to the seed later
    // would only ever reach a database that had never been seeded. The
    // theme was invisible for exactly that reason on the first run.
    //
    // Fresh cyan. Dark teal is where every generated health page lands,
    // and navy read as a bank — both were rejected for being dark before
    // they were anything else. This is water and daylight: cool, bright,
    // and easy to sit in front of. Every other shade on the site is
    // derived from this one value, so changing the practice's colour is
    // this line, the field in Directus, or BRAND_COLOUR in the
    // environment to try one without an edit.
    const brandColour = process.env.BRAND_COLOUR ?? "#17A2C6";
    await must("set the practice brand colour", api.patch(`/items/practice`, {
      theme_primary: brandColour,
    }));

    // And a logo drawn from it, so the two practices are told apart by
    // more than a hue and `theme_logo` has something to point at.
    const logo = await uploadBrandAsset(
      `${practice.name} monogram`,
      `${practice.slug}-monogram.svg`,
      "image/svg+xml",
      // Redrawn, like the other generated placeholders. Without this the
      // monogram is whatever colour the practice used to be — the logo
      // in the masthead stayed teal through two colour changes, which is
      // the "an existing thing is skipped so later edits never land"
      // mistake for the sixth time in this repository.
      monogramSvg(practice.name, brandColour), true,
    );
    if (logo) {
      await must("set the practice logo", api.patch(`/items/practice`, {
        theme_logo: logo,
      }));
    }
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
      rooms.push(await findOrCreate<Row>("rooms", { name }, {
        name, chair_number: i + 1, active: true,
      }));
    }

    // --- opening hours, rotas, leave and chair downtime ---------------
    //
    // Seeded before the diary on purpose. The availability trigger holds
    // every appointment against these, so writing them afterwards would
    // mean the demo book was never checked against the rules it exists to
    // demonstrate — and a rule nothing has been tested against is a
    // comment with a semicolon on the end.
    {
      // Sunday is a row that says "closed", not a missing row: the
      // difference is a decision versus an unfinished rota.
      for (const w of WEEK) {
        await findOrCreate<Row>("clinic_hours", { weekday: w.day }, {
          weekday: w.day, closed: w.opens === null,
          opens_at: w.opens, closes_at: w.closes, note: w.note ?? null,
        });
      }

      let sessions = 0;
      for (const r of ROTA) {
        const who = users[r.who];
        if (!who) continue;
        for (const day of r.days) {
          await findOrCreate<Row>("practitioner_hours",
            { practitioner: who, weekday: day },
            { practitioner: who, weekday: day, starts_at: r.from, ends_at: r.to });
          sessions++;
        }
      }

      // One clinician on leave and one chair down, both far enough out
      // that the demo diary is not built around them — they are there to
      // be hit by somebody trying to book into them.
      await findOrCreate<Row>("absences",
        { kind: "annual_leave" },
        {
          practitioner: users.hygienist ?? null, kind: "annual_leave",
          starts_at: atClinicISO(practice.timezone, 21, 0), ends_at: atClinicISO(practice.timezone, 26, 0), status: "booked",
          note: "Booked in January",
        });
      // Landed on a fixed offset it fell on a Sunday, when the practice is
      // shut regardless — a closure that closes nothing. Walk forward to
      // the first day the practice is actually open, because a bank
      // holiday is only interesting on a day somebody would have worked.
      let holiday = 28;
      const openDays = new Set(WEEK.filter((w) => w.opens !== null).map((w) => w.day));
      while (holiday < 40 && !openDays.has(weekdayFromToday(practice.timezone, holiday))) holiday++;
      await findOrCreate<Row>("absences",
        { kind: "public_holiday" },
        {
          practitioner: null, kind: "public_holiday",
          starts_at: atClinicISO(practice.timezone, holiday, 0),
          ends_at: atClinicISO(practice.timezone, holiday + 1, 0),
          status: "booked",
          note: "Practice closed",
        });
      await findOrCreate<Row>("room_closures",
        { room: rooms[1]!.id },
        {
          room: rooms[1]!.id, reason: "equipment_fault",
          starts_at: atClinicISO(practice.timezone, 16, 8), ends_at: atClinicISO(practice.timezone, 18, 18),
          note: "Waiting on a compressor part",
        });

      log.made(`  7 opening-hour rows, ${sessions} rota sessions, 2 absences, 1 chair closure`);
    }

    // --- treatment catalogue -----------------------------------------
    const treatments: Row[] = [];
    for (const t of TREATMENTS) {
      treatments.push(await findOrCreate<Row>("treatments", { code: t.code }, {
        ...t, active: true,
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
      patients.push(await findOrCreate<Row>("patients", { reference }, {
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

    // --- the diary ------------------------------------------------------
    //
    // Built from the rota rather than from a counter. An earlier grid was
    // `hour = 9 + (i % 8)` on every day including Sunday, which produced a
    // book the availability trigger now refuses one row at a time: the
    // practice shut, the hygienist off, the dentist not in on a Friday.
    // Generating from the same WEEK and ROTA that seeded the tables makes
    // the demo diary satisfy the rules by construction — the only honest
    // way to ship a rule and a dataset together.
    //
    // It is also *full*, and that took a second pass. Twenty-six
    // appointments looked fine on a day sheet and made the reporting
    // dashboard read 0.8% chair utilisation — which is arithmetically
    // correct against three chairs open eleven hours a day, and looks
    // exactly like a broken query. A practice that is 1% booked is not a
    // practice. So the generator fills each clinician's sessions at
    // 45-minute intervals and leaves roughly one slot in four free,
    // because a diary with no gaps is not a practice either: there would
    // be nothing for the slot search to find.
    //
    // Each clinician keeps one chair for the whole run. That is how a lot
    // of practices actually work, and it means neither exclusion
    // constraint can fire — one clinician is never in two places, and one
    // chair never holds two people.
    //
    // Guarded at the block, not per appointment. Slots are keyed to
    // *today*, and an earlier per-item guard matched on the absolute
    // timestamp — so seeding again three days later matched nothing and
    // built a second book on top of the first.
    let appts = 0;
    const book = await must<Row[]>("find diary",
      api.get(`/items/appointments?limit=1&fields=id`));

    if (book.length === 0) {
      const openOn = new Map(WEEK.map((w) => [w.day, w]));
      const reasons = ["checkup", "hygiene", "filling", "consultation", "crown", "emergency"];
      type Slot = { day: number; minutes: number; who: string; lane: number };
      const slots: Slot[] = [];

      // Five weeks back, not two. The reporting dashboard defaults to the
      // last thirty days, and a diary that starts halfway through the
      // window reports half the utilisation the practice actually ran at —
      // arithmetically correct and completely misleading.
      for (let day = -35; day <= 14; day++) {
        const weekday = weekdayFromToday(practice.timezone, day);
        const open = openOn.get(weekday);
        if (!open || open.opens === null || open.closes === null) continue;   // shut

        const working = ROTA.filter((r) => r.days.includes(weekday));
        working.forEach((r, lane) => {
          const from = Math.max(hourOf(open.opens!), hourOf(r.from)) * 60;
          const until = Math.min(hourOf(open.closes!), hourOf(r.to)) * 60;
          // Start on the quarter-hour grid a practice books on.
          let minutes = Math.ceil(from / 15) * 15;
          let n = 0;
          for (; minutes + 45 <= until; minutes += 45, n++) {
            // Roughly one in four left free, and a longer gap around the
            // middle of the session — which is lunch, and a diary without
            // one reads as generated.
            const midday = Math.abs(minutes - (from + until) / 2) < 40;
            if (midday || n % 4 === 3) continue;
            slots.push({ day, minutes, who: r.who, lane });
          }
        });
      }

      // One request per batch rather than per appointment. Several hundred
      // sequential POSTs, each running the scheduling hook's four
      // availability queries, turns provisioning into a coffee break.
      const rows = slots.map((slot, i) => {
        const patient = pick(patients, i);
        const past = slot.day < 0;
        return {
          patient: patient.id,
          practitioner: users[slot.who] ?? null,
          room: rooms[slot.lane % rooms.length]!.id,
          starts_at: atClinicISO(practice.timezone, slot.day, Math.floor(slot.minutes / 60), slot.minutes % 60),
          ends_at: atClinicISO(practice.timezone, slot.day, Math.floor((slot.minutes + 45) / 60), (slot.minutes + 45) % 60),
          // A real book is mostly kept. One in eleven missed and one in
          // seventeen cancelled is roughly what a practice sees, and the
          // no-show rate on the dashboard is only meaningful if the demo
          // has some.
          status: past
            ? (i % 11 === 0 ? "no_show" : i % 17 === 0 ? "cancelled" : "completed")
            : (i % 4 === 0 ? "confirmed" : "scheduled"),
          reason: pick(reasons, i),
          reminder_sent: past,
        };
      }).filter((r) => r.practitioner !== null);

      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const made = await api.post("/items/appointments", batch);
        if (made.ok) appts += batch.length;
        else log.fail(`appointments ${i}–${i + batch.length}: ${made.error.message}`);
      }
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
          patient: payer.id, plan_type: "payment_plan",
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
            payment_plan: plan.id,
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
          patient: patient.id,
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
        { name: "Meridian Dental Laboratory" },
        {
          name: "Meridian Dental Laboratory",
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
          patient: patient.id, laboratory: lab.id,
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
          patient: subject.id, examiner: users.hygienist,
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
          screening: screening.id, sextant,
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
          patient: subject.id, examiner: users.hygienist,
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
            exam: exam.id, tooth, is_present: true,
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
            exam: exam.id, tooth, site,
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
          patient: subject.id, taken_on: at(-400, 10).slice(0, 10),
          pregnant: "no", smoker: "yes", anticoagulants: "no",
          summary: "Well. Smokes 10/day. No regular medication.",
          signed_on: at(-400, 11),
        });
      const h2 = await findOrCreate<Row>("medical_histories",
        { patient: subject.id as string, taken_on: at(-30, 10).slice(0, 10) },
        {
          patient: subject.id, taken_on: at(-30, 10).slice(0, 10),
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
          noted_on: at(-120, 10).slice(0, 10), ...f,
        });
        if (r.ok) found++;
      }

      // Notes, including an amendment that corrects an earlier entry
      // rather than editing it.
      const original = await findOrCreate<Row>("clinical_notes",
        { patient: subject.id as string, written_on: at(-30, 11) },
        {
          patient: subject.id, author: users.dentist,
          written_on: at(-30, 11), kind: "examination",
          body: "Routine examination. BPE 1/1/1 upper, 2/1/2 lower. Advised on interdental cleaning. " +
                "Amalgam 36 sound. No caries detected.",
          locked_on: at(-30, 12),
        });
      const amendment = await must<Row[]>("find amendment",
        api.get(`/items/clinical_notes?limit=1&filter[amends][_eq]=${original.id}`));
      if (!amendment.length) {
        await api.post("/items/clinical_notes", {
          patient: subject.id, author: users.dentist,
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
          patient: subject.id,
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
        const row = await findOrCreate<Row>("recall_types", { name: t.name },
          { ...t });
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
        const row = await findOrCreate<Row>("recall_statuses", { name: st.name },
          { ...st });
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
          assessed_on: at(-((ri % 24) + 1), 9).slice(0, 10),
          ...r,
        });
        if (made.ok) teeth++;
        else log.fail(`dentition ${r.designation}: ${made.error.message}`);
      }
      log.made(`  ${teeth} dentition records across 4 patients`);

      // The same mesiodens, on the chart.
      //
      // `dentition` records that the tooth exists; `tooth_conditions`
      // records its state, and the chart draws the second. Without a row
      // here the interface's whole supernumerary section — the ISO 10394
      // label and its four translations — was unreachable: ADULT_TEETH
      // holds the 32 permanent teeth and nothing else ever wrote a letter
      // into that column. A feature no seed exercises is a feature nobody
      // has seen work, and the README was illustrating it with a
      // screenshot taken before that stopped being true.
      //
      // Its own existence check, not the `continue` in the loop above:
      // that one skips a patient who has any finding at all, and this
      // patient has five.
      {
        const already = await must<Row[]>("find the mesiodens finding",
          api.get(`/items/tooth_conditions?limit=1&filter[patient][_eq]=${mesiodens.id}` +
                  `&filter[tooth][_eq]=AB`));
        if (!already.length) {
          const made = await api.post("/items/tooth_conditions", {
            patient: mesiodens.id,
            tooth: "AB",
            surface: "whole",
            condition: "fractured",
            recorded_at: at(-3, 11),
            notes: "Mesiodens, crown fractured. Extraction before orthodontics.",
          });
          if (made.ok) log.made("  1 supernumerary finding on the chart");
          else log.fail(`supernumerary finding: ${made.error.message}`);
        }
      }
    }

    // --- clinical history behind the diary -------------------------------
    //
    // A treatment record for most completed appointments, which is what
    // makes "daily production" a line rather than eight dots. Without it
    // the dashboard summed ten records across a month of three hundred
    // appointments and reported a practice that saw patients and billed
    // almost nothing.
    //
    // Deliberately not every one: some appointments are a consultation or
    // a review with nothing to record. And deliberately no invoices —
    // those are generated in the block below from a small fixed set, so
    // the invoice arithmetic checks stay legible instead of reconciling
    // three hundred lines.
    {
      const already = await must<Row[]>("find history",
        api.get(`/items/treatment_records?limit=1&fields=id`));
      if (already.length === 0) {
        const done = await must<Array<Row & { patient: string; practitioner: string | null; starts_at: string }>>(
          "find completed appointments",
          api.get(`/items/appointments?limit=-1&fields=id,patient,practitioner,starts_at` +
                  `&filter[status][_eq]=completed&sort=starts_at`));

        const history = done
          // Four in five. The rest are the consultations and reviews that
          // produce a note and no charge.
          .filter((_, i) => i % 5 !== 4)
          .map((appointment, i) => {
            const meta = pick(TREATMENTS, i * 3);
            const treatment = treatments.find((t) => (t as Row & { code?: string }).code === meta.code);
            return {
              patient: appointment.patient,
              appointment: appointment.id,
              treatment: treatment?.id ?? null,
              practitioner: appointment.practitioner,
              tooth: meta.requires_tooth ? pick(ADULT_TEETH, i * 7) : null,
              surfaces: meta.requires_tooth ? (i % 2 === 0 ? "O" : "M,O") : null,
              performed_at: appointment.starts_at,
              price: meta.default_price,
              status: "completed",
            };
          });

        let made = 0;
        for (let i = 0; i < history.length; i += 50) {
          const batch = history.slice(i, i + 50);
          const r = await api.post("/items/treatment_records", batch);
          if (r.ok) made += batch.length;
          else log.fail(`history ${i}–${i + batch.length}: ${r.error.message}`);
        }
        log.made(`  ${made} treatment records behind the completed appointments`);
      } else {
        log.skip("clinical history");
      }
    }

    // --- invoices for that history ---------------------------------------
    //
    // Without these the dashboard reported sixty-one thousand of
    // production against two thousand invoiced, which is not a practice
    // with a billing problem — it is a demo with a missing generator, and
    // a dentist would spot it in a second.
    //
    // One invoice per visit rather than per item: a patient gets a bill
    // for the appointment, not for each surface. Written as headers first
    // and lines second, because the invoice-totals flow recalculates the
    // header from the lines — so the header is authoritative only until
    // the first line lands, and both have to agree or the suite's "no
    // header disagrees with its lines" check is right to complain.
    {
      const existing = await must<Row[]>("find history invoices",
        api.get(`/items/invoices?limit=1&fields=id&filter[notes][_eq]=visit`));
      if (existing.length === 0) {
        const records = await must<Array<Row & { patient: string; performed_at: string; price: string }>>(
          "find billable history",
          api.get(`/items/treatment_records?limit=-1&fields=id,patient,performed_at,price` +
                  `&filter[status][_eq]=completed&sort=performed_at`));

        // Grouped into visits of up to three items, which is what a course
        // of treatment on one day looks like on a bill.
        const visits: Array<typeof records> = [];
        for (let i = 0; i < records.length; i += 3) visits.push(records.slice(i, i + 3));

        const headers = visits.map((visit, i) => {
          const subtotal = visit.reduce((sum, r) => sum + Number(r.price ?? 0), 0);
          const issued = String(visit[0]!.performed_at).slice(0, 10);
          return {
            patient: visit[0]!.patient,
            number: `${practice.slug.toUpperCase().slice(0, 3)}-${issued.replace(/-/g, "")}-${String(i + 1).padStart(3, "0")}`,
            // Most bills get paid. The ones that do not are what makes the
            // outstanding figure mean anything.
            status: i % 7 === 0 ? "overdue" : i % 5 === 0 ? "sent" : "paid",
            issued_at: issued,
            due_at: new Date(new Date(issued).getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
            paid_at: i % 7 === 0 || i % 5 === 0 ? null : issued,
            tax_rate: 21,
            subtotal,
            total: Math.round(subtotal * 1.21 * 100) / 100,
            notes: "visit",
          };
        });

        const made: Row[] = [];
        for (let i = 0; i < headers.length; i += 50) {
          const r = await api.post<Row[]>("/items/invoices", headers.slice(i, i + 50));
          if (r.ok) made.push(...(Array.isArray(r.data) ? r.data : []));
          else log.fail(`visit invoices ${i}: ${r.error.message}`);
        }

        const lines = made.flatMap((invoice, i) =>
          (visits[i] ?? []).map((r, n) => ({
            invoice: invoice.id,
            treatment_record: r.id,
            description: `Treatment on ${String(r.performed_at).slice(0, 10)}`,
            quantity: 1,
            unit_price: Number(r.price ?? 0),
            amount: Number(r.price ?? 0),
            sort: n + 1,
          })),
        );
        for (let i = 0; i < lines.length; i += 50) {
          const r = await api.post("/items/invoice_lines", lines.slice(i, i + 50));
          if (!r.ok) log.fail(`visit invoice lines ${i}: ${r.error.message}`);
        }
        log.made(`  ${made.length} visit invoices, ${lines.length} lines`);
      } else {
        log.skip("visit invoices");
      }
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
          patient: patient.id, tooth,
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
        // Synthetic, and labelled as such on the record itself. No real
        // patient imaging is used anywhere in this repository: a
        // radiograph is identifiable health data under GDPR Article 9,
        // and there is no lawful basis for putting one in a demo.
        // See scripts/make-demo-radiographs.mjs.
        ["opg-panoramic.png", `${practice.slug} OPG panoramic`, "image/png", "radiograph", -420,
          "Baseline panoramic taken at the new-patient exam. SYNTHETIC IMAGE — drawn for the demo, not a real radiograph."],
        ["bitewing-right.png", `${practice.slug} bitewing right`, "image/png", "radiograph", -180,
          "Right bitewing, recall interval imaging. SYNTHETIC IMAGE — drawn for the demo, not a real radiograph."],
        ["consent-extraction.txt", `${practice.slug} consent, extraction 46`, "text/plain", "consent", -30,
          "Signed in surgery before the extraction was booked."],
        ["referral-orthodontics.txt", `${practice.slug} orthodontic referral`, "text/plain", "referral", -14,
          "Referred for crowding and a retained deciduous canine."],
        // Two DICOM studies, for the endpoint that reads their headers.
        // Stored intact and never rendered — see apps/core/src/imaging.
        ["bitewing-left.dcm", `${practice.slug} bitewing left (DICOM)`, "application/dicom", "radiograph", -150,
          "Exported from the sensor as DICOM. The header names the patient it was taken of."],
        // The one that is filed against the wrong person, on purpose. A
        // sensor exports by study number and a study lands on the wrong
        // file; this is what the header check is for, and a demo where
        // every study matches demonstrates nothing.
        ["cbct-small-field.dcm", `${practice.slug} CBCT lower right (DICOM)`, "application/dicom", "radiograph", -150,
          "Filed against this patient — the study's own header names somebody else. Check before reporting."],
      ];
      let filed = 0;
      for (const [file, title, type, kind, day, note] of docs) {
        const fileId = await uploadDemoFile(file, title, type);
        if (!fileId) continue;
        // Set here as well as by the flow. The seed is idempotent, so on
        // a re-run the document already exists and no create event fires
        // — the classification would then only ever be right on a first
        // run, which is the sort of thing that works on your machine.
        await must("classify demo file", api.patch(`/files/${fileId}`, { document_kind: kind }));
        await findOrCreate<Row>("documents", { file: fileId }, {
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
      status: "active",
    });
    await api.patch(`/items/patients/${portalPatient.id}`, { portal_user: portalUser.id });
    log.made(`  portal login ${portalEmail}`);

    // --- the practice's public website --------------------------------
    {
      const dutch = practice.country === "NL";
      await must("describe the practice publicly", api.patch(`/items/practice`, {
        website_domain: `${practice.slug}.example.com`,
        strapline: dutch
          ? "Careful dentistry on the Prinsengracht"
          : "Dentistry in Dubai Marina, seven days a week",
        intro: dutch
          ? "A five-surgery practice a short walk from Westermarkt. We see " +
            "children and adults, take emergencies the same day where we can, " +
            "and will always tell you what something costs before we start."
          : "A modern practice at the heart of the Marina, open seven days. " +
            "We see families, treat emergencies the same day, and explain the " +
            "price of any treatment before it begins.",
      }));

      /**
       * What the practice offers, in the practice's own words.
       *
       * The body copy is the point of a treatment page and is written
       * the way a dentist actually explains it at the chair: what the
       * appointment involves, how long it takes, and what it will feel
       * like. Not marketing. Somebody reads this at eleven at night
       * because they are frightened of Thursday.
       */
      const services: Array<{
        name: string; slug: string; summary: string; price: number | null; body: string;
      }> = [
        {
          name: "Check-up and hygiene", slug: "check-up-and-hygiene", price: 75,
          summary: "A full examination, a scale and polish, and a plan for anything that needs doing. Most people come twice a year.",
          body:
            "The dentist looks at every tooth, the gums around them, and the soft " +
            "tissue of the mouth and tongue. Radiographs are taken only when there " +
            "is a reason to take them — usually every two or three years, and less " +
            "often for children.\n\n" +
            "The hygienist then removes the hard deposit that a toothbrush cannot, " +
            "which is what causes gum disease, and shows you where you are missing. " +
            "Almost everybody misses the same two places.\n\n" +
            "Allow forty minutes for the two together. You will leave knowing " +
            "whether anything needs doing, what it would cost, and what happens if " +
            "you leave it — which is a real option and is sometimes the right one.",
        },
        {
          name: "Emergency appointments", slug: "emergency", price: 95,
          summary: "Toothache, a lost filling, a broken tooth. Ring before ten in the morning and we will do our best to see you the same day.",
          body:
            "An emergency appointment is about getting you out of pain, not about " +
            "finishing the treatment. Often that means opening a tooth to relieve " +
            "the pressure, dressing it, and bringing you back when you can think " +
            "straight.\n\n" +
            "Ring rather than email. Same-day slots are held back each morning and " +
            "given out in the order people ring; an email sitting unread is not a " +
            "place in that queue.\n\n" +
            "If your face is swollen, you cannot swallow, or you cannot open your " +
            "mouth properly, say so when you ring. That is not a dental appointment " +
            "and we will tell you where to go instead.",
        },
        {
          name: "White fillings", slug: "white-fillings", price: 140,
          summary: "Tooth-coloured composite, matched to the shade of the tooth beside it. Usually one visit.",
          body:
            "Composite is bonded to the tooth rather than wedged into it, so less " +
            "sound tooth has to be cut away than for the silver fillings many people " +
            "still have. The shade is matched to the tooth next to it before we " +
            "start, in daylight where we can.\n\n" +
            "One visit, usually under an hour. The tooth may be sensitive to cold " +
            "for a week or two afterwards; that settles and does not mean anything " +
            "has gone wrong.\n\n" +
            "A filling is not forever. A well-placed one in a mouth that is looked " +
            "after should give you ten years or more, and we will tell you honestly " +
            "when a tooth has had its last one and needs a crown instead.",
        },
        {
          name: "Crowns and bridges", slug: "crowns-and-bridges", price: 650,
          summary: "For a tooth too broken to fill. Made by a laboratory we have used for years, and fitted over two visits.",
          body:
            "When there is more filling than tooth left, another filling will keep " +
            "breaking. A crown covers what remains and holds it together.\n\n" +
            "Two visits. At the first the tooth is shaped, an impression or a scan " +
            "is taken, and a temporary crown goes on — which will feel slightly odd " +
            "and is meant to. The laboratory makes the real one, and it is fitted " +
            "about two weeks later.\n\n" +
            "A bridge is the same idea across a gap: the teeth either side carry a " +
            "replacement for the missing one. It is not always the right answer, and " +
            "we will say so when it is not.",
        },
        {
          name: "Root canal treatment", slug: "root-canal", price: 480,
          summary: "When the nerve inside a tooth has died or become infected. It saves the tooth, and it should not hurt.",
          body:
            "The reputation is forty years out of date. The tooth is numbed exactly " +
            "as it would be for a filling, and the pain people remember is the " +
            "infection, which this is what removes.\n\n" +
            "The nerve space is cleaned, shaped and sealed. Back teeth have three or " +
            "four canals and take longer than front teeth — plan for ninety minutes, " +
            "sometimes over two visits.\n\n" +
            "A treated tooth is more brittle than a live one, so a back tooth almost " +
            "always needs a crown afterwards to stop it splitting. That is a separate " +
            "appointment and a separate cost, and you will be told about it before " +
            "the root treatment starts, not after.",
        },
        {
          name: "Teeth straightening", slug: "orthodontics", price: null,
          summary: "Clear aligners and fixed braces for adults and teenagers. We will tell you honestly whether it is worth it.",
          body:
            "The first appointment is an assessment, not a sales pitch. Some bites " +
            "should be treated because they are damaging teeth. Some people simply " +
            "want straighter teeth, which is a perfectly good reason. And some are " +
            "better off leaving it alone, and will be told so.\n\n" +
            "Clear aligners suit mild and moderate crowding and are removable, which " +
            "means they only work if they are worn — twenty-two hours a day, which " +
            "people underestimate. Fixed braces do things aligners cannot.\n\n" +
            "There is no price on this page because there is no honest one. It " +
            "depends on how far the teeth have to move and how long that takes. You " +
            "will have a written figure before anything is agreed.",
        },
      ];
      // One service is left unpublished on purpose. A draft that has
      // always been there is what makes "a draft never reaches a
      // visitor" a check that can fail: a draft created moments before
      // the page is fetched sits inside the site's content cache, so the
      // page could not have contained it either way.
      const DRAFT_SERVICE = "orthodontics";
      for (const [i, svc] of services.entries()) {
        const published = svc.slug !== DRAFT_SERVICE;
        const row = await findOrCreate<Row>("services", { slug: svc.slug }, {
          name: svc.name, slug: svc.slug, summary: svc.summary,
          body: svc.body, price_from: svc.price, published, sort: i + 1,
        });
        // Patched as well as created, because `findOrCreate` *skips* a row
        // that already exists — so the body copy added after the first
        // seed would never reach a database that had already been seeded.
        // The practice's brand colour was invisible for exactly this
        // reason, and this is the same mistake one file away.
        //
        // By id, not by filter: Directus's PATCH-by-query is the *batch*
        // form and wants `{ query, data }`, so a flat payload comes back
        // as `"data" is required` — which reads like a missing field
        // rather than the wrong endpoint shape.
        await must("keep the treatment page current", api.patch(
          `/items/services/${String(row["id"])}`,
          { summary: svc.summary, body: svc.body, price_from: svc.price, sort: i + 1, published },
        ));
      }

      const faqs: Array<[string, string]> = [
        ["Are you taking new patients?",
         "Yes. Register online and the practice will confirm your first appointment."],
        ["What happens if I am in pain?",
         "Ring us before ten in the morning and we will try to see you that day. If we cannot, we will tell you who can."],
        ["Will you tell me what it costs first?",
         "Always. Nothing is started before you have seen the price in writing and agreed to it."],
        ["I am nervous about the dentist.",
         "Say so when you book and we will give you a longer appointment. A great many of our patients say the same thing."],
        ["Can I change or cancel an appointment online?",
         "Yes — sign in to the patient area. Cancelling online puts the slot straight back on the diary for somebody else."],
      ];
      for (const [i, [question, answer]] of faqs.entries()) {
        await findOrCreate<Row>("faqs", { question }, {
          question, answer, published: true, sort: i + 1,
        });
      }

      /*
       * Two pages the practice wrote itself, and a third left as a draft.
       *
       * The draft is the one worth seeding: a page that exists and is
       * not published is how you find out whether "published" is a
       * filter or a decoration, and the check suite asks for it by
       * address and expects a 404.
       *
       * Terms in the footer and a complaints procedure in both, because
       * a complaints procedure a patient cannot find is the same as not
       * having one — which is the argument for `nav` being a field
       * rather than a convention.
       */
      const pages: Array<[string, string, string, string, string]> = [
        ["Terms of treatment", "terms", "footer",
         "What you can expect from us, and what we ask of you.",
         "## Appointments\n\nWe hold your appointment time for you. If you cannot come, tell us as " +
         "early as you can and we will offer the slot to somebody on the cancellation list — most " +
         "of whom are in pain.\n\n## Fees\n\nWe will tell you what a treatment costs before it " +
         "starts, and we will tell you again if the plan changes. Nothing is done that you have not " +
         "agreed to.\n\n## Missed appointments\n\nA missed appointment is a chair nobody could " +
         "use. We do not charge for the first one.\n\n## Your records\n\nWe keep your clinical " +
         "record for as long as the law requires — see the privacy notice, which says exactly how " +
         "long and why."],
        ["Making a complaint", "complaints", "both",
         "If something has gone wrong, we would rather hear it from you than not hear it at all.",
         "## Tell us first\n\nSpeak to whoever treated you, or ask for the practice manager. Most " +
         "things are settled the same day, and a complaint made early is one we can still do " +
         "something about.\n\n## In writing\n\nIf you would rather write, use the address on the " +
         "contact page. We will acknowledge it within three working days and give you a full answer " +
         "within ten.\n\n## If you are still not satisfied\n\nYou can take it further, and we " +
         "will tell you how rather than wait to be asked. Going elsewhere with a complaint is your " +
         "right and not a discourtesy."],
        ["Accessibility", "accessibility", "none",
         "How to get into the building, and what to tell us beforehand.",
         "This page is a draft. It is here so that a page which exists and is not published can be " +
         "asked for by address, and answer 404."],
      ];
      let published = 0;
      for (const [i, [title, slug, nav, summary, body]] of pages.entries()) {
        const status = slug === "accessibility" ? "draft" : "published";
        await findOrCreate<Row>("pages", { slug }, {
          title, slug, nav, summary, body, status, sort: i + 1,
        });
        if (status === "published") published++;
      }
      log.made(`  ${pages.length} pages (${published} published, ${pages.length - published} draft)`);

      /*
       * Placeholder imagery, so the site is not a page of empty frames.
       *
       * Drawn from the practice's own brand colour rather than
       * downloaded: a stock photograph of a stranger presented as this
       * surgery is a small lie on a page whose argument is that it does
       * not tell them, and a photograph of a person on a dental website
       * reads as a patient.
       *
       * Every frame reads a file id, so replacing one is an upload. This
       * is what a practice does on the day it has real photographs, and
       * nothing in the code changes.
       */
      {
        // A photograph if the practice has one on disk, the drawn panel
        // if not. Same title either way, so swapping a file in replaces
        // the asset rather than leaving two.
        const heroPhoto = await websitePhoto("hero");
        const hero = heroPhoto
          ? await uploadBrandAsset(
              `${practice.name} hero`, heroPhoto.filename, heroPhoto.type,
              heroPhoto.bytes, true,
            )
          : await uploadBrandAsset(
              `${practice.name} hero`, `${practice.slug}-hero.svg`, "image/svg+xml",
              heroSvg(brandColour, practice.slug), true,
            );
        if (hero) {
          await must("set the hero image", api.patch("/items/practice", { hero_image: hero }));
        }

        let pictured = 0;
        let shot = 0;
        type Svc = Row & { slug: string; name: string; image: string | null };
        for (const svc of await must<Svc[]>("find services for imagery",
          api.get("/items/services?limit=-1&fields=id,slug,name,image"))) {
          // Redrawn whether or not the field is set, and *attached* only
          // if it is empty. Skipping a service that already has an image
          // would mean the placeholder keeps whatever the generator drew
          // the first time — the "an existing thing is skipped, so later
          // edits never land" mistake, four files away from where it was
          // last made. A practice that uploaded its own photograph keeps
          // it: the field is not touched, and the redrawn placeholder
          // simply sits unused in the Branding folder.
          const photo = await websitePhoto(svc.slug);
          const id = photo
            ? await uploadBrandAsset(
                `Treatment — ${svc.name}`, `service-${svc.slug}-${photo.filename}`,
                photo.type, photo.bytes, true,
              )
            : await uploadBrandAsset(
                `Treatment — ${svc.name}`,
                `service-${svc.slug}.svg`, "image/svg+xml",
                serviceSvg(brandColour, svc.slug), true,
              );
          if (photo) shot++;
          if (!id) continue;
          if (!svc.image) {
            await must("set the treatment image", api.patch(`/items/services/${String(svc.id)}`, { image: id }));
          }
          pictured++;
        }
        log.made(`  ${pictured} treatment images set — ${shot} photographs, ${pictured - shot} drawn`);
      }

      // The clinicians who agreed to appear. Opt-in, so the seed sets it
      // explicitly rather than relying on a default.
      const clinicians = await must<Array<Row & { job_title: string | null; first_name: string | null; last_name: string | null; public_photo: string | null }>>(
        "find clinicians for the team page",
        api.get(`/users?limit=-1&fields=id,job_title,first_name,last_name,public_photo`));
      const bios: Record<string, string> = {
        principal_dentist: "Qualified in 2004 and has run this practice since 2013. Particular interest in restoring worn and broken front teeth.",
        associate_dentist: "Joined in 2019. Sees both adults and children, and takes most of our same-day emergencies.",
        hygienist: "Works with patients who have gum disease, and with anyone who would rather their check-up took a little longer.",
      };
      // The order a patient reads them in, not the order the query
      // returned them in. Sorted by row, the associate came out above the
      // principal — which on a practice website is the sort of detail
      // somebody notices and nobody can explain.
      const rank: Record<string, number> = {
        principal_dentist: 1, associate_dentist: 2, hygienist: 3,
      };
      let shown = 0;
      for (const person of clinicians) {
        const job = String(person["job_title"] ?? "");
        const bio = bios[job];
        if (!bio) continue;
        // A portrait frame, so the people page is not three empty
        // squares. Initials on the practice's colour rather than a grey
        // silhouette: an outline of a head reads as somebody who declined
        // to be seen, and on a page of three clinicians it reads as three.
        const who = [person.first_name, person.last_name].filter(Boolean).join(" ") || "Clinician";
        // A real likeness if the practice supplied one — `hannah-prins.jpg`
        // in assets/website — otherwise the drawn monogram. Same title
        // either way, so dropping a face in replaces the placeholder
        // rather than leaving two files behind.
        const face = await websitePhoto(portraitSlug(who));
        const drawn = face
          ? await uploadBrandAsset(
              `Portrait — ${who}`, `portrait-${portraitSlug(who)}-${face.filename}`,
              face.type, face.bytes, true,
            )
          : await uploadBrandAsset(
              `Portrait — ${who}`,
              `portrait-${String(person.id).slice(0, 8)}.svg`, "image/svg+xml",
            portraitSvg(brandColour, who), true,
          );
        const photo = person.public_photo ?? drawn;
        await must("publish a clinician profile", api.patch(`/users/${person.id}`, {
          public_profile: true, public_bio: bio, public_sort: rank[job] ?? 99,
          ...(photo ? { public_photo: photo } : {}),
        }));
        shown++;
      }
      log.made(`  website: ${services.length - 1} services published (1 left as a draft), ${faqs.length} questions, ${shown} clinician profiles`);
    }

    // --- a patient who left a very long time ago ----------------------
    //
    // Without one, the retention review is a page that always says zero —
    // and a feature that cannot be seen working is a feature nobody can
    // tell is broken. Every other row in this seed was created today or
    // within the last year, so nothing has ever been past its period.
    //
    // A practice that has been going twenty years has exactly this
    // patient: seen a few times, moved away, record still on file because
    // the WGBO says it must be. The rows are written through the API like
    // everything else and then back-dated in SQL, because `date_created`
    // is a Directus system field no payload key overrides — see
    // `demo-history.ts`, which is named for doing precisely that.
    {
      const dutchPractice = practice.country === "NL";
      const archiveRef = `${practice.slug.toUpperCase().slice(0, 3)}-ARCH`;
      const longAgo = await findOrCreate<Row>("patients", { reference: archiveRef }, {
        reference: archiveRef,
        first_name: dutchPractice ? "Elly" : "Fatima",
        last_name: dutchPractice ? "Bakker" : "Al Mansoori",
        date_of_birth: "1948-03-11",
        status: "inactive",
        // An address the practice has not used in twenty years, which is
        // the point: the record is kept because the law says so, not
        // because anybody expects to write to her. `email` is required on
        // this collection, so "no email" is not expressible — worth
        // noticing, because a practice digitising paper records from the
        // nineties will meet exactly that.
        email: dutchPractice ? "elly.bakker@example.com" : "fatima.almansoori@example.com",
        phone: dutchPractice ? "+31 20 555 0199" : "+971 4 555 0199",
        preferred_language: dutchPractice ? "nl" : "en",
        allow_email: false, allow_sms: false, allow_whatsapp: false,
      });

      const practitioner = users["owner"];

      /*
       * Deliberately **no appointment**.
       *
       * One was the obvious thing to add and it broke four unrelated
       * checks, which turned out to be the checks being right. An
       * appointment from twenty-one years ago is judged by this suite
       * against *today's* opening hours and today's rota — and a rota
       * from 2005 is not in this system and never will be. Nothing can
       * honestly validate it.
       *
       * It costs nothing: `last_contact` falls back to the row's own date
       * when a patient has no appointment on file, so her record is still
       * twenty-one years old and still comes due.
       */
      await findOrCreate<Row>("clinical_notes", { patient: longAgo.id }, {
        patient: longAgo.id, author: practitioner ?? null,
        written_on: new Date().toISOString().slice(0, 10),
        kind: "examination",
        body: "Routine examination. Nothing requiring treatment. Patient moving away.",
      });
      // Unsigned, and that is the realistic shape for a record this old:
      // the paper was signed and the scan is in a filing cabinet. A signed
      // consent carries a fingerprint binding it to what it signed, and
      // inventing one for a row the practice never signed here would make
      // that guarantee a decoration.
      await findOrCreate<Row>("consents", { patient: longAgo.id }, {
        patient: longAgo.id,
        title: "Examination and radiographs",
        risks_discussed: true, alternatives_discussed: true,
      });
      const archivedInvoice = await findOrCreate<Row>("invoices", { number: `${archiveRef}-0001` }, {
        patient: longAgo.id,
        number: `${archiveRef}-0001`,
        status: "paid",
        issued_at: new Date().toISOString().slice(0, 10),
        due_at: new Date().toISOString().slice(0, 10),
        paid_at: new Date().toISOString(),
        // Subtotal and rate, not a bare total: every invoice in this
        // system has to be its subtotal plus the tax on the row, and the
        // suite checks it. A hand-typed total is how that stops being true.
        tax_rate: 21,
        subtotal: 42,
        total: Math.round(42 * 1.21 * 100) / 100,
      });
      const oldInvoiceId = archivedInvoice.id;
      // A line, because an invoice header that disagrees with its own
      // lines is exactly what the suite refuses — and an invoice with a
      // subtotal and nothing behind it disagrees with zero.
      if (oldInvoiceId) {
        await findOrCreate<Row>("invoice_lines", { invoice: oldInvoiceId, description: "Examination" }, {
          invoice: oldInvoiceId,
          description: "Examination", quantity: 1, unit_price: 42, amount: 42, sort: 1,
        });
      }
      await findOrCreate<Row>("messages", { patient: longAgo.id }, {
        patient: longAgo.id,
        direction: "outbound", channel: "email", kind: "reminder",
        subject: "Your appointment", body: "A reminder of your appointment.",
        // `sent` with nothing behind it is the state this system refuses
        // to record — it is how a practice ends up believing a message
        // went out. Both are set, as the adapter would have set them.
        status: "sent",
        provider_id: `mock:archive-${practice.slug}`,
        sent_at: new Date().toISOString(),
      });
      /*
       * Patched as well as created, for the reason this seed has met
       * three times now: `findOrCreate` **skips** a row that already
       * exists, so a corrected shape never reaches a database that has
       * already been seeded. The consent, the invoice and the message all
       * had to be fixed after the suite refused them, and none of the
       * fixes landed until this ran.
       */
      const consent = (await must<Row[]>("find the archived consent",
        api.get(`/items/consents?limit=1&fields=id&filter[patient][_eq]=${longAgo.id}`)))[0];
      if (consent) {
        await must("unsign the archived consent",
          api.patch(`/items/consents/${consent.id}`, { signed_on: null }));
      }
      const oldInvoice = (await must<Row[]>("find the archived invoice",
        api.get(`/items/invoices?limit=1&fields=id&filter[number][_eq]=${archiveRef}-0001`)))[0];
      if (oldInvoice) {
        await must("balance the archived invoice", api.patch(`/items/invoices/${oldInvoice.id}`, {
          tax_rate: 21, subtotal: 42, total: Math.round(42 * 1.21 * 100) / 100,
        }));
      }
      const oldMessage = (await must<Row[]>("find the archived message",
        api.get(`/items/messages?limit=1&fields=id&filter[patient][_eq]=${longAgo.id}`)))[0];
      if (oldMessage) {
        await must("give the archived message something behind it",
          api.patch(`/items/messages/${oldMessage.id}`, {
            provider_id: `mock:archive-${practice.slug}`,
            sent_at: new Date().toISOString(),
          }));
      }

      log.made(`  1 patient who left the practice, for the retention review`);
    }

    // --- the disposal register -----------------------------------------
    //
    // Two rows, and again the second is the one worth having. A register
    // of everything that was destroyed reads like a queue; a register
    // that also records what was **held back, and why**, is a review.
    // Without the second, "not this one" can only be expressed by doing
    // nothing, which is indistinguishable from not having looked.
    {
      const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
      const financialRule = (await must<Row[]>("find the financial retention rule",
        api.get(`/items/retention_rules?limit=1&fields=id` +
                `&filter[record_type][_eq]=financial`)))[0];
      const prefix = practice.slug.toUpperCase().slice(0, 3);

      const reviews: Array<Record<string, unknown>> = [
        {
          reference: `${prefix}-DIS-2026-01`,
          status: "carried_out",
          record_type: "financial",
          rule: financialRule?.id ?? null,
          covering:
            "Invoices and payment records issued before the start of the statutory " +
            "period, for patients with no outstanding balance and no open query.",
          records_counted: 148,
          reviewed_as_at: daysAgo(40),
          authorised_by: users["owner"],
          authorised_on: daysAgo(38),
          grounds:
            "The statutory period has elapsed and nothing else requires these to be " +
            "kept: no claim, no complaint, no outstanding balance. Checked against the " +
            "retention rule linked above rather than against a remembered number.",
          method: "deleted",
          carried_out_on: daysAgo(31),
          carried_out_by: users["owner"],
        },
        {
          reference: `${prefix}-DIS-2026-02`,
          status: "withheld",
          record_type: "clinical_record",
          covering:
            "One clinical record past its statutory period, identified in the same " +
            "review as the financial records above.",
          records_counted: 1,
          reviewed_as_at: daysAgo(40),
          // The field that makes this a review rather than a queue.
          withheld_reason:
            "Subject to an open complaint. The period elapsing is the reason this was " +
            "looked at, not a reason to destroy it — a record under complaint is kept " +
            "until the matter is closed and then reviewed again.",
        },
      ];
      for (const review of reviews) {
        await findOrCreate<Row>("disposals", { reference: String(review["reference"]) }, {
          ...review,
        });
      }
      log.made(`  ${reviews.length} disposal reviews (one carried out, one held back)`);
    }

    // --- the breach register ------------------------------------------
    //
    // Two rows, and the second is the one worth having. Article 33(5)
    // requires a practice to document **every** breach, including the
    // ones it decides not to report — and a register containing only the
    // reported ones is evidence that the reporting decision was never
    // written down. Most demos ship the first row and not the second.
    {
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
      const breaches: Array<Record<string, unknown>> = [
        {
          reference: `${practice.slug.toUpperCase().slice(0, 3)}-BR-2026-01`,
          discovered_at: hoursAgo(18 * 24),
          occurred_at: hoursAgo(19 * 24),
          status: "closed",
          summary: "Recall letters posted to the wrong addresses",
          facts:
            "A mail merge was run against an export taken before an address update, so " +
            "eleven recall letters went to previous addresses. Each letter carried the " +
            "patient's name, the practice's name and an appointment date. No clinical " +
            "detail was included.",
          data_categories: ["identity", "contact"],
          people_affected: 11,
          records_affected: 11,
          likely_consequences:
            "Somebody at the old address learns that the named person is a patient here " +
            "and when they are due. Distressing rather than damaging, but it is health " +
            "data by implication.",
          measures_taken:
            "The merge now runs against a live query rather than an export. All eleven " +
            "patients were rung. The two letters returned undelivered were shredded.",
          risk: "risk",
          authority_notified_at: hoursAgo(18 * 24 - 9),
          authority_reference: "AP-2026-004417",
          subjects_notified_at: hoursAgo(18 * 24 - 26),
          subjects_notified_how: "Telephoned, followed by a letter to the correct address.",
        },
        {
          reference: `${practice.slug.toUpperCase().slice(0, 3)}-BR-2026-02`,
          discovered_at: hoursAgo(6 * 24),
          occurred_at: hoursAgo(6 * 24),
          status: "closed",
          summary: "Appointment reminder sent to the wrong email address",
          facts:
            "A patient gave an address with a transposed character and it was entered as " +
            "given. One reminder reached a stranger: the patient's first name, the " +
            "practice's name, and a date and time. No surname, no record, no attachment.",
          data_categories: ["identity", "contact"],
          people_affected: 1,
          records_affected: 1,
          likely_consequences:
            "A stranger learns a first name and that the person has a dental appointment. " +
            "Not enough to identify anybody.",
          measures_taken:
            "The address was corrected with the patient on the telephone. New addresses " +
            "are now read back before the first message is sent.",
          risk: "unlikely",
          // The field that makes this row worth keeping. Without it the
          // register cannot show that a decision was made rather than
          // missed — and the database refuses the row for exactly that
          // reason.
          why_not_notified:
            "One recipient, a first name and an appointment time, no clinical content and " +
            "no surname. Assessed as unlikely to result in a risk to the rights and " +
            "freedoms of the patient, so not notified under Article 33(1). Documented " +
            "here under Article 33(5).",
        },
      ];
      for (const breach of breaches) {
        await findOrCreate<Row>("data_breaches", { reference: String(breach["reference"]) }, {
          ...breach,
        });
      }
      log.made(`  ${breaches.length} breach-register entries (one reported, one documented and not)`);
    }

    // --- what this practice is obliged to keep, and for how long -------
    //
    // The two demo practices are in different jurisdictions and are
    // subject to genuinely different statutory periods. That is the whole
    // reason retention is a table: twenty years in the Netherlands,
    // twenty-five in the UAE, and no single number is right for both.
    {
      const dutch = practice.country === "NL";
      const rules: Array<[string, number, string, string]> = dutch
        ? [
            ["clinical_record", 20, "last_contact", "WGBO, Art. 7:454 BW"],
            ["imaging", 20, "last_contact", "WGBO, Art. 7:454 BW"],
            ["consent", 20, "last_contact", "WGBO, Art. 7:454 BW"],
            ["correspondence", 20, "last_contact", "WGBO, Art. 7:454 BW"],
            ["financial", 7, "record_date", "Algemene wet inzake rijksbelastingen, Art. 52"],
            ["audit_log", 2, "record_date", "NEN 7513 — retained long enough to investigate"],
          ]
        : [
            ["clinical_record", 25, "last_contact", "UAE Federal Law No. 2 of 2019, Art. 14"],
            ["imaging", 25, "last_contact", "UAE Federal Law No. 2 of 2019, Art. 14"],
            ["consent", 25, "last_contact", "UAE Federal Law No. 2 of 2019, Art. 14"],
            ["correspondence", 25, "last_contact", "UAE Federal Law No. 2 of 2019, Art. 14"],
            ["financial", 5, "record_date", "UAE Federal Decree-Law No. 28 of 2022, Art. 56"],
            ["audit_log", 2, "record_date", "Retained long enough to investigate an incident"],
          ];
      for (const [record_type, years, starts_from, legal_basis] of rules) {
        await findOrCreate<Row>("retention_rules", { record_type }, {
          record_type, years, starts_from, legal_basis,
        });
      }
      log.made(`  ${rules.length} retention rules (${dutch ? "NL" : "AE"} — clinical records ${rules[0]![1]} years)`);
    }

  }

  // Give some patients a mobile and permission to use it, so the channel
  // choice has something to choose between. Email on and the rest off is
  // the schema default and the conservative reading — a practice has an
  // address because it was given for correspondence, and holding a mobile
  // number is not consent to text it.
  {
    const patients = await must<Row[]>("find patients for contact consent",
      api.get("/items/patients?limit=-1&fields=id&sort=id"));
    let consented = 0;
    for (const [i, patient] of patients.entries()) {
      // Two in five have agreed to texts, and one in five has asked for
      // texts *instead* of email. That second group is the point: with
      // everybody on email as well, the preferred channel always wins and
      // the fallback never runs — a demo that cannot show its own
      // consent logic working.
      if (i % 5 >= 2) continue;
      const textsOnly = i % 5 === 0;
      const r = await api.patch(`/items/patients/${patient.id}`, {
        allow_sms: true,
        allow_email: !textsOnly,
        phone: `+3120555${String(1000 + i).slice(-4)}`,
      });
      if (r.ok) consented++;
    }
    // And one who has asked not to be contacted at all — the row that
    // proves a refusal is recorded rather than a message quietly not sent.
    const last = patients[patients.length - 1];
    if (last) {
      await api.patch(`/items/patients/${last.id}`, {
        allow_email: false, allow_sms: false, allow_whatsapp: false,
      });
    }
    log.made(`  ${consented} patients consented to texts (some instead of email), 1 opted out of everything`);
  }

  // --- money actually received ----------------------------------------
  //
  // `invoices.paid_at` alone says an invoice is settled and nothing else.
  // Without payment rows behind it the accounting export has one side of
  // every entry — invoices raised, nothing ever collected — and a journal
  // that only debits the debtors account is a demo of a practice that
  // has never been paid.
  {
    type PaidInvoice = Row & {
      patient: string; total: string;
      paid_at: string | null; issued_at: string | null;
    };
    const settled = await must<PaidInvoice[]>(
      "find paid invoices",
      api.get("/items/invoices?limit=-1&fields=id,patient,total,paid_at,issued_at" +
              "&filter[status][_eq]=paid&sort=number"),
    );
    let taken = 0;
    for (const [i, invoice] of settled.entries()) {
      // Three ways patients actually pay, in roughly the proportions a
      // practice sees. Deterministic by index so a re-seed does not
      // reshuffle the books.
      const method = i % 5 === 0 ? "cash" : i % 5 === 1 ? "bank_transfer" : "card";
      const made = await findOrCreate<Row>(
        "payments",
        { invoice: invoice.id as string },
        {
          patient: invoice.patient,
          invoice: invoice.id,
          amount: invoice.total,
          method,
          status: "settled",
          provider: method === "card" ? "payments.mock-gateway" : "payments.desk",
          provider_reference:
            method === "card"
              ? `mock:ch_seed${String(i).padStart(4, "0")}`
              : `desk:seed-${String(i).padStart(4, "0")}`,
          // The key a real caller would have generated. Unique, so a
          // re-seed collides with the row it already made rather than
          // taking the money a second time — which is the same guard the
          // service relies on, exercised by the seed itself.
          idempotency_key: `seed-${invoice.id}`,
          received_at: invoice.paid_at ?? invoice.issued_at,
        },
      );
      if (made) taken++;
    }

    // One refund, because a set of books with no credit note in it has
    // never been used. The negative amount is the whole mechanism — a
    // refund is a payment with the sign flipped, not a different table.
    const refundable = settled[2];
    if (refundable) {
      await findOrCreate<Row>(
        "payments",
        { idempotency_key: `seed-refund-${refundable.id}` },
        {
          patient: refundable.patient,
          invoice: refundable.id,
          amount: `-${(Number(refundable.total) / 4).toFixed(2)}`,
          method: "card",
          status: "settled",
          provider: "payments.mock-gateway",
          provider_reference: `mock:re_seed0002`,
          idempotency_key: `seed-refund-${refundable.id}`,
          received_at: refundable.paid_at ?? refundable.issued_at,
          note: "Goodwill refund — one unit of the plan was not carried out.",
        },
      );
    }
    log.made(`  ${taken} payments recorded, one of them refunded in part`);
  }

  // Everything above was created in this run, so every `date_created` is
  // "a moment ago" — which makes patient growth one bar and recall
  // conversion zero. Both look broken. See demo-history.ts.
  await spreadDemoHistory();

  log.info(`all demo accounts use the password ${DEMO_PASSWORD}`);

  // --- the reminder sweep's own account --------------------------------
  //
  // A static token, because the reminder sweep runs on a timer and has no
  // user to borrow one from. Generated here rather than committed: a
  // credential that ships in a repository is a credential every clone
  // shares, and this one can read every practice's diary.
  //
  // The awkward part is that Directus redacts `token` on read — it comes
  // back as ten asterisks, which is truthy. Trusting it meant the second
  // seed run decided the account already had a token, and wrote
  // `**********` into .env over the real one. The core service then
  // authenticated fine (it had the old value in its environment) while
  // every other reader of .env had a string of asterisks, and the failure
  // showed up as a 403 from an endpoint nobody had touched.
  //
  // So .env is treated as the source of truth, and the database is made
  // to agree with it. That converges from either direction: a lost .env
  // gets a fresh token, and a restored one is pushed back into Directus.
  {
    const email = "reminders@enamel.dev";
    const REDACTED = /^\*+$/;

    const fromEnv = (process.env["REMINDER_TOKEN"] ?? "").trim();
    const usable = fromEnv && !REDACTED.test(fromEnv) ? fromEnv : null;
    const token = usable ?? randomBytes(32).toString("base64url");

    const existing = await must<Row[]>(
      "find the reminder account",
      api.get(`/users?limit=1&fields=id&filter[email][_eq]=${encodeURIComponent(email)}`),
    );

    const payload = {
      first_name: "Reminder",
      last_name: "Sweep",
      role: roleIds.get("Reminder service") ?? null,
      status: "active",
      token,
    };

    if (existing[0]) {
      await must("token the reminder account", api.patch(`/users/${existing[0].id}`, payload));
      log.skip("reminder service account");
    } else {
      await must("create the reminder account", api.post("/users", { email, ...payload }));
      log.made(`  reminder service account ${email}`);
    }

    await writeEnv("REMINDER_TOKEN", token);
  }

  // --- the website's own read-only account -------------------------------
  //
  // A third service credential, and a third because what each one can do
  // if it leaks is the only thing standing behind it. This one reads
  // opening hours and a list of services. It cannot read a patient, and
  // the verify suite asserts that rather than trusting this comment.
  {
    const email = "website@enamel.dev";
    const REDACTED = /^\*+$/;
    const fromEnv = (process.env["WEBSITE_TOKEN"] ?? "").trim();
    const usable = fromEnv && !REDACTED.test(fromEnv) ? fromEnv : null;
    const token = usable ?? randomBytes(32).toString("base64url");

    const existing = await must<Row[]>(
      "find the website account",
      api.get(`/users?limit=1&fields=id&filter[email][_eq]=${encodeURIComponent(email)}`),
    );
    const payload = {
      first_name: "Website",
      last_name: "Reader",
      role: roleIds.get("Website") ?? null,
      status: "active",
      token,
    };
    if (existing[0]) {
      await must("token the website account", api.patch(`/users/${existing[0].id}`, payload));
      log.skip("website account");
    } else {
      await must("create the website account", api.post("/users", { email, ...payload }));
      log.made(`  website account ${email}`);
    }
    await writeEnv("WEBSITE_TOKEN", token);
  }

  // --- the portal's registrar account ------------------------------------
  //
  // Separate from the reminder sweep's, and the separation is the point: a
  // token that can create a login is not a token to share with a job that
  // sets booleans. Same .env-is-the-source-of-truth dance, same reason —
  // Directus redacts `token` on read, so trusting what comes back writes a
  // row of asterisks over the real credential.
  {
    const email = "portal@enamel.dev";
    const REDACTED = /^\*+$/;
    const fromEnv = (process.env["PORTAL_TOKEN"] ?? "").trim();
    const usable = fromEnv && !REDACTED.test(fromEnv) ? fromEnv : null;
    const token = usable ?? randomBytes(32).toString("base64url");

    const existing = await must<Row[]>(
      "find the portal account",
      api.get(`/users?limit=1&fields=id&filter[email][_eq]=${encodeURIComponent(email)}`),
    );
    const payload = {
      first_name: "Portal",
      last_name: "Registrar",
      role: roleIds.get("Portal registrar") ?? null,
      status: "active",
      token,
    };
    if (existing[0]) {
      await must("token the portal account", api.patch(`/users/${existing[0].id}`, payload));
      log.skip("portal registrar account");
    } else {
      await must("create the portal account", api.post("/users", { email, ...payload }));
      log.made(`  portal registrar account ${email}`);
    }
    await writeEnv("PORTAL_TOKEN", token);

    // The account this replaces. It was called scheduler@ back when the
    // service was called the scheduler; the credential is scoped to the
    // reminder sweep, not to whichever process happens to run it, so it
    // was renamed with the job. Left behind it would be a live token with
    // read access to every practice's diary and nothing using it.
    const retired = await must<Row[]>(
      "find the old scheduler account",
      api.get(`/users?limit=1&fields=id&filter[email][_eq]=scheduler%40enamel.dev`),
    );
    if (retired[0]) {
      const gone = await api.delete(`/users/${retired[0].id}`);
      if (gone.ok) log.made("  retired the old scheduler@enamel.dev account");
      else log.fail(`retire scheduler@enamel.dev: ${gone.error.message}`);
    }
  }

  /*
   * A demonstration queue operator, so the narrow grant can be tried
   * rather than described.
   *
   * A person with a password, not a service account with a token: the
   * whole point is that somebody signs into Directus, sees a sidebar with
   * nothing in it, clicks Queues and gets the board. An account nobody
   * can log into would prove the permission exists and not that it works.
   */
  {
    const email = "ops@enamel.dev";
    const existing = await must<Row[]>(
      "find the queue operator account",
      api.get(`/users?limit=1&fields=id&filter[email][_eq]=${encodeURIComponent(email)}`),
    );
    const payload = {
      first_name: "Ops",
      last_name: "Operator",
      role: roleIds.get("Queue operator") ?? null,
      status: "active",
      password: DEMO_PASSWORD,
    };
    if (existing[0]) {
      await must("update the queue operator", api.patch(`/users/${existing[0].id}`, payload));
      log.skip("queue operator account");
    } else {
      await must("create the queue operator", api.post("/users", { email, ...payload }));
      log.made(`  queue operator account ${email}`);
    }
  }
}

/**
 * Puts a generated secret into .env without disturbing what is there.
 *
 * The alternative is printing it and asking somebody to paste it, which
 * works exactly once and then gets skipped. `docker compose` reads .env
 * on its own, so writing it here is what makes `pnpm setup` a single
 * command rather than a command and an instruction.
 */
async function writeEnv(key: string, value: string): Promise<void> {
  const path = fromRoot(".env");
  let contents = "";
  try {
    contents = await readFile(path, "utf8");
  } catch {
    log.warn(`no .env to write ${key} into — set it by hand`);
    return;
  }

  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(contents)
    ? contents.replace(pattern, line)
    : `${contents.replace(/\n*$/, "")}\n\n# Written by the seed. The scheduler service authenticates with this.\n${line}\n`;

  if (next === contents) return;
  await writeFile(path, next, "utf8");
  log.made(`  ${key} written to .env`);
}
