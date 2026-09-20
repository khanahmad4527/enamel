import { Form, data, useNavigation } from "react-router";
import type { Route } from "./+types/portal.profile";
import { api, ApiError, type Env } from "~/lib/api.server";
import { requireToken, sessions } from "~/lib/session.server";
import { parseForm, profileSchema, sameOrigin, type FieldErrors } from "~/lib/schema";
import { Announce, ErrorSummary, Field } from "~/components/form";
import { usePatient, usePractice } from "./portal";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Your details · Enamel patient area" }];
}

type Result = { errors: FieldErrors; values: Record<string, string>; saved: boolean };

const LANGUAGES: Array<[string, string]> = [
  ["en-GB", "English"],
  ["nl-NL", "Nederlands"],
  ["de-DE", "Deutsch"],
  ["fr-FR", "Français"],
];

/**
 * The patient's own details, and their consent.
 *
 * Every field here was already writable by the Patient policy — contact
 * details, address, preferred language and the three consent booleans.
 * Only the page was missing, which meant a patient could *see* that the
 * practice held permission to text them and had no way to withdraw it.
 * A portal that displays a preference it will not let you change is
 * worse than one that never mentions it.
 *
 * Password change is deliberately **not** here. `PATCH /users/me` is 403
 * for the Patient policy, and widening that is a decision with a real
 * question attached — Directus does not require the current password, so
 * doing it properly means re-authenticating first. Written up in
 * docs/NEXT.md rather than half-built.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const storage = sessions(env);
  const session = await storage.getSession(request.headers.get("cookie"));
  await requireToken(session, env.DIRECTUS_URL, storage);
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.env as unknown as Env;
  const fail = (errors: FieldErrors, values: Record<string, string> = {}, status = 400) =>
    data<Result>({ errors, values, saved: false }, { status });

  if (!sameOrigin(request)) {
    return fail({ form: "That request did not come from this site." }, {}, 403);
  }

  const storage = sessions(env);
  const session = await storage.getSession(request.headers.get("cookie"));
  const token = await requireToken(session, env.DIRECTUS_URL, storage);

  const form = await request.formData();
  // Unchecked boxes are absent from a form body entirely, so an untouched
  // consent toggle would parse as "missing" rather than as "no". Normalise
  // before the schema sees it, or turning a consent off would silently do
  // nothing.
  for (const box of ["allow_email", "allow_sms", "allow_whatsapp"]) {
    if (!form.has(box)) form.set(box, "");
  }
  const parsed = parseForm(profileSchema, form);
  if (!parsed.ok) return fail(parsed.errors, parsed.values);

  const record = await api.record(env, token.access);
  if (!record) return fail({ form: "This login is not linked to a patient record yet." });

  try {
    await api.updateRecord(env, token.access, {
      email: parsed.value.email.toLowerCase(),
      phone: parsed.value.phone || null,
      address: parsed.value.address || null,
      preferred_language: parsed.value.preferred_language,
      allow_email: parsed.value.allow_email,
      allow_sms: parsed.value.allow_sms,
      allow_whatsapp: parsed.value.allow_whatsapp,
    }, record.id);
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not save that.";
    return fail({ [/email/i.test(message) ? "email" : "form"]: message }, {
      email: parsed.value.email,
      phone: parsed.value.phone ?? "",
      address: parsed.value.address ?? "",
      preferred_language: parsed.value.preferred_language,
    });
  }

  return data<Result>({ errors: {}, values: {}, saved: true });
}

const ORDER = ["form", "email", "phone", "address", "preferred_language"];

export default function Profile({ actionData }: Route.ComponentProps) {
  const patient = usePatient();
  const practice = usePractice();
  const busy = useNavigation().state === "submitting";
  const errors = actionData?.errors ?? {};
  const v = actionData?.values ?? {};
  const or = (key: string, fallback: string | null) => v[key] ?? fallback ?? "";

  return (
    <main className="shell" id="main">
      <div className="stack stack--loose">
        <header>
          <p className="eyebrow">{practice?.name ?? "Your practice"}</p>
          <h1 className="h1">Your details</h1>
          <p className="lede">
            How the practice reaches you, and what you have agreed they may use. Your name
            and date of birth are part of your clinical record — ring the practice to change
            those.
          </p>
        </header>

        <Form method="post" className="stack" noValidate>
          <ErrorSummary errors={errors} order={ORDER} />
          {errors["form"] ? <Announce tone="bad">{errors["form"]}</Announce> : null}
          {actionData?.saved ? <Announce>Your details have been saved.</Announce> : null}

          <section className="feature feature--own stack">
            <h2 className="h3">Getting in touch</h2>

            <Field name="email" label="Email address" required error={errors["email"]}>
              {(f) => (
                <input {...f} type="email" autoComplete="email" inputMode="email"
                       defaultValue={or("email", patient.email)} />
              )}
            </Field>

            <Field name="phone" label="Mobile number" error={errors["phone"]}
                   hint="Needed if you want appointment reminders by text.">
              {(f) => (
                <input {...f} type="tel" autoComplete="tel" inputMode="tel"
                       defaultValue={or("phone", patient.phone)} />
              )}
            </Field>

            <Field name="address" label="Address" error={errors["address"]}>
              {(f) => (
                <textarea {...f} autoComplete="street-address"
                          defaultValue={or("address", patient.address)} />
              )}
            </Field>

            <Field name="preferred_language" label="Preferred language"
                   error={errors["preferred_language"]}
                   hint="Used for letters and reminders the practice sends you.">
              {(f) => (
                <select {...f} defaultValue={or("preferred_language", "en-GB") || "en-GB"}>
                  {LANGUAGES.map(([code, label]) => (
                    <option key={code} value={code}>{label}</option>
                  ))}
                </select>
              )}
            </Field>
          </section>

          <section className="panel stack stack--tight">
            <h2 className="h2">How we may contact you</h2>
            <p className="hint" style={{ marginTop: 0 }}>
              You can change these at any time, and turning one off takes effect
              immediately. Anything urgent about your treatment, the practice will ring you
              about regardless.
            </p>

            <div className="check">
              <input type="checkbox" id="f-allow_email" name="allow_email" value="on"
                     defaultChecked={patient.allow_email} />
              <div>
                <label htmlFor="f-allow_email">Email</label>
                <p className="hint">Appointment confirmations, reminders and letters.</p>
              </div>
            </div>

            <div className="check">
              <input type="checkbox" id="f-allow_sms" name="allow_sms" value="on"
                     defaultChecked={patient.allow_sms} />
              <div>
                <label htmlFor="f-allow_sms">Text message</label>
                <p className="hint">Short reminders the day before. Needs a mobile number above.</p>
              </div>
            </div>

            <div className="check">
              <input type="checkbox" id="f-allow_whatsapp" name="allow_whatsapp" value="on"
                     defaultChecked={patient.allow_whatsapp} />
              <div>
                <label htmlFor="f-allow_whatsapp">WhatsApp</label>
                <p className="hint">The same reminders, if you would rather have them there.</p>
              </div>
            </div>
          </section>

          <div className="row">
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </Form>

        <section className="panel">
          <h2 className="h2">Your password</h2>
          <p className="lede">
            Changing your password is not available here yet. Ring the practice and they
            will reset it for you.
          </p>
        </section>
      </div>
    </main>
  );
}
