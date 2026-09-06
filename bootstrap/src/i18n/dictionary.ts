/**
 * German, Dutch and French for everything an operator reads.
 *
 * Directus has three separate translation mechanisms and this uses all
 * of them:
 *
 *   1. `directus_collections.translations` — collection names, with
 *      singular and plural, because German and Dutch inflect differently
 *      from English and "1 Patienten" reads wrong.
 *   2. `directus_fields.meta.translations` — field labels.
 *   3. The `directus_translations` collection — arbitrary strings keyed
 *      by name, referenced anywhere Directus accepts `$t:key`. That is
 *      how bookmark names and field notes get translated, since neither
 *      has a translations array of its own.
 *
 * Field labels are keyed by field name, not by collection.field, because
 * `patient`, `status` and `notes` mean the same thing everywhere they
 * appear — one entry, translated once, applied wherever it occurs.
 */

export type Lang = "de-DE" | "nl-NL" | "fr-FR";
export const LANGUAGES: Lang[] = ["de-DE", "nl-NL", "fr-FR"];

/** [German, Dutch, French] */
export type T3 = [string, string, string];

export const COLLECTIONS: Record<string, { singular: T3; plural: T3 }> = {
  clinics:           { singular: ["Praxis", "Praktijk", "Cabinet"],
                       plural:   ["Praxen", "Praktijken", "Cabinets"] },
  rooms:             { singular: ["Behandlungsraum", "Behandelkamer", "Salle de soins"],
                       plural:   ["Behandlungsräume", "Behandelkamers", "Salles de soins"] },
  patients:          { singular: ["Patient", "Patiënt", "Patient"],
                       plural:   ["Patienten", "Patiënten", "Patients"] },
  appointments:      { singular: ["Termin", "Afspraak", "Rendez-vous"],
                       plural:   ["Termine", "Afspraken", "Rendez-vous"] },
  treatments:        { singular: ["Leistung", "Verrichting", "Acte"],
                       plural:   ["Leistungskatalog", "Verrichtingen", "Catalogue d'actes"] },
  treatment_records: { singular: ["Behandlungseintrag", "Behandelverslag", "Acte réalisé"],
                       plural:   ["Behandlungsdokumentation", "Behandelverslagen", "Actes réalisés"] },
  tooth_conditions:  { singular: ["Zahnbefund", "Tandbevinding", "Constat dentaire"],
                       plural:   ["Zahnbefunde", "Tandbevindingen", "Constats dentaires"] },
  invoices:          { singular: ["Rechnung", "Factuur", "Facture"],
                       plural:   ["Rechnungen", "Facturen", "Factures"] },
  invoice_lines:     { singular: ["Rechnungsposition", "Factuurregel", "Ligne de facture"],
                       plural:   ["Rechnungspositionen", "Factuurregels", "Lignes de facture"] },
  clinical:          { singular: ["Klinisch", "Klinisch", "Clinique"],
                       plural:   ["Klinisch", "Klinisch", "Clinique"] },
  billing:           { singular: ["Abrechnung", "Facturatie", "Facturation"],
                       plural:   ["Abrechnung", "Facturatie", "Facturation"] },
};

