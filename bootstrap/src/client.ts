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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
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
