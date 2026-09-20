import { defineHook } from "@directus/extensions-sdk";
import { InvalidPayloadError } from "@directus/errors";

/**
 * Document rules, on the way in.
 *
 * Same division of labour as the scheduling hook next door, and for the
 * same reason. `enamel_document_versions` in the bootstrap's constraints
 * step is what actually enforces a version chain — it runs for anything
 * that can reach the database, including a script somebody writes next
 * year. What it cannot do is explain itself: a violation arrives as HTTP
 * 500 with `ENAMEL_DOC_OTHER_PATIENT` embedded in an insert statement,
 * which tells a dentist filing a retake nothing and leaks the schema to
 * anybody authenticated.
 *
 * So the rules are asked twice. Here, where the answer is a sentence, and
 * in Postgres, where it cannot be routed around. The hook races — two
 * requests can both pass before either writes — and the trigger is the
 * one that cannot, which is the right way round: losing the race costs
 * you an ugly 500 instead of a version chain that forks.
 */

type Payload = Record<string, unknown>;

type Document = {
  id?: string;
  patient?: string | null;
  kind?: string | null;
  supersedes?: string | null;
  superseded_by?: string | null;
  supersede_reason?: string | null;
};

/** The fields that can make a document illegal. Everything else is a note. */
const VERSION_FIELDS = ["supersedes", "supersede_reason", "patient"];

