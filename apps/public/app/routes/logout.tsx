import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { api, type Env } from "~/lib/api.server";
import { sessions } from "~/lib/session.server";

/**
 * Signing out, on both sides.
 *
 * Destroying the cookie is enough for this browser. It is not enough for
 * the refresh token that was in it, which would keep working until it
 * expired — so it is revoked at Directus as well. A "sign out" that only
 * forgets locally is the kind of thing that reads fine and is wrong on a
 * shared computer.
 */
async function signOut(request: Request, context: { env: unknown }) {
  const env = context.env as Env;
  const storage = sessions(env);
  const session = await storage.getSession(request.headers.get("cookie"));

  const refresh = session.get("refresh");
  if (refresh) await api.signOut(env, refresh);

  return redirect("/", { headers: { "set-cookie": await storage.destroySession(session) } });
}

export async function action({ request, context }: Route.ActionArgs) {
  return signOut(request, context);
}

/** A GET lands here too, so /logout typed into the bar does the right thing. */
export async function loader({ request, context }: Route.LoaderArgs) {
  return signOut(request, context);
}
