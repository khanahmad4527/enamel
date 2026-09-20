#!/usr/bin/env node
/**
 * Regenerate the six screenshots the README embeds.
 *
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/screenshots.mjs
 *
 * Reads the running stack, writes straight into docs/screenshots/.
 *
 * This exists because the images did not have it. They were taken by
 * hand, and the README went on showing a tooth chart for some time after
 * the interface it pictured had stopped rendering — nothing could rebuild
 * them, so nobody did. A screenshot with no source is a claim with no
 * check.
 *
 * Playwright is not a dependency of this repo: it pulls a browser, and
 * the suite that actually guards behaviour does not need one. Install it
 * when you need this:
 *
 *   npm i -g playwright && npx playwright install chromium
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "playwright is not installed.\n" +
    "  npm i -g playwright && npx playwright install chromium\n",
  );
  process.exit(2);
}

const ADMIN = process.env.DIRECTUS_URL ?? "http://localhost:9056";
const EMAIL = process.env.ADMIN_EMAIL;
const PASS = process.env.ADMIN_PASSWORD;
if (!EMAIL || !PASS) {
  // Not a default. The old version of this fell back to a guessed
  // address, the login silently failed, and the run reported success on
  // pages it had never reached.
  console.error("set ADMIN_EMAIL and ADMIN_PASSWORD (they are in .env)");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? resolve(here, "../docs/screenshots");
mkdirSync(OUT, { recursive: true });

const DEMO = "EnamelDemo!2026";
const b = await chromium.launch();
const view = { viewport: { width: 1560, height: 1500 }, deviceScaleFactor: 2 };
const chartView = { viewport: { width: 1560, height: 1010 }, deviceScaleFactor: 2 };
const wide = { viewport: { width: 2200, height: 1100 }, deviceScaleFactor: 2 };

/**
 * The right-hand drawer is open by default and eats a third of the frame,
 * covering the columns these images exist to show. Its state is read by
 * measuring: the class does not change when it collapses, only the width,
 * so looking for `.is-open` matched nothing and did nothing.
 */
const closeDrawer = async (p) => {
  const width = () => p.evaluate(() => {
    const el = document.querySelector("#sidebar") || document.querySelector(".sidebar");
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  });
  if ((await width()) > 280) {
    await p.locator(".sidebar-toggle").first().click().catch(() => {});
    await p.waitForTimeout(1200);
  }
};

const shot = async (p, name, wait = 3500) => {
  await p.waitForTimeout(wait);
  await closeDrawer(p);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log("  ✓", name);
};

/**
 * A fresh context per user. Reusing one keeps the previous session
 * cookie, `/admin/login` redirects straight past the form, and the fill
 * times out on an input that is not there.
 */
const signIn = async (ctx, email, password) => {
  const p = await ctx.newPage();
  await p.goto(`${ADMIN}/admin/login`, { waitUntil: "networkidle" });
  await p.fill('input[type="email"]', email);
  await p.fill('input[type="password"]', password);
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/admin\/(?!login)/, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(4000);
  if (p.url().includes("/login")) throw new Error(`could not sign in as ${email}`);
  /* A fresh instance puts Directus's "you have not set a project owner"
     dialog over everything, and the first run of the newer shots below
     captured that licence modal instead of a dashboard. Dismissed here so
     every screenshot gets it, rather than in the five that noticed.
     Setting PROJECT_OWNER_EMAIL in .env stops it appearing at all. */
  await p.getByRole("button", { name: /remind later/i }).click().catch(() => {});
  await p.waitForTimeout(700);
  return p;
};

/** Record ids fetched AS the user who will open them. An id found as
 *  somebody else opens as "Page Not Found" and reads as a broken build. */
