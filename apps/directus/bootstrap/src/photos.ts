import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The practice's photographs, if there are any.
 *
 * The site used to be illustrated entirely by `imagery.ts`, which draws
 * abstract panels from the brand colour. Those are honest — obviously not
 * photography, so nobody mistakes the demo for a real practice — but they
 * are also the reason the site did not look like a dental practice.
 *
 * So real pictures sit in `assets/website/` and are picked up by slot
 * name. Nothing here is precious about them: the generated panel is still
 * the fallback, and a missing file is not an error. That is the whole
 * handover story — a practice drops `hero.jpg` in beside the placeholder,
 * re-runs the seed, and the code is untouched.
 *
 * There was a `CREDIT` map here, writing an attribution line onto each
 * file in Directus. It existed because the placeholders were Wikimedia
 * and rawpixel images under CC BY and CC BY-SA, which oblige whoever
 * publishes them to say where they came from. The photographs are the
 * practice's own now, so there is nobody to credit and the machinery for
 * doing it is gone rather than left to describe something untrue.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "assets", "website");

export type Photo = { bytes: Uint8Array; filename: string; type: string };

/**
 * The photograph for a slot, or null to fall back to a drawn panel.
 *
 * Only ENOENT is swallowed. A file that exists and cannot be read is a
 * real fault and is worth letting through rather than quietly shipping a
 * placeholder over the top of somebody's photograph.
 */
export async function websitePhoto(slot: string): Promise<Photo | null> {
  for (const ext of ["jpg", "png"] as const) {
    try {
      const bytes = await readFile(join(ROOT, `${slot}.${ext}`));
      return {
        bytes,
        filename: `${slot}.${ext}`,
        type: ext === "jpg" ? "image/jpeg" : "image/png",
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return null;
}

/**
 * A clinician's own photograph, found by name.
 *
 * `hannah-prins.jpg` beside the treatment pictures and the seed picks it
 * up — the same rule as everything else in this folder, so a practice adds
 * a new dentist by adding a file rather than by editing code.
 *
 * Nothing is generated as a fallback for a face, and that is deliberate:
 * the drawn monogram stays until somebody supplies one. A stock
 * photograph of a real person captioned with a dentist's name invents a
 * professional identity for somebody who never agreed to it, and no
 * licence covers that. A likeness the practice owns, or none.
 */
export function portraitSlug(name: string): string {
  return name
    .toLowerCase()
    // Dekker, Okonkwo, Björk — strip the accents rather than the letters.
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
