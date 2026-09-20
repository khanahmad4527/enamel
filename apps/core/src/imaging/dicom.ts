/**
 * Reading a DICOM header, and stopping there.
 *
 * DICOM is two different problems wearing one file extension.
 *
 * The header is a tag-length-value stream with a documented dictionary,
 * and parsing it is the two hundred lines below. It answers the questions
 * a practice management system actually asks: whose study is this, when
 * was it taken, on what machine, is it the modality it claims to be, and
 * does the name inside the file match the patient it was filed against.
 * That last one is worth more than it sounds — a sensor exports by study,
 * and the commonest imaging incident in a practice is an image attached
 * to the wrong file.
 *
 * The pixels are the other problem, and this deliberately does not touch
 * them. Rendering DICOM properly means:
 *
 *   - Transfer syntaxes. Pixel data can be raw, RLE, JPEG baseline,
 *     lossless JPEG, JPEG-LS or JPEG 2000. The last three are the ones
 *     dental sensors and CBCT units actually emit, and none of them is
 *     something a browser decodes. You ship codecs, usually compiled to
 *     WebAssembly, and then you maintain them.
 *   - Window/level from the study's own tags, plus a modality LUT and a
 *     VOI LUT, because 12- and 16-bit samples do not map to 8-bit screen
 *     values by guessing.
 *   - Multi-frame and volumetric data. CBCT is a stack, and a viewer that
 *     shows slice one of four hundred is not a CBCT viewer.
 *   - And the part that is not code: a calibrated display. A diagnosis
 *     made from a radiograph on an uncalibrated laptop is a diagnosis
 *     made badly, whatever the software does.
 *
 * That is a product — it is what Horos, OsiriX and every PACS vendor
 * sell — and building a bad one inside a practice management system is
 * worse than building none, because a bad one still looks like it works.
 *
 * And underneath the engineering there is a harder reason, which is the
 * one that actually settles it.
 *
 * **Under EU Regulation 2017/745 (the MDR), software intended to provide
 * information used for diagnostic decisions is a medical device.**
 * Annex VIII, Rule 11 puts it in Class IIa at the least, and higher where
 * a wrong answer could cause serious deterioration. Class IIa means a
 * notified body, a clinical evaluation, a quality system under ISO 13485,
 * technical documentation and post-market surveillance — years and a
 * budget, not a sprint. MDCG 2019-11 draws the line the other side of
 * which this file sits: software that stores, archives, communicates or
 * performs simple search is **not** a device.
 *
 * So the constraint is not "we have not got round to the codecs". It is
 * that a practice management system which rendered a radiograph *for
 * reading* would be claiming to be something it has not been assessed as,
 * and the claim is made by intended purpose rather than by feature list.
 * Storing the study intact and handing it to a viewer that has been
 * assessed is the correct architecture and not a compromise.
 *
 * So the honest shape is: store the file intact, read what the header
 * says, show it, and hand the study to something that reads DICOM for a
 * living. The route out is DICOMweb — WADO-RS to fetch, STOW-RS to store,
 * QIDO-RS to search — which is why the adapter boundary matters more here
 * than a half-written decoder would.
 */

/** The 128-byte preamble, then the literal "DICM". */
const MAGIC_OFFSET = 128;
const MAGIC = "DICM";

/** Value representations that carry a 4-byte length instead of 2. */
const LONG_FORM = new Set(["OB", "OW", "OF", "OD", "OL", "OV", "SQ", "UN", "UT", "UC", "UR"]);

/**
 * The tags worth surfacing, by (group,element).
 *
 * Not the whole dictionary — that is thousands of entries and this needs
 * the handful a practice acts on. Names are the DICOM standard's, because
 * anybody comparing this against a study in another tool will be reading
 * those.
 */
const TAGS: Record<string, string> = {
  "0002,0010": "transferSyntaxUid",
  "0008,0016": "sopClassUid",
  "0008,0020": "studyDate",
  "0008,0030": "studyTime",
  "0008,0060": "modality",
  "0008,0070": "manufacturer",
  "0008,1030": "studyDescription",
  "0008,103e": "seriesDescription",
  "0008,1090": "manufacturerModelName",
  "0010,0010": "patientName",
  "0010,0020": "patientId",
  "0010,0030": "patientBirthDate",
  "0010,0040": "patientSex",
  "0018,0060": "kvp",
  "0018,1150": "exposureTime",
  "0020,000d": "studyInstanceUid",
  "0020,000e": "seriesInstanceUid",
  "0028,0002": "samplesPerPixel",
  "0028,0004": "photometricInterpretation",
  "0028,0008": "numberOfFrames",
  "0028,0010": "rows",
  "0028,0011": "columns",
  "0028,0100": "bitsAllocated",
  "0028,1050": "windowCenter",
  "0028,1051": "windowWidth",
};