export const FIELDS: Record<string, T3> = {
  // shared
  clinic:             ["Praxis", "Praktijk", "Cabinet"],
  status:             ["Status", "Status", "Statut"],
  notes:              ["Notizen", "Notities", "Notes"],
  name:               ["Name", "Naam", "Nom"],
  email:              ["E-Mail", "E-mail", "E-mail"],
  phone:              ["Telefon", "Telefoon", "Téléphone"],
  address:            ["Adresse", "Adres", "Adresse"],
  city:               ["Stadt", "Plaats", "Ville"],
  country:            ["Land", "Land", "Pays"],
  active:             ["Aktiv", "Actief", "Actief"],
  description:        ["Beschreibung", "Omschrijving", "Description"],
  patient:            ["Patient", "Patiënt", "Patient"],
  practitioner:       ["Behandler", "Behandelaar", "Praticien"],
  treatment:          ["Leistung", "Verrichting", "Acte"],
  appointment:        ["Termin", "Afspraak", "Rendez-vous"],
  price:              ["Preis", "Prijs", "Prix"],
  // clinics
  slug:               ["Kürzel", "Kenmerk", "Identifiant"],
  timezone:           ["Zeitzone", "Tijdzone", "Fuseau horaire"],
  currency:           ["Währung", "Valuta", "Devise"],
  // rooms
  chair_number:       ["Stuhlnummer", "Stoelnummer", "N° de fauteuil"],
  // patients
  first_name:         ["Vorname", "Voornaam", "Prénom"],
  last_name:          ["Nachname", "Achternaam", "Nom de famille"],
  date_of_birth:      ["Geburtsdatum", "Geboortedatum", "Date de naissance"],
  reference:          ["Patientennummer", "Patiëntnummer", "N° de patient"],
  preferred_language: ["Bevorzugte Sprache", "Voorkeurstaal", "Langue préférée"],
  portal_user:        ["Portalzugang", "Portaalgebruiker", "Accès portail"],
  medical_alerts:     ["Medizinische Warnhinweise", "Medische waarschuwingen", "Alertes médicales"],
  allergies:          ["Allergien", "Allergieën", "Allergies"],
  clinical_notes:     ["Klinische Notizen", "Klinische notities", "Notes cliniques"],
  tooth_chart:        ["Zahnschema", "Tandkaart", "Schéma dentaire"],
  // appointments
  starts_at:          ["Beginn", "Begintijd", "Début"],
  ends_at:            ["Ende", "Eindtijd", "Fin"],
  room:               ["Behandlungsraum", "Behandelkamer", "Salle"],
  reason:             ["Grund", "Reden", "Motif"],
  reminder_sent:       ["Erinnerung gesendet", "Herinnering verzonden", "Rappel envoyé"],
  // treatments
  code:               ["Ziffer", "Code", "Code"],
  category:           ["Kategorie", "Categorie", "Catégorie"],
  duration_minutes:   ["Dauer (Minuten)", "Duur (minuten)", "Durée (minutes)"],
  default_price:      ["Standardpreis", "Standaardprijs", "Prix par défaut"],
  requires_tooth:     ["Zahn erforderlich", "Tand vereist", "Dent requise"],
  // clinical records
  tooth_fdi:          ["Zahn (FDI)", "Tand (FDI)", "Dent (FDI)"],
  surfaces:           ["Flächen", "Vlakken", "Faces"],
  surface:            ["Fläche", "Vlak", "Face"],
  performed_at:       ["Durchgeführt am", "Uitgevoerd op", "Réalisé le"],
  condition:          ["Befund", "Bevinding", "Constat"],
  recorded_at:        ["Erfasst am", "Vastgelegd op", "Enregistré le"],
  treatment_record:   ["Behandlungseintrag", "Behandelverslag", "Acte réalisé"],
  // billing
  number:             ["Rechnungsnummer", "Factuurnummer", "N° de facture"],
  issued_at:          ["Rechnungsdatum", "Factuurdatum", "Date d'émission"],
  due_at:             ["Fällig am", "Vervaldatum", "Échéance"],
  paid_at:            ["Bezahlt am", "Betaald op", "Payé le"],
  subtotal:           ["Zwischensumme", "Subtotaal", "Sous-total"],
  tax_rate:           ["MwSt.-Satz", "Btw-tarief", "Taux de TVA"],
  total:              ["Gesamtbetrag", "Totaalbedrag", "Total"],
  pdf:                ["PDF", "PDF", "PDF"],
  invoice:            ["Rechnung", "Factuur", "Facture"],
  lines:              ["Positionen", "Regels", "Lignes"],
  quantity:           ["Menge", "Aantal", "Quantité"],
  unit_price:         ["Einzelpreis", "Stukprijs", "Prix unitaire"],
  amount:             ["Betrag", "Bedrag", "Montant"],
  // users
  job_title:          ["Funktion", "Functie", "Fonction"],
};

