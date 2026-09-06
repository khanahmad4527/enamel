import { login, api } from "./client.js";
import { log } from "./log.js";
import { collections, groups, userFields, fileFields } from "./schema/index.js";
import { policies } from "./access/policies.js";
import { roles } from "./access/roles.js";
import { presets } from "./presets.js";
import {
  applyCollection, applyField, applyRelations,
  applyPolicies, applyRoles, applyPresets, retireFields,
} from "./apply.js";
import { seed } from "./seed.js";
import { applyFlows } from "./flows.js";
import { applyBranding } from "./branding.js";
import { applyTranslations } from "./i18n/apply.js";

async function main() {
  const wantSeed = process.argv.includes("--seed");

  log.step(`Connecting to ${api.url}`);
  await login();
  log.info("authenticated as admin");

  log.step("Sidebar groups");
  for (const g of groups) await applyCollection(g);

  log.step("Collections and fields");
  for (const c of collections) await applyCollection(c);

  log.step("Tenancy fields on directus_users and directus_files");
  for (const f of userFields) await applyField("directus_users", f);
  for (const f of fileFields) await applyField("directus_files", f);

  log.step("Retired fields");
  await retireFields([["appointments", "reminder_sent_at"]]);

  log.step("Relations");
  await applyRelations(collections);
  // directus_users.clinic can only be linked once clinics exists.
  await applyRelations([
    {
      collection: "directus_files",
      meta: {},
      fields: [],
      relations: [
        {
          collection: "directus_files",
          field: "clinic",
          related_collection: "clinics",
          meta: {},
          schema: { on_delete: "SET NULL" },
        },
      ],
    },
    {
      collection: "directus_users",
      meta: {},
      fields: [],
      relations: [
        {
          collection: "directus_users",
          field: "clinic",
          related_collection: "clinics",
          meta: {},
          schema: { on_delete: "SET NULL" },
        },
      ],
    },
  ]);

  log.step("Access policies");
  const policyIds = await applyPolicies(policies);

  log.step("Roles");
  const roleIds = await applyRoles(roles, policyIds);

  log.step("Global bookmarks");
  await applyPresets(presets, roleIds);

  log.step("Flows");
  await applyFlows();

  log.step("Branding");
  await applyBranding();

  log.step("Translations (de, nl, fr)");
  await applyTranslations();

  if (wantSeed) {
    log.step("Demo data");
    await seed(roleIds);
  }

  // Most steps throw through `must()`. The per-item ones — fields,
  // relations, permissions, bookmarks, translations — log and carry on,
  // so one bad field does not cost you the other 143. That is only
  // defensible if the run ends by admitting it.
  const failed = log.failures();
  if (failed > 0) {
    log.warn(`${failed} step${failed === 1 ? "" : "s"} failed — this instance is NOT fully provisioned`);
    log.info("scroll up for the ✗ lines; re-running is safe and picks up where this left off");
    process.exitCode = 1;
    return;
  }

  log.done(
    wantSeed
      ? `Enamel is provisioned and seeded — open ${api.url}/admin`
      : `Enamel is provisioned — open ${api.url}/admin (run with --seed for demo data)`,
  );
}

main().catch((err) => {
  log.fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