/**
 * Transfer syntaxes, and whether the pixel data behind them is something
 * anything here could draw.
 *
 * Listed rather than inferred so the answer names the encoding: "JPEG
 * 2000 lossless" is a sentence somebody can act on, and "unsupported" is
 * not.
 */
type Syntax = {
  name: string;
  /** Is the *pixel data* encapsulated in a codec stream? */
  pixelsAreCompressed: boolean;
  /**
   * Is the *dataset* explicit VR little endian?
   *
   * The distinction is the one that is easy to get wrong, and did here.
   * Compression applies to the pixel data only: a JPEG 2000 study still
   * writes every other tag as plain explicit VR little endian, so the
   * patient name in it is perfectly readable. Bailing out of the parse on
   * "not 1.2.840.10008.1.2.1" meant the wrong-patient check — the whole
   * reason for reading a header — silently did nothing on exactly the
   * files a modern sensor produces.
   *
   * Only two real syntaxes need different handling: implicit VR, which
   * needs the tag dictionary this does not ship, and big endian, which
   * needs every read byte-swapped.
   */
  explicitLittleEndian: boolean;
};

const TRANSFER_SYNTAXES: Record<string, Syntax> = {
  "1.2.840.10008.1.2": { name: "Implicit VR little endian", pixelsAreCompressed: false, explicitLittleEndian: false },
  "1.2.840.10008.1.2.1": { name: "Explicit VR little endian", pixelsAreCompressed: false, explicitLittleEndian: true },
  "1.2.840.10008.1.2.2": { name: "Explicit VR big endian", pixelsAreCompressed: false, explicitLittleEndian: false },
  "1.2.840.10008.1.2.5": { name: "RLE lossless", pixelsAreCompressed: true, explicitLittleEndian: true },
  "1.2.840.10008.1.2.4.50": { name: "JPEG baseline (lossy)", pixelsAreCompressed: true, explicitLittleEndian: true },
  "1.2.840.10008.1.2.4.51": { name: "JPEG extended (lossy)", pixelsAreCompressed: true, explicitLittleEndian: true },
  "1.2.840.10008.1.2.4.57": { name: "JPEG lossless", pixelsAreCompressed: true, explicitLittleEndian: true },
  "1.2.840.10008.1.2.4.70": { name: "JPEG lossless, first-order prediction", pixelsAreCompressed: true, explicitLittleEndian: true },
  "1.2.840.10008.1.2.4.80": { name: "JPEG-LS lossless", pixelsAreCompressed: true, explicitLittleEndian: true },
  "1.2.840.10008.1.2.4.81": { name: "JPEG-LS near-lossless", pixelsAreCompressed: true, explicitLittleEndian: true },
  "1.2.840.10008.1.2.4.90": { name: "JPEG 2000 lossless", pixelsAreCompressed: true, explicitLittleEndian: true },
  "1.2.840.10008.1.2.4.91": { name: "JPEG 2000", pixelsAreCompressed: true, explicitLittleEndian: true },
};

export type DicomHeader = Record<string, string | number> & {
  transferSyntax?: string;
  transferSyntaxUid?: string;
};

export type DicomReading = {
  isDicom: boolean;
  /** Why not, when it is not — so "this is a PNG named .dcm" is sayable. */
  reason?: string;
  header?: DicomHeader;
  /** What it would take to draw this one, in a sentence. */
  rendering?: { possible: false; because: string };
};

