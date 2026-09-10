import { api, must } from "../client.js";
import { log } from "../log.js";
import { collections, groups } from "../schema/index.js";
import { COLLECTIONS, FIELDS, FIELD_EN, STRINGS, LANGUAGES, type Lang, type T3 } from "./dictionary.js";

/** Turns a [de, nl, fr] tuple into the per-language rows Directus wants. */
function rows<T>(t: T3, make: (lang: Lang, value: string) => T): T[] {
  return LANGUAGES.map((lang, i) => make(lang, t[i] as string));
}

/**
 * The translations array for one field label.
 *
 * An `en-US` row is added only where `FIELD_EN` overrides Directus's
 * title-cased guess, so the common case stays as it was rather than
 * gaining 263 entries that repeat the column name back.
 */
function fieldTranslations(field: string, t: T3) {
  const all = rows(t, (language, translation) => ({ language, translation }));
  const en = FIELD_EN[field];
  return en ? [{ language: "en-US", translation: en }, ...all] : all;
}

/**
 * `directus_translations` holds arbitrary keyed strings. Anywhere
 * Directus accepts `$t:some_key` — bookmark names, field notes,
 * collection notes — it resolves from here, per language.
 */
async function applyStrings(): Promise<void> {
  const existing = await must<Array<{ id: string; key: string; language: string; value: string }>>(
    "list translations",
    api.get("/translations?limit=-1&fields=id,key,language,value"),
  );
  const have = new Map(existing.map((t) => [`${t.key}::${t.language}`, t]));

  let made = 0, changed = 0;
  for (const [key, entry] of Object.entries(STRINGS)) {
    const all: Array<{ language: string; value: string }> = [
      { language: "en-US", value: entry.en },
      ...rows(entry.t, (language, value) => ({ language, value })),
    ];
    for (const row of all) {
      const current = have.get(`${key}::${row.language}`);
      if (current) {
        // Create-only would mean a corrected translation never reaches
        // an instance that already has the key — and a typo in a
        // bookmark name would be permanent short of deleting rows by
        // hand. Collection names and field labels already re-patch.
        if (current.value === row.value) continue;
        const r = await api.patch(`/translations/${current.id}`, { value: row.value });
        if (r.ok) changed++;
        else log.fail(`translation ${key}/${row.language}: ${r.error.message}`);
        continue;
      }
      const r = await api.post("/translations", { key, language: row.language, value: row.value });
      if (r.ok) made++;
      else log.fail(`translation ${key}/${row.language}: ${r.error.message}`);
    }
  }
  log.made(
    `${made} translation strings across ${LANGUAGES.length + 1} languages` +
      (changed ? `, ${changed} updated` : ""),
  );
}

async function applyCollectionNames(): Promise<void> {
  let done = 0;
  for (const c of [...groups, ...collections]) {
    const entry = COLLECTIONS[c.collection];
    if (!entry) continue;
    const translations = rows(entry.singular, (language, singular) => ({
      language,
      translation: "",
      singular,
      plural: "",
    })).map((row, i) => ({ ...row, plural: entry.plural[i] as string, translation: entry.plural[i] as string }));

    const r = await api.patch(`/collections/${c.collection}`, { meta: { translations } });
    if (r.ok) done++;
    else log.fail(`collection ${c.collection}: ${r.error.message}`);
  }
  log.made(`${done} collection names translated`);
}

async function applyFieldNames(): Promise<void> {
  let done = 0, skipped = 0;
  for (const c of collections) {
    for (const f of c.fields) {
      // Divider titles are $t: references resolved at render time, so
      // they need no translations array of their own.
      if (f.field === "id" || f.field.startsWith("divider_")) continue;
      const t = FIELDS[f.field];
      if (!t) { skipped++; continue; }
      const translations = fieldTranslations(f.field, t);
      const r = await api.patch(`/fields/${c.collection}/${f.field}`, { meta: { translations } });
      if (r.ok) done++;
      else log.fail(`field ${c.collection}.${f.field}: ${r.error.message}`);
    }
  }
  // `lines` on invoices is created by the relation's one_field, so it is
  // not in any field list — translate it explicitly.
  {
    const t = FIELDS["lines"];
    if (t) {
      const translations = fieldTranslations("lines", t);
      const r = await api.patch("/fields/invoices/lines", { meta: { translations } });
      if (r.ok) done++;
    }
  }

  // directus_users gains two fields of ours; translate those too.
  for (const field of ["clinic", "job_title"]) {
    const t = FIELDS[field];
    if (!t) continue;
    const translations = fieldTranslations(field, t);
    const r = await api.patch(`/fields/directus_users/${field}`, { meta: { translations } });
    if (r.ok) done++;
  }
  log.made(`${done} field labels translated${skipped ? ` (${skipped} without an entry)` : ""}`);
}

export async function applyTranslations(): Promise<void> {
  await applyStrings();
  await applyCollectionNames();
  await applyFieldNames();
}
