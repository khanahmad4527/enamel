import { api, must } from "./client.js";
import { log } from "./log.js";
import type { Collection, Field, Policy, Preset, Role } from "./types.js";

/**
 * Every function here is idempotent: it checks for the thing, creates it
 * if absent, and leaves it alone otherwise. Re-running is safe and is the
 * normal way to pick up a schema change.
 */

async function exists(path: string): Promise<boolean> {
  const r = await api.get(path);
  return r.ok;
}

/**
 * Meta keys that have to be sent as `null` to be removed.
 *
 * A PATCH merges, so a key the schema file no longer sets simply stays
 * whatever it was. That is right for the keys Directus manages on its own
 * and wrong for these three, which change what the admin *shows*.
 *
 * `data_breaches` is why this exists. It was created with
 * `archive_field: "status"`, which seemed reasonable until both seeded
 * entries were closed and the register displayed "no items" — Directus
 * hides archived rows from the default view. Removing the key from the
 * schema file changed nothing, because an absent key is not a removal.
 */
/*
 * Meta keys that have to be sent as `null` to go away.
 *
 * A PATCH merges, so a key simply dropped from the schema file is not
 * cleared — it keeps whatever the instance already had, and the source
 * stops describing the thing it provisions. `color` is here because
 * every collection and folder used to carry a hardcoded hex: a green,
 * an amber, a purple, a blue, chosen one at a time. Uncoloured icons
 * take `--theme--primary`, which Directus derives from the practice's
 * brand colour and recomputes for light and dark; a hardcoded one does
 * not, which is exactly why half the sidebar looked wrong in one theme
 * and half looked wrong in the other. Removing the colours is what makes
 * them follow the theme, and this line is what makes removing them land.
 */
const CLEARABLE_META = [
  "archive_field", "archive_value", "unarchive_value", "sort_field", "color",
] as const;

export async function applyCollection(c: Collection): Promise<void> {
  if (await exists(`/collections/${c.collection}`)) {
    /*
     * Reconciled, not skipped.
     *
     * This used to skip an existing collection entirely, which meant a
     * collection's *meta* — its note, its group, its sort, its display
     * template, whether it archives — was fixed at the moment it was
     * first created and no edit to the schema file afterwards ever
     * reached an instance that already had it. Exactly the same shape as
     * `findOrCreate` skipping a row, which this seed has met three times.
     */
    const meta = { ...(c.meta ?? {}) } as Record<string, unknown>;
    for (const key of CLEARABLE_META) {
      if (!(key in meta)) meta[key] = null;
    }
    await must(
      `update collection ${c.collection}`,
      api.patch(`/collections/${c.collection}`, { meta }),
    );
    log.skip(`collection ${c.collection}`);
  } else {
    // Fields go in with the collection so the primary key is set up in
    // one shot; relations need both sides present, so they come later.
    await must(
      `create collection ${c.collection}`,
      api.post("/collections", {
        collection: c.collection,
        meta: c.meta,
        schema: c.fields.length ? (c.schema ?? {}) : null,
        fields: c.fields.filter((f) => f.field === "id"),
      }),
    );
    log.made(`collection ${c.collection}`);
  }

  for (const field of c.fields) {
    if (field.field === "id") continue;
    await applyField(c.collection, field);
  }
}

export async function applyField(collection: string, field: Field): Promise<void> {
  if (await exists(`/fields/${collection}/${field.field}`)) {
    // The definition is the source of truth, so an existing field is
    // updated rather than skipped — otherwise a new validation rule or a
    // changed note would never reach an instance that already has the
    // field. Directus merges the meta keys it is given, so translations
    // applied later in the run survive.
    const r = await api.patch(`/fields/${collection}/${field.field}`, { meta: field.meta ?? {} });
    if (!r.ok) log.fail(`  ${collection}.${field.field} — ${r.error.message}`);
    else log.skip(`  ${collection}.${field.field}`);
    return;
  }
  const r = await api.post(`/fields/${collection}`, field);
  if (!r.ok) {
    log.fail(`  ${collection}.${field.field} — ${r.error.message}`);
    return;
  }
  log.made(`  ${collection}.${field.field}`);
}

export async function applyRelations(collections: Collection[]): Promise<void> {
  const existing = await must<Array<{ collection: string; field: string }>>(
    "list relations",
    api.get("/relations"),
  );
  const have = new Set(existing.map((r) => `${r.collection}.${r.field}`));

  for (const c of collections) {
    for (const rel of c.relations ?? []) {
      const key = `${rel.collection}.${rel.field}`;
      if (have.has(key)) {
        log.skip(`relation ${key}`);
        continue;
      }
      const r = await api.post("/relations", rel);
      if (!r.ok) {
        log.fail(`relation ${key} — ${r.error.message}`);
        continue;
      }
      log.made(`relation ${key} → ${rel.related_collection}`);
    }
  }
}

