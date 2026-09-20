/**
 * Synthetic radiographs for the demo.
 *
 *   node scripts/make-demo-radiographs.mjs demo/documents
 *
 * These are **drawings**, not clinical images. No real patient imaging is
 * used anywhere in this repository and none ever should be — a radiograph
 * is identifiable health data under GDPR Article 9, and "we found it on
 * the internet" is not a lawful basis.
 *
 * They exist because the viewer needed something to reveal. The
 * placeholders they replace were 726-byte black rectangles, so brightness
 * and contrast visibly did nothing and the interface looked broken when
 * it was working perfectly.
 *
 * Two things make the difference between this reading as a radiograph and
 * reading as a diagram, and the first attempt got both wrong:
 *
 *   **Nothing has a hard edge.** Structures are signed-distance fields
 *   composited by coverage, and the whole density map is blurred before
 *   any grain is added. A radiograph is an unsharp shadow cast through
 *   tissue; crisp outlines are the single thing that makes a drawing of
 *   one look like clip art.
 *
 *   **The tonal order has to be right**, because that is what the viewer
 *   exists to manipulate: metal brighter than enamel, enamel brighter
 *   than dentine, dentine brighter than bone, pulp darker than all of
 *   them, air darkest. Raise the contrast on one of these and the
 *   interproximal areas genuinely open up.
 *
 * Written with no image library. A greyscale PNG is a signature, an IHDR,
 * zlib-deflated scanlines each prefixed with a filter byte, and an IEND —
 * and Node ships zlib. A dependency to draw this would be a dependency to
 * audit.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

/* ---------------- a greyscale PNG, by hand ---------------- */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function greyPng(w, h, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 1; // Sub filter: helps on smooth gradients.
    for (let x = 0; x < w; x++) {
      const v = px[y * w + x], left = x ? px[y * w + x - 1] : 0;
      raw[y * (w + 1) + 1 + x] = (v - left) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- helpers ---------------- */

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Coverage from a signed distance: 1 well inside, 0 well outside. */
const cover = (d, soft = 1.6) => smoothstep(soft, -soft, d);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}

/* ---------------- signed distance fields ---------------- */

function sdRoundedBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r, qy = Math.abs(py) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/** A tapering capsule: radius r0 at a, r1 at b. Roots and canals. */
function sdCone(px, py, ax, ay, bx, by, r0, r1) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const len2 = bax * bax + bay * bay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / len2));
  return Math.hypot(pax - bax * h, pay - bay * h) - mix(r0, r1, h);
}

/* ---------------- radiodensity ---------------- */

const AIR = 22, SOFT = 58, BONE = 104, LAMINA = 132;
const DENTINE = 156, ENAMEL = 212, PULP = 72, METAL = 246, CARIES = 112;

/* ---------------- one posterior tooth ---------------- */

/**
 * A molar, as a field function.
 *
 * `dir` is -1 for an upper tooth and +1 for a lower one; everything is a
 * distance from the occlusal plane, so the two arches are one piece of
 * code mirrored.
 *
 * Three things here are what stop it reading as a diagram, and all three
 * were wrong in the first two attempts:
 *
 *   **Enamel is a cap, not an outline.** Offsetting the crown shape
 *   *towards the neck* and subtracting gives a covering over the occlusal
 *   half that thins out at the sides — which is the actual anatomy, and
 *   the reason interproximal caries appears where it does. Subtracting a
 *   concentric shape instead draws a rim all the way round and reads as
 *   a sticker.
 *
 *   **Nothing is a repeated stamp.** Each tooth gets its own width,
 *   height and a degree or two of tilt. Four identical shapes in a row is
 *   the single strongest cue that something was generated.
 *
 *   **Roots are short, thick and divergent.** Long thin ones cross into
 *   an X under the crown and read as drawn sticks rather than as
 *   structures embedded in bone.
 */
