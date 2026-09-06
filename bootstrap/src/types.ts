/**
 * A small declarative layer over the Directus API.
 *
 * The alternative is committing a `schema snapshot` blob, but nobody can
 * read one — and this repo exists to be read. Everything below describes
 * intent; `apply.ts` turns it into API calls and is idempotent, so
 * re-running only ever fills in what's missing.
 */

export type FieldType =
  | "uuid" | "string" | "text" | "integer" | "bigInteger" | "float"
  | "decimal" | "boolean" | "date" | "time" | "timestamp" | "json" | "csv"
  /** Presentation-only: dividers and the tooth chart hold no column. */
  | "alias";

export type Field = {
  field: string;
  type: FieldType;
  /** Directus field metadata: interface, display, validation, layout. */
  meta?: Record<string, unknown>;
  /** Database column options: nullable, default, unique, primary key. */
  schema?: Record<string, unknown> | null;
};

export type Relation = {
  /** Collection holding the foreign key. */
  collection: string;
  field: string;
  related_collection: string;
  meta?: Record<string, unknown>;
  schema?: Record<string, unknown>;
};

export type Collection = {
  collection: string;
  meta: {
    icon?: string;
    note?: string;
    color?: string;
    sort?: number;
    group?: string | null;
    hidden?: boolean;
    singleton?: boolean;
    archive_field?: string;
    archive_value?: string;
    unarchive_value?: string;
    sort_field?: string;
    display_template?: string;
    [k: string]: unknown;
  };
  schema?: Record<string, unknown>;
  fields: Field[];
  relations?: Relation[];
};

/** A Directus 11+ policy: the unit permissions actually attach to. */
export type Policy = {
  name: string;
  icon: string;
  description: string;
  app_access: boolean;
  admin_access?: boolean;
  enforce_tfa?: boolean;
  permissions: Permission[];
};

export type Permission = {
  collection: string;
  action: "create" | "read" | "update" | "delete" | "share";
  /** Row-level filter. `$CURRENT_USER` and `$CURRENT_POLICIES` resolve at request time. */
  permissions?: Record<string, unknown> | null;
  /** Validation applied to incoming payloads on create/update. */
  validation?: Record<string, unknown> | null;
  /** Field-level access. `["*"]` is everything; list fields to restrict. */
  fields?: string[];
  presets?: Record<string, unknown> | null;
};

export type Role = {
  name: string;
  icon: string;
  description: string;
  /** Policy names, resolved to ids at apply time. */
  policies: string[];
};

/** A saved view. `role: null` makes it a global bookmark for everyone. */
export type Preset = {
  bookmark: string | null;
  collection: string;
  role?: string | null;
  icon?: string;
  color?: string;
  layout?: string;
  layout_query?: Record<string, unknown>;
  layout_options?: Record<string, unknown>;
  filter?: Record<string, unknown> | null;
  search?: string | null;
};
