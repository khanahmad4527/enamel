import { fromRoot } from "./root.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { api, must, postFile } from "./client.js";
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

const BRAND = fromRoot("brand");

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

/**
 * The admin palette, derived from the one brand colour rather than typed.
 *
 * These four were hardcoded teals, and that was a second source of truth
 * for "what colour is this practice". Setting `BRAND_COLOUR` re-themed the
 * public site, the monogram and the generated imagery, and left the admin
 * exactly as it was — so the two halves of the same product disagreed, and
 * the only way to notice was to look at both.
 *
 * Derived by moving along the brand hue's lightness, because that is the
 * axis contrast lives on. The targets are the roles Directus actually uses
 * each token for:
 *
 *   `deep`  the project header, which carries white text — so it is taken
 *           down until white clears 4.5:1 on it.
 *   `light` the primary action in the light theme.
 *   `lift`  the primary in the dark theme, where the accent has to be
 *           lighter than the ground rather than darker.
 *   `ink`   the near-black behind the module rail, tinted with the hue so
 *           it reads as part of the same palette and not as a grey.
 */
const BRAND_HEX = process.env["BRAND_COLOUR"] ?? "#1978bb";

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, sat, l];
}

function toHex(h: number, sat: number, l: number): string {
  const a = sat * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Relative luminance, for the one place below that has to be measured. */
function lumOf(hex: string): number {
  return [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i]!, 0);
}
const onWhite = (hex: string): number => 1.05 / (lumOf(hex) + 0.05);

const [BH, BS] = toHsl(BRAND_HEX);
/** Walk down until white text clears 4.5:1 — measured, not guessed. */
const DEEP = ((): string => {
  for (let l = 0.45; l >= 0.10; l -= 0.005) {
    const c = toHex(BH, Math.min(BS + 0.1, 1), l);
    if (onWhite(c) >= 4.6) return c;
  }
  return toHex(BH, BS, 0.18);
})();
const TEAL = DEEP;                                  // the project header
const TEAL_LIGHT = toHex(BH, BS, 0.41);             // light-theme primary
const MINT = toHex(BH, Math.min(BS, 0.72), 0.68);   // dark-theme primary
const INK = toHex(BH, 0.42, 0.08);                  // module rail

/*
 * The surfaces, tinted with the same hue instead of a second one.
 *
 * These were hardcoded green-teals — `#0F1F1D` for the page, `#132726`
 * for the nav list, `#0A1716` for the module rail — and they survived the
 * first pass at re-theming because that pass only replaced the four
 * *accent* constants. The accents went blue and the whole background
 * stayed green, which is worse than either on its own: the admin looked
 * like two products.
 *
 * Kept at low saturation on purpose. A background carries the hue, it
 * does not announce it; past about a quarter saturation a dark surface
 * stops reading as "near-black" and starts reading as "coloured", which
 * is what made the old greens so noticeable once the accent no longer
 * agreed with them.
 */
const L_BG      = toHex(BH, 0.20, 0.985);  // page, light
const L_LIST    = toHex(BH, 0.22, 0.955);  // nav list, light
const L_FG      = toHex(BH, 0.30, 0.14);   // body text, light
const L_PRIMBG  = toHex(BH, 0.40, 0.93);   // selected row, light
const D_BG      = toHex(BH, 0.22, 0.09);   // page, dark
const D_LIST    = toHex(BH, 0.20, 0.115);  // nav list, dark
const D_FG      = toHex(BH, 0.18, 0.89);   // body text, dark
const D_PRIMBG  = toHex(BH, 0.45, 0.16);   // selected row, dark
const D_SECOND  = toHex(BH, 0.70, 0.78);   // secondary accent, dark

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
  const bytes = await readFile(join(BRAND, file));

  if (found.length && found[0]) {
    /*
     * Replaced, not skipped.
     *
     * This used to return the existing id and never look at the file on
     * disk again, which made the brand kit the one corner of the product
     * `BRAND_COLOUR` could not reach: the site re-themed, the admin
     * re-themed, the generated imagery re-themed, and the favicon, the
     * app icons and the sign-in backdrop stayed the teal they were first
     * uploaded as. Months later they were the only green left, and
     * nothing in the provisioning would ever have corrected them.
     *
     * The same trap as `findOrCreate` skipping a row and `applyCollection`
     * skipping meta, in a fourth place. The file on disk is the source of
     * truth; it is sent every time rather than trusted to be unchanged,
     * which costs a handful of small uploads on a step that runs rarely
     * and removes the whole class of staleness.
     */
    const res = await postFile(() => {
      const form = new FormData();
      form.append("title", title);
      form.append("file", new Blob([new Uint8Array(bytes).buffer], { type }), file);
      return form;
    }, `/files/${found[0].id}`, "PATCH");
    if (!res.ok) log.fail(`replace ${file}: HTTP ${res.status}`);
    if (found[0].folder !== folder) await must("move file", api.patch(`/files/${found[0].id}`, { folder }));
    log.made(`asset ${file} redrawn`);
    return found[0].id;
  }

  // Through `postFile` rather than a bare fetch: the JSON client would
  // stringify a FormData, and a bare fetch would ignore a 429. Ten images
  // in a row is enough to trip the rate limiter, and it did.
  const res = await postFile(() => {
    const form = new FormData();
    // Directus reads multipart fields in order: anything that is not the
    // payload has to be appended before it, or it is ignored.
    form.append("title", title);
    form.append("folder", folder);
    form.append("file", new Blob([new Uint8Array(bytes)], { type }), file);
    return form;
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
  `Sign in as \`desk@kadehuis.example.com\`, then again as \`dentist@kadehuis.example.com\`. Password \`${DEMO_PASSWORD}\` for both.`,
  "",
  "Open the same patient as each. The dentist reads the clinical notes; the front desk never sees that they exist.",
  "",
  "`owner@kadehuis.example.com` works in Dutch — same instance, four languages.",
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
    primaryBackground: L_PRIMBG,
    secondary: MINT,
    foreground: L_FG,
    foregroundAccent: INK,
    background: L_BG,
    navigation: {
      // `navigation.list`, not `navigation.background` — see the dark
      // block below for why.
      list: { background: L_LIST },
      project: { foreground: INK },
      modules: { background: INK, button: { foregroundActive: MINT } },
    },
  };

  const dark = {
    primary: MINT,
    primaryBackground: D_PRIMBG,
    secondary: D_SECOND,
    foreground: D_FG,
    foregroundAccent: "#FFFFFF",
    background: D_BG,
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
     * shell — header bar, nav pane and module gutter — so a branded project
     * tile costs you a branded application. The identity carries on the
     * logo tile, the nav list and the accents instead.
     *
     * Verified against the variables the 12.3.1 admin bundle actually
     * emits, not against the 11 docs.
     */
    navigation: {
      list: { background: D_LIST },
      project: { foreground: "#FFFFFF" },
      modules: { background: INK, button: { foregroundActive: MINT } },
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