function molar({ cx, occ, dir, hw, crownH, rootH, tilt = 0, filling, decay }) {
  const neckY = occ + dir * crownH;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);

  return (px, py, put) => {
    // Rotate into the tooth's own frame about the neck, so a tilt pivots
    // the crown rather than sliding it sideways.
    const ox = px - cx, oy = py - neckY;
    const x = cx + ox * cosT - oy * sinT;
    const y = neckY + ox * sinT + oy * cosT;

    const dy = (y - occ) * dir;
    if (dy < -18 || dy > crownH + rootH + 18) return;

    /* --- roots: two, divergent, tapering, embedded --- */
    for (const side of [-1, 1]) {
      const fromX = cx + side * hw * 0.26;
      const toX = cx + side * hw * 0.52;
      const d = sdCone(x, y, fromX, neckY - dir * 10, toX, neckY + dir * rootH,
                       hw * 0.44, hw * 0.19);
      if (d < 4) {
        // Lamina dura, then the root, then the canal inside it.
        //
        // The lamina is deliberately faint and the canal narrow. Drawn at
        // full strength they dominate a root this size, and each root
        // reads as a hollow outline — two bright lines with a dark gap —
        // which at four roots per tooth looks like crossed sticks rather
        // than anything embedded in bone.
        put(LAMINA, cover(d - 3.0, 2.6) * 0.32);
        put(DENTINE - 10, cover(d, 2.2));
        const canal = sdCone(x, y, fromX, neckY, toX, neckY + dir * rootH * 0.78,
                             hw * 0.055, hw * 0.014);
        put(PULP + 46, cover(canal, 1.6) * 0.55);
      }
    }

    /* --- crown --- */
    const t = Math.max(0, Math.min(1, dy / crownH));
    const cy = occ + dir * crownH * 0.5;
    // Widest at the contact point, narrowing to the neck.
    const bulge = 1 + 0.08 * Math.sin(Math.PI * Math.min(1, t * 1.15));
    const dCrown = sdRoundedBox(x - cx, y - cy, hw * bulge, crownH * 0.5, hw * 0.5);
    if (dCrown > 5) return;
    put(DENTINE, cover(dCrown, 1.8));

    // Two cusps on the occlusal surface: a shallow notch in the middle.
    const groove = sdCone(x, y, cx, occ - dir * 6, cx, occ + dir * crownH * 0.2,
                          hw * 0.13, hw * 0.05);
    put(SOFT + 30, cover(groove, 2.2) * 0.55 * (1 - t));

    // Enamel cap: the crown minus the same crown shifted towards the neck.
    const inner = sdRoundedBox(
      x - cx, y - (cy + dir * crownH * 0.42),
      hw * bulge - hw * 0.10, crownH * 0.52, hw * 0.40,
    );
    put(ENAMEL, Math.max(0, cover(dCrown, 2.0) - cover(inner, 3.0)));

    // Pulp chamber with horns reaching towards the cusps.
    const chamber = sdRoundedBox(x - cx, (y - (cy + dir * crownH * 0.10)) * 1.35,
                                 hw * 0.30, crownH * 0.17, hw * 0.16);
    put(PULP, cover(chamber, 1.8));
    for (const side of [-1, 1]) {
      const horn = sdCone(x, y, cx + side * hw * 0.22, cy + dir * crownH * 0.08,
                          cx + side * hw * 0.34, occ + dir * crownH * 0.24,
                          hw * 0.07, hw * 0.02);
      put(PULP + 8, cover(horn, 1.4) * 0.8);
    }

    if (filling) {
      const dF = sdRoundedBox(x - (cx + filling.offset), (y - (occ + dir * crownH * 0.2)) * 1.15,
                              filling.w, crownH * 0.15, 6);
      put(METAL, cover(dF, 1.4));
    }

    // Interproximal caries: a soft wedge just below the contact point,
    // widest at the surface — which is where the contrast control earns
    // its keep, because at default exposure it is barely there.
    if (decay) {
      const dD = sdCone(x, y, cx + decay.side * hw * 1.02, occ + dir * crownH * 0.30,
                        cx + decay.side * hw * 0.48, occ + dir * crownH * 0.52,
                        hw * 0.17, hw * 0.04);
      put(CARIES, cover(dD, 2.6) * 0.85);
    }
  };
}

/* ---------------- compose, blur, grain ---------------- */

function compose(W, H, background, painters, { blur = 2, grain = 7, seed = 1 }) {
  const dens = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = background(x + 0.5, y + 0.5);
      const put = (value, coverage) => {
        if (coverage > 0.001) v = mix(v, value, Math.min(1, coverage));
      };
      for (const p of painters) p(x + 0.5, y + 0.5, put);
      dens[y * W + x] = v;
    }
  }

  // Three box passes ≈ a gaussian. This is the step that turns a diagram
  // into a shadow; without it every structure has a drawn outline.
  const tmp = new Float32Array(W * H);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let k = -blur; k <= blur; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= W) continue;
          s += dens[y * W + xx]; n++;
        }
        tmp[y * W + x] = s / n;
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let k = -blur; k <= blur; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= H) continue;
          s += tmp[yy * W + x]; n++;
        }
        dens[y * W + x] = s / n;
      }
    }
  }

  // Grain last, and more of it in the dark, which is how film behaves.
  const noise = rng(seed);
  const px = Buffer.alloc(W * H);
  for (let i = 0; i < dens.length; i++) {
    const v = dens[i];
    px[i] = clamp(v + (noise() - 0.5) * (grain + (255 - v) * 0.03));
  }
  return px;
}