type IdName = { id: string; name: string };

export async function applyPolicies(policies: Policy[]): Promise<Map<string, string>> {
  const existing = await must<IdName[]>("list policies", api.get("/policies?limit=-1&fields=id,name"));
  const byName = new Map(existing.map((p) => [p.name, p.id]));

  for (const policy of policies) {
    let id = byName.get(policy.name);
    if (id) {
      log.skip(`policy ${policy.name}`);
    } else {
      const created = await must<IdName>(
        `create policy ${policy.name}`,
        api.post("/policies", {
          name: policy.name,
          icon: policy.icon,
          description: policy.description,
          app_access: policy.app_access,
          admin_access: policy.admin_access ?? false,
          enforce_tfa: policy.enforce_tfa ?? false,
        }),
      );
      id = created.id;
      byName.set(policy.name, id);
      log.made(`policy ${policy.name}`);
    }

    // Permissions are replaced wholesale so the file stays the source of
    // truth — editing a filter here and re-running actually takes effect.
    //
    // This used to delete by comma-separated path, which Directus answers
    // with 403, and the result was never checked. So nothing was ever
    // deleted: each run appended another copy of every rule, and one
    // policy had reached 61 permissions where it defines 7. Identical
    // duplicates are harmless — right up until you *narrow* a filter, at
    // which point Directus ORs the new rule with three stale copies of
    // the old one and the tightening silently does nothing. Which is how
    // an access model drifts open.
    //
    // The batch form takes the ids in the body, and `must` makes a failed
    // wipe fatal. A half-replaced permission set is not something to
    // carry on from.
    const current = await must<Array<{ id: number }>>(
      "list permissions",
      api.get(`/permissions?limit=-1&fields=id&filter[policy][_eq]=${id}`),
    );
    if (current.length) {
      await must(
        `clear permissions on ${policy.name}`,
        api.delete("/permissions", current.map((p) => p.id)),
      );
    }

    let made = 0;
    for (const perm of policy.permissions) {
      const r = await api.post("/permissions", {
        policy: id,
        collection: perm.collection,
        action: perm.action,
        permissions: perm.permissions ?? {},
        validation: perm.validation ?? {},
        fields: perm.fields ?? ["*"],
        presets: perm.presets ?? null,
      });
      if (r.ok) made++;
      else log.fail(`  ${policy.name}: ${perm.action} ${perm.collection} — ${r.error.message}`);
    }
    log.info(`  ${made} permissions on ${policy.name}`);
  }

  return byName;
}

export async function applyRoles(
  roles: Role[],
  policyIds: Map<string, string>,
): Promise<Map<string, string>> {
  const existing = await must<IdName[]>("list roles", api.get("/roles?limit=-1&fields=id,name"));
  const byName = new Map(existing.map((r) => [r.name, r.id]));

  for (const role of roles) {
    let id = byName.get(role.name);
    if (id) {
      log.skip(`role ${role.name}`);
    } else {
      const created = await must<IdName>(
        `create role ${role.name}`,
        api.post("/roles", { name: role.name, icon: role.icon, description: role.description }),
      );
      id = created.id;
      byName.set(role.name, id);
      log.made(`role ${role.name}`);
    }

    for (const policyName of role.policies) {
      const policyId = policyIds.get(policyName);
      if (!policyId) {
        log.warn(`role ${role.name}: unknown policy "${policyName}"`);
        continue;
      }
      const linked = await must<Array<{ id: number }>>(
        "check access",
        api.get(`/access?limit=1&fields=id&filter[role][_eq]=${id}&filter[policy][_eq]=${policyId}`),
      );
      if (linked.length) continue;
      const r = await api.post("/access", { role: id, policy: policyId, sort: 1 });
      if (r.ok) log.made(`  ${role.name} ← ${policyName}`);
      else log.fail(`  ${role.name} ← ${policyName}: ${r.error.message}`);
    }
  }

  return byName;
}

/**
 * Fields this repo used to ship and no longer does.
 *
 * Renaming a field leaves the old column behind on every instance that
 * already had it, still in the data model and still offered in filters —
 * so a retired name is listed here and dropped, rather than left for
 * someone to trip over. Deleting a field deletes its data: only ever add
 * a name here when that is the intent.
 */
export async function retireFields(pairs: Array<[string, string]>): Promise<void> {
  for (const [collection, field] of pairs) {
    const found = await api.get(`/fields/${collection}/${field}`);
    if (!found.ok) continue;
    const r = await api.delete(`/fields/${collection}/${field}`);
    if (r.ok) log.made(`retired ${collection}.${field}`);
    else log.fail(`retire ${collection}.${field} — ${r.error.message}`);
  }
}