export default defineHook(({ filter, action }, { services, getSchema }) => {
  const { ItemsService } = services as {
    ItemsService: new (collection: string, opts: Record<string, unknown>) => {
      readOne(key: string, query?: Record<string, unknown>): Promise<Record<string, unknown>>;
      readByQuery(query: Record<string, unknown>): Promise<Record<string, unknown>[]>;
      updateOne(key: string, data: Record<string, unknown>): Promise<unknown>;
    };
  };

  /**
   * Which folder a file belongs in, from the document that classifies it.
   *
   * A flow already copies `document_kind` onto the file, because that is
   * what the permission rule reads. It cannot also put the file in the
   * right folder: a flow has no branching, and this is a five-way choice.
   * So it happens here, where a map is just a map.
   *
   * Imaging is split from the rest of a patient's documents deliberately.
   * A radiograph is the file in the building most worth stealing and the
   * one a misplaced permission exposes most expensively, and an
   * administrator auditing who can reach imaging should be looking at one
   * folder rather than filtering a column.
   */
  const FOLDER_FOR_KIND: Record<string, string> = {
    radiograph: "Radiographs and scans",
    photograph: "Radiographs and scans",
    scan: "Radiographs and scans",
    consent: "Patient documents",
    invoice: "Patient documents",
    other: "Patient documents",
    referral: "Correspondence",
    letter: "Correspondence",
    lab_report: "Lab work",
  };

  /**
   * After the write, not before it.
   *
   * A `filter` runs inside the transaction and can refuse; putting a file
   * somewhere is not grounds to refuse a document, and a folder that
   * cannot be found must not stop a clinician filing a radiograph. So
   * this is an `action`, it runs as the system, and every failure is a
   * log line rather than an exception.
   */
  /**
   * A picture chosen for the website becomes readable by the website.
   *
   * The site serves imagery through `/brand/:id`, which only relays files
   * flagged `brand_asset` — the flag is what keeps a visitor from walking
   * the file library by guessing uuids, and it is why a radiograph cannot
   * be fetched that way.
   *
   * Without this, uploading a photograph and picking it in `hero_image`
   * produced a broken image and no error anywhere: the field was set, the
   * file existed, and the proxy correctly refused it. So choosing a file
   * for one of these three fields is what marks it, which makes "upload a
   * photo and pick it" work with nothing else to remember.
   *
   * The flag is never removed. A file that stopped being the hero is
   * still a picture of the building, and un-flagging it would break any
   * page still pointing at it — including a cached one.
   */
  /*
   * Which fields publish a file, and which folder each one files it into.
   *
   * The logo is the brand kit; the hero, the treatment pictures and the
   * portraits are the website's. They share a permission and they are not
   * the same kind of thing, and a library where finding the logo means
   * scrolling past every picture of a waiting room is a library nobody
   * tidies twice.
   */
  const IMAGE_FIELDS: Record<string, Array<{ field: string; folder: string }>> = {
    practice: [
      { field: "theme_logo", folder: "Branding" },
      { field: "hero_image", folder: "Website" },
    ],
    services: [{ field: "image", folder: "Website" }],
    directus_users: [{ field: "public_photo", folder: "Website" }],
  };

  const publish = async (collection: string, payload: Record<string, unknown>, ctx: unknown) => {
    const wanted = (IMAGE_FIELDS[collection] ?? [])
      .map((f) => ({ ...f, id: payload[f.field] }))
      .filter((f): f is { field: string; folder: string; id: string } =>
        typeof f.id === "string" && f.id.length > 0);
    if (!wanted.length) return;
    try {
      const schema = (ctx as { schema?: unknown })?.schema ?? (await getSchema());
      const files = new ItemsService("directus_files", { schema, accountability: null });
      const folders = new ItemsService("directus_folders", { schema, accountability: null });
      for (const { folder: name, id } of wanted) {
        const found = await folders.readByQuery({ filter: { name: { _eq: name } }, fields: ["id"], limit: 1 });
        const folder = found[0]?.["id"];
        await files.updateOne(id, { brand_asset: true, ...(folder ? { folder } : {}) });
      }
    } catch {
      // A picture the site cannot serve is a broken image. A save that
      // failed because of one would be worse.
    }
  };

  /*
   * System collections do not emit `<collection>.items.update`.
   *
   * Directus names the event for a *custom* collection
   * `patients.items.update`, and for one of its own `users.update` — no
   * `directus_` prefix and no `.items`. So `directus_users.items.update`
   * was a listener for an event that is never raised, and the branch of
   * this hook that files a clinician's photograph had never once run.
   *
   * It hid for months because the portraits were generated SVGs that
   * nobody thought to look up the folder of. The first real photographs
   * landed at the root of the file library and the check that says every
   * picture the site points at is filed went red on a clean rebuild.
   *
   * Both spellings are registered. The wrong one is inert rather than an
   * error, which is precisely why the mistake survived being written.
   */
  const events = (collection: string): string[] =>
    collection.startsWith("directus_")
      ? [`${collection.slice("directus_".length)}.create`, `${collection.slice("directus_".length)}.update`]
      : [`${collection}.items.create`, `${collection}.items.update`];

  for (const collection of Object.keys(IMAGE_FIELDS)) {
    for (const event of events(collection)) {
      action(event, async (meta, ctx) => {
        await publish(collection, ((meta as { payload?: Record<string, unknown> }).payload ?? {}), ctx);
      });
    }
  }

  action("documents.items.create", async (meta, ctx) => {
    try {
      const payload = (meta as { payload?: Record<string, unknown> }).payload ?? {};
      const file = payload["file"];
      const kind = String(payload["kind"] ?? "");
      const want = FOLDER_FOR_KIND[kind];
      if (!file || !want) return;

      const schema = (ctx as { schema?: unknown }).schema ?? (await getSchema());
      const folders = new ItemsService("directus_folders", { schema, accountability: null });
      const found = await folders.readByQuery({ filter: { name: { _eq: want } }, fields: ["id"], limit: 1 });
      const folder = found[0]?.["id"];
      if (!folder) return;

      const files = new ItemsService("directus_files", { schema, accountability: null });
      await files.updateOne(String(file), { folder });
    } catch {
      // A file in the wrong folder is untidy. A document that would not
      // save because of it would be a bug.
    }
  });

  const reject = (message: string): never => {
    throw new InvalidPayloadError({ reason: message });
  };

  /**
   * The row as it will be, not as the payload describes it.
   *
   * An update sends only what changed, so `supersedes` can arrive without
   * the `patient` it has to be checked against. Merging the stored row
   * under the payload is what makes a one-field patch answerable.
   */
  async function resolve(
    payload: Payload,
    key: string | undefined,
    schema: unknown,
  ): Promise<Document> {
    if (!key) return payload as Document;
    const documents = new ItemsService("documents", { schema, accountability: null });
    const stored = await documents
      .readOne(key, { fields: ["id", "patient", "kind", "supersedes", "supersede_reason"] })
      .catch(() => ({}));
    return { ...(stored as Document), ...(payload as Document), id: key };
  }

  async function guard(
    payload: Payload,
    key: string | undefined,
    ctx: { schema?: unknown },
  ): Promise<Payload> {
    if (key && !VERSION_FIELDS.some((f) => f in payload)) return payload;

    const schema = ctx.schema ?? (await getSchema());
    const doc = await resolve(payload, key, schema);
    if (!doc.supersedes) return payload;

    if (doc.id && doc.supersedes === doc.id) {
      reject("a document cannot replace itself");
    }

    const documents = new ItemsService("documents", { schema, accountability: null });
    const prior = (await documents
      .readOne(String(doc.supersedes), {
        fields: ["id", "patient", "kind", "taken_on", "superseded_by"],
      })
      .catch(() => null)) as
      | { id: string; patient: string; kind: string; taken_on: string | null; superseded_by: string | null }
      | null;

    if (!prior) reject("the document being replaced no longer exists");

    // The one that matters. An m2o picker in the admin is not a control —
    // anything holding an API token can send any uuid, and the mistake
    // this stops is moving an image out of one person's file and into
    // another's history.
    if (prior!.patient !== doc.patient) {
      reject("that document is on a different patient's file");
    }

    if (prior!.superseded_by && prior!.superseded_by !== doc.id) {
      reject(
        `that ${prior!.kind ?? "document"}${prior!.taken_on ? ` from ${prior!.taken_on}` : ""} ` +
          "has already been replaced by a newer one",
      );
    }

    if (!String(doc.supersede_reason ?? "").trim()) {
      reject("say why the earlier document was replaced");
    }

    return payload;
  }

  /**
   * Deleting the document a retake replaced.
   *
   * The foreign key already refuses it — `supersedes` is NO ACTION, so
   * Postgres will not let the earlier version go while a later one points
   * at it. That refusal is correct and it is unreadable: HTTP 500 and a
   * constraint name, on a delete somebody pressed for an ordinary reason.
   *
   * Archiving is what they actually want, and the row's own `status`
   * field does it, so the message says so instead of only saying no.
   */
  filter("documents.items.delete", async (input, _meta, ctx) => {
    const keys = (Array.isArray(input) ? input : [input]).map(String).filter(Boolean);
    if (keys.length === 0) return input;

    const schema = (ctx as { schema?: unknown }).schema ?? (await getSchema());
    const documents = new ItemsService("documents", { schema, accountability: null });
    const held = (await documents
      .readByQuery({
        filter: { supersedes: { _in: keys } },
        fields: ["supersedes", "kind", "taken_on"],
        limit: 1,
      })
      .catch(() => [])) as Array<{ kind?: string; taken_on?: string | null }>;

    if (held[0]) {
      reject(
        `a later version of that ${held[0].kind ?? "document"} replaced it, so it stays on file — ` +
          "set its status to archived instead",
      );
    }
    return input;
  });

  filter("documents.items.create", async (input, _meta, ctx) =>
    guard(input as Payload, undefined, ctx as { schema?: unknown }),
  );

  filter("documents.items.update", async (input, meta, ctx) => {
    const keys = ((meta as { keys?: string[] }).keys ?? []) as string[];
    if (keys.length === 0) return guard(input as Payload, undefined, ctx as { schema?: unknown });
    // Each key against its own merged view. A batch that points two
    // documents at the same predecessor is a fork neither payload shows
    // on its own.
    for (const key of keys) await guard({ ...(input as Payload) }, key, ctx as { schema?: unknown });
    return input;
  });
});
