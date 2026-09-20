import { z } from "zod";

/**
 * One schema per form, used on both sides of the wire.
 *
 * Before this the site layer validated almost nothing: it read
 * `formData`, checked that two passwords matched, and forwarded the rest.
 * The deep layers were sound — the core service, Directus field rules and
 * Postgres constraints all check properly — so nothing *unsafe* got
 * through. What got through was a bad experience: one error string for
 * the whole form, no idea which field was wrong, and every value cleared
 * on a failed submit so a patient on a phone retyped the lot.
 *
 * These schemas are the single definition. The action parses with them,
 * the fields derive their `required`/`minlength`/`type` hints from them,
 * and the messages are written to be read by a person rather than by a
 * developer — "We need your date of birth to match you to your records"
 * rather than "date_of_birth: Required".
 */

/** Trim before anything else: " ada@example.com " is a valid address. */
const trimmed = z.string().trim();

export const emailField = trimmed
  .min(1, "Enter your email address.")
  .email("That does not look like an email address.");

/**
 * Long, not complex.
 *
 * A length rule is the one that actually helps. Complexity rules mostly
 * produce `Password1!`, and NIST has recommended against them for years.
 */
export const passwordField = trimmed
  .min(12, "Use at least 12 characters — a short phrase works well.")
  .max(200, "That is longer than we can store.");

export const loginSchema = z.object({
  email: emailField,
  password: trimmed.min(1, "Enter your password."),
});

export const registerSchema = z
  .object({
    first_name: trimmed.min(1, "Enter your first name.").max(60),
    last_name: trimmed.min(1, "Enter your last name.").max(60),
    date_of_birth: trimmed
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter your date of birth.")
      .refine((v) => new Date(v) <= new Date(), "That date is in the future.")
      .refine(
        (v) => new Date(v) >= new Date("1900-01-01"),
        "Check the year — that is before 1900.",
      ),
    email: emailField,
    password: passwordField,
    confirm: trimmed.min(1, "Type your password again."),
  })
  // On `confirm`, not on the object, so the message lands on the field
  // the person has to change rather than at the top of the form.
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "The two passwords do not match.",
  });

export const profileSchema = z.object({
  email: emailField,
  phone: trimmed
    .max(40)
    // Deliberately permissive. A phone number the practice can ring is
    // one a human wrote down; refusing "0207 946 0111 (work)" because it
    // is not E.164 helps nobody. The messaging adapters do the strict
    // check at send time, where being wrong is visible.
    .optional()
    .or(z.literal("")),
  address: trimmed.max(400).optional().or(z.literal("")),
  preferred_language: z.enum(["en-GB", "de-DE", "nl-NL", "fr-FR"]),
  allow_email: z.coerce.boolean(),
  allow_sms: z.coerce.boolean(),
  allow_whatsapp: z.coerce.boolean(),
});

export const passwordChangeSchema = z
  .object({
    current: trimmed.min(1, "Enter your current password."),
    next: passwordField,
    confirm: trimmed.min(1, "Type the new password again."),
  })
  .refine((v) => v.next === v.confirm, {
    path: ["confirm"],
    message: "The two passwords do not match.",
  })
  .refine((v) => v.next !== v.current, {
    path: ["next"],
    message: "Choose a different password from the current one.",
  });

/** Field name → the first message for it. */
export type FieldErrors = Record<string, string>;

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldErrors; values: Record<string, string> };

/**
 * Parse a submitted form, and keep what was typed.
 *
 * Returning the raw values alongside the errors is what lets a failed
 * submit re-render with the fields still filled in. Passwords are
 * deliberately excluded from that — echoing one back into the HTML puts
 * it in the page source, in the browser's back-forward cache, and in any
 * proxy log along the way.
 */
export function parseForm<T extends z.ZodTypeAny>(
  schema: T,
  form: FormData,
): Parsed<z.infer<T>> {
  const raw: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") raw[key] = value;
  }

  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };

  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "form");
    // First message per field. A person fixes one thing at a time, and
    // three stacked messages on one input is noise.
    if (!errors[field]) errors[field] = issue.message;
  }

  const values = { ...raw };
  for (const secret of ["password", "confirm", "current", "next"]) delete values[secret];

  return { ok: false, errors, values };
}

/**
 * Is this request coming from our own page?
 *
 * The session cookie is `sameSite: lax`, which already stops a
 * cross-site form POST carrying it. That is a real control and it is one
 * layer — an older browser, or a future change to `sameSite`, and it is
 * the only thing standing there.
 *
 * An Origin check is the cheap second layer. A token would be stronger
 * still and needs somewhere to keep it, which for a stateless cookie
 * session means either a second cookie or a server-side store; for a
 * site whose actions are "book", "cancel" and "change my phone number",
 * the origin check is the proportionate answer and the reasoning is
 * written down rather than assumed.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Some browsers omit Origin on same-origin form posts; fall back to
  // Referer, and treat neither-present as suspicious for a mutation.
  const source = origin ?? request.headers.get("referer");
  if (!source) return false;
  try {
    return new URL(source).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * Check one field, on its own, against the same schema the action uses.
 *
 * The point is that it is the *same* schema. A second copy of the rules
 * written for the browser is a second copy that drifts, and the way you
 * find out is a patient being told their password is fine and then told
 * it is not — which is worse than no client-side checking at all,
 * because it teaches them not to trust the form.
 *
 * Returns `undefined` when the field is acceptable, or when the schema
 * has nothing to say about it. Errors about *other* fields are ignored:
 * checking `email` must not report that `password` is missing, because
 * the person has not reached it yet.
 */
export function checkField<T extends z.ZodTypeAny>(
  schema: T,
  name: string,
  value: string,
  all: Record<string, string> = {},
): string | undefined {
  const result = schema.safeParse({ ...all, [name]: value });
  if (result.success) return undefined;
  for (const issue of result.error.issues) {
    if (String(issue.path[0] ?? "") === name) return issue.message;
  }
  return undefined;
}
