import { Form, NavLink, Outlet, data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/portal";
import { api, type Clinic, type Env, type PatientRecord } from "~/lib/api.server";
import { themeFor } from "~/lib/theme";
import { requireToken, sessions } from "~/lib/session.server";

/**
 * Everything behind the sign-in, and the one place the token is resolved.
 *
 * Child routes ask this layout for the patient record rather than fetching
 * it again, which is why it lives here: one request per page load, and one
 * answer to "who is this" that the whole portal shares.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const storage = sessions(env);
  const session = await storage.getSession(request.headers.get("cookie"));
  const token = await requireToken(session, env.DIRECTUS_URL, storage);

  // In parallel: the practice no longer hangs off the patient record, and
  // fetching it after would put a second round trip in front of every
  // portal page for a logo and a colour.
  const [record, practice] = await Promise.all([
    api.record(env, token.access),
    api.practice(env, token.access).catch(() => null),
  ]);

  // A login with no patient record behind it. Registration goes out of its
  // way to make this impossible, but a practice can delete a record, and
  // "the page is blank" is a bad way to find out.
  if (!record) {
    return data(
      { record: null as PatientRecord | null, practice },
      token.changed
        ? { headers: { "set-cookie": await storage.commitSession(session) } }
        : undefined,
    );
  }

  return data(
    { record, practice },
    token.changed
      ? { headers: { "set-cookie": await storage.commitSession(session) } }
      : undefined,
  );
}

/** Children read the record from here instead of fetching it again. */
export function usePatient(): PatientRecord {
  const parent = useRouteLoaderData<typeof loader>("routes/portal");
  if (!parent?.record) throw new Error("no patient record in the portal layout");
  return parent.record;
}

/**
 * The practice, for the pages inside the portal.
 *
 * It used to hang off the patient record — `patient.clinic.timezone` —
 * which was convenient and is gone. Every portal page needs the timezone
 * at least, because a time shown in the browser's zone is the wrong time
 * for anyone reading it abroad, so it is loaded once by the layout and
 * read from here.
 */
export function usePractice(): Clinic | null {
  return useRouteLoaderData<typeof loader>("routes/portal")?.practice ?? null;
}

export default function Portal({ loaderData }: Route.ComponentProps) {
  const record = loaderData.record;
  const practice = loaderData.practice;

  /**
   * The practice's colour, as inline custom properties on a wrapper.
   *
   * Not a `<style>` tag injected into the head: as inline properties the
   * theme is server-rendered with the page — no flash, no client fetch —
   * scoped to this subtree so it cannot leak, and free, because the
   * clinic row was already being fetched for the record above.
   *
   * An empty object when the practice has set no colour, so the
   * stylesheet's own defaults apply and nothing breaks.
   */
  const theme = themeFor(practice?.theme_primary) as React.CSSProperties;

  return (
    <div style={theme} className="themed">
      <header className="masthead">
        <div className="masthead__inner">
          <a className="wordmark" href="/portal">
            {/* The logo when the practice has one, and the name either way.
                
                Never the logo *instead of* the name. An image alone is a
                masthead that says nothing when it fails to load, when a
                practice has not uploaded one, or to somebody using a
                screen reader who then hears the same words twice — which
                is why the image is decorative here and the text does the
                naming. See `routes/brand.tsx` for why the bytes come
                through this server rather than straight from Directus. */}
            {practice?.theme_logo ? (
              <img
                className="wordmark__logo"
                src={`/brand/${practice.theme_logo}`}
                alt=""
                width={28}
                height={28}
              />
            ) : null}
            <span>
              {practice?.name ?? "Enamel"}
              <small>Patient area</small>
            </span>
          </a>
          <nav className="nav">
            <NavLink to="/portal" end>My visits</NavLink>
            <NavLink to="/portal/book">Book</NavLink>
            <NavLink to="/portal/profile">Your details</NavLink>
            <Form method="post" action="/logout">
              <button type="submit">Sign out</button>
            </Form>
          </nav>
        </div>
      </header>

      {record ? (
        <Outlet />
      ) : (
        <main className="shell shell--narrow" id="main">
          <div className="feature stack">
            <h1 className="h1">Your account is not linked yet</h1>
            <p className="lede">
              You are signed in, but this login is not attached to a patient record at the
              practice. Please ring them and they can link it.
            </p>
          </div>
        </main>
      )}
    </div>
  );
}
