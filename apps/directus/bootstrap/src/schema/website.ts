import type { Collection, Field } from "../types.js";
import { pk, timestamps, divider } from "./_helpers.js";

/**
 * The practice's public website, as content the practice owns.
 *
 * Deliberately **not** a generic page builder. A CMS with a block editor
 * is a different product, and a dental practice that is handed one
 * produces a website nobody maintains. What a practice actually needs to
 * keep current is a short list: what treatments they offer, who works
 * there, when they are open, and the questions people ring up to ask.
 * Four shapes, each with a form a receptionist can fill in.
 *
 * Opening hours are already `clinic_hours` — the same rows the scheduling
 * engine refuses bookings against. A website that publishes hours from a
 * second table is a website that will eventually disagree with the diary.
 */

export const services: Collection = {
  collection: "services",
  meta: {
    icon: "medical_services",
    note: "$t:enamel_note_services",
    display_template: "{{name}}",
    sort: 1,
    group: "website",
    archive_field: "published",
    archive_value: "false",
    unarchive_value: "true",
    sort_field: "sort",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "name",
      type: "string",
      meta: { interface: "input", required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      field: "slug",
      type: "string",
      meta: {
        interface: "input", required: true, width: "half",
        note: "$t:enamel_note_slug",
        validation: { slug: { _regex: "^[a-z0-9]+(-[a-z0-9]+)*$" } },
        validation_message: "$t:enamel_vm_slug",
      },
      schema: { is_nullable: false },
    },
    {
      field: "summary",
      type: "text",
      meta: {
        interface: "input-multiline", required: true,
        note: "$t:enamel_note_service_summary",
      },
      schema: { is_nullable: false },
    },
    {
      field: "body",
      type: "text",
      meta: { interface: "input-rich-text-md", note: "$t:enamel_note_service_body" },
      schema: {},
    },
    {
      /**
       * Optional, and optional on purpose.
       *
       * `treatments` is the internal catalogue with the price the
       * practice actually charges. A website service is the thing a
       * patient recognises — "root canal treatment" covers four
       * catalogue entries — so the two are not the same list. Linking one
       * is useful when they happen to coincide; requiring it would force
       * the website to be shaped like the billing system.
       */
      field: "treatment",
      type: "uuid",
      meta: {
        interface: "select-dropdown-m2o", special: ["m2o"], width: "half",
        options: { template: "{{code}} — {{name}}" },
        note: "$t:enamel_note_service_treatment",
      },
      schema: {},
    },
    {
      field: "price_from",
      type: "decimal",
      meta: {
        interface: "input", width: "half",
        note: "$t:enamel_note_price_from",
      },
      schema: { numeric_precision: 10, numeric_scale: 2 },
    },
    {
      /**
       * The picture, when the practice has one.
       *
       * Nullable on purpose, and every page is designed to look finished
       * without it. A website that falls apart until somebody uploads a
       * photograph is a website a practice cannot launch, and the first
       * thing a practice does not have on the day it goes live is
       * photographs.
       *
       * Rendered through `/brand/:id` rather than `/assets/:id`: the
       * asset endpoint is anonymous and the Website token is the only
       * credential allowed to read these, so the site proxies them. That
       * is also what keeps a visitor from walking the file library by
       * guessing ids.
       */
      field: "image",
      type: "uuid",
      meta: {
        interface: "file-image", special: ["file"], width: "half",
        note: "$t:enamel_note_web_image",
      },
      schema: {},
    },
    {
      field: "published",
      type: "boolean",
      meta: { interface: "boolean", width: "half", note: "$t:enamel_note_published" },
      schema: { default_value: false },
    },
    { field: "sort", type: "integer", meta: { interface: "input", hidden: true }, schema: {} },
    ...timestamps(),
  ],
  relations: [
    { collection: "services", field: "treatment", related_collection: "treatments", meta: {}, schema: { on_delete: "SET NULL" } },
    { collection: "services", field: "image", related_collection: "directus_files", meta: {}, schema: { on_delete: "SET NULL" } },
  ],
};

