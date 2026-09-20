import { defineComponent, h, onMounted, resolveComponent, type PropType, type VNode } from "vue";
import { refusalFrom, type Refusal, type StateKind } from "./refusal";
import { useEnamelTheme } from "./theme";

/**
 * The four things a view can be showing instead of its content.
 *
 * Written with `h()` rather than as a single-file component on purpose.
 * These extensions are each bundled separately by the Directus extension
 * builder, and a `.vue` file living in a workspace package would have to
 * survive every one of those rollup configurations reaching through a
 * symlink into `node_modules`. A `.ts` file compiles the same way the
 * rest of the extension does, everywhere, with nothing to configure. The
 * component is small enough that the readability cost is a fair trade for
 * never debugging a build.
 *
 * Loading, empty, condition, error — and *condition* is the one worth
 * naming. See `refusal.ts`: an administrator opening a view that belongs
 * to a practice has not hit an error, and painting it red says the
 * software is broken when the access model is working.
 */
export const EnamelState = defineComponent({
  name: "EnamelState",
  props: {
    loading: { type: Boolean, default: false },
    /**
     * Anything thrown or caught. Classified by `refusalFrom`.
     *
     * `default: null` and not `default: null as unknown` is not a style
     * choice. Vue infers a prop's type from its default when the declared
     * type is `unknown`, so the plain `null` made this prop `null |
     * undefined` — a caller passing the `unknown` it caught was a type
     * error, and a caller reading it back would have been told it could
     * only ever be null. Nothing caught that, because until this commit
     * nothing type-checked an extension at all.
     */
    error: { type: [Object, String] as PropType<unknown>, default: null as unknown },
    /**
     * A refusal the caller has already built, in its own words.
     *
     * The shared thing here is the *presentation and the classification*,
     * not the English. The tooth chart carries its messages in four
     * languages, and a component that insisted on its own strings would
     * have quietly regressed three of them — a caller with translations
     * passes them through here and gets the same panel.
     *
     * Takes precedence over `error` when both are set.
     */
    refusal: { type: Object as PropType<Refusal | null>, default: null },
    /** True when the request worked and there is simply nothing to show. */
    empty: { type: Boolean, default: false },
    emptyTitle: { type: String, default: "Nothing to show" },
    emptyBody: { type: String, default: "" },
    emptyHint: { type: String, default: "" },
    /** Overridable for the same reason as `refusal`. */
    loadingLabel: { type: String, default: "Loading…" },
    /** Fills the panel rather than sitting inline. For a whole module. */
    fill: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    onMounted(useEnamelTheme);

    return (): VNode | VNode[] | null => {
      if (props.loading) return panel("loading", {
        kind: "condition",
        title: props.loadingLabel,
        body: "",
      }, props.fill);

      if (props.refusal) return panel("refusal", props.refusal, props.fill);
      if (props.error) return panel("error", refusalFrom(props.error), props.fill);

      if (props.empty) {
        return panel("empty", {
          kind: "empty",
          title: props.emptyTitle,
          body: props.emptyBody,
          ...(props.emptyHint ? { hint: props.emptyHint } : {}),
        }, props.fill);
      }

      return slots["default"]?.() ?? null;
    };
  },
});

/**
 * Material **Symbols** names, not Material Icons names.
 *
 * Directus 11 ships Material Symbols, and the two libraries renamed
 * things: `info_outline` and `error_outline` are Material *Icons*. The
 * failure is not a missing icon — the font matches the longest ligature
 * it knows, draws `info`, and leaves the characters it did not consume
 * on screen as text. The panel read "ⓘ_OUTLINE".
 *
 * Anything added here has to be checked against Material Symbols, and
 * the way to check is to look at it.
 */
const ICON: Record<StateKind, string> = {
  error: "error",
  condition: "info",
  empty: "inbox",
};

function panel(mode: string, refusal: Refusal, fill: boolean): VNode {
  // `v-icon` rather than a `material-icons` span.
  //
  // The admin registers its own icon component globally and does *not*
  // ship the ligature class the Material font docs tell you to use — so
  // `<span class="material-icons">info_outline</span>` renders the words
  // "info_outline" in the middle of the panel. Resolved by name because
  // this package is bundled separately from the app that registers it.
  const VIcon = resolveComponent("v-icon");

  const children: VNode[] = [
    h("div", { class: "en-state__mark" },
      mode === "loading"
        ? [h("span", { class: "en-state__spinner" })]
        : [h(VIcon, { name: ICON[refusal.kind], large: true, class: "en-state__icon" })]),
    h("p", { class: "en-state__title" }, refusal.title),
  ];
  if (refusal.body) children.push(h("p", { class: "en-state__body" }, refusal.body));
  if (refusal.hint) children.push(h("p", { class: "en-state__hint" }, refusal.hint));

  return h("div", {
    class: [
      "enamel-scope",
      "en-state",
      `en-state--${refusal.kind}`,
      fill ? "en-state--fill" : "",
    ].filter(Boolean).join(" "),
    // Announced to a screen reader. An error is assertive because it
    // interrupts what somebody was doing; a condition is polite because
    // it is the page describing itself.
    role: refusal.kind === "error" ? "alert" : "status",
    "aria-live": refusal.kind === "error" ? "assertive" : "polite",
  }, children);
}

/**
 * The stylesheet for the component above, injected the same way and for
 * the same reason as the theme mapping.
 */
export const ENAMEL_STATE_CSS = `
.en-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  padding: 40px 24px;
  border: 1px solid var(--en-line-soft);
  border-radius: var(--en-radius);
  background: var(--en-sunken);
  color: var(--en-ink);
}
.en-state--fill { min-height: 320px; flex: 1 1 auto; }
.en-state__mark { display: flex; align-items: center; justify-content: center; height: 32px; }
.en-state__icon { --v-icon-color: var(--en-ink-dim); color: var(--en-ink-dim); }
.en-state--error .en-state__icon { --v-icon-color: var(--en-danger); color: var(--en-danger); }
.en-state__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--en-ink-strong);
  text-wrap: balance;
}
.en-state--error .en-state__title { color: var(--en-danger); }
.en-state__body {
  margin: 0;
  max-width: 58ch;
  font-size: 14px;
  line-height: 1.55;
  color: var(--en-ink);
}
.en-state__hint {
  margin: 6px 0 0;
  max-width: 58ch;
  font-size: 13px;
  color: var(--en-ink-dim);
}
.en-state__spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--en-line);
  border-top-color: var(--en-accent);
  border-radius: 50%;
  animation: en-spin 0.8s linear infinite;
}
@keyframes en-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .en-state__spinner { animation: none; border-top-color: var(--en-line); }
}
`;
