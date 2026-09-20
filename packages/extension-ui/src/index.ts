/**
 * What every Enamel extension shares.
 *
 * The reason this package exists is a bug rather than a principle. The
 * day sheet and the practice report both refused an administrator with
 * the same sentence, and rendered it two completely different ways — one
 * a floating grey toast over the grid, the other a red banner in the
 * flow. Nobody decided that; they were two files written on different
 * days. Six extensions inventing their own error, empty and loading
 * states is six chances for the seventh to be different again.
 */
export { EnamelState, ENAMEL_STATE_CSS } from "./state";
export { refusalFrom, messageOf, statusOf, type Refusal, type StateKind } from "./refusal";
export { useEnamelTheme, ENAMEL_THEME_CSS } from "./theme";

import { ENAMEL_STATE_CSS } from "./state";
import { ENAMEL_THEME_CSS } from "./theme";

const MARKER = "enamel-extension-ui";

/**
 * Install the theme mapping and the component styles together.
 *
 * Call once from an extension's setup. Idempotent by a DOM marker rather
 * than a module boolean, because each extension is bundled separately and
 * therefore has its own module scope — a boolean would be false six
 * times over and the sheet would be appended six times.
 */
export function installEnamelUi(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(MARKER)) return;
  const style = document.createElement("style");
  style.id = MARKER;
  style.textContent = ENAMEL_THEME_CSS + ENAMEL_STATE_CSS;
  document.head.appendChild(style);
}