export const faqs: Collection = {
  collection: "faqs",
  meta: {
    icon: "help_center",
    note: "$t:enamel_note_faqs",
    display_template: "{{question}}",
    sort: 2,
    group: "website",
    archive_field: "published",
    archive_value: "false",
    unarchive_value: "true",
    sort_field: "sort",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "question",
      type: "string",
      meta: { interface: "input", required: true },
      schema: { is_nullable: false },
    },
    {
      field: "answer",
      type: "text",
      meta: { interface: "input-multiline", required: true },
      schema: { is_nullable: false },
    },
    {
      field: "published",
      type: "boolean",
      meta: { interface: "boolean", width: "half", note: "$t:enamel_note_published" },
      schema: { default_value: false },
    },
    { field: "sort", type: "integer", meta: { interface: "input", hidden: true }, schema: {} },
    ...timestamps(),
  ],
  relations: [
  ],
};

/**
 * A clinician's public profile, on the user record rather than in a
 * separate `team` table.
 *
 * The alternative is a `team_members` collection, and it is the wrong
 * shape: the practice would then hold two records for the same person,
 * and the website would eventually list somebody who left. These are
 * fields on the person who already exists, and `public_profile` is the
 * one switch that decides whether they appear.
 *
 * Opt-in, default off. A clinician's name and photograph on a public
 * website is their decision, not the practice's.
 */
export const publicProfileFields: Field[] = [
  {
    field: "public_profile",
    type: "boolean",
    meta: {
      interface: "boolean",
      width: "half",
      group: null,
      note: "$t:enamel_note_public_profile",
    },
    schema: { default_value: false },
  },
  {
    /**
     * A portrait, for the people page.
     *
     * Opt-in like the profile itself — a clinician who has agreed to be
     * named has not agreed to be photographed, and the two are separate
     * decisions a practice should be able to record separately.
     */
    field: "public_photo",
    type: "uuid",
    meta: {
      interface: "file-image", special: ["file"], width: "half",
      note: "$t:enamel_note_public_photo",
    },
    schema: {},
  },
  {
    field: "public_bio",
    type: "text",
    meta: {
      interface: "input-multiline",
      group: null,
      note: "$t:enamel_note_public_bio",
    },
    schema: {},
  },
  {
    field: "public_sort",
    type: "integer",
    meta: { interface: "input", width: "half", group: null, hidden: true },
    schema: {},
  },
];

/**
 * What a practice says about itself on its own front page, and the
 * domain that front page answers on.
 */
export const websiteClinicFields: Field[] = [
  divider("$t:enamel_div_clinic_website", "divider_clinic_website", "public"),
  {
    /**
     * The photograph across the top of the front page.
     *
     * One image, and the page is composed to work without it: a practice
     * that has not taken photographs yet still gets a finished-looking
     * website, and the day it has one the change is an upload rather than
     * a deployment.
     */
    field: "hero_image",
    type: "uuid",
    meta: {
      interface: "file-image", special: ["file"], width: "half",
      note: "$t:enamel_note_hero_image",
    },
    schema: {},
  },

  {
    /**
     * The host this practice's website answers on.
     *
     * How a multi-tenant site knows which practice a visitor came for.
     * Locally there is one host, so the path is used instead — see
     * `clinicFromRequest` in the patient site. Both resolve to the same
     * thing, which is why the site works on a laptop and on a domain
     * without a second code path.
     */
    field: "website_domain",
    type: "string",
    meta: {
      interface: "input", width: "half",
      note: "$t:enamel_note_website_domain",
      options: { placeholder: "kadehuis.example.com" },
    },
    schema: {},
  },
  {
    field: "strapline",
    type: "string",
    meta: {
      interface: "input", width: "half",
      note: "$t:enamel_note_strapline",
      options: { placeholder: "$t:enamel_ph_tagline" },
    },
    schema: {},
  },
  {
    field: "intro",
    type: "text",
    meta: { interface: "input-multiline", note: "$t:enamel_note_intro" },
    schema: {},
  },
  {
    /**
     * The line under the telephone number in the masthead strip.
     *
     * It was "Same-day for pain where we can", written into the React
     * file — a promise about how this practice runs its diary, hardcoded
     * where the practice could not reach it. Either it is true and they
     * should be able to word it themselves, or it is not and they need
     * to take it down without waiting for a deploy.
     *
     * Optional, and the strip closes up without it rather than leaving a
     * gap, so a practice that makes no such promise simply makes none.
     */
    field: "phone_note",
    type: "string",
    meta: {
      interface: "input", width: "half",
      note: "$t:enamel_note_phone_note",
      options: { placeholder: "$t:enamel_ph_phone_note" },
    },
    schema: {},
  },
];


