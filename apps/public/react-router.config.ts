import type { Config } from "@react-router/dev/config";

export default {
  // Server-rendered on purpose. The patient's Directus token lives in an
  // httpOnly cookie and never reaches the browser, which means every call
  // to the practice's API happens in a loader or an action — so a stolen
  // XSS payload has nothing to read.
  ssr: true,
  // `dist`, not the React Router default of `build`, because the
  // Cloudflare plugin owns the output directory: it writes the worker and
  // its generated wrangler config beside the client assets. Left at the
  // default, the SSR pass looks for a client manifest in one directory
  // while the client pass has just written it to the other.
  buildDirectory: "dist",
} satisfies Config;
