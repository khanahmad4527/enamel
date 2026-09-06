import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { api, must, authHeader } from "./client.js";
import { log } from "./log.js";
import { DEMO_PASSWORD } from "./env.js";

/**
 * Project branding, applied through the API so it ships with the repo
 * rather than living in someone's browser session. A clone gets the same
 * login screen and the same admin chrome as everyone else.
 *
 * Directus exposes: project_logo (admin nav), public_favicon (browser
 * tab), public_background + public_foreground (login screen), and
 * theme_*_overrides, which restyle the whole admin without custom CSS.
 */

const BRAND = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "brand");

/**
 * The brand kit gets a folder of its own. The root of the file library is
 * where a practice's scans and referral letters land, and an admin who
 * cannot tell the logo from a patient document will eventually delete the
 * wrong one.
 *
 * The name is rendered literally. `$t:` references resolve in field
 * notes, divider titles and bookmark names, but not in folder names — nor
 * in file titles, the project descriptor, or the login note. Verified
 * against 12.3.1 rather than assumed: each renders the raw `$t:key`
 * string. So this word has to work in all four languages on its own,
 * which is why it is not "Merk", "Marke" or "Identité".
 */
const FOLDER = "Branding";

const TEAL = "#0B5A52";       // header/primary — deep enough for white to sit calmly on it
const TEAL_LIGHT = "#0D6E63";  // primary action colour in the light theme
const MINT = "#6FD8C8";
const INK = "#0C1B1A";

type FileRow = { id: string; filename_download: string; folder: string | null };
type FolderRow = { id: string; name: string };

/** Creates the folder once, and finds it by name on every later run. */
async function ensureFolder(name: string): Promise<string> {
  const found = await must<FolderRow[]>(
    "find folder",
    api.get(`/folders?limit=1&fields=id&filter[name][_eq]=${encodeURIComponent(name)}`),
  );
  if (found.length && found[0]) {
    log.skip(`folder ${name}`);
    return found[0].id;
  }
  const made = await must<FolderRow>("create folder", api.post("/folders", { name }));
  log.made(`folder ${name}`);
  return made.id;
}

/**
 * Uploads once and reuses the existing file on later runs — and moves it
 * if it predates the folder, so an instance provisioned by an earlier
 * version tidies itself up on the next run instead of keeping two homes
 * for the same asset.
 */
async function upload(file: string, title: string, type: string, folder: string): Promise<string> {
  const found = await must<FileRow[]>(
    "find file",
    api.get(
      `/files?limit=1&fields=id,folder&filter[filename_download][_eq]=${encodeURIComponent(file)}`,
    ),
  );
  if (found.length && found[0]) {
    if (found[0].folder !== folder) {
      await must("move file", api.patch(`/files/${found[0].id}`, { folder }));
      log.made(`asset ${file} moved into ${FOLDER}`);
    } else {
      log.skip(`asset ${file}`);
    }
    return found[0].id;
  }

  const bytes = await readFile(join(BRAND, file));
  const form = new FormData();
  // Directus reads multipart fields in order: anything that is not the
  // payload has to be appended before it, or it is ignored.
  form.append("title", title);
  form.append("folder", folder);
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), file);

  // FormData needs the raw fetch — our JSON client would stringify it.
  const res = await fetch(`${api.url}/files`, {
    method: "POST",
    headers: { authorization: authHeader() },
    body: form,
  });
  const body = (await res.json()) as { data?: FileRow; errors?: unknown };
  if (!res.ok || !body.data) {
    throw new Error(`upload ${file}: ${JSON.stringify(body.errors ?? body)}`);
  }
  log.made(`asset ${file}`);
  return body.data.id;
}

/**
 * The rest of the kit. Directus never asks for these, but a designer who
 * inherits the instance should not have to ask for the source marks — and
 * the icons are what you reach for the day this gets a public front end.
 */
const KIT: ReadonlyArray<readonly [file: string, title: string, type: string]> = [
  ["logo.svg", "Enamel logo (vector)", "image/svg+xml"],
  ["mark.svg", "Enamel mark (vector)", "image/svg+xml"],
  ["icon-512.png", "Enamel app icon, 512px", "image/png"],
  ["apple-touch-icon.png", "Enamel Apple touch icon, 180px", "image/png"],
  ["favicon.ico", "Enamel favicon (ICO)", "image/x-icon"],
];

/**
 * The sign-in note is the first thing a stranger reads, and it is the only
 * place to hand them the two accounts this project exists to contrast. A
 * demo whose credentials live in a README is a demo nobody signs into.
 */