/**
 * Pages the practice writes itself.
 *
 * The website had six routes and every one of them was a React file:
 * adding a terms page, a complaints procedure or an accessibility
 * statement meant a deployment. For a practice that cannot deploy, that
 * is the same as not being able to add a page at all — and those three
 * are exactly the pages a dental practice is obliged to publish.
 *
 * So this is the escape hatch, and it is deliberately dull: a slug, a
 * title, a body and a switch that decides whether it is published.
 * `/pages/:slug` renders it, and `nav` decides whether the header and
 * footer link to it.
 *
 * It does **not** replace the designed routes. A home page that reads
 * the opening hours and says whether the practice is open right now is
 * not a rich-text field, and turning it into one to be consistent would
 * make the site worse. Anything with logic stays a route; everything
 * that is genuinely prose lives here.
 */
export const pages: Collection = {
  collection: "pages",
  meta: {
    icon: "article",
    note: "$t:enamel_note_pages",
    display_template: "{{title}}",
    sort: 3,
    group: "website",
    archive_field: "status",
    archive_value: "archived",
    unarchive_value: "draft",
    sort_field: "sort",
  },
  schema: {},
  fields: [
    pk(),
    {
      field: "title",
      type: "string",
      meta: { interface: "input", required: true, width: "half" },
      schema: { is_nullable: false },
    },
    {
      /**
       * The address. Unique, because two pages answering on one URL is a
       * coin toss, and validated to the same shape as everywhere else in
       * this schema so a title typed straight in cannot produce
       * `/pages/Terms%20%26%20Conditions`.
       */
      field: "slug",
      type: "string",
      meta: {
        interface: "input", required: true, width: "half",
        note: "$t:enamel_note_page_slug",
        options: { trim: true, placeholder: "terms" },
        validation: { slug: { _regex: "^[a-z0-9]+(-[a-z0-9]+)*$" } },
        validation_message: "$t:enamel_vm_slug",
      },
      schema: { is_nullable: false, is_unique: true },
    },
    {
      field: "status",
      type: "string",
      meta: {
        interface: "select-dropdown", required: true, width: "half", display: "labels",
        options: {
          choices: [
            { text: "$t:enamel_ps_published", value: "published", color: "#2ECDA7" },
            { text: "$t:enamel_ps_draft", value: "draft", color: "#FFC23B" },
            { text: "$t:enamel_ps_archived", value: "archived", color: "#A2B5CD" },
          ],
        },
        note: "$t:enamel_note_page_status",
      },
      schema: { default_value: "draft", is_nullable: false },
    },
    {
      /**
       * Whether the site links to it, which is separate from whether it
       * exists. A privacy notice has to be reachable and does not belong
       * in the header; a terms page linked from the footer is not the
       * same as one linked from the navigation.
       */
      field: "nav",
      type: "string",
      meta: {
        interface: "select-dropdown", width: "half",
        options: {
          choices: [
            { text: "$t:enamel_nav_none", value: "none" },
            { text: "$t:enamel_nav_header", value: "header" },
            { text: "$t:enamel_nav_footer", value: "footer" },
            { text: "$t:enamel_nav_both", value: "both" },
          ],
        },
        note: "$t:enamel_note_page_nav",
      },
      schema: { default_value: "footer" },
    },
    { field: "sort", type: "integer", meta: { interface: "input", hidden: true }, schema: {} },
    {
      field: "summary",
      type: "text",
      meta: { interface: "input-multiline", note: "$t:enamel_note_page_summary" },
      schema: {},
    },
    {
      field: "body",
      type: "text",
      meta: { interface: "input-rich-text-md", required: true, note: "$t:enamel_note_page_body" },
      schema: { is_nullable: false },
    },
    ...timestamps(),
  ],
  relations: [],
};

export const websiteCollections = [services, faqs, pages];