const idAs = async (ctx, email, password, path) => {
  const r = await ctx.request.post(`${ADMIN}/auth/login`, { data: { email, password } });
  const token = (await r.json()).data.access_token;
  const q = await ctx.request.get(`${ADMIN}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return (await q.json()).data?.[0];
};

// 1. the login screen, branded, before anybody is signed in.
//    1440x900 — the login screen is a composition, and a different aspect
//    ratio reads as a redesign in a diff.
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`${ADMIN}/admin/login`, { waitUntil: "networkidle" });
  await shot(p, "login");
  await ctx.close();
}

// 2 + 3. the admin as the administrator, then the chart as a dentist
{
  const ctx = await b.newContext(view);
  const p = await signIn(ctx, EMAIL, PASS);
  await p.goto(`${ADMIN}/admin/content/patients`, { waitUntil: "networkidle" });
  await shot(p, "admin");
  await ctx.close();
}
for (const [name, email] of [["tooth-chart", "dentist@kadehuis.example.com"],
                             ["tooth-chart-nl", "owner@kadehuis.example.com"]]) {
  const ctx = await b.newContext(chartView);
  // The patient with the supernumerary tooth, not merely the first one
  // charted — the ISO 10394 row is the point of this image, and without
  // the filter the shot silently shows an ordinary mouth.
  const row = await idAs(ctx, email, DEMO,
    "/items/tooth_conditions?limit=1&fields=patient&filter[tooth][_eq]=AB");
  if (!row?.patient) { console.log(`  ! no supernumerary finding for ${name}`); await ctx.close(); continue; }
  const p = await signIn(ctx, email, DEMO);
  await p.goto(`${ADMIN}/admin/content/patients/${row.patient}`, { waitUntil: "networkidle" });
  await p.waitForTimeout(5000);
  const chart = p.locator(".tooth-chart").first();
  if (!(await chart.count())) throw new Error(`${name}: the chart did not render`);
  await chart.scrollIntoViewIfNeeded();
  await p.evaluate(() => window.scrollBy(0, -260));
  await p.waitForTimeout(1200);
  await closeDrawer(p);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  const text = await chart.innerText();
  if (!text.includes("AB")) throw new Error(`${name}: the supernumerary row is not in the shot`);
  console.log("  ✓", name);
  await ctx.close();
}

// 4. the admin in Dutch
{
  const ctx = await b.newContext(view);
  const p = await signIn(ctx, "owner@kadehuis.example.com", DEMO);
  await p.goto(`${ADMIN}/admin/content/patients`, { waitUntil: "networkidle" });
  await shot(p, "admin-nl");
  await ctx.close();
}

// 5. the same record as the desk and as a dentist, composed side by side
{
  const ctxA = await b.newContext(wide);
  const patient = await idAs(ctxA, "desk@kadehuis.example.com", DEMO, "/items/patients?limit=1&fields=id");
  const desk = await signIn(ctxA, "desk@kadehuis.example.com", DEMO);
  await desk.goto(`${ADMIN}/admin/content/patients/${patient.id}`, { waitUntil: "networkidle" });
  await desk.waitForTimeout(4000);
  const form = (p) => p.locator("main.main-content-container").first();
  await form(desk).screenshot({ path: `${OUT}/_roles-desk.png` });

  const ctxB = await b.newContext(wide);
  const dds = await signIn(ctxB, "dentist@kadehuis.example.com", DEMO);
  await dds.goto(`${ADMIN}/admin/content/patients/${patient.id}`, { waitUntil: "networkidle" });
  await dds.waitForTimeout(4000);
  // Onto the fields the desk never receives; at the top both halves look
  // the same and the image argues for nothing.
  const alerts = dds.locator('.field:has-text("Medical Alerts")').first();
  if (await alerts.count()) { await alerts.scrollIntoViewIfNeeded(); await dds.evaluate(() => window.scrollBy(0, -120)); }
  await dds.waitForTimeout(1200);
  await form(dds).screenshot({ path: `${OUT}/_roles-dentist.png` });

  const { readFileSync, rmSync } = await import("node:fs");
  const b64 = (f) => `data:image/png;base64,${readFileSync(`${OUT}/${f}`).toString("base64")}`;
  const composer = await (await b.newContext({ viewport: { width: 1816, height: 700 }, deviceScaleFactor: 2 })).newPage();
  await composer.setContent(`
    <style>
      :root { color-scheme: dark; }
      body { margin:0; background:#0d1b1a; font:14px/1.3 -apple-system,Segoe UI,sans-serif; color:#e6edf3; }
      .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:10px; }
      h2 { margin:0 0 2px; font-size:20px; letter-spacing:.02em; text-transform:uppercase; color:#2ecfb0; }
      p { margin:0 0 8px; font-size:14px; font-weight:600; }
      img { width:100%; display:block; border-radius:4px; }
    </style>
    <div class="grid">
      <div><h2>Front desk</h2><p>the form ends at Preferred Language</p><img src="${b64("_roles-desk.png")}"></div>
      <div><h2>Dentist</h2><p>and keeps going, into the fields the API denies the desk</p><img src="${b64("_roles-dentist.png")}"></div>
    </div>`);
  await composer.waitForTimeout(900);
  await composer.locator(".grid").screenshot({ path: `${OUT}/roles-compare.png` });
  for (const half of ["_roles-desk.png", "_roles-dentist.png"]) rmSync(`${OUT}/${half}`, { force: true });
  console.log("  ✓ roles-compare");
  await ctxA.close(); await ctxB.close();
}


/* ---------------------------------------------------------------------
 * The five the README grew later: the website itself, the day sheet, the
 * practice report, the Insights dashboard and the local mailbox. Same
 * rule as the six above — a screenshot with no source is a claim with no
 * check.
 *
 * A fresh instance shows Directus's "you have not set a project owner"
 * modal over everything, which is how the first run of this captured a
 * licence dialog instead of a dashboard. Dismissed before each shot
 * rather than hoped away; set PROJECT_OWNER_EMAIL in .env and it never
 * appears at all.
 * ------------------------------------------------------------------- */
const SITE = process.env.PUBLIC_URL_BASE ?? "http://localhost:8058";
const MAIL = process.env.MAILPIT_URL ?? "http://localhost:8025";
// 1. the public website, top of the home page
{
  const ctx = await b.newContext({ viewport:{width:1440,height:1250}, deviceScaleFactor:2 });
  const p = await ctx.newPage();
  await p.goto(SITE, { waitUntil:"networkidle" });
  await p.evaluate(async()=>{for(let y=0;y<2200;y+=500){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,120));}window.scrollTo(0,0);});
  await p.waitForLoadState("networkidle"); await p.waitForTimeout(1500);
  await shot(p, "website");
  await ctx.close();
}
// 2. the day sheet, on a day with a full diary
{
  const ctx = await b.newContext({ viewport:{width:1560,height:1000}, deviceScaleFactor:2 });
  const p = await signIn(ctx, "desk@kadehuis.example.com", DEMO);
  await p.goto(`${ADMIN}/admin/day-sheet`, { waitUntil:"networkidle" });
  await p.waitForTimeout(2600); await closeDrawer(p);
  for (let i=0;i<4;i++){ if(!(await p.locator("text=Closed on").count())) break;
    await p.locator('.ds-nudge .v-button:nth-child(3) button').click(); await p.waitForTimeout(1500); }
  await p.evaluate(()=>document.activeElement&&document.activeElement.blur()); await p.mouse.move(5,5);
  await p.waitForTimeout(1400);
  await shot(p, "day-sheet");
  await ctx.close();
}
// 3. the practice report
{
  const ctx = await b.newContext({ viewport:{width:1560,height:1100}, deviceScaleFactor:2 });
  const p = await signIn(ctx, "owner@kadehuis.example.com", DEMO);
  await p.goto(`${ADMIN}/admin/practice-report`, { waitUntil:"networkidle" });
  await p.waitForTimeout(4000); await closeDrawer(p); await p.waitForTimeout(1200);
  await shot(p, "practice-report");
  await ctx.close();
}
// 4. the Insights dashboard
{
  const ctx = await b.newContext({ viewport:{width:1560,height:900}, deviceScaleFactor:2 });
  const p = await signIn(ctx, EMAIL, PASS);
  await p.goto(`${ADMIN}/admin/insights`, { waitUntil:"networkidle" });
  await p.waitForTimeout(1800);
  await p.locator("a[href*='/insights/']").first().click().catch(()=>{});
  await p.waitForTimeout(4200); await closeDrawer(p); await p.waitForTimeout(1200);
  await shot(p, "insights");
  await ctx.close();
}
// 5. Mailpit — a reminder that never left the machine
{
  const ctx = await b.newContext({ viewport:{width:1440,height:860}, deviceScaleFactor:2 });
  const p = await ctx.newPage();
  await p.goto(MAIL, { waitUntil:"networkidle" }).catch(()=>{});
  await p.waitForTimeout(2600);
  await shot(p, "mail");
  await ctx.close();
}


/* The job board, and the door into it. Signed in as the queue operator
   rather than an administrator, because that grant is the point: the
   account behind this screenshot can open the board and cannot read a
   patient. The board is a separate origin, so it arrives as a new tab. */
{
const ctx=await b.newContext({viewport:{width:1560,height:900},deviceScaleFactor:2});
const p=await ctx.newPage();
await p.goto("http://localhost:9056/admin/login",{waitUntil:"networkidle"});
await p.fill('input[type="email"]',"ops@enamel.dev");
await p.fill('input[type="password"]',"EnamelDemo!2026");
await p.click('button[type="submit"]');
await p.waitForURL(/\/admin\/(?!login)/,{timeout:30000}).catch(()=>{});
await p.waitForTimeout(3000);
await p.getByRole("button",{name:/remind later/i}).click().catch(()=>{});
await p.goto("http://localhost:9056/admin/queues",{waitUntil:"networkidle"});
await p.waitForTimeout(2500);
await p.evaluate(()=>document.activeElement&&document.activeElement.blur());
await p.mouse.move(5,5); await p.waitForTimeout(900);
await p.screenshot({path:`${OUT}/queues-door.png`});
console.log("  ✓ queues-door");
const [board]=await Promise.all([
  ctx.waitForEvent("page",{timeout:20000}),
  p.click("text=Open in a new tab").catch(()=>{}),
]).catch(()=>[null]);
if(!board){ console.log("no board tab"); process.exit(1); }
await board.waitForURL(/\/queues/,{timeout:20000}).catch(()=>{});
await board.setViewportSize({width:1560,height:900});
await board.waitForTimeout(5000);
const txt=(await board.locator("body").innerText().catch(()=>"")).replace(/\s+/g," ").slice(0,220);
console.log("board says:", txt);
await board.screenshot({path:`${OUT}/queues.png`});
console.log("  ✓ queues");
}

await b.close();
console.log(`\n  thirteen images written to ${OUT}`);