/**
 * Policies and roles that a rename left behind.
 *
 * `applyPolicies` and `applyRoles` match on name, so renaming one creates
 * the new and orphans the old — which is worse than untidy when the thing
 * orphaned is an access policy. "Scheduler worker" grants read on every
 * practice's diary; leaving it attached to a role nobody audits is how a
 * permission survives the decision that retired it.
 *
 * Only ever list something here when deleting it is the intent.
 */
export async function retireAccess(
  policies: string[] = [],
  roles: string[] = [],
): Promise<void> {
  for (const name of roles) {
    const found = await api.get<Array<{ id: string }>>(
      `/roles?limit=1&fields=id&filter[name][_eq]=${encodeURIComponent(name)}`,
    );
    if (!found.ok || !found.data.length) continue;
    const r = await api.delete(`/roles/${found.data[0]!.id}`);
    if (r.ok) log.made(`retired the "${name}" role`);
    else log.fail(`retire role ${name} — ${r.error.message}`);
  }
  for (const name of policies) {
    const found = await api.get<Array<{ id: string }>>(
      `/policies?limit=1&fields=id&filter[name][_eq]=${encodeURIComponent(name)}`,
    );
    if (!found.ok || !found.data.length) continue;
    const r = await api.delete(`/policies/${found.data[0]!.id}`);
    if (r.ok) log.made(`retired the "${name}" policy`);
    else log.fail(`retire policy ${name} — ${r.error.message}`);
  }
}

/**
 * Flows that something better replaced.
 *
 * Left in place they would keep firing alongside whatever took over —
 * two writers on one field, racing, and the loser's value is whichever
 * landed last. Listed here and deleted.
 */
export async function retireFlows(names: string[]): Promise<void> {
  for (const name of names) {
    const found = await api.get<Array<{ id: string }>>(
      `/flows?limit=1&fields=id&filter[name][_eq]=${encodeURIComponent(name)}`,
    );
    if (!found.ok || !found.data.length) continue;
    const r = await api.delete(`/flows/${found.data[0]!.id}`);
    if (r.ok) log.made(`retired the "${name}" flow`);
    else log.fail(`retire flow ${name} — ${r.error.message}`);
  }
}

export async function applyPresets(
  presets: Preset[],
  roleIds: Map<string, string>,
): Promise<void> {
  const existing = await must<Array<{ id: number; bookmark: string | null; user: string | null; role: string | null; collection: string }>>(
    "list presets",
    api.get("/presets?limit=-1&fields=id,bookmark,user,role,collection"),
  );
  // Only the global ones are ours. A user's own saved bookmark can share
  // a name with one of these, and overwriting somebody's private view
  // because it collides with a shipped one would be its own bug.
  const mine = new Map(
    existing.filter((p) => p.user === null && p.bookmark).map((p) => [p.bookmark as string, p.id]),
  );
  // A preset with no bookmark, no role and no user is the collection's
  // default view. There is at most one per collection, so it is keyed by
  // collection rather than by name — a name is exactly what it lacks.
  const defaults = new Map(
    existing
      .filter((p) => p.user === null && !p.bookmark && !p.role)
      .map((p) => [p.collection, p.id]),
  );

  for (const preset of presets) {
    // A named role scopes the bookmark to it; null shows it to everyone,
    // narrowed by their own permissions rather than duplicated per role.
    let role: string | null = null;
    if (preset.role) {
      role = roleIds.get(preset.role) ?? null;
      if (!role) log.warn(`bookmark "${preset.bookmark}": unknown role "${preset.role}"`);
    }

    const body = {
      bookmark: preset.bookmark,
      collection: preset.collection,
      role,
      user: null,
      icon: preset.icon ?? "bookmark",
      color: preset.color ?? null,
      layout: preset.layout ?? "tabular",
      layout_query: preset.layout_query ?? {},
      layout_options: preset.layout_options ?? {},
      filter: preset.filter ?? null,
      search: preset.search ?? null,
    };

    // Reconciled rather than create-only. A bookmark is a filter, and an
    // edited filter that never reaches an instance already holding the
    // bookmark is the sort of drift that makes people stop trusting the
    // provisioning and start clicking.
    const id = preset.bookmark ? mine.get(preset.bookmark) : defaults.get(preset.collection);
    if (id !== undefined) {
      const r = await api.patch(`/presets/${id}`, body);
      const label = preset.bookmark ? `bookmark "${preset.bookmark}"` : `default view for ${preset.collection}`;
      if (r.ok) log.skip(label);
      else log.fail(`${label} — ${r.error.message}`);
      continue;
    }

    const r = await api.post("/presets", body);
    const made = preset.bookmark
      ? `bookmark "${preset.bookmark}"${preset.role ? ` (${preset.role} only)` : ""}`
      : `default view for ${preset.collection}`;
    if (r.ok) log.made(made);
    else log.fail(`${made} — ${r.error.message}`);
  }
}
