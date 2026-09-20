import { getCurrentInstance } from "vue";

/**
 * Directus provides vue-i18n to app extensions, but it is not a declared
 * dependency of this package and the API has shifted across Directus
 * majors. Reading the locale off the component's own i18n instance keeps
 * the widget working if either changes: worst case `locale` is undefined
 * and the chart renders in English.
 */
export function useI18nSafe(): { locale: { value: string } } | null {
  const instance = getCurrentInstance();
  const globals = instance?.appContext.config.globalProperties as
    | { $i18n?: { locale: string }; $root?: unknown }
    | undefined;

  if (globals?.$i18n && typeof globals.$i18n.locale === "string") {
    return { locale: { value: globals.$i18n.locale } };
  }

  // Directus 11 exposes the composer on the app instance instead.
  const i18n = (instance?.appContext.app as unknown as {
    __VUE_I18N__?: { global?: { locale?: { value?: string } | string } };
  })?.__VUE_I18N__;
  const g = i18n?.global?.locale;
  if (g && typeof g === "object" && typeof g.value === "string") {
    return { locale: { value: g.value } };
  }
  if (typeof g === "string") return { locale: { value: g } };

  return null;
}
