import type { Collection } from "../types.js";
import { websiteClinicFields } from "./website.js";
import { pk, divider, timestamps } from "./_helpers.js";

/**
 * The practice itself — one row, and Directus enforces that.
 *
 * This was `clinics`, plural, and every other collection carried a
 * `clinic` column that policies filtered on. That made one installation
 * serve many practices, and it is gone: the product serves one.
 *
 * A singleton rather than a table with one row in it, because those are
 * different promises. A one-row table invites a second row, and the day
 * somebody adds one every query that assumed a single practice is
 * silently wrong. `singleton: true` makes the admin open the record
 * directly instead of a list, and there is no "create" button to press.
 *
 * The practice's name, address, hours, timezone, currency and branding
 * still have to live somewhere, and this is that somewhere — the public
 * website and every letterhead read it.
 */
export const practice: Collection = {
  collection: "practice",
  meta: {
    icon: "domain",
    note: "$t:enamel_note_practice",
    display_template: "{{name}}",
    sort: 1,
    singleton: true,
  },
  fields: [
    pk(),
    divider("$t:enamel_div_practice", "divider_practice", "domain"),
    {
      field: "name",
      type: "string",
      meta: { interface: "input", required: true, width: "half", options: { placeholder: "Kadehuis Dental" } },
      schema: { is_nullable: false },
    },
    {
      field: "slug",
      type: "string",
      meta: {
        // Not "extension-slug": that is a Marketplace interface this repo
        // does not ship, and Directus renders a missing interface as an
        // error card where the input should be. Core input plus a rule
        // that actually rejects a bad slug is worth more than a widget.
        interface: "input", special: ["cast-string"], width: "half",
        options: { trim: true, placeholder: "kadehuis-dental" },
        note: "$t:enamel_note_slug",
        validation: { slug: { _regex: "^[a-z0-9]+(-[a-z0-9]+)*$" } },
        validation_message: "$t:enamel_vm_slug",
      },
      schema: { is_unique: true },
    },
    {
      /**
       * Timezones, currencies and — further down — the patient's
       * preferred language are deliberately NOT translated. An IANA
       * identifier is the same string in every locale, a currency code is
       * an ISO 4217 code, and a language is shown in its own language
       * because that is who is reading it: "Nederlands" is more use to a
       * Dutch speaker than "Dutch" rendered in German.
       */
      field: "timezone",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        note: "$t:enamel_note_timezone",
        options: {
          allowOther: true,
          choices: [
            { text: "Europe/Amsterdam", value: "Europe/Amsterdam" },
            { text: "Europe/Berlin", value: "Europe/Berlin" },
            { text: "Europe/Lisbon", value: "Europe/Lisbon" },
            { text: "Europe/Istanbul", value: "Europe/Istanbul" },
            { text: "Asia/Dubai", value: "Asia/Dubai" },
            { text: "Asia/Kolkata", value: "Asia/Kolkata" },
            { text: "Asia/Bangkok", value: "Asia/Bangkok" },
            { text: "America/Mexico_City", value: "America/Mexico_City" },
            { text: "America/New_York", value: "America/New_York" },
          ],
        },
      },
      schema: { default_value: "Europe/Amsterdam" },
    },
    {
      field: "currency",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        options: {
          choices: [
            { text: "EUR (€)", value: "EUR" }, { text: "GBP (£)", value: "GBP" },
            { text: "USD ($)", value: "USD" }, { text: "AED (د.إ)", value: "AED" },
            { text: "INR (₹)", value: "INR" }, { text: "THB (฿)", value: "THB" },
          ],
        },
      },
      schema: { default_value: "EUR" },
    },
    divider("$t:enamel_div_contact", "divider_contact", "call"),
    {
      field: "email",
      type: "string",
      meta: {
        interface: "input", options: { iconLeft: "mail" }, width: "half",
        validation: { email: { _regex: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}$" } },
        validation_message: "$t:enamel_vm_email",
      },
      schema: {},
    },
    { field: "phone", type: "string", meta: { interface: "input", options: { iconLeft: "call" }, width: "half" }, schema: {} },
    { field: "address", type: "text", meta: { interface: "input-multiline", width: "full" }, schema: {} },
    { field: "city", type: "string", meta: { interface: "input", width: "half" }, schema: {} },
    { field: "country", type: "string", meta: { interface: "select-dropdown", width: "half", options: { allowOther: true, choices: [
      { text: "$t:enamel_co_nl", value: "NL" }, { text: "$t:enamel_co_de", value: "DE" }, { text: "$t:enamel_co_pt", value: "PT" },
      { text: "$t:enamel_co_tr", value: "TR" }, { text: "$t:enamel_co_ae", value: "AE" }, { text: "$t:enamel_co_in", value: "IN" },
    ] } }, schema: {} },
    divider("$t:enamel_div_clinic_theme", "divider_clinic_theme", "palette"),
    {
      /**
       * One colour, and the site derives the rest.
       *
       * The obvious design is to let a practice set primary, accent, ink
       * and surface. That is also how you get an unreadable site: the
       * first practice to pick a pale gold as their ink, or to set a
       * surface that collides with their accent, ships a page nobody can
       * read and nobody on the practice's side will know why.
       *
       * So the practice chooses the thing that is actually theirs — the
       * brand colour — and everything else is computed from it, including
       * whether text on top of it is black or white. See `readableOn` in
       * the patient site. A theme system that cannot produce an
       * inaccessible result is worth more than one that can express
       * anything.
       *
       * Deliberately separate from `directus_settings`, which is the
       * *staff admin's* branding. A practice may well want a public site
       * that looks nothing like the back office, and conflating the two
       * means changing one to fix the other.
       */
      field: "theme_primary",
      type: "string",
      meta: {
        interface: "select-color",
        width: "half",
        note: "$t:enamel_note_theme_primary",
      },
      schema: {},
    },
    {
      field: "theme_logo",
      type: "uuid",
      meta: {
        interface: "file-image",
        special: ["file"],
        width: "half",
        note: "$t:enamel_note_theme_logo",
      },
      schema: {},
    },
    ...websiteClinicFields,
    ...timestamps(),
  ],
  relations: [
    {
      collection: "practice",
      field: "hero_image",
      related_collection: "directus_files",
      meta: {},
      schema: { on_delete: "SET NULL" },
    },
    {
      collection: "practice",
      field: "theme_logo",
      related_collection: "directus_files",
      meta: {},
      schema: { on_delete: "SET NULL" },
    },
  ],
};

export const rooms: Collection = {
  collection: "rooms",
  meta: {
    icon: "chair",
    note: "$t:enamel_note_rooms",
    display_template: "{{name}}",
    sort: 2,
    group: "clinical",
  },
  fields: [
    pk(),
    {
      field: "name",
      type: "string",
      meta: { interface: "input", required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      field: "chair_number",
      type: "integer",
      meta: { interface: "input", width: "half" },
      schema: {},
    },
    {
      field: "active",
      type: "boolean",
      meta: { interface: "boolean", width: "half" },
      schema: { default_value: true },
    },
    ...timestamps(),
  ],
  relations: [
  ],
};
