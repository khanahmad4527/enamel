/**
 * Extension-local translations.
 *
 * `$t:` and `directus_translations` cover *content* — collection names,
 * field labels, bookmark titles. They do not reach strings baked into an
 * extension's own template, which is what everything here is: condition
 * names, tooth anatomy, arch labels, error states.
 *
 * Rather than merge into the app's global i18n (which risks colliding
 * with core keys and leaks across extensions), the widget keeps its own
 * table and reads only the *current locale* from the app. Locales match
 * the four the rest of the project ships.
 */

export type Locale = "en-US" | "de-DE" | "nl-NL" | "fr-FR";
export const FALLBACK: Locale = "en-US";

export type Messages = {
  loading: string;
  unsavedPatient: string;
  noFindings: string;
  noAccess: string;
  loadFailed: string;
  upper: string;
  lower: string;
  archUpper: string;
  archLower: string;
  sideRight: string;
  sideLeft: string;
  tooth: string;
  positions: string[];
  conditions: Record<string, string>;
  surfaces: Record<string, string>;
};

const en: Messages = {
  loading: "Loading chart…",
  unsavedPatient: "Save the patient first — the chart needs a record to attach findings to.",
  noFindings: "No findings recorded for this tooth.",
  noAccess: "You don't have access to clinical records.",
  loadFailed: "Could not load the chart.",
  upper: "Upper",
  lower: "Lower",
  archUpper: "Upper",
  archLower: "Lower",
  sideRight: "right",
  sideLeft: "left",
  tooth: "Tooth",
  positions: [
    "Central incisor", "Lateral incisor", "Canine",
    "First premolar", "Second premolar",
    "First molar", "Second molar", "Third molar",
  ],
  conditions: {
    healthy: "Healthy", caries: "Caries", filled: "Filled", crown: "Crown",
    root_canal: "Root canal", implant: "Implant", missing: "Missing", fractured: "Fractured",
  },
  surfaces: {
    whole: "Whole tooth", M: "Mesial", O: "Occlusal", D: "Distal", B: "Buccal", L: "Lingual",
  },
};

const de: Messages = {
  loading: "Zahnschema wird geladen…",
  unsavedPatient: "Bitte den Patienten zuerst speichern — das Zahnschema braucht einen Datensatz.",
  noFindings: "Für diesen Zahn sind keine Befunde erfasst.",
  noAccess: "Sie haben keinen Zugriff auf klinische Daten.",
  loadFailed: "Das Zahnschema konnte nicht geladen werden.",
  upper: "Oberkiefer",
  lower: "Unterkiefer",
  archUpper: "Oberkiefer",
  archLower: "Unterkiefer",
  sideRight: "rechts",
  sideLeft: "links",
  tooth: "Zahn",
  positions: [
    "Mittlerer Schneidezahn", "Seitlicher Schneidezahn", "Eckzahn",
    "Erster Prämolar", "Zweiter Prämolar",
    "Erster Molar", "Zweiter Molar", "Weisheitszahn",
  ],
  conditions: {
    healthy: "Gesund", caries: "Karies", filled: "Gefüllt", crown: "Krone",
    root_canal: "Wurzelbehandlung", implant: "Implantat", missing: "Fehlend", fractured: "Fraktur",
  },
  surfaces: {
    whole: "Ganzer Zahn", M: "Mesial", O: "Okklusal", D: "Distal", B: "Bukkal", L: "Lingual",
  },
};

const nl: Messages = {
  loading: "Tandkaart laden…",
  unsavedPatient: "Sla de patiënt eerst op — de tandkaart heeft een dossier nodig.",
  noFindings: "Geen bevindingen vastgelegd voor deze tand.",
  noAccess: "Je hebt geen toegang tot klinische gegevens.",
  loadFailed: "De tandkaart kon niet worden geladen.",
  upper: "Bovenkaak",
  lower: "Onderkaak",
  archUpper: "Bovenkaak",
  archLower: "Onderkaak",
  sideRight: "rechts",
  sideLeft: "links",
  tooth: "Tand",
  positions: [
    "Centrale snijtand", "Laterale snijtand", "Hoektand",
    "Eerste premolaar", "Tweede premolaar",
    "Eerste molaar", "Tweede molaar", "Verstandskies",
  ],
  conditions: {
    healthy: "Gezond", caries: "Cariës", filled: "Gevuld", crown: "Kroon",
    root_canal: "Wortelkanaalbehandeling", implant: "Implantaat", missing: "Ontbrekend", fractured: "Gefractureerd",
  },
  surfaces: {
    whole: "Hele tand", M: "Mesiaal", O: "Occlusaal", D: "Distaal", B: "Buccaal", L: "Linguaal",
  },
};

const fr: Messages = {
  loading: "Chargement du schéma…",
  unsavedPatient: "Enregistrez d'abord le patient — le schéma a besoin d'un dossier.",
  noFindings: "Aucun constat enregistré pour cette dent.",
  noAccess: "Vous n'avez pas accès aux dossiers cliniques.",
  loadFailed: "Le schéma dentaire n'a pas pu être chargé.",
  upper: "Maxillaire",
  lower: "Mandibulaire",
  archUpper: "Maxillaire",
  archLower: "Mandibulaire",
  sideRight: "droite",
  sideLeft: "gauche",
  tooth: "Dent",
  positions: [
    "Incisive centrale", "Incisive latérale", "Canine",
    "Première prémolaire", "Deuxième prémolaire",
    "Première molaire", "Deuxième molaire", "Dent de sagesse",
  ],
  conditions: {
    healthy: "Saine", caries: "Carie", filled: "Obturée", crown: "Couronne",
    root_canal: "Traitement radiculaire", implant: "Implant", missing: "Absente", fractured: "Fracturée",
  },
  surfaces: {
    whole: "Dent entière", M: "Mésiale", O: "Occlusale", D: "Distale", B: "Vestibulaire", L: "Linguale",
  },
};

const TABLE: Record<Locale, Messages> = {
  "en-US": en, "de-DE": de, "nl-NL": nl, "fr-FR": fr,
};

/**
 * Directus locales are full tags ("de-DE"), but a user may be on a
 * regional variant we don't ship ("de-AT"). Match the language subtag
 * before giving up, so de-AT still reads German rather than English.
 */
export function messagesFor(locale: string | undefined): Messages {
  if (!locale) return TABLE[FALLBACK];
  if (locale in TABLE) return TABLE[locale as Locale];
  const lang = locale.split("-")[0];
  const hit = (Object.keys(TABLE) as Locale[]).find((l) => l.split("-")[0] === lang);
  return TABLE[hit ?? FALLBACK];
}
