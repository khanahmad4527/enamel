/**
 * A practice's colour, turned into two palettes that cannot be unreadable.
 *
 * Two, because a colour readable on a white page is not readable on a
 * black one and the viewer picks which page they get. The first version
 * of this file computed one palette, against the light ground, and it
 * shipped: sixty text elements between 2.87:1 and 3.39:1 in dark mode,
 * across every page of the site. They looked fine. They were measured.
 *
 * The practice sets one thing: their brand colour. Everything else here
 * is computed from it — the hover shade, the tint behind a link, and
 * crucially **whether text sitting on top of it is black or white**.
 *
 * That last one is the whole reason this file exists rather than the
 * colour going straight into a CSS variable. A practice picks their
 * brand colour from a letterhead; nobody picks it by checking the
 * contrast ratio of white text on it. Left alone, the first practice
 * with a pale brand ships a page with white text on yellow, and the
 * people who could tell them are the ones who cannot read it.
 *
 * Everything degrades: a clinic with no colour set returns nothing, and
 * the stylesheet's own defaults apply. Nothing here can break a page by
 * being absent.
 */

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parse(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const toHex = (rgb: [number, number, number]) =>
  "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 1;
  const la = luminance(x), lb = luminance(y);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Black or white on this colour, whichever a person can actually read.
 *
 * The near-black is the site's own ink rather than pure `#000`, because
 * pure black on a mid colour is harsher than it needs to be and this is
 * a page anxious people read.
 */
export function readableOn(colour: string): string {
  const dark = "#131e29";
  return contrast(colour, "#ffffff") >= contrast(colour, dark) ? "#ffffff" : dark;
}

function mixTo(colour: string, target: string, amount: number): string {
  const a = parse(colour), b = parse(target);
  if (!a || !b) return colour;
  return toHex([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]);
}

/**
 * Step a colour towards black until it meets a contrast target.
 *
 * Capped, because a target that cannot be met — somebody picks white as
 * their brand colour — must terminate rather than loop, and near-black
 * is the correct answer in that case anyway.
 */
/**
 * Step a colour towards a target until it meets a contrast ratio.
 *
 * Capped, because a target that cannot be met — somebody picks white as
 * their brand colour and wants it readable on paper — must terminate
 * rather than loop, and the fully-stepped colour is the best available
 * answer in that case anyway.
 *
 * The first version darkened by a *fixed* amount, which is the sort of
 * thing that looks right and is wrong for exactly the inputs that needed
 * it: a pale amber came out at 3.65:1, still under AA, still shipped.
 * Stepping until the ratio passes is barely more code and cannot be
 * wrong by a bit.
 */
function stepUntilReadable(colour: string, against: string, target: number, towards: string): string {
  let current = colour;
  for (let step = 0; step < 20; step++) {
    if (contrast(current, against) >= target) return current;
    current = mixTo(colour, towards, (step + 1) * 0.05);
  }
  return current;
}

/**
 * The two grounds a brand colour has to survive, and they are not the
 * page's background.
 *
 * In each scheme the *worst case* is what matters, because one token is
 * used on several surfaces. In light that is the sunken grey behind the
 * footer — darker than the page, so it is where dark text on it comes
 * closest to failing. In dark it is the raised surface behind the
 * masthead and the hours panel — lighter than the page, so it is where
 * light text on it comes closest to failing. Computing against the page
 * background instead passes the page and fails the footer.
 */
const WORST_LIGHT = "#e2eff3";
const WORST_DARK = "#26424d";

export type Theme = Record<string, string>;

/**
 * The custom properties for one practice.
 *
 * Returned as a plain object so the caller can spread it into a `style`
 * attribute on a wrapper element. That is deliberately not a `<style>`
 * tag injected into the head: as inline properties on an element the
 * theme is server-rendered with the page (no flash), scoped to that
 * subtree (it cannot leak into anything else), and needs no extra
 * request — the clinic row is already being fetched for the page.
 */
export function themeFor(primary: string | null | undefined): Theme {
  if (!primary || !parse(primary)) return {};

  const colour = primary.startsWith("#") ? primary : `#${primary}`;

  // The brand on a dark ground, lifted until a focus ring drawn in it is
  // actually visible against the lightest dark surface. A brand colour is
  // chosen against a letterhead, which is white; dropped unchanged onto a
  // near-black page, a dark one becomes a shape you cannot see, and the
  // focus outline is drawn in it.
  const lifted = stepUntilReadable(colour, WORST_DARK, 3, "#ffffff");

  return {
    "--brand": colour,
    "--brand-deep": mixTo(colour, "#000000", 0.22),
    "--brand-on": readableOn(colour),
    "--brand-ink-light": stepUntilReadable(colour, WORST_LIGHT, 4.5, "#000000"),
    "--brand-wash-light": mixTo(colour, "#ffffff", 0.9),

    "--brand-lift": lifted,
    "--brand-lift-deep": mixTo(lifted, "#ffffff", 0.18),
    "--brand-lift-on": readableOn(lifted),
    "--brand-ink-dark": stepUntilReadable(colour, WORST_DARK, 4.5, "#ffffff"),
    "--brand-wash-dark": mixTo(colour, "#0c141b", 0.86),
  };
}

/** What the theme resolves to, for the check that asserts it is readable. */
export function describeTheme(primary: string | null | undefined) {
  const t = themeFor(primary);
  if (!t["--brand"]) return null;
  return {
    accent: t["--brand"]!,
    textOnAccent: t["--brand-on"]!,
    contrastOnAccent: contrast(t["--brand"]!, t["--brand-on"]!),
    linkOnPaper: t["--brand-ink-light"]!,
    contrastLinkOnPaper: contrast(t["--brand-ink-light"]!, WORST_LIGHT),
    // The half the first version did not have. Every one of these was
    // failing — between 2.87:1 and 3.39:1 — on a page that looked fine.
    accentInDark: t["--brand-lift"]!,
    textOnAccentInDark: t["--brand-lift-on"]!,
    contrastOnAccentInDark: contrast(t["--brand-lift"]!, t["--brand-lift-on"]!),
    linkInDark: t["--brand-ink-dark"]!,
    contrastLinkInDark: contrast(t["--brand-ink-dark"]!, WORST_DARK),
  };
}
