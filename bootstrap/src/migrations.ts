import { api, must } from "./client.js";
import { log } from "./log.js";

/**
 * Migrations.
 *
 * Provisioning from code covers everything a fresh database needs, and it
 * does not cover a column that changes shape under data that already
 * exists. Postgres will not add a NOT NULL column to a populated table,
 * so `tooth_conditions.tooth` cannot simply appear next to the integer
 * `tooth_fdi` it replaces — the create fails, and on an instance with a
 * hundred findings in it that is the correct behaviour.
 *
 * The honest answer is a migration: create the column nullable, carry the
 * old values across, then let the schema step tighten it. Each function
 * here is a no-op on a database that never had the old shape, which is
 * every fresh clone — so this file is dead weight to a new reader and the
 * difference between a working upgrade and a broken one to anybody who
 * cloned last week.
 */

type Field = { field: string };
type Row = { id: string; tooth_fdi?: number | null; tooth?: string | null };

async function fieldNames(collection: string): Promise<Set<string>> {
  const fields = await must<Field[]>(`fields of ${collection}`, api.get(`/fields/${collection}`));
  return new Set(fields.map((f) => f.field));
}

/**
 * tooth_fdi (integer) -> tooth (string).
 *
 * A tooth designation stopped being a number the moment supernumerary
 * teeth were modelled: ISO 10394 designates them with letters, so `AB`
 * has to live in the same column as `36`.
 */
async function toothDesignations(collection: string): Promise<void> {
  const have = await fieldNames(collection);
  if (!have.has("tooth_fdi")) return;          // already migrated, or never here
  if (!have.has("tooth")) {
    // Nullable on purpose. The schema step sends the real definition; all
    // this needs to do is exist long enough to receive the old values.
    await must(
      `add ${collection}.tooth`,
      api.post(`/fields/${collection}`, {
        field: "tooth",
        type: "string",
        meta: { interface: "input", hidden: true },
        schema: {},
      }),
    );
    log.made(`${collection}.tooth added for migration`);
  }

  const rows = await must<Row[]>(
    `read ${collection}`,
    api.get(`/items/${collection}?limit=-1&fields=id,tooth_fdi,tooth`),
  );
  const pending = rows.filter((r) => r.tooth == null && r.tooth_fdi != null);
  for (const row of pending) {
    const r = await api.patch(`/items/${collection}/${row.id}`, { tooth: String(row.tooth_fdi) });
    if (!r.ok) log.fail(`migrate ${collection}/${row.id}: ${r.error.message}`);
  }
  if (pending.length) log.made(`${pending.length} ${collection} rows carried to string designations`);
  else log.skip(`${collection} designations`);
}

export async function runMigrations(): Promise<void> {
  await toothDesignations("tooth_conditions");
  await toothDesignations("treatment_records");
}
