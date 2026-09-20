/**
 * Everything the bootstrap needs from the outside world, resolved once.
 *
 * It lives in its own module because `verify.ts` deliberately does not go
 * through the API client — it makes its own logins — and had drifted into
 * its own copy of the base URL and the demo password. Two copies of a
 * password is one too many: change the seed and the verifier stops being
 * able to log in.
 */
import { fromRoot } from "./root.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Read .env ourselves rather than trusting the caller to export it. Only
 * scripts/setup.sh did, so the documented `pnpm provision` path ran with
 * ADMIN_PASSWORD unset and died at login. Anything already in the
 * environment wins, so a one-off override still works.
 */
function loadDotEnv(): void {
  const file = fromRoot(".env");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const key = m?.[1];
    if (!key || key in process.env) continue;
    let value = (m?.[2] ?? "").trim();
    const quote = value[0];
    if (value.length > 1 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotEnv();

/**
 * The port is declared once, in DIRECTUS_PORT. It used to be declared
 * three times — DIRECTUS_PORT, PUBLIC_URL and DIRECTUS_URL — and moving
 * only the first pointed the bootstrap at whatever was still on 9056,
 * which in the case the docs cite for moving ports is somebody else's
 * Directus. Provisioning into it would have worked, too.
 *
 * DIRECTUS_URL stays as an override for a non-local instance.
 */
export const PORT = process.env.DIRECTUS_PORT ?? "9056";
export const URL_BASE = process.env.DIRECTUS_URL ?? `http://localhost:${PORT}`;

/**
 * Every seeded account shares one password. Overridable, because the
 * value is printed on the login screen and nobody should have to ship a
 * public demo with a password a stranger has read in a README.
 */
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "EnamelDemo!2026";

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@enamel.dev";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";

/**
 * Direct database access, for the DDL Directus has no endpoint for.
 *
 * Exclusion constraints, CHECKs and triggers are not expressible through
 * `/fields` or `/collections`, and they are exactly the rules that have
 * to hold no matter which client is writing — a flow, the admin, a token
 * somebody minted last year. Those live in Postgres, so provisioning
 * needs a connection to it as well as to the API.
 *
 * The host reaches the container on a loopback-published port; the
 * core service reaches it as `database:5432` over the compose
 * network and never uses these.
 */
export const DB_HOST = process.env.DB_HOST ?? "127.0.0.1";
export const DB_PORT = Number(process.env.DB_PORT ?? 5432);
export const DB_DATABASE = process.env.DB_DATABASE ?? "enamel";
export const DB_USER = process.env.DB_USER ?? "enamel";
export const DB_PASSWORD = process.env.DB_PASSWORD ?? "";

/**
 * The core service.
 *
 * Part of the stack rather than an optional extra, so the checks against
 * it are real checks: if this is unreachable the instance is incomplete,
 * and a suite that quietly passed anyway would be telling you the slot
 * search works when nothing is answering.
 */
export const CORE_URL =
  process.env.CORE_URL ?? `http://localhost:${process.env.CORE_PORT ?? "8057"}`;
export const REMINDER_TOKEN = process.env.REMINDER_TOKEN ?? "";

/** The provider webhook's own secret — deliberately not the operator token. */
export const INBOUND_SECRET = process.env.MESSAGING_INBOUND_SECRET ?? "";

/**
 * The patient site.
 *
 * Server-rendered, so the checks against it are HTTP checks like any
 * other: does the sign-in page answer, and does /portal refuse somebody
 * with no cookie. Anything deeper is asserted against the API the site
 * calls, not against its HTML — a test that scrapes markup breaks when
 * the design changes and passes when the permissions do.
 */
export const PUBLIC_URL_BASE =
  process.env.PUBLIC_URL_BASE ?? `http://localhost:${process.env.PUBLIC_PORT ?? "8058"}`;

/** The registrar's credential. Creates a login; cannot read one. */
export const PORTAL_TOKEN = process.env.PORTAL_TOKEN ?? "";


/**
 * The public website's read-only credential.
 *
 * Separate from every other service token because what it can do if it
 * leaks is the only thing standing behind it — and in this case that is
 * "read the opening hours".
 */
export const WEBSITE_TOKEN = process.env.WEBSITE_TOKEN ?? "";
