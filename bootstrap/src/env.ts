/**
 * Everything the bootstrap needs from the outside world, resolved once.
 *
 * It lives in its own module because `verify.ts` deliberately does not go
 * through the API client — it makes its own logins — and had drifted into
 * its own copy of the base URL and the demo password. Two copies of a
 * password is one too many: change the seed and the verifier stops being
 * able to log in.
 */
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
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
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
 * only the first pointed the bootstrap at whatever was still on 8056,
 * which in the case the docs cite for moving ports is somebody else's
 * Directus. Provisioning into it would have worked, too.
 *
 * DIRECTUS_URL stays as an override for a non-local instance.
 */
export const PORT = process.env.DIRECTUS_PORT ?? "8056";
export const URL_BASE = process.env.DIRECTUS_URL ?? `http://localhost:${PORT}`;

/**
 * Every seeded account shares one password. Overridable, because the
 * value is printed on the login screen and nobody should have to ship a
 * public demo with a password a stranger has read in a README.
 */
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "EnamelDemo!2026";

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@enamel.dev";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
