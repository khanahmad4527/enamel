import { api, must } from "./client.js";
import { log } from "./log.js";

/**
 * The file library, arranged.
 *
 * Directus gives a fresh instance one flat library, and a dental practice
 * fills it with things that have nothing to do with each other: a logo, a
 * bitewing, a signed consent form, a laboratory docket, a letter to a
 * consultant. Flat, they sort by upload date — so the radiograph of a
 * child sits between the practice's favicon and a referral letter, and
 * the person tidying up cannot tell which is which without opening them.
 *
 * That is not only untidy. `document_kind` already decides who may read a
 * file, and the one thing a permission cannot do is make the library
 * *legible* to the person holding the permission. A folder does.
 *
 * ## Branding and Website are two folders, not one
 *
 * They were one until somebody looked in it. The brand kit is a logo, a
 * favicon and a letterhead — half a dozen files that change once a
 * decade and are the practice's identity. The website's pictures are a
 * hero, a photograph per treatment and a portrait per clinician: dozens
 * of files that change whenever somebody redoes the front page. Put them
 * together and finding the logo means scrolling past every picture of a
 * waiting room, which is exactly the problem folders exist to solve.
 *
 * They share a permission — both are readable by the Website token —
 * and that is not a reason to share a folder. What a file *is* and who
 * may *read* it are different questions, and a library arranged by the
 * second answers neither.
 *
 * ## Names, not `$t:` keys
 *
 * Folder names render literally — `$t:` resolves in field notes, divider
 * titles and bookmark names, and not here. Verified rather than assumed.
 * So each name has to work in all four languages by itself, which rules
 * out "Correspondentie" as much as it rules out "Correspondence" being
 * translated. They are short, concrete English nouns, which is the same
 * compromise the Branding folder already makes.
 */
export const FOLDERS = {
  branding: "Branding",
  website: "Website",
  documents: "Patient documents",
  imaging: "Radiographs and scans",
  lab: "Lab work",
  correspondence: "Correspondence",
} as const;

/**
 * Which folder a file belongs in, from the `document_kind` the classify
 * flow already writes.
 *
 * Imaging is separated from the rest of a patient's documents on purpose,
 * and it is the one split that is about more than tidiness. A radiograph
 * is the file in this building most worth stealing and the one a
 * misplaced permission exposes most expensively — GDPR Article 9 health
 * data with a person's jaw in it. Keeping it in its own folder means an
 * administrator auditing who can reach imaging is looking at one place
 * rather than filtering a column.
 */
export const FOLDER_FOR_KIND: Record<string, keyof typeof FOLDERS> = {
  radiograph: "imaging",
  photograph: "imaging",
  scan: "imaging",
  consent: "documents",
  referral: "correspondence",
  letter: "correspondence",
  lab_report: "lab",
  invoice: "documents",
  other: "documents",
};

type FolderRow = { id: string; name: string };

/** Creates each folder once, and finds it by name on every later run. */
export async function applyFolders(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [key, name] of Object.entries(FOLDERS)) {
    const found = await must<FolderRow[]>(
      "find folder",
      api.get(`/folders?limit=1&fields=id&filter[name][_eq]=${encodeURIComponent(name)}`),
    );
    if (found.length && found[0]) {
      ids[key] = found[0].id;
      log.skip(`folder ${name}`);
      continue;
    }
    const made = await must<FolderRow>("create folder", api.post("/folders", { name }));
    ids[key] = made.id;
    log.made(`folder ${name}`);
  }
  return ids;
}

/**
 * Put every already-uploaded file where it belongs.
 *
 * Runs on every provision rather than once, because the alternative is a
 * library that is tidy for a new instance and flat for the one that has
 * been running. A file already in a folder is left alone — somebody may
 * have moved it deliberately, and a provisioning step that overrules a
 * human every night is a provisioning step people turn off.
 */
export async function fileEverything(ids: Record<string, string>): Promise<void> {
  type File = { id: string; folder: string | null; document_kind: string | null; brand_asset: boolean };
  const files = await must<File[]>(
    "find files to file",
    api.get("/files?limit=-1&fields=id,folder,document_kind,brand_asset"),
  );

  /*
   * Which brand assets are the website's pictures rather than the brand
   * kit, asked of the three fields that point at them.
   *
   * By reference, not by filename or title. A file is the hero because
   * something points at it, and that is the only fact about it that
   * stays true when somebody renames it.
   */
  const pointedAt = new Set<string>();
  const practice = await must<Record<string, unknown>>(
    "read the practice for its imagery",
    api.get("/items/practice?fields=hero_image"),
  ).catch(() => ({} as Record<string, unknown>));
  if (typeof practice["hero_image"] === "string") pointedAt.add(practice["hero_image"]);
  for (const svc of await must<Array<{ image: string | null }>>(
    "find treatment imagery", api.get("/items/services?limit=-1&fields=image"),
  ).catch(() => [])) {
    if (svc.image) pointedAt.add(svc.image);
  }
  for (const who of await must<Array<{ public_photo: string | null }>>(
    "find clinician portraits", api.get("/users?limit=-1&fields=public_photo"),
  ).catch(() => [])) {
    if (who.public_photo) pointedAt.add(who.public_photo);
  }

  /*
   * A file already in a folder is left where it is — somebody may have
   * moved it deliberately, and a provisioning step that overrules a
   * person every night is one they turn off.
   *
   * With one exception, and it is the reason this paragraph exists.
   * Website imagery used to be filed into Branding, because there was no
   * Website folder to put it in. Those files are in Branding not because
   * anybody decided they belonged there but because the code had nowhere
   * else — so a picture the website points at, sitting in Branding, is
   * moved. Without this the split would apply to new instances and leave
   * every existing one exactly as muddled as before, which is the
   * "skipping what already exists means the fix never lands" mistake this
   * repository has now made five times.
   */
  const brandingId = ids["branding"];
  let moved = 0;
  for (const f of files) {
    const stranded = pointedAt.has(f.id) && f.folder && f.folder === brandingId;
    if (f.folder && !stranded) continue;
    const key = pointedAt.has(f.id)
      ? "website"
      : f.brand_asset
        ? "branding"
        : FOLDER_FOR_KIND[String(f.document_kind ?? "")] ?? null;
    if (!key || !ids[key]) continue;
    const done = await api.patch(`/files/${f.id}`, { folder: ids[key] });
    if (done.ok) moved++;
    else log.fail(`file ${f.id}: ${done.error.message}`);
  }
  log.made(`  ${moved} files put in a folder`);
}