/**
 * Strings referenced with `$t:key`. Bookmark names and field notes have
 * no translations array of their own, so they point at these instead.
 * English is stored too — `$t:` resolves for every language, including
 * the default one.
 */
export const STRINGS: Record<string, { en: string; t: T3 }> = {
  // --- bookmarks ---
  enamel_bm_todays_diary: {
    en: "Today's diary",
    t: ["Heutiger Terminplan", "Agenda van vandaag", "Agenda du jour"],
  },
  enamel_bm_my_schedule: {
    en: "My schedule",
    t: ["Mein Terminplan", "Mijn agenda", "Mon planning"],
  },
  enamel_bm_needs_reminder: {
    en: "Needs a reminder",
    t: ["Erinnerung nötig", "Herinnering nodig", "Rappel à envoyer"],
  },
  enamel_bm_no_shows: {
    en: "No-shows this month",
    t: ["Nicht erschienen (30 Tage)", "Niet verschenen (30 dagen)", "Absences (30 jours)"],
  },
  enamel_bm_unpaid: {
    en: "Unpaid invoices",
    t: ["Offene Rechnungen", "Openstaande facturen", "Factures impayées"],
  },
  enamel_bm_new_patients: {
    en: "New patients this month",
    t: ["Neue Patienten (30 Tage)", "Nieuwe patiënten (30 dagen)", "Nouveaux patients (30 jours)"],
  },
  enamel_bm_plans: {
    en: "Treatment plans in progress",
    t: ["Laufende Behandlungspläne", "Lopende behandelplannen", "Plans de traitement en cours"],
  },
  enamel_bm_completed_today: {
    en: "Work completed today",
    t: ["Heute abgeschlossen", "Vandaag afgerond", "Actes réalisés aujourd'hui"],
  },
  enamel_bm_medical_alerts: {
    en: "Medical alerts to review",
    t: ["Medizinische Warnhinweise prüfen", "Medische waarschuwingen nakijken", "Alertes médicales à vérifier"],
  },

  // --- field notes ---
  enamel_note_clinic: {
    en: "Owning practice. Every access policy filters on this.",
    t: [
      "Zugehörige Praxis. Jede Zugriffsrichtlinie filtert danach.",
      "Eigenaar-praktijk. Elk toegangsbeleid filtert hierop.",
      "Cabinet propriétaire. Toutes les règles d'accès filtrent dessus.",
    ],
  },
  enamel_note_medical_alerts: {
    en: "Conditions a clinician must see before treating. Never exposed to reception.",
    t: [
      "Befunde, die vor der Behandlung bekannt sein müssen. Für die Rezeption nicht sichtbar.",
      "Aandoeningen die de behandelaar vooraf moet zien. Niet zichtbaar voor de balie.",
      "Antécédents à connaître avant tout soin. Jamais visibles par l'accueil.",
    ],
  },
  enamel_note_tooth_fdi: {
    en: "FDI two-digit notation: quadrant then position (11–48 adult, 51–85 deciduous).",
    t: [
      "FDI-Zahnschema: Quadrant, dann Position (11–48 bleibend, 51–85 Milchzähne).",
      "FDI-notatie: kwadrant en positie (11–48 blijvend, 51–85 melkgebit).",
      "Notation FDI : quadrant puis position (11–48 permanentes, 51–85 temporaires).",
    ],
  },
  enamel_note_tooth_chart: {
    en: "Current state of each tooth, from the findings log. Click a tooth for its history.",
    t: [
      "Aktueller Zustand jedes Zahns aus der Befundhistorie. Zahn anklicken für den Verlauf.",
      "Huidige staat van elke tand uit het bevindingenlogboek. Klik een tand voor de historie.",
      "État actuel de chaque dent, d'après l'historique des constats. Cliquez une dent pour son historique.",
    ],
  },
  enamel_note_reminder: {
    en: "Set by the reminder flow. Its presence is what stops a second send.",
    t: [
      "Wird vom Erinnerungs-Flow gesetzt. Ein gesetzter Wert verhindert den zweiten Versand.",
      "Wordt gezet door de herinnerings-flow. Een gevulde waarde voorkomt een tweede verzending.",
      "Renseigné par le flux de rappel. Sa présence empêche un second envoi.",
    ],
  },
  // --- section dividers ---
  enamel_div_practice:  { en: "Practice", t: ["Praxis", "Praktijk", "Cabinet"] },
  enamel_div_contact:   { en: "Contact", t: ["Kontakt", "Contact", "Coordonnées"] },
  enamel_div_identity:  { en: "Identity", t: ["Stammdaten", "Persoonsgegevens", "Identité"] },
  enamel_div_contact_fd:{ en: "Contact — front desk may read and write",
                          t: ["Kontakt — Rezeption darf lesen und schreiben",
                              "Contact — balie mag lezen en schrijven",
                              "Coordonnées — accessibles à l'accueil"] },
  enamel_div_clinical:  { en: "Clinical — withheld from front-desk policies",
                          t: ["Klinisch — für die Rezeption gesperrt",
                              "Klinisch — afgeschermd voor de balie",
                              "Clinique — masqué à l'accueil"] },
  enamel_div_chart:     { en: "Dental chart", t: ["Zahnschema", "Tandkaart", "Schéma dentaire"] },
  enamel_div_booking:   { en: "Booking", t: ["Terminbuchung", "Afspraak", "Réservation"] },
  enamel_div_reminders: { en: "Reminders", t: ["Erinnerungen", "Herinneringen", "Rappels"] },
  enamel_div_tooth:     { en: "Tooth", t: ["Zahn", "Tand", "Dent"] },
  enamel_div_outcome:   { en: "Outcome", t: ["Ergebnis", "Resultaat", "Résultat"] },
  enamel_div_dates:     { en: "Dates", t: ["Daten", "Datums", "Dates"] },
  enamel_div_amounts:   { en: "Amounts", t: ["Beträge", "Bedragen", "Montants"] },

  // --- remaining field notes ---
  enamel_note_amount: { en: "The line total. Quantity and unit price are what you worked it out from.",
    t: ["Zeilensumme. Menge und Einzelpreis sind die Grundlage dafür.",
        "Regeltotaal. Aantal en stukprijs zijn de basis daarvoor.",
        "Total de la ligne. La quantité et le prix unitaire en sont la base."] },
  enamel_note_slug: { en: "Used in URLs and invoice numbering.",
    t: ["Wird in URLs und Rechnungsnummern verwendet.",
        "Gebruikt in URL's en factuurnummering.",
        "Utilisé dans les URL et la numérotation des factures."] },
  enamel_note_timezone: { en: "Appointment reminders are scheduled against this.",
    t: ["Terminerinnerungen richten sich danach.",
        "Afspraakherinneringen worden hierop gepland.",
        "Les rappels de rendez-vous s'appuient dessus."] },
  enamel_note_dob: { en: "Drives paediatric vs adult tooth numbering.",
    t: ["Bestimmt Milchgebiss- oder Erwachsenen-Zahnschema.",
        "Bepaalt melkgebit- of volwassen tandnummering.",
        "Détermine la numérotation dentaire, temporaire ou permanente."] },
  enamel_note_reference: { en: "Human-friendly patient number, generated on create.",
    t: ["Lesbare Patientennummer, beim Anlegen vergeben.",
        "Leesbaar patiëntnummer, toegekend bij aanmaken.",
        "Numéro de patient lisible, attribué à la création."] },
  enamel_note_portal_user: { en: "Links this record to a login for the patient portal.",
    t: ["Verknüpft diesen Datensatz mit einem Portalzugang.",
        "Koppelt dit dossier aan een portaalaccount.",
        "Relie ce dossier à un accès au portail patient."] },
  enamel_note_appt_notes: { en: "Scheduling notes — not a clinical record.",
    t: ["Terminnotizen — keine klinische Dokumentation.",
        "Planningsnotities — geen klinisch dossier.",
        "Notes de planification — pas un dossier clinique."] },
  enamel_note_code: { en: "Practice or national procedure code.",
    t: ["Praxis- oder nationale Leistungsziffer.",
        "Praktijk- of landelijke verrichtingcode.",
        "Code d'acte, du cabinet ou national."] },
  enamel_note_duration: { en: "Default chair time when booking.",
    t: ["Standard-Behandlungszeit bei der Buchung.",
        "Standaard stoeltijd bij het inplannen.",
        "Temps au fauteuil par défaut."] },
  enamel_note_requires_tooth: { en: "Tooth-specific procedures must record an FDI number.",
    t: ["Zahnbezogene Leistungen erfordern eine FDI-Nummer.",
        "Tandspecifieke verrichtingen vereisen een FDI-nummer.",
        "Les actes liés à une dent exigent un numéro FDI."] },
  enamel_note_number: { en: "Generated per clinic on create.",
    t: ["Wird je Praxis beim Anlegen vergeben.",
        "Per praktijk toegekend bij aanmaken.",
        "Attribué par cabinet à la création."] },
  enamel_note_pdf: { en: "Rendered by the invoice flow when the status becomes Sent.",
    t: ["Wird vom Rechnungs-Flow erzeugt, sobald der Status Versendet ist.",
        "Wordt door de factuur-flow gemaakt zodra de status Verzonden is.",
        "Généré par le flux de facturation au passage au statut Envoyée."] },
  enamel_note_treatment_record: { en: "The work that produced this finding, if any.",
    t: ["Die Behandlung, aus der dieser Befund stammt, sofern vorhanden.",
        "De behandeling waaruit deze bevinding volgt, indien van toepassing.",
        "L'acte à l'origine de ce constat, le cas échéant."] },
  enamel_note_user_clinic: { en: "The practice this account belongs to. Every access policy filters on it.",
    t: ["Die Praxis dieses Kontos. Jede Zugriffsrichtlinie filtert danach.",
        "De praktijk van dit account. Elk toegangsbeleid filtert hierop.",
        "Le cabinet de ce compte. Toutes les règles d'accès filtrent dessus."] },

  // --- status and choice labels ---
  enamel_s_active:    { en: "Active", t: ["Aktiv", "Actief", "Actif"] },
  enamel_s_inactive:  { en: "Inactive", t: ["Inaktiv", "Inactief", "Inactif"] },
  enamel_s_archived:  { en: "Archived", t: ["Archiviert", "Gearchiveerd", "Archivé"] },
  enamel_s_scheduled: { en: "Scheduled", t: ["Geplant", "Gepland", "Planifié"] },
  enamel_s_confirmed: { en: "Confirmed", t: ["Bestätigt", "Bevestigd", "Confirmé"] },
  enamel_s_completed: { en: "Completed", t: ["Abgeschlossen", "Afgerond", "Terminé"] },
  enamel_s_cancelled: { en: "Cancelled", t: ["Abgesagt", "Geannuleerd", "Annulé"] },
  enamel_s_no_show:   { en: "No-show", t: ["Nicht erschienen", "Niet verschenen", "Absent"] },
  enamel_s_planned:   { en: "Planned", t: ["Geplant", "Gepland", "Planifié"] },
  enamel_s_draft:     { en: "Draft", t: ["Entwurf", "Concept", "Brouillon"] },
  enamel_s_sent:      { en: "Sent", t: ["Versendet", "Verzonden", "Envoyée"] },
  enamel_s_paid:      { en: "Paid", t: ["Bezahlt", "Betaald", "Payée"] },
  enamel_s_overdue:   { en: "Overdue", t: ["Überfällig", "Achterstallig", "En retard"] },
  enamel_s_void:      { en: "Void", t: ["Storniert", "Vervallen", "Annulée"] },

  enamel_note_subtotal: {
    en: "Recalculated from the lines by a flow.",
    t: [
      "Wird per Flow aus den Positionen neu berechnet.",
      "Wordt door een flow herberekend uit de regels.",
      "Recalculé à partir des lignes par un flux.",
    ],
  },
};