function ascii(bytes: Uint8Array, from: number, length: number): string {
  let out = "";
  for (let i = from; i < from + length && i < bytes.length; i++) {
    const code = bytes[i]!;
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

/**
 * Read the file-meta group and, where the rest is explicit little endian,
 * keep going into the dataset.
 *
 * Group 0002 is *always* explicit VR little endian regardless of what the
 * rest of the file uses — that is the whole point of it, and it is where
 * the transfer syntax that governs everything after it is declared.
 * Implicit VR needs the tag dictionary to know each value's type, which
 * is the dictionary this deliberately does not ship; those files stop
 * after the meta group, and the reading says so rather than guessing.
 */
export function readDicomHeader(buffer: ArrayBuffer): DicomReading {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (bytes.length < MAGIC_OFFSET + 4) {
    return { isDicom: false, reason: "The file is too small to be a DICOM study." };
  }
  if (ascii(bytes, MAGIC_OFFSET, 4) !== MAGIC) {
    return {
      isDicom: false,
      // Named precisely because this is the common case: a sensor's
      // export tool writes a PNG and the practice files it as .dcm.
      reason: "No DICM marker at byte 128 — this is not a DICOM file, whatever it is named.",
    };
  }

  const header: DicomHeader = {};
  let offset = MAGIC_OFFSET + 4;
  let explicit = true;
  let metaEnds = Number.POSITIVE_INFINITY;

  while (offset + 8 <= bytes.length) {
    const group = view.getUint16(offset, true);
    const element = view.getUint16(offset + 2, true);
    const tag = `${group.toString(16).padStart(4, "0")},${element.toString(16).padStart(4, "0")}`;
    offset += 4;

    let length: number;
    let vr = "";

    if (explicit) {
      vr = ascii(bytes, offset, 2);
      if (LONG_FORM.has(vr)) {
        // Two reserved bytes, then a 32-bit length.
        length = view.getUint32(offset + 4, true);
        offset += 8;
      } else {
        length = view.getUint16(offset + 2, true);
        offset += 4;
      }
    } else {
      length = view.getUint32(offset, true);
      offset += 4;
    }

    // An undefined length means a sequence delimited by an item tag, and
    // walking those needs the dictionary this does not carry. Everything
    // worth reading here comes before one.
    if (length === 0xffffffff) break;

    const name = TAGS[tag];
    if (name && length > 0 && offset + length <= bytes.length) {
      if (vr === "US") header[name] = view.getUint16(offset, true);
      else if (vr === "UL") header[name] = view.getUint32(offset, true);
      else header[name] = ascii(bytes, offset, length);
    }

    // (0002,0000) is the meta group's own byte count: where it ends, and
    // therefore where the declared transfer syntax starts applying.
    if (tag === "0002,0000" && length === 4) {
      metaEnds = offset + length + view.getUint32(offset, true);
    }

    offset += length;

    if (offset >= metaEnds && Number.isFinite(metaEnds)) {
      const uid = String(header["transferSyntaxUid"] ?? "");
      const syntax = TRANSFER_SYNTAXES[uid];
      if (syntax) header["transferSyntax"] = syntax.name;
      // Implicit VR needs the tag dictionary this does not ship; big
      // endian needs every read byte-swapped. Both stop here and the
      // reading says what it could not go on to read, which beats
      // emitting confident nonsense. Everything else — including every
      // compressed syntax — carries an explicit VR little endian dataset
      // and is read exactly like an uncompressed one.
      if (!syntax?.explicitLittleEndian) {
        explicit = false;
        break;
      }
      metaEnds = Number.POSITIVE_INFINITY;
    }

    // Pixel data. Everything worth reading is behind us, and the bytes
    // ahead are the part this does not decode.
    if (tag === "7fe0,0010") break;
  }

  const uid = String(header["transferSyntaxUid"] ?? "");
  const syntax = TRANSFER_SYNTAXES[uid];
  if (syntax && !header["transferSyntax"]) header["transferSyntax"] = syntax.name;

  return {
    isDicom: true,
    header,
    rendering: {
      possible: false,
      because: syntax
        ? syntax.pixelsAreCompressed
          ? `The pixel data is ${syntax.name}. Decoding it needs a codec no browser ships, ` +
            "and windowing it needs the study's own VOI LUT — this is a PACS integration, not a viewer."
          : `The pixel data is ${syntax.name}, which is readable in principle, but a 12- or 16-bit ` +
            "sample still needs the study's window and level to become a screen value, and a " +
            "diagnostic reading needs a calibrated display."
        : "The transfer syntax is not one this recognises, so what the pixel data is encoded as is unknown.",
    },
  };
}

/**
 * Does the name inside the study match the patient it was filed against?
 *
 * The commonest imaging incident in a practice is an image attached to
 * the wrong file, and the study itself carries the answer. Compared
 * loosely on purpose — DICOM writes names as `Last^First^Middle`, sensors
 * vary in what they fill in, and a comparison strict enough to be exact
 * is strict enough to cry wolf on every second study until somebody turns
 * it off.
 */
export function nameLooksLike(dicomName: string, first: string, last: string): boolean {
  const parts = dicomName.split("^").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return true;
  const f = first.trim().toLowerCase();
  const l = last.trim().toLowerCase();
  const flat = parts.join(" ");
  return (Boolean(l) && flat.includes(l)) || (Boolean(f) && flat.includes(f));
}
