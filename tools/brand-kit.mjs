/**
 * Redraws the brand kit in the practice's colour.
 *
 * These are the files Directus serves as the project logo, the favicon
 * and the sign-in screen. They used to be static teal PNGs committed in
 * September, which meant `BRAND_COLOUR` re-themed the site, the admin and
 * the generated imagery and left the icons and the login page on the old
 * palette — the one corner of the product the colour could not reach.
 *
 * Kept as a script rather than folded into the seed on purpose: it needs a
 * browser to rasterise and PIL to write an .ico, and neither belongs as a
 * dependency of a provisioning step that otherwise talks only to an API.
 * Run it when the colour changes; the output is committed.
 *
 *   node tools/brand-kit.mjs [#hex]
 */
import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BRAND = process.argv[2] ?? process.env.BRAND_COLOUR ?? "#1978bb";
/* Overridable so the script can be run from wherever Playwright is
   installed; defaults to the repo's own brand directory. */
const OUT = process.env.BRAND_DIR ?? new URL("../brand/", import.meta.url).pathname;

const hx = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return .2126*f(r)+.7152*f(g)+.0722*f(b); };
/** White or near-black, whichever is readable on the brand — never assumed. */
const ON = (1.05 / (lum(hx(BRAND)) + 0.05)) >= ((lum(hx(BRAND)) + 0.05) / 0.05) ? "#ffffff" : "#0e212f";
const darker = (h, k) => "#" + hx(h).map((c) => Math.round(c * k).toString(16).padStart(2, "0")).join("");

const TOOTH = "M16 2.6c-6.6 0-10.4 4-10.4 9.7 0 3.4.9 6 1.8 9.9.5 2.5 1 5.2 1.5 6.6.4 1.2 1.1 2 2.1 2 1.7 0 2.2-1.8 2.5-4.6.3-2.6.7-5.6 1-7.4.2-1.3.7-2.1 1.5-2.1s1.3.8 1.5 2.1c.3 1.8.7 4.8 1 7.4.3 2.8.8 4.6 2.5 4.6 1 0 1.7-.8 2.1-2 .5-1.4 1-4.1 1.5-6.6.9-3.9 1.8-6.5 1.8-9.9 0-5.7-3.8-9.7-10.4-9.7z";

const iconSvg = (px) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${px}" height="${px}">` +
  `<rect width="32" height="32" rx="7" fill="${BRAND}"/>` +
  `<g fill="${ON}" transform="translate(16 16.5) scale(0.84) translate(-16 -16)"><path d="${TOOTH}"/></g></svg>`;

const b = await chromium.launch();
const page = await (await b.newContext({ deviceScaleFactor: 1 })).newPage();

async function png(svg, px, file) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.waitForTimeout(120);
  writeFileSync(OUT + file, await page.screenshot({ omitBackground: true }));
  console.log("  drew", file, `${px}px`);
}

// 1. the vector logo — a recolour, so the wordmark's own drawing survives.
const logo = readFileSync(OUT + "logo.svg", "utf8").replace(/#0D6E63/gi, BRAND);
writeFileSync(OUT + "logo.svg", logo);
console.log("  recoloured logo.svg ->", BRAND);

// 2. the rasters
await png(iconSvg(512), 512, "icon-512.png");
await png(iconSvg(192), 192, "icon-192.png");
await png(iconSvg(180), 180, "apple-touch-icon.png");

// 3. the sign-in backdrop: the brand walked down to near-black, so the
//    white wordmark sits on it with room to spare.
const bg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="1600" height="1000">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${darker(BRAND, 0.20)}"/><stop offset="1" stop-color="${darker(BRAND, 0.06)}"/>
  </linearGradient></defs>
  <rect width="1600" height="1000" fill="url(#g)"/>
  <g fill="${BRAND}" opacity="0.10">
    <circle cx="1280" cy="240" r="320"/><circle cx="240" cy="820" r="260"/>
  </g></svg>`;
await page.setViewportSize({ width: 1600, height: 1000 });
await page.setContent(`<body style="margin:0">${bg}</body>`);
await page.waitForTimeout(150);
writeFileSync(OUT + "login-background.png", await page.screenshot());
await b.close();

// 4. formats Playwright will not write: .jpg and .ico
execFileSync("python3", ["-c", `
from PIL import Image
im = Image.open("${OUT}login-background.png").convert("RGB")
im.save("${OUT}login-background.jpg", quality=86)
ic = Image.open("${OUT}icon-512.png").convert("RGBA")
ic.save("${OUT}favicon.ico", sizes=[(16,16),(32,32),(48,48),(64,64)])
print("  wrote login-background.jpg and favicon.ico")
`]);
execFileSync("rm", ["-f", OUT + "login-background.png"]);
console.log("brand kit redrawn in", BRAND);
