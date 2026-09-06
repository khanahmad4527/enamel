/**
 * FDI two-digit notation (ISO 3950), which is what most of the world
 * outside the US uses: first digit is the quadrant, second is the
 * position counting outward from the midline.
 *
 *   1x upper right   2x upper left
 *   4x lower right   3x lower left
 *
 * Rendering order runs right-to-left across the top and left-to-right
 * across the bottom, so the chart matches how a clinician faces a
 * patient — the patient's right is on the viewer's left.
 */

export type Quadrant = 1 | 2 | 3 | 4;

export const UPPER_RIGHT = [18, 17, 16, 15, 14, 13, 12, 11] as const;
export const UPPER_LEFT = [21, 22, 23, 24, 25, 26, 27, 28] as const;
export const LOWER_LEFT = [31, 32, 33, 34, 35, 36, 37, 38] as const;
export const LOWER_RIGHT = [48, 47, 46, 45, 44, 43, 42, 41] as const;

export const UPPER_ARCH = [...UPPER_RIGHT, ...UPPER_LEFT];
export const LOWER_ARCH = [...LOWER_RIGHT, ...LOWER_LEFT];

/**
 * Anatomy as data, not prose: the quadrant tells you arch and side, the
 * position indexes the anatomical name. The component assembles these in
 * whichever language the operator is reading.
 */
export type ToothAnatomy = {
  arch: "upper" | "lower";
  side: "right" | "left";
  /** 1-8, indexes Messages.positions */
  position: number;
};

export function toothAnatomy(fdi: number): ToothAnatomy {
  const quadrant = Math.floor(fdi / 10);
  return {
    arch: quadrant === 1 || quadrant === 2 ? "upper" : "lower",
    side: quadrant === 1 || quadrant === 4 ? "right" : "left",
    position: fdi % 10,
  };
}

/** Molars are wider than incisors; the chart reads wrong if they aren't. */
export function toothWidth(fdi: number): number {
  const position = fdi % 10;
  if (position >= 6) return 30;
  if (position >= 4) return 26;
  if (position === 3) return 24;
  return 22;
}

export type Condition =
  | "healthy" | "caries" | "filled" | "crown"
  | "root_canal" | "implant" | "missing" | "fractured";

export type ConditionStyle = {
  fill: string;
  stroke: string;
  text: string;
  /** Missing teeth are drawn as an absence: no fill, dashed outline, strike. */
  absent?: boolean;
};

export const CONDITION_STYLE: Record<Condition, ConditionStyle> = {
  healthy:   {    fill: "#FFFFFF", stroke: "#9FB2AE", text: "#0C1B1A" },
  caries:    {     fill: "#E35169", stroke: "#B93247", text: "#FFFFFF" },
  filled:    {     fill: "#3399FF", stroke: "#1F6FC4", text: "#FFFFFF" },
  crown:     {      fill: "#FFC23B", stroke: "#C8901B", text: "#0C1B1A" },
  root_canal:{ fill: "#A855F7", stroke: "#7E33C8", text: "#FFFFFF" },
  implant:   {    fill: "#0D6E63", stroke: "#12B39F", text: "#FFFFFF" },
  fractured: {  fill: "#F97316", stroke: "#C2570D", text: "#FFFFFF" },
  missing:   {    fill: "transparent", stroke: "#6B7C79", text: "#8FA09D", absent: true },
};

export type Finding = {
  id: string;
  tooth_fdi: number;
  surface: string | null;
  condition: Condition;
  recorded_at: string | null;
  notes: string | null;
};

/**
 * The log is append-only, so "the state of tooth 26" is simply its most
 * recent entry. Keeping history rather than mutating a row is what lets
 * a chart show change over time.
 */
export function latestByTooth(findings: Finding[]): Map<number, Finding> {
  const out = new Map<number, Finding>();
  for (const f of findings) {
    const current = out.get(f.tooth_fdi);
    if (!current) { out.set(f.tooth_fdi, f); continue; }
    const a = f.recorded_at ?? "";
    const b = current.recorded_at ?? "";
    if (a >= b) out.set(f.tooth_fdi, f);
  }
  return out;
}
