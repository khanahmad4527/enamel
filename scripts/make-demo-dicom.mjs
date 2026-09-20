// Generates the demo DICOM studies committed under demo/documents.
//
//   node scripts/make-demo-dicom.mjs demo/documents
//
// Run it when the seeded patient names change, so the header check has
// something true to compare against. The output is committed because the
// other demo documents are, and a clone should not need a build step to
// have a study to look at.
// Committed rather than generated at seed time so a clone has them, and
// small on purpose: a real intraoral study is 10–30 MB of pixel data this
// deliberately does not read.
import { writeFileSync } from "node:fs";

function el(group, element, vr, value) {
  const isLong = ["OB","OW","OF","OD","OL","OV","SQ","UN","UT","UC","UR"].includes(vr);
  let body;
  if (vr === "US") { body = Buffer.alloc(2); body.writeUInt16LE(value, 0); }
  else if (vr === "UL") { body = Buffer.alloc(4); body.writeUInt32LE(value, 0); }
  else { body = Buffer.from(String(value), "latin1"); if (body.length % 2) body = Buffer.concat([body, Buffer.from("\0")]); }
  const head = Buffer.alloc(isLong ? 12 : 8);
  head.writeUInt16LE(group, 0); head.writeUInt16LE(element, 2);
  head.write(vr, 4, "latin1");
  if (isLong) { head.writeUInt16LE(0, 6); head.writeUInt32LE(body.length, 8); }
  else head.writeUInt16LE(body.length, 6);
  return Buffer.concat([head, body]);
}

function study({ out, syntax, name, id, birth, date, modality, description, model, rows, columns, bits }) {
  const meta = Buffer.concat([
    el(0x0002, 0x0002, "UI", "1.2.840.10008.5.1.4.1.1.1.3"),
    el(0x0002, 0x0003, "UI", "1.2.276.0.7230010.3.1.4.1"),
    el(0x0002, 0x0010, "UI", syntax),
    el(0x0002, 0x0012, "UI", "1.2.276.0.7230010.3.0.3.6.1"),
  ]);
  const dataset = Buffer.concat([
    el(0x0008, 0x0016, "UI", "1.2.840.10008.5.1.4.1.1.1.3"),
    el(0x0008, 0x0020, "DA", date),
    el(0x0008, 0x0030, "TM", "094512"),
    el(0x0008, 0x0060, "CS", modality),
    el(0x0008, 0x0070, "LO", "Enamel Demo Imaging"),
    el(0x0008, 0x1030, "LO", description),
    el(0x0008, 0x1090, "LO", model),
    el(0x0010, 0x0010, "PN", name),
    el(0x0010, 0x0020, "LO", id),
    el(0x0010, 0x0030, "DA", birth),
    el(0x0010, 0x0040, "CS", "F"),
    el(0x0018, 0x0060, "DS", "60"),
    el(0x0020, 0x000d, "UI", "1.2.276.0.7230010.3.1.2.1"),
    el(0x0020, 0x000e, "UI", "1.2.276.0.7230010.3.1.3.1"),
    el(0x0028, 0x0002, "US", 1),
    el(0x0028, 0x0004, "CS", "MONOCHROME2"),
    el(0x0028, 0x0010, "US", rows),
    el(0x0028, 0x0011, "US", columns),
    el(0x0028, 0x0100, "US", bits),
    el(0x0028, 0x1050, "DS", "2048"),
    el(0x0028, 0x1051, "DS", "4096"),
    // A stub pixel-data element. The point of these files is the header.
    el(0x7fe0, 0x0010, "OW", "\0\0\0\0\0\0\0\0"),
  ]);
  writeFileSync(out, Buffer.concat([
    Buffer.alloc(128), Buffer.from("DICM"),
    el(0x0002, 0x0000, "UL", meta.length), meta, dataset,
  ]));
  console.log("wrote", out);
}

const dir = process.argv[2];
study({
  out: `${dir}/bitewing-left.dcm`,
  syntax: "1.2.840.10008.1.2.1",
  name: "de Vries^Sofie", id: "RIV-0001", birth: "19541231",
  date: "20260214", modality: "IO",
  description: "Bitewing left, recall imaging", model: "EX-2 Intraoral",
  rows: 1024, columns: 1280, bits: 16,
});
study({
  out: `${dir}/cbct-small-field.dcm`,
  // The one a modern unit actually emits, and the one a naive parser
  // gives up on: only the pixel data is JPEG 2000, the tags are not.
  syntax: "1.2.840.10008.1.2.4.90",
  // Deliberately somebody else's name. This is the file that demonstrates
  // the check that matters: a study exported by study number and attached
  // to the wrong patient, which is the commonest imaging incident there
  // is. The seed files it against Sofie de Vries and the endpoint says so.
  name: "Janssen^Pieter", id: "RIV-0009", birth: "19770812",
  date: "20260214", modality: "DX",
  description: "CBCT small field, lower right quadrant", model: "Volumetric 3D",
  rows: 800, columns: 800, bits: 16,
});
