import { Form, Link, data, useNavigation } from "react-router";
import type { Route } from "./+types/register";
import { api, ApiError, clientAddress, type Env } from "~/lib/api.server";
import { parseForm, registerSchema, sameOrigin, type FieldErrors , checkField} from "~/lib/schema";
import { Announce, ErrorSummary, Field, Secret, useLiveErrors } from "~/components/form";
import { practiceOrNull } from "~/lib/site.server";
import { themeFor } from "~/lib/theme";
import { NOINDEX } from "~/lib/seo";

export function meta({ data }: Route.MetaArgs) {
  return [
    { title: data?.practice ? `Register with ${data.practice}` : "Create an account · Enamel patient area" },
    NOINDEX,
  ];
}

type Result = {
  errors: FieldErrors;
  values: Record<string, string>;
  done: boolean;
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  // On a practice's own domain their name is already the answer to "your
  // practice", so the field opens on it. Still a field rather than a
  // hidden input: somebody who has landed on the wrong practice's site
  // must be able to say so, and a value they cannot see is a value they
  // cannot correct.
  const host = await practiceOrNull(env);
  try {
    return {
      reachable: true,
      practice: host?.name ?? null,
      primary: host?.theme_primary ?? null,
    };
  } catch {
    return {
      reachable: false,
      practice: host?.name ?? null,
      primary: host?.theme_primary ?? null,
    };
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.env as unknown as Env;
  const fail = (errors: FieldErrors, values: Record<string, string> = {}, status = 400) =>
    data<Result>({ errors, values, done: false }, { status });

  if (!sameOrigin(request)) {
    return fail({ form: "That request did not come from this site." }, {}, 403);
  }

  const form = await request.formData();
  const parsed = parseForm(registerSchema, form);
  if (!parsed.ok) return fail(parsed.errors, parsed.values);

  const v = parsed.value;
  try {
    await api.register(env, {
      email: v.email.toLowerCase(),
      password: v.password,
      first_name: v.first_name,
      last_name: v.last_name,
      date_of_birth: v.date_of_birth,
    }, clientAddress(request));
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not create that account.";
    // Put the message on the field it is about where the service names
    // one; a "that does not look like an email address" floating at the
    // top of the form is an instruction with no target.
    const field = /email|address/i.test(message) ? "email"
      : /password/i.test(message) ? "password"
      : /birth/i.test(message) ? "date_of_birth"
      : "form";
    // Re-render with what they typed, minus the secrets. `parsed` is the
    // success branch here, so the values come off the parsed object
    // rather than the failure one.
    const { password: _p, confirm: _c, ...keep } = v;
    return fail({ [field]: message }, keep as Record<string, string>);
  }

  return data<Result>({ errors: {}, values: {}, done: true });
}

const ORDER = ["form", "first_name", "last_name", "date_of_birth", "email", "password", "confirm"];

export default function Register({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state === "submitting";
  const live = useLiveErrors(registerSchema, checkField, actionData?.errors ?? {});
  const errors = live.errors;
  const values = actionData?.values ?? {};
  const theme = themeFor(loaderData?.primary) as React.CSSProperties;

  if (actionData?.done) {
    return (
      <main className="shell shell--narrow themed" id="main" style={theme}>
        <div className="stack stack--loose">
          <header>
            <p className="eyebrow">Enamel patient area</p>
            <h1 className="h1">Check your details with the practice</h1>
          </header>
          <div className="feature feature--own stack stack--tight">
            <p style={{ margin: 0 }}>
              Your account has been created. The practice will match it to the records they
              already hold before your history appears — until then you can sign in, and you
              may see very little.
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              If you are already a patient there, ring the practice and ask them to link the
              two. We deliberately do not do that automatically: matching a stranger to an
              existing file on an email address and a birthday is how the wrong person ends
              up reading somebody's notes.
            </p>
          </div>
          <div className="row">
            <Link className="btn btn--primary" to="/login">Sign in</Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="shell shell--narrow themed" id="main" style={theme}>
      <div className="stack stack--loose">
        <header>
          <p className="eyebrow">
            {loaderData.practice ? `${loaderData.practice} · patient area` : "Enamel patient area"}
          </p>
          <h1 className="h1">Create an account</h1>
          <p className="lede">
            This gives you your appointments and your letters. It does not change anything
            the practice already holds.
          </p>
        </header>

        <Form method="post" className="stack" noValidate>
          <ErrorSummary errors={errors} order={ORDER} />
          {errors["form"] ? <Announce tone="bad">{errors["form"]}</Announce> : null}
          {!loaderData.reachable ? (
            <Announce tone="warn">
              We cannot reach the practice list at the moment, so registration is
              unavailable. Please try again shortly.
            </Announce>
          ) : null}

          <p className="hint" style={{ marginTop: 0 }}>
            Fields marked <span className="req" aria-hidden="true">*</span> are required.
          </p>

          {/*
            The practice chooser was here, and it is gone with tenancy.
            Asking somebody to pick from a list of one is a question with
            no information in it, and a required field they cannot get
            wrong is a required field that only exists to be got wrong.
          */}

          <div className="pair">
            <Field name="first_name" label="First name" required error={errors["first_name"]}>
              {(f) => <input {...f}
                {...live.on("first_name")} autoComplete="given-name" defaultValue={values["first_name"] ?? ""} />}
            </Field>
            <Field name="last_name" label="Last name" required error={errors["last_name"]}>
              {(f) => <input {...f}
                {...live.on("last_name")} autoComplete="family-name" defaultValue={values["last_name"] ?? ""} />}
            </Field>
          </div>

          <Field
            name="date_of_birth"
            label="Date of birth"
            required
            error={errors["date_of_birth"]}
            hint="The practice uses this to match you to your records."
          >
            {(f) => <input {...f} type="date" autoComplete="bday" defaultValue={values["date_of_birth"] ?? ""} />}
          </Field>

          <Field name="email" label="Email address" required error={errors["email"]}>
            {(f) => (
              <input {...f}
                {...live.on("email")} type="email" autoComplete="email" inputMode="email"
                     defaultValue={values["email"] ?? ""} />
            )}
          </Field>

          {/* Grid, with the note on its own row. As flex children the hint
              under Password pushed that box taller and the two inputs
              stopped lining up. */}
          <div className="pair">
            <Field name="password" label="Password" required error={errors["password"]}>
              {(f) => <Secret {...f}
                {...live.on("password")} autoComplete="new-password" />}
            </Field>
            <Field name="confirm" label="Confirm password" required error={errors["confirm"]}>
              {(f) => <Secret {...f}
                {...live.on("confirm")} autoComplete="new-password" />}
            </Field>
            <p className="pair__note">
              At least 12 characters. A short phrase you will remember beats something
              clever you will not.
            </p>
          </div>

          <div className="row">
            <button className="btn btn--primary" type="submit" disabled={busy || !loaderData.reachable}>
              {busy ? "Creating…" : "Create account"}
            </button>
            <Link className="btn btn--quiet" to="/login">I already have one</Link>
          </div>
        </Form>
      </div>
    </main>
  );
}
