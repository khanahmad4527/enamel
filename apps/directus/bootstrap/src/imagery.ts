/**
 * Placeholder imagery, drawn rather than downloaded.
 *
 * A dental practice website needs pictures and this one has none yet, so
 * something has to stand in the frames until a practice supplies its own.
 * The obvious answer — stock photography — is the wrong one twice over: a
 * photograph of a stranger presented as this practice's surgery is a
 * small lie on a page whose whole argument is that it does not tell them,
 * and a photograph of a person on a dental website reads as a patient.
 *
 * So these are abstract, generated from the practice's own brand colour,
 * and they look deliberately like placeholders rather than like a
 * photograph somebody might mistake for the real building. Replacing one
 * is an upload: every frame reads a file id from Directus, and the code
 * does not care where the bytes came from.
 *
 * SVG rather than a raster, because it is a few hundred bytes, scales to
 * any frame without a second asset, and can be generated from a colour
 * without pulling an image library into the provisioning step.
 */

/** Mix two hex colours. `t` of 0 is `a`, 1 is `b`. */
function mix(a: string, b: string, t: number): string {
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [ar, ag, ab] = hex(a);
  const [br, bg, bb] = hex(b);
  const to = (x: number) => Math.round(x).toString(16).padStart(2, "0");
  return `#${to(ar! + (br! - ar!) * t)}${to(ag! + (bg! - ag!) * t)}${to(ab! + (bb! - ab!) * t)}`;
}

/**
 * A deterministic number from a string, so the same frame is the same
 * picture on every provision. A placeholder that reshuffles on each run
 * makes every screenshot a diff.
 */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * The wide one, for the top of the front page.
 *
 * Arcs rather than anything representational: a curve is what a dental
 * arch, an instrument and a chair all have in common, and it is honest
 * about being decoration.
 */
export function heroSvg(colour: string, key = "hero"): string {
  const seed = seedOf(key);
  const deep = mix(colour, "#000000", 0.42);
  const mid = mix(colour, "#000000", 0.08);
  const light = mix(colour, "#ffffff", 0.34);
  const glow = mix(colour, "#ffffff", 0.72);

  // Concentric arcs off the right edge: the one shape a dental arch, an
  // instrument and a chair all share, and honest about being decoration
  // rather than pretending to be a room.
  const arcs = Array.from({ length: 7 }, (_, i) => {
    const r = 210 + i * 132 + (seed % 46);
    const o = (0.30 - i * 0.032).toFixed(3);
    return `<circle cx="1210" cy="470" r="${r}" fill="none" stroke="${glow}" stroke-width="${34 - i * 3}" opacity="${o}"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900" role="img" aria-label="">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="${deep}"/>
      <stop offset="0.5" stop-color="${mid}"/>
      <stop offset="1" stop-color="${light}"/>
    </linearGradient>
    <radialGradient id="r" cx="0.76" cy="0.44" r="0.62">
      <stop offset="0" stop-color="${glow}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${glow}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="c"><rect width="1600" height="900"/></clipPath>
  </defs>
  <rect width="1600" height="900" fill="url(#g)"/>
  <g clip-path="url(#c)">
    ${arcs}
    <rect width="1600" height="900" fill="url(#r)"/>
    <path d="M0 690 C 420 610, 700 780, 1010 668 S 1420 520, 1600 610 L1600 900 L0 900 Z" fill="${deep}" opacity="0.30"/>
    <path d="M0 782 C 380 706, 760 846, 1080 760 S 1440 640, 1600 714 L1600 900 L0 900 Z" fill="${deep}" opacity="0.42"/>
  </g>
</svg>`;
}

/**
 * A square-ish one, for a treatment.
 *
 * Each treatment gets a different arrangement from its own slug, so the
 * list does not read as one image repeated six times — which is what a
 * single shared placeholder looks like, and it looks like a bug.
 */
export function serviceSvg(colour: string, key: string): string {
  const seed = seedOf(key);
  const deep = mix(colour, "#000000", 0.30);
  const base = mix(colour, "#000000", 0.02);
  const light = mix(colour, "#ffffff", 0.40);
  const glow = mix(colour, "#ffffff", 0.78);

  // Each treatment draws from its own slug, so a list of six does not
  // read as one image repeated — which is what a single shared
  // placeholder looks like, and it looks like a bug.
  const rot = (seed % 140) - 70;
  const cx = 300 + (seed % 260);
  const cy = 180 + ((seed >> 3) % 220);
  const bars = Array.from({ length: 3 }, (_, i) => {
    const y = 96 + i * 150 + ((seed >> (i + 2)) % 40);
    const w = 200 + ((seed >> (i + 4)) % 300);
    return `<rect x="-40" y="${y}" width="${w}" height="26" rx="13" fill="${glow}" opacity="${(0.24 - i * 0.05).toFixed(2)}"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 560" width="800" height="560" role="img" aria-label="">
  <defs>
    <linearGradient id="s${seed % 97}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${base}"/>
      <stop offset="1" stop-color="${light}"/>
    </linearGradient>
  </defs>
  <rect width="800" height="560" fill="url(#s${seed % 97})"/>
  ${bars}
  <g transform="rotate(${rot} ${cx} ${cy})">
    <rect x="${cx - 175}" y="${cy - 175}" width="350" height="350" rx="140" fill="${glow}" opacity="0.22"/>
    <rect x="${cx - 108}" y="${cy - 108}" width="216" height="216" rx="88" fill="${glow}" opacity="0.26"/>
  </g>
  <circle cx="${770 - (seed % 150)}" cy="${500 - ((seed >> 5) % 130)}" r="${72 + (seed % 46)}" fill="${deep}" opacity="0.30"/>
</svg>`;
}

/**
 * A portrait frame, for a clinician who has not supplied a photograph.
 *
 * Deliberately not a silhouette of a person. A grey outline of a head is
 * the internet's way of saying "we have nothing", and on a page of three
 * clinicians it reads as three people who declined to be seen. Initials
 * on the practice's own colour reads as a design decision, because it is
 * one.
 */
export function portraitSvg(colour: string, name: string): string {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]!.toUpperCase()).join("");
  const top = mix(colour, "#000000", 0.16);
  const bottom = mix(colour, "#000000", 0.44);
  const ink = mix(colour, "#ffffff", 0.94);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" role="img" aria-label="">
  <defs>
    <linearGradient id="p${initials.charCodeAt(0) || 65}" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="${top}"/>
      <stop offset="1" stop-color="${bottom}"/>
    </linearGradient>
  </defs>
  <rect width="600" height="600" fill="url(#p${initials.charCodeAt(0) || 65})"/>
  <circle cx="300" cy="300" r="226" fill="none" stroke="${ink}" stroke-width="3" opacity="0.30"/>
  <text x="300" y="300" text-anchor="middle" dominant-baseline="central"
        font-family="Georgia, 'Times New Roman', serif" font-size="212" font-weight="600"
        fill="${ink}" opacity="0.94">${initials}</text>
</svg>`;
}
