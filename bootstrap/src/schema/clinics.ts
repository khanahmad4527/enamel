import type { Collection } from "../types.js";
import { pk, timestamps, status, clinicRef, divider } from "./_helpers.js";

export const clinics: Collection = {
  collection: "clinics",
  meta: {
    icon: "domain",
    note: "Practices on this instance. Every other collection is scoped to one.",
    color: "#0D6E63",
    display_template: "{{name}}",
    sort: 1,
    archive_field: "status",
    archive_value: "archived",
    unarchive_value: "active",
  },
  fields: [
    pk(),
    divider("$t:enamel_div_practice", "divider_practice", "domain"),
    {
      field: "name",
      type: "string",
      meta: { interface: "input", required: true, width: "half", options: { placeholder: "Riverside Dental" } },
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
        options: { trim: true, placeholder: "riverside-dental" },
        note: "$t:enamel_note_slug",
        validation: { slug: { _regex: "^[a-z0-9]+(-[a-z0-9]+)*$" } },
        validation_message: "$t:enamel_vm_slug",
      },
      schema: { is_unique: true },
    },
    status(
      [
        { text: "$t:enamel_s_active", value: "active", color: "#2ECDA7" },
        { text: "$t:enamel_s_archived", value: "archived", color: "#A2B5CD" },
      ],
      "active",
    ),
    {
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
      { text: "Netherlands", value: "NL" }, { text: "Germany", value: "DE" }, { text: "Portugal", value: "PT" },
      { text: "Türkiye", value: "TR" }, { text: "UAE", value: "AE" }, { text: "India", value: "IN" },
    ] } }, schema: {} },
    ...timestamps(),
  ],
};

export const rooms: Collection = {
  collection: "rooms",
  meta: {
    icon: "chair",
    note: "Treatment rooms. Appointments book a practitioner and a room.",
    color: "#0D6E63",
    display_template: "{{name}}",
    sort: 2,
    group: "clinical",
  },
  fields: [
    pk(),
    clinicRef(),
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
    {
      collection: "rooms",
      field: "clinic",
      related_collection: "clinics",
      meta: { sort_field: null },
      schema: { on_delete: "CASCADE" },
    },
  ],
};
