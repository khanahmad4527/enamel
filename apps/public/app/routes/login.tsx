import { Form, Link, data, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/login";
import { api, ApiError, type Env } from "~/lib/api.server";
import { sessions, tokenFor } from "~/lib/session.server";
import { practiceOrNull } from "~/lib/site.server";
import { themeFor } from "~/lib/theme";
import { NOINDEX } from "~/lib/seo";
import { checkField, loginSchema, parseForm, sameOrigin, type FieldErrors } from "~/lib/schema";
import { Announce, ErrorSummary, Field, Secret, useLiveErrors } from "~/components/form";

export function meta({ data }: Route.MetaArgs) {
  return [
    { title: data?.practice ? `Sign in — ${data.practice}` : "Sign in · Enamel patient area" },
    // Kept out of a search index. These pages redirect a crawler to
    // themselves, so nothing could leak — but "Sign in" ranking under a
    // practice's name is a bad result, and robots.txt is a request while
    // this is an instruction to the indexer that did fetch the page.
    NOINDEX,
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const storage = sessions(env);
  const session = await storage.getSession(request.headers.get("cookie"));
  if (await tokenFor(session, env.DIRECTUS_URL)) throw redirect("/portal");

  // On a practice's own domain the sign-in is part of their website, and
  // is rendered in their colour. On the shared host it belongs to nobody
  // in particular and keeps the default palette — the patient area is one
  // door for every practice, and branding it would be a guess about who
  // is standing at it.
  const clinic = await practiceOrNull(env);
  return { practice: clinic?.name ?? null, primary: clinic?.theme_primary ?? null, base: clinic ? "" : null };
}

/**
 * One shape for every failure, so the component can index it.
 *
 * Without this each `data()` call narrows to its own literal and the
 * union has no `email` key on one arm and no `password` on another —
 * which typechecks as an error at the point of *reading* it, a long way
 * from the cause.
 */
type Failed = { errors: FieldErrors; values: Record<string, string> };

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.env as unknown as Env;

  // Second layer behind the `sameSite: lax` cookie. See `sameOrigin`.
  if (!sameOrigin(request)) {
    return data<Failed>(
      { errors: { form: "That request did not come from this site." }, values: {} },
      { status: 403 },
    );
  }

  const storage = sessions(env);
  const session = await storage.getSession(request.headers.get("cookie"));

  const form = await request.formData();
  const parsed = parseForm(loginSchema, form);
  if (!parsed.ok) return data<Failed>({ errors: parsed.errors, values: parsed.values }, { status: 400 });

  try {
    const auth = await api.signIn(env, parsed.value.email.toLowerCase(), parsed.value.password);
    session.set("access", auth.access_token);
    session.set("refresh", auth.refresh_token);
    session.set("expires", Date.now() + auth.expires);
    session.set("email", parsed.value.email.toLowerCase());
  } catch (e) {
    // One message for a wrong password and for an address with no
    // account. Telling them apart answers "is this person registered
    // here", which is a clinical disclosure wearing a login form.
    //
    // It goes on `form` rather than on `email`, because marking the
    // email field invalid would imply we know which half was wrong.
    const down = e instanceof ApiError && e.status >= 500;
    return data<Failed>(
      {
        errors: {
          form: down
            ? "We could not reach the practice's system. Please try again shortly."
            : "That email address and password did not match.",
        },
        values: { email: parsed.value.email },
      },
      { status: down ? 502 : 401 },
    );
  }

  return redirect("/portal", { headers: { "set-cookie": await storage.commitSession(session) } });
}

const ORDER = ["form", "email", "password"];

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state === "submitting";
  // Checked as they leave each field rather than only on submit — same
  // schema, so the two can never disagree.
  const live = useLiveErrors(loginSchema, checkField, actionData?.errors ?? {});
  const errors = live.errors;
  const values = actionData?.values ?? {};
  const theme = themeFor(loaderData?.primary) as React.CSSProperties;

  return (
    <main className="shell shell--narrow themed" id="main" style={theme}>
      <div className="stack stack--loose">
        <header>
          <p className="eyebrow">
            {loaderData?.practice ? `${loaderData.practice} · patient area` : "Enamel patient area"}
          </p>
          <h1 className="h1">Sign in</h1>
          {loaderData?.base !== null && loaderData?.base !== undefined ? (
            <p className="hint">
              <Link to={loaderData.base || "/"}>Back to {loaderData.practice}</Link>
            </p>
          ) : null}
        </header>

        <Form method="post" className="stack" noValidate>
          <ErrorSummary errors={errors} order={ORDER} />
          {errors["form"] ? <Announce tone="bad">{errors["form"]}</Announce> : null}

          <p className="hint" style={{ marginTop: 0 }}>
            Fields marked <span className="req" aria-hidden="true">*</span> are required.
          </p>

          <Field name="email" label="Email address" required error={errors["email"]}>
            {(f) => (
              <input
                {...f}
                type="email"
                autoComplete="email"
                inputMode="email"
                defaultValue={values["email"] ?? ""}
                {...live.on("email")}
              />
            )}
          </Field>

          <Field name="password" label="Password" required error={errors["password"]}>
            {(f) => <Secret {...f} autoComplete="current-password" {...live.on("password")} />}
          </Field>

          <div className="row">
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <Link className="btn btn--quiet" to="/register">Create an account</Link>
          </div>
        </Form>
      </div>
    </main>
  );
}