const PUBLIC_NOTE = [
  "**Demo instance.** Every record here is invented.",
  "",
  // Prose, not labelled lines. The note renders in a ~410px column, and
  // a label beside an email address is wider than that — so "Front desk"
  // and the address it belonged to landed on separate lines and read as
  // four unrelated fragments. In a sentence they wrap wherever they like
  // without coming apart, and the addresses say which is which anyway.
  `Sign in as \`desk@riverside.example.com\`, then again as \`dentist@riverside.example.com\`. Password \`${DEMO_PASSWORD}\` for both.`,
  "",
  "Open the same patient as each. The dentist reads the clinical notes; the front desk never sees that they exist.",
  "",
  "`owner@riverside.example.com` works in Dutch — same instance, four languages.",
].join("\n");

/**
 * One rule, for one genuine gap: the project descriptor in the nav header
 * inherits `--theme--foreground-subdued` (#666672, a grey-mauve), which is
 * too dim against the dark shell to read comfortably.
 *
 * It takes its colour from the project foreground the theme already
 * defines, rather than a hardcoded white — which was correct while the
 * project tile was teal in both themes and became invisible in light mode
 * the moment 12 stopped painting that tile.
 */
const CUSTOM_CSS = `.project-info .descriptor {
  color: var(--theme--navigation--project--foreground);
  opacity: 0.72;
}`;

/**
 * Directus 12 blocks the admin behind a "You have not set a project owner"
 * modal until someone names a contact and accepts the MSCL-1.0-GPL terms.
 * Every fresh clone hits it on first sign-in.
 *
 * That acceptance belongs to whoever runs the instance, not to a repo, so
 * this ships blank and reads the environment. Fill PROJECT_OWNER_EMAIL in
 * .env and the modal never appears; leave it and you accept the terms
 * yourself, in the dialog, like Directus intends.
 */
const OWNER = process.env.PROJECT_OWNER_EMAIL?.trim();

export async function applyBranding(): Promise<void> {
  const folder = await ensureFolder(FOLDER);

  const logo = await upload("logo-white.png", "Enamel logo", "image/png", folder);
  const favicon = await upload("icon-192.png", "Enamel favicon", "image/png", folder);
  const background = await upload("login-background.jpg", "Enamel login background", "image/jpeg", folder);
  const foreground = await upload("login-foreground.png", "Enamel wordmark", "image/png", folder);
  for (const [file, title, type] of KIT) await upload(file, title, type, folder);

  // Only the tokens that carry the identity are overridden; everything
  // else inherits, so the admin keeps working after a Directus upgrade.
  const light = {
    primary: TEAL_LIGHT,
    primaryBackground: "#E6F2F0",
    secondary: MINT,
    foreground: "#1B2E2C",
    foregroundAccent: INK,
    background: "#FBFCFC",
    navigation: {
      // `navigation.list`, not `navigation.background` — see the dark
      // block below for why.
      list: { background: "#F2F6F5" },
      project: { foreground: INK },
      modules: { background: INK, button: { foregroundActive: MINT } },
    },
  };

  const dark = {
    primary: MINT,
    primaryBackground: "#123B36",
    secondary: "#8FEADC",
    foreground: "#DCE8E6",
    foregroundAccent: "#FFFFFF",
    background: "#0F1F1D",
    /**
     * Two of these keys moved in Directus 12, and the overrides were
     * silently ignored until they were corrected — Directus accepts an
     * unknown theme key and does nothing with it, so a stale name looks
     * exactly like a working one.
     *
     *   navigation.background         -> navigation.list.background
     *   navigation.project.background -> gone; the project tile now takes
     *                                    shell.background
     *
     * `shell.background` is deliberately not set. It paints the entire
     * shell — header bar, nav pane and module gutter — so a teal project
     * tile costs you a teal application. The identity carries on the logo
     * tile, the nav list and the mint accents instead.
     *
     * Verified against the variables the 12.3.1 admin bundle actually
     * emits, not against the 11 docs.
     */
    navigation: {
      list: { background: "#132726" },
      project: { foreground: "#FFFFFF" },
      modules: { background: "#0A1716", button: { foregroundActive: MINT } },
    },
  };

  await must(
    "apply settings",
    api.patch("/settings", {
      project_name: "Enamel",
      project_descriptor: "Dental practice management",
      project_color: TEAL,
      project_url: "https://khanahmad.com",
      project_logo: logo,
      public_favicon: favicon,
      public_background: background,
      public_foreground: foreground,
      public_note: PUBLIC_NOTE,
      default_appearance: "dark",
      // Explicit, not inherited: without it Directus falls back to the
      // browser's locale, so the same instance greets two people in two
      // languages before either has signed in.
      default_language: "en-US",
      theme_light_overrides: light,
      theme_dark_overrides: dark,
      custom_css: CUSTOM_CSS,
      // product_updates rides along: naming an owner without it leaves
      // the modal half-answered and Directus asks again.
      ...(OWNER ? { project_owner: OWNER, product_updates: false } : {}),
    }),
  );
  log.made("project settings, palette and login screen");
  if (OWNER) log.made(`project owner ${OWNER} (MSCL terms accepted)`);
  else log.warn("no PROJECT_OWNER_EMAIL — Directus will ask for one on first sign-in");
}
