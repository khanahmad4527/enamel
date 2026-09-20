/**
 * Talking to the practice.
 *
 * Two upstreams, and which one answers a given question is a design
 * decision rather than an accident:
 *
 *   Directus answers anything the patient's own permissions already
 *   cover — their appointments, their invoices, their record. The portal
 *   policy scopes those to the signed-in patient, so this layer adds no
 *   filtering of its own and cannot get it wrong.
 *
 *   The core service answers slot search, which is an intersection of
 *   five tables no permission model can express, and booking, which needs
 *   to go through the same rules everything else does.
 *
 * Nothing here holds a privileged credential. Every call carries the
 * patient's own token, so this site is incapable of reading anything the
 * practice has not already decided a patient may see — including by bug.
 * The one exception is registration, which has no patient yet; that is
 * handled by the core service with its own narrowly-scoped account, and
 * this site only forwards the form.
 */

export type Env = {
  DIRECTUS_URL: string;
  CORE_URL: string;
  PORTAL_SESSION_SECRET: string;
  PORTAL_SECURE?: string;
  /**
   * The read-only content credential, and the only static token this site
   * holds. It reads published services, questions, opening hours, team
   * profiles and retention rules — and is refused on every clinical
   * collection, which the verify suite asserts rather than assumes. See
   * `site.server.ts` for why a static token is right there and wrong here.
   */
  WEBSITE_TOKEN: string;
  /** Seconds a published page may lag the practice's edits. 0 disables it. */
  WEBSITE_CACHE_SECONDS?: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The sentence a caller should show, out of whichever shape came back.
 *
 * Three shapes, because there are two upstreams: Directus answers with
 * `errors[0].message`, Nest with `message` as a string or an array of
 * them. All three are unwrapped here so a route never has to know which
 * service refused it.
 *
 * "Invalid payload." is stripped from whichever shape carries it. That is
 * Directus's own prefix on a validation failure, and the part after it is
 * a sentence written to be read — "Hannah Prins is already booked from
 * 10:15 to 10:45". Showing the prefix turns a useful answer into an error
 * message, and it arrives with the prefix down either path: straight from
 * Directus, or relayed by the core service, which passes the sentence
 * through verbatim rather than inventing its own.
 */
function messageFrom(body: unknown, fallback: string): string {
  const b = body as {
    errors?: Array<{ message?: string }>;
    message?: string | string[];
  } | null;
  const tidy = (m: string) => m.replace(/^Invalid payload\.\s*/i, "").trim();
  const first = b?.errors?.[0]?.message;
  if (typeof first === "string") return tidy(first);
  if (typeof b?.message === "string") return tidy(b.message);
  if (Array.isArray(b?.message) && typeof b.message[0] === "string") return tidy(b.message[0]);
  return fallback;
}

/**
 * The address of the person at the other end.
 *
 * This site is server-rendered, so a request it makes to the practice
 * leaves from the site's own container — and to anything counting per IP
 * downstream, every patient in the world is the same caller. The
 * registration limiter is per IP. One bucket for everybody is not a
 * limiter, it is a queue with a cap.
 *
 * `CF-Connecting-IP` is what Cloudflare sets and is the trustworthy one
 * in production, because the edge writes it and a client cannot. The
 * other two are the local development path, where wrangler is the only
 * thing in front of this.
 *
 * Forwarded, never trusted here: whether to believe it is the receiving
 * service's decision, and core makes it against a list of trusted peers
 * rather than by taking the header's word.
 */
export function clientAddress(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return request.headers.get("x-real-ip");
}

async function call<T>(
  url: string,
  token: string | null,
  init: RequestInit = {},
  fallback = "Something went wrong.",
  forIp: string | null = null,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      // Appended rather than set: if something already forwarded a chain
      // to this site, replacing it would erase a hop somebody downstream
      // may be counting on.
      ...(forIp ? { "x-forwarded-for": forIp } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, messageFrom(body, fallback));
  return (body as { data?: T }).data ?? (body as T);
}

/* ---------------- Directus: the patient's own record ---------------- */

export type Clinic = {
  id: string;
  name: string;
  city: string | null;
  country: string | null;
  timezone: string;
  currency: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  /** The practice's brand colour. Everything else is derived from it. */
  theme_primary: string | null;
  theme_logo: string | null;
};

export type PatientRecord = {
  id: string;
  status: string;
  reference: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  clinic: Clinic | null;
  allow_email: boolean;
  allow_sms: boolean;
  allow_whatsapp: boolean;
};

export type Person = { id: string; first_name: string | null; last_name: string | null; job_title: string | null };

export type Appointment = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  reason: string | null;
  practitioner: Person | null;
};

