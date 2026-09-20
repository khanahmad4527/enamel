/**
 * Thin REST wrapper. The SDK would work too, but a plain fetch client
 * keeps every request visible — this repo is meant to be read, and an
 * opaque call chain teaches nobody how the Directus API actually works.
 */
import { URL_BASE, ADMIN_EMAIL, ADMIN_PASSWORD } from "./env.js";

const EMAIL = ADMIN_EMAIL;
const PASSWORD = ADMIN_PASSWORD;

let token: string | null = null;

/** Exposed for multipart uploads, which can't go through `request`. */
export function authHeader(): string {
  if (!token) throw new Error("not authenticated");
  return `Bearer ${token}`;
}

export async function login(): Promise<void> {
  const res = await fetch(`${URL_BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = (await res.json()) as { data?: { access_token: string }; errors?: unknown };
  if (!res.ok || !body.data?.access_token) {
    throw new Error(`Login failed for ${EMAIL}: ${JSON.stringify(body.errors ?? body)}`);
  }
  token = body.data.access_token;
}

export type ApiError = { status: number; message: string; code?: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait when the server says to wait.
 *
 * Directus answers a 429 with a `Retry-After` header and, helpfully, the
 * exact figure in the message: "Too many requests, retry after 211ms".
 * Reading the header first and falling back to the sentence covers both
 * the standard and what this particular server actually sends.
 *
 * A small floor and a little more than asked for, because retrying at
 * precisely the moment the window opens puts every client that was
 * refused back on the wire simultaneously.
 */
function retryAfterMs(res: Response, message: string, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(250, seconds * 1000) + attempt * 100;
  }
  const stated = /retry after (\d+)ms/i.exec(message);
  if (stated?.[1]) return Math.max(250, Number(stated[1])) + attempt * 100;
  // No guidance at all: back off geometrically rather than guessing.
  return 250 * 2 ** attempt;
}

/**
 * Provisioning talks to a rate-limited API, so it has to behave like a
 * client of one.
 *
 * This is not a hypothetical. Turning Directus's rate limiter on is what
 * found it: the bootstrap fires several hundred sequential calls from one
 * address, tripped the per-IP limit halfway through the flows, and the
 * whole run died on `429 Too many requests, retry after 211ms` — a server
 * that had just said, in those words, exactly what to do about it.
 *
 * The alternative fix was to raise the limit until provisioning fitted
 * under it, which would have meant choosing the production rate limit to
 * suit a script that runs twice a day. A client that ignores a 429 is a
 * broken client; the limit is not the thing that was wrong.
 */
const MAX_RETRIES = 6;

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  attempt = 0,
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 429 && attempt < MAX_RETRIES) {
    // Read the body before sleeping: the message carries the figure, and
    // an unread body holds the connection open while we wait.
    const text = await res.text().catch(() => "");
    const message = (() => {
      try { return JSON.parse(text)?.errors?.[0]?.message ?? ""; } catch { return text; }
    })();
    await sleep(retryAfterMs(res, message, attempt));
    return request<T>(method, path, body, attempt + 1);
  }

  if (res.status === 204) return { ok: true, data: undefined as T };

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const first = parsed?.errors?.[0];
    return {
      ok: false,
      error: {
        status: res.status,
        message: first?.message ?? res.statusText,
        code: first?.extensions?.code,
      },
    };
  }
  return { ok: true, data: parsed.data as T };
}

/**
 * A multipart upload, with the same 429 handling as everything else.
 *
 * Uploads cannot go through `request` — they are `multipart/form-data`,
 * not JSON — and that exemption is exactly how the rate limiter caught
 * provisioning a second time after the JSON path was fixed: the branding
 * step pushes ten images in a row and died on the ninth. Two call sites
 * needing the same retry is one call site.
 *
 * The FormData is rebuilt by the caller on each attempt rather than
 * reused, because a body that has been read once is not guaranteed to be
 * readable again.
 */
export async function postFile(build: () => FormData, path = "/files", method = "POST"): Promise<Response> {
  let res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { authorization: authHeader() },
    body: build(),
  });
  for (let attempt = 0; res.status === 429 && attempt < 6; attempt++) {
    const header = Number(res.headers.get("retry-after") ?? "");
    const stated = /retry after (\d+)ms/i.exec(await res.clone().text().catch(() => "")); 
    const wait = Number.isFinite(header) && header > 0
      ? header * 1000
      : stated?.[1]
        ? Math.max(250, Number(stated[1]))
        : 250 * 2 ** attempt;
    await sleep(wait + attempt * 100);
    res = await fetch(`${URL_BASE}${path}`, {
      method,
      headers: { authorization: authHeader() },
      body: build(),
    });
  }
  return res;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
  url: URL_BASE,
};

/** Throws with context. Use where a failure means the run can't continue. */
export async function must<T>(
  label: string,
  p: Promise<{ ok: true; data: T } | { ok: false; error: ApiError }>,
): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${label}: ${r.error.status} ${r.error.message}`);
  return r.data;
}