/** Trabecular bone: mid grey, softly blotchy, never regular. */
function bone(x, y) {
  const a = Math.sin(x * 0.041 + Math.cos(y * 0.027) * 1.7);
  const b = Math.sin((x * 0.7 + y) * 0.023) * Math.cos((x - y * 0.6) * 0.035);
  const c = Math.sin(x * 0.11) * Math.sin(y * 0.13);
  return BONE + a * 9 + b * 11 + c * 4;
}

function bitewing() {
  const W = 960, H = 660, OCC = 330;
  const jitter = rng(4242);
  const painters = [];
  for (let i = 0; i < 4; i++) {
    const cx = 132 + i * 226;
    const v = () => 0.92 + jitter() * 0.16;      // ±8% on each dimension
    const tilt = () => (jitter() - 0.5) * 0.07;  // a couple of degrees
    painters.push(molar({
      cx, occ: OCC - 5, dir: -1,
      hw: 88 * v(), crownH: 118 * v(), rootH: 128 * v(), tilt: tilt(),
      filling: i === 1 ? { offset: 14, w: 25 } : null,
      decay: i === 2 ? { side: -1 } : null,
    }));
    painters.push(molar({
      cx: cx + 12, occ: OCC + 5, dir: 1,
      hw: 85 * v(), crownH: 112 * v(), rootH: 134 * v(), tilt: tilt(),
      filling: i === 3 ? { offset: -9, w: 20 } : null,
      decay: null,
    }));
  }
  const background = (x, y) => {
    const gap = Math.abs(y - OCC);
    if (gap < 26) return mix(SOFT, AIR + 18, smoothstep(26, 5, gap));
    const toBone = smoothstep(26, 88, gap);
    return mix(SOFT + 4, bone(x, y), toBone);
  };
  return { W, H, px: compose(W, H, background, painters, { blur: 2, grain: 7, seed: 20260914 }) };
}

function panoramic() {
  const W = 1360, H = 620;
  const archY = (x) => 300 + Math.pow((x - W / 2) / 460, 2) * 104;
  const painters = [];
  for (let i = 0; i < 14; i++) {
    const x = 150 + i * 82;
    const y = archY(x);
    const front = Math.abs(x - W / 2) < 175;
    painters.push(molar({
      cx: x, occ: y - 3, dir: -1,
      hw: front ? 22 : 33, crownH: front ? 62 : 55, rootH: front ? 76 : 86,
      tilt: (i - 6.5) * 0.012,
      filling: i === 3 || i === 11 ? { offset: 0, w: 10 } : null, decay: null,
    }));
    painters.push(molar({
      cx: x, occ: y + 3, dir: 1,
      hw: front ? 21 : 32, crownH: front ? 58 : 52, rootH: front ? 72 : 82,
      tilt: (i - 6.5) * 0.010,
      filling: null, decay: null,
    }));
  }
  const background = (x, y) => {
    const a = archY(x);
    const d = y - a;
    if (d > 210) return mix(bone(x, y) + 10, SOFT - 6, smoothstep(210, 300, d));
    if (d > 120) return bone(x, y) + 12;                       // mandible body
    if (d < -170) {
      // The maxillary sinus: the dark space that makes an OPG an OPG.
      const sinus = smoothstep(230, 330, Math.abs(x - W / 2)) * smoothstep(-170, -230, d);
      return mix(bone(x, y) - 12, SOFT + 20, sinus);
    }
    return bone(x, y);
  };
  return { W, H, px: compose(W, H, background, painters, { blur: 2, grain: 6, seed: 771 }) };
}

const dir = process.argv[2] ?? "demo/documents";
for (const [name, make] of [["bitewing-right.png", bitewing], ["opg-panoramic.png", panoramic]]) {
  const { W, H, px } = make();
  writeFileSync(`${dir}/${name}`, greyPng(W, H, px));
  console.log(`wrote ${dir}/${name}  ${W}×${H}`);
}