export type Invoice = {
  id: string;
  number: string;
  status: string;
  issued_at: string;
  due_at: string | null;
  total: string;
};

export type Message = {
  id: string;
  direction: string;
  channel: string;
  kind: string;
  subject: string | null;
  body: string;
  sent_at: string | null;
  date_created: string;
};

export type Document = {
  id: string;
  kind: string;
  taken_on: string | null;
  note: string | null;
  file: string | null;
  date_created: string;
};

/*
 * The practice used to ride along on the patient record through
 * `patients.clinic`, so a themed page cost no extra read. There is no
 * such column now — the practice is a singleton — so it is fetched
 * alongside, in parallel, which costs one request and not one round trip.
 */
const PRACTICE_FIELDS = [
  "id", "name", "city", "country", "timezone", "currency",
  "phone", "email", "address", "theme_primary", "theme_logo",
].join(",");

export const api = {
  async signIn(env: Env, email: string, password: string) {
    return call<{ access_token: string; refresh_token: string; expires: number }>(
      `${env.DIRECTUS_URL}/auth/login`,
      null,
      { method: "POST", body: JSON.stringify({ email, password, mode: "json" }) },
      "Those details did not work.",
    );
  },

  async signOut(env: Env, refresh: string): Promise<void> {
    // Best effort. The cookie is destroyed either way, and a portal that
    // refuses to sign somebody out because the API hiccuped is worse than
    // one that leaves a token to expire on its own.
    await fetch(`${env.DIRECTUS_URL}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh, mode: "json" }),
    }).catch(() => undefined);
  },

  /**
   * The patient record this login is attached to.
   *
   * Returns a list because the portal policy filters it — the query asks
   * for every patient and the permission layer answers with the one.
   * That is the whole tenancy story for this site: no filter of its own,
   * so no filter of its own to get wrong.
   *
   * Note what is *not* fetched anywhere on this site: /users/me. The
   * patient's own name, email and practice all live on this row, and
   * reading them here means the portal never needs read access to the
   * user table at all.
   */
  async record(env: Env, token: string): Promise<PatientRecord | null> {
    const rows = await call<PatientRecord[]>(
      `${env.DIRECTUS_URL}/items/patients?limit=1&fields=id,status,reference,first_name,last_name,` +
        `email,phone,address,allow_email,allow_sms,allow_whatsapp`,
      token,
    );
    return rows[0] ?? null;
  },

  updateRecord(env: Env, token: string, patch: Record<string, unknown>, id: string) {
    return call<PatientRecord>(`${env.DIRECTUS_URL}/items/patients/${id}`, token, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }, "Could not save that.");
  },

  appointments(env: Env, token: string) {
    return call<Appointment[]>(
      `${env.DIRECTUS_URL}/items/appointments?limit=-1&sort=-starts_at` +
        `&fields=id,starts_at,ends_at,status,reason,practitioner.id,practitioner.first_name,` +
        `practitioner.last_name,practitioner.job_title`,
      token,
    );
  },

  /**
   * Cancelling.
   *
   * Straight to Directus with the patient's own token, because the whole
   * rule is already written as a permission: their own row, still to
   * come, not already finished, and `status` the only field they may
   * write. Routing this through the core service would add a place to
   * get that wrong and take nothing away.
   */
  cancel(env: Env, token: string, id: string) {
    return call<{ id: string }>(`${env.DIRECTUS_URL}/items/appointments/${id}`, token, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled" }),
    }, "That appointment could not be cancelled.");
  },

  /** The clinicians at their practice — the booking page's choice list. */
  practitioners(env: Env, token: string) {
    return call<Person[]>(
      `${env.DIRECTUS_URL}/users?limit=-1&sort=first_name&fields=id,first_name,last_name,job_title`,
      token,
    );
  },

  treatments(env: Env, token: string) {
    return call<Array<{ id: string; code: string; name: string; category: string | null; duration_minutes: number }>>(
      `${env.DIRECTUS_URL}/items/treatments?limit=-1&sort=name` +
        `&fields=id,code,name,category,duration_minutes&filter[duration_minutes][_nnull]=true`,
      token,
    );
  },

  invoices(env: Env, token: string) {
    return call<Invoice[]>(
      `${env.DIRECTUS_URL}/items/invoices?limit=-1&sort=-issued_at&fields=id,number,status,issued_at,due_at,total`,
      token,
    );
  },

  messages(env: Env, token: string) {
    return call<Message[]>(
      `${env.DIRECTUS_URL}/items/messages?limit=20&sort=-date_created` +
        `&fields=id,direction,channel,kind,subject,body,sent_at,date_created`,
      token,
    );
  },

  documents(env: Env, token: string) {
    return call<Document[]>(
      `${env.DIRECTUS_URL}/items/documents?limit=-1&sort=-date_created` +
        `&fields=id,kind,taken_on,note,file,date_created`,
      token,
    );
  },

  /* ---------------- the core service ---------------- */

  slots(env: Env, token: string, params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    return call<{ clinic: string; timezone: string; slots: Slot[] }>(
      `${env.CORE_URL}/api/availability/slots?${qs}`,
      token,
      {},
      "Could not look up available times.",
    );
  },

  book(env: Env, token: string, body: Record<string, unknown>) {
    return call<{ id: string }>(
      `${env.CORE_URL}/api/availability/book`,
      token,
      { method: "POST", body: JSON.stringify(body) },
      "That time could not be booked.",
    );
  },

  /**
   * Registration, which is the one thing a patient cannot do as
   * themselves — they have no account yet.
   *
   * Forwarded to the core service rather than done here, so the only
   * credential that can create a login lives in the service that already
   * has a pattern for narrowly-scoped service accounts. This site holds
   * none, which is what lets it face the internet.
   */
  register(env: Env, body: Record<string, unknown>, clientIp: string | null) {
    return call<{ id: string; email: string }>(
      `${env.CORE_URL}/api/portal/register`,
      null,
      { method: "POST", body: JSON.stringify(body) },
      "Could not create that account.",
      // The one call where the caller's address is the control. Without
      // it, core counts every registration on earth into one bucket and
      // the twenty-first person that hour is turned away because of the
      // twenty before them.
      clientIp,
    );
  },

  /** The practice. A singleton, so no id and no list. */
  practice(env: Env, token: string) {
    return call<Clinic>(
      `${env.DIRECTUS_URL}/items/practice?fields=${PRACTICE_FIELDS}`,
      token,
      {},
      "Could not read the practice.",
    );
  },

  clinics(env: Env) {
    return call<Array<{ id: string; name: string; city: string | null }>>(
      `${env.CORE_URL}/api/portal/practices`,
      null,
      {},
      "Could not list the practices.",
    );
  },
};

export type Slot = {
  date: string;
  starts_at: string;
  ends_at: string;
  local_start: string;
  local_end: string;
  practitioner: string;
  practitioner_name: string;
  room: string;
  room_name: string;
};
