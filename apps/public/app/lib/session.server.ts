import { createCookieSessionStorage, redirect } from "react-router";

/**
 * The patient's session, and where their token is not.
 *
 * Directus hands back an access token and a refresh token. Both go in an
 * httpOnly cookie and neither ever reaches the browser's JavaScript — so
 * every call to the practice's API happens in a loader or an action, and
 * a cross-site scripting payload on this site has nothing to steal.
 *
 * The alternative most portals reach for is putting the access token in
 * `localStorage` and calling the API from the browser. That is simpler
 * and it means one injected script walks away with a credential that can
 * read somebody's clinical record. Not a trade worth making for a page
 * that mostly renders four appointments.
 *
 * There is no session table. The cookie is signed and carries the tokens
 * itself, which is the right shape for Workers — no KV round trip on
 * every request, and nothing to clean up when a patient never comes back.
 * The cost is that signing out cannot invalidate a token server-side, so
 * it is also revoked at Directus on the way out.
 */

type SessionData = {
  access: string;
  refresh: string;
  /** Epoch ms when the access token stops working. */
  expires: number;
  email: string;
};

type SessionFlash = { error: string; notice: string };

export function sessions(env: { PORTAL_SESSION_SECRET: string; PORTAL_SECURE?: string }) {
  return createCookieSessionStorage<SessionData, SessionFlash>({
    cookie: {
      name: "__enamel_portal",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secrets: [env.PORTAL_SESSION_SECRET],
      // Off for local http. A deployment behind TLS sets PORTAL_SECURE=1
      // and this becomes true — a secure cookie simply never arrives over
      // plain http, which looks like "sign-in does nothing".
      //
      // Read off the binding rather than `process.env`, because this runs
      // in workerd where there is no process. That is the whole reason
      // the env is threaded through loaders instead of imported.
      secure: env.PORTAL_SECURE === "1",
      maxAge: 60 * 60 * 24 * 14,
    },
  });
}

export type Session = Awaited<ReturnType<ReturnType<typeof sessions>["getSession"]>>;

/**
 * The access token for this request, refreshed if it has expired.
 *
 * Directus access tokens last about fifteen minutes. A portal that only
 * checks "is there a session" logs the patient out mid-booking; one that
 * refreshes on demand does not. The refreshed pair has to be written back
 * to the cookie, so this returns the session for the caller to commit.
 */
export async function tokenFor(
  session: Session,
  directusUrl: string,
): Promise<{ access: string; changed: boolean } | null> {
  const access = session.get("access");
  const refresh = session.get("refresh");
  const expires = session.get("expires") ?? 0;
  if (!access || !refresh) return null;

  // Thirty seconds of slack: a token that expires while the request is in
  // flight is the same problem as one that expired a minute ago.
  if (Date.now() < expires - 30_000) return { access, changed: false };

  const res = await fetch(`${directusUrl}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh, mode: "json" }),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as {
    data?: { access_token: string; refresh_token: string; expires: number };
  };
  if (!body.data?.access_token) return null;

  session.set("access", body.data.access_token);
  session.set("refresh", body.data.refresh_token);
  session.set("expires", Date.now() + body.data.expires);
  return { access: body.data.access_token, changed: true };
}

/** Sends anybody without a working session to the sign-in page. */
export async function requireToken(
  session: Session,
  directusUrl: string,
  storage: ReturnType<typeof sessions>,
): Promise<{ access: string; changed: boolean }> {
  const token = await tokenFor(session, directusUrl);
  if (!token) {
    throw redirect("/login", {
      headers: { "set-cookie": await storage.destroySession(session) },
    });
  }
  return token;
}
