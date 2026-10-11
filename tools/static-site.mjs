/**
 * Builds the public website as flat files for Cloudflare Pages.
 *
 *   node tools/static-site.mjs [outdir]
 *
 * The site is normally server-rendered: every page asks Directus for the
 * practice's own content when somebody loads it. That is the right shape
 * for a practice running the software, and the wrong shape for a
 * showcase, which should be a handful of files on a CDN with nothing to
 * keep patched.
 *
 * So this crawls the running site once and writes what it gets. Reading
 * the rendered HTML rather than re-implementing the routes means the
 * static copy cannot drift from the real one: whatever the app serves is
 * what lands here.
 *
 * What does NOT come along, and cannot: signing in, booking and
 * registering all need Directus and the core service. Those links are
 * rewritten to the repository instead of left to 404 — a dead button on
 * a portfolio piece reads as a broken build rather than as a boundary.
 *
 * Nothing on the public pages needs JavaScript. They are server-rendered
 * HTML with one `<details>` for the FAQ, so the export is HTML, CSS and
 * images, and there is no hydration to go wrong.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SITE = process.env.SITE_URL ?? "http://localhost:8058";
/*
 * Where the export is served, which is not where it was crawled.
 *
 * The app writes its absolute URLs — the canonical, og:url, the sitemap,
 * the Sitemap line in robots.txt, the JSON-LD — from the address it was
 * asked on, which is right for a server and wrong for a crawl: the first
 * export went live telling search engines that every page's real address
 * was http://localhost:8058. They cannot use a canonical they cannot
 * reach, so the pages were filed as duplicates with no canonical at all.
 */
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "https://enamel.khanahmad.com").replace(/\/$/, "");
const OUT = process.argv[2] ?? "dist-static";
const REPO = process.env.REPO_URL ?? "https://github.com/khanahmad4527/enamel";

/** Every public path. The portal, sign-in and register are deliberately absent. */
const PAGES = ["/", "/services", "/team", "/contact", "/privacy", "/robots.txt", "/sitemap.xml"];

const seen = new Set();
const assets = new Set();          // every /brand/<id> and /assets/<file>

const get = async (path) => {
  const res = await fetch(`${SITE}${path}`, { redirect: "follow" });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res;
};

/** Discover the service and page slugs from the rendered markup rather than
 *  from a second source that could disagree with it. */
async function discover() {
  const html = await (await get("/")).text();
  const more = new Set();
  for (const m of html.matchAll(/href="(\/(?:services|pages)\/[a-z0-9-]+)"/g)) more.add(m[1]);
  const services = await (await get("/services")).text();
  for (const m of services.matchAll(/href="(\/services\/[a-z0-9-]+)"/g)) more.add(m[1]);
  return [...more];
}

/** Everything the pages point at that has to come along. */
function collect(html) {
  // The practice's images, which Directus streams through /brand/<id>,
  // and the stylesheet the build emitted under /assets/. Missing the
  // second is how a static export ends up unstyled: the pages render,
  // every link works, and it looks like a plain-text site.
  for (const m of html.matchAll(/\/brand\/[0-9a-f-]{36}/g)) assets.add(m[0]);
  for (const m of html.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)) assets.add(m[0]);
}

/** Rewrite the things that only exist while a backend does. */
function rewrite(html) {
  // Images get a file extension (see below), so their URLs change.
  html = html.replace(/\/brand\/[0-9a-f-]{36}/g, (u) => renamed.get(u) ?? u);

  // Booking and sign-in need the core service. Point them at the source
  // rather than leaving them to 404 — a dead button on a portfolio piece
  // reads as a broken build rather than as a boundary.
  html = html
    .replace(/href="\/portal[^"]*"/g, `href="${REPO}"`)
    .replace(/href="\/login"/g, `href="${REPO}"`)
    .replace(/href="\/register"/g, `href="${REPO}"`);

  /*
   * And the scripts go.
   *
   * These pages are server-rendered HTML with one `<details>` for the
   * FAQ — nothing on them needs JavaScript. Left in, React Router
   * hydrates and immediately asks for `/__manifest`, which cannot exist
   * on a static host, so every page load logs a 404 and the client
   * router starts treating the outbound GitHub links as internal routes.
   *
   * All of them, not only the modules: the inline scroll-restoration
   * script and the hydration context are only ever read by the modules,
   * and the context alone was half of every page's bytes. The JSON-LD
   * stays — it is data for search engines, not code.
   */
  html = html
    .replace(/<script(?![^>]*type="application\/ld\+json")[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]+rel="modulepreload"[^>]*>/g, "");
  return html;
}

/** Every crawled address becomes the public one, in pages, sitemap and robots alike. */
function publicise(body) {
  const out = body.replaceAll(SITE, PUBLIC_URL);
  // Fail the export rather than publish a page that still points home:
  // an escaped or scheme-less form would slip past the line above.
  const host = new URL(SITE).host;
  if (out.includes(host)) throw new Error(`${host} survived the rewrite — refusing to write it`);
  return out;
}

const pages = new Map();           // path -> raw body
const renamed = new Map();         // /brand/<id> -> /brand/<id>.<ext>

async function fetchPage(path) {
  if (seen.has(path)) return;
  seen.add(path);
  const res = await get(path);
  const body = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/html")) collect(body);
  pages.set(path, body);
}

function writePage(path, body) {
  // "/" -> index.html; "/team" -> team/index.html so the URL keeps working
  // without a server rewriting anything.
  const file =
    path === "/" ? "index.html"
    : path.includes(".") ? path.slice(1)
    : `${path.slice(1)}/index.html`;
  const full = join(OUT, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  console.log("  ·", path, "->", file);
}

mkdirSync(OUT, { recursive: true });

// 1. every page, collecting what it points at
for (const p of [...PAGES, ...(await discover())]) await fetchPage(p);

/*
 * 2. the files — and they need their extension back.
 *
 * Directus serves /brand/<uuid> with no suffix and declares the type in
 * a header, which works because something is answering the request. A
 * static host guesses from the filename, so the practice's logo went out
 * as `application/octet-stream` and the browser declined to draw it: the
 * bytes were correct, the file was on disk, and the masthead was empty.
 */
const EXT = { "image/svg+xml": ".svg", "image/jpeg": ".jpg", "image/png": ".png",
              "image/webp": ".webp", "image/x-icon": ".ico" };
for (const url of assets) {
  const res = await fetch(`${SITE}${url}`);
  if (!res.ok) { console.log("  ! missing", url); continue; }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  const ext = url.startsWith("/brand/") ? (EXT[type] ?? "") : "";
  if (ext) renamed.set(url, url + ext);
  const buf = Buffer.from(await res.arrayBuffer());
  const full = join(OUT, (url + ext).slice(1));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buf);
}

// 3. the pages, now that the file names are known
for (const [path, body] of pages) {
  writePage(path, publicise(path.endsWith(".xml") || path.endsWith(".txt") ? body : rewrite(body)));
}
console.log(`\n  ${seen.size} pages and ${assets.size} files in ${OUT}/`);
