import { login, api } from "./client.js";
import { log } from "./log.js";
import { collections, groups, userFields, fileFields } from "./schema/index.js";
import { policies } from "./access/policies.js";
import { roles } from "./access/roles.js";
import { presets, collectionDefaults } from "./presets.js";
import {
  applyCollection, applyField, applyRelations,
  applyPolicies, applyRoles, applyPresets, retireFields, retireAccess, retireFlows,
} from "./apply.js";
import { seed } from "./seed.js";
import { applyFlows } from "./flows.js";
import { applyDashboards } from "./dashboards.js";
import { applyBranding } from "./branding.js";
import { applyFolders, fileEverything } from "./folders.js";
import { applyTranslations } from "./i18n/apply.js";
import { runMigrations } from "./migrations.js";
import { applyConstraints } from "./constraints.js";

async function main() {
  const wantSeed = process.argv.includes("--seed");

  log.step(`Connecting to ${api.url}`);
  await login();
  log.info("authenticated as admin");

  // Before the schema step, because its job is to make a column that
  // changes shape survive data that already exists.
  log.step("Migrations");
  await runMigrations();

  log.step("Sidebar groups");
  for (const g of groups) await applyCollection(g);

  log.step("Collections and fields");
  for (const c of collections) await applyCollection(c);

  log.step("Tenancy fields on directus_users and directus_files");
  for (const f of userFields) await applyField("directus_users", f);
  for (const f of fileFields) await applyField("directus_files", f);

  log.step("Retired fields");
  await retireFields([
    ["appointments", "reminder_sent_at"],
    // Was an integer, and an integer cannot hold "AB".
    ["tooth_conditions", "tooth_fdi"],
    ["treatment_records", "tooth_fdi"],
  ]);

  log.step("Relations");
  await applyRelations(collections);
  // directus_users.clinic can only be linked once clinics exists.
  // `directus_files` and `directus_users` each carried a `clinic` foreign
  // key, which was how multi-tenancy reached the two tables Directus
  // owns. Both are gone. What is left is the clinician's portrait, which
  // is a file reference on a system collection and therefore has to be
  // declared here rather than alongside the field.
  await applyRelations([
    {
      collection: "directus_users",
      meta: {},
      fields: [],
      relations: [
        {
          collection: "directus_users",
          field: "public_photo",
          related_collection: "directus_files",
          meta: {},
          schema: { on_delete: "SET NULL" },
        },
      ],
    },
  ]);


  // After the schema step: the columns have to exist before a constraint
  // can reference them, and after relations so `practitioner` and `room`
  // are real foreign keys rather than loose uuids.
  log.step("Database rules");
  await applyConstraints();

  log.step("Access policies");
  const policyIds = await applyPolicies(policies);

  log.step("Roles");
  const roleIds = await applyRoles(roles, policyIds);

  // Renamed when the service stopped being "the scheduler": the credential
  // is scoped to the reminder sweep, not to whichever process runs it.
  log.step("Retired access");
  await retireAccess(["Scheduler worker"], ["Scheduler"]);
  // The two invoice-total flows are gone: they wrote the wrong invoice on a
  // batch insert, and a database trigger does it correctly for any size.
  await retireFlows(["Invoice totals (line added)", "Invoice totals (line changed)"]);

  log.step("Global bookmarks");
  await applyPresets(presets, roleIds);

  log.step("Default list layouts");
  await applyPresets(collectionDefaults, roleIds);

  log.step("Flows");
  await applyFlows();

  log.step("Insights dashboard");
  await applyDashboards();

  log.step("Branding");
  await applyBranding();

  // After branding, because the brand kit's own folder is created there
  // and this finds it by name rather than making a second one.
  const folderIds = await applyFolders();
  await fileEverything(folderIds);

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
