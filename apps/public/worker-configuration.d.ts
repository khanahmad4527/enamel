/**
 * The bindings the Worker is given.
 *
 * Five values, and two of them are secrets. In local development
 * they come from `.dev.vars`, which the container writes from its own
 * environment at start-up; a real deployment sets DIRECTUS_URL and
 * CORE_URL in wrangler.jsonc and PORTAL_SESSION_SECRET with
 * `wrangler secret put`, because a cookie-signing key in the repository
 * signs everybody's session, not just this one.
 */
interface Env {
  DIRECTUS_URL: string;
  CORE_URL: string;
  PORTAL_SESSION_SECRET: string;
  /** "1" behind TLS. See the cookie's `secure` flag. */
  PORTAL_SECURE?: string;
  /**
   * Reads the practice's *published* content and nothing else. A second
   * secret rather than a reuse of the first, because what a leaked
   * credential can reach is the only thing standing behind it.
   */
  WEBSITE_TOKEN: string;
  /** Seconds a published page may lag the practice's edits. 0 disables it. */
  WEBSITE_CACHE_SECONDS?: string;
}
