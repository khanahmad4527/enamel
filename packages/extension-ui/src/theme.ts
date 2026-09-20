/**
 * Directus's theme variables, mapped once.
 *
 * Every extension in this repo needs the same half-dozen colours, and
 * every one of them used to declare its own mapping at the root of its
 * own component. That is how `--theme--background-page` got into two
 * files — a variable that **does not exist**, resolves to nothing, and
 * paints white blocks under light text in dark mode. It was found by
 * looking at a screen, which is the only way that class of bug is ever
 * found.
 *
 * One mapping, injected once, and the fallbacks are the light-theme
 * values so an extension rendered before the admin's own stylesheet has
 * settled is readable rather than invisible.
 *
 * The names below are the real ones. Checked against a running instance,
 * not against memory:
 *   --theme--background            the page
 *   --theme--background-normal     a raised surface
 *   --theme--background-subdued    a recessed one
 *   --theme--foreground            body text
 *   --theme--foreground-subdued    secondary text — but see --en-ink-dim
 *   --theme--border-color          hairlines
 *   --theme--primary               the accent
 *   --theme--primary-background    a tint of it
 *   --theme--danger / --theme--warning / --theme--success
 */
export const ENAMEL_THEME_CSS = `
.enamel-scope {
  --en-bg:            var(--theme--background, #f0f4f9);
  --en-surface:       var(--theme--background-normal, #e4eaf1);
  --en-sunken:        var(--theme--background-subdued, #f7f9fc);
  --en-ink:           var(--theme--foreground, #4f5464);
  --en-ink-strong:    var(--theme--foreground-accent, #172940);
  /*
   * Derived, not taken.
   *
   * Directus's own '--theme--foreground-subdued' measures **2.68:1** on
   * '--theme--background-normal' in this admin — under the 4.5:1 WCAG
   * asks for body text — and every extension here was using it for slider
   * labels, metadata lines and hints. It looks like the right token and
   * it is not usable for text.
   *
   * So the secondary tone is mixed from the *readable* foreground rather
   * than inherited from the subdued one: far enough toward the background
   * to read as secondary, close enough to stay legible, and it follows
   * whichever theme the admin is in because both ends are theme tokens.
   * The subdued token is still right for what it was named for — borders,
   * icons, things that are not read.
   */
  --en-ink-dim:       color-mix(in srgb, var(--theme--foreground, #4f5464) 80%, var(--theme--background, #f0f4f9));
  --en-line:          var(--theme--border-color, #d3dae4);
  --en-line-soft:     var(--theme--border-color-subdued, #e4eaf1);
  --en-accent:        var(--theme--primary, #73b8e8);
  --en-accent-wash:   var(--theme--primary-background, rgba(102, 68, 255, 0.1));
  --en-danger:        var(--theme--danger, #e35169);
  --en-danger-wash:   var(--theme--danger-background, rgba(227, 81, 105, 0.1));
  --en-warning:       var(--theme--warning, #ffa439);
  --en-success:       var(--theme--success, #2ecda7);
  --en-radius:        var(--theme--border-radius, 6px);
  --en-border-width:  var(--theme--border-width, 2px);
}
`;

const MARKER = "enamel-extension-theme";

/**
 * Put the mapping in the document, once, however many extensions ask.
 *
 * Idempotent by the marker id rather than by a module-level boolean: each
 * extension is a separately bundled module with its own module scope, so
 * a boolean would be true six times and the sheet would be added six
 * times. The DOM is the only shared state they have.
 */
export function useEnamelTheme(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(MARKER)) return;
  const style = document.createElement("style");
  style.id = MARKER;
  style.textContent = ENAMEL_THEME_CSS;
  document.head.appendChild(style);
}
