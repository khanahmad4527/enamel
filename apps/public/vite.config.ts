import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vite";

/**
 * The site is built for workerd, not for Node.
 *
 * That matters more than it looks: the Cloudflare plugin runs the dev
 * server, the preview server and the production build in the same runtime
 * Cloudflare would, so a Node API that does not exist at the edge fails
 * here rather than on deploy. `viteEnvironment: { name: "ssr" }` is what
 * hands React Router's server build to the worker.
 */
export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter(), tsconfigPaths()],
  // The two plugins disagree about where the server bundle goes: the
  // Cloudflare plugin names the directory after the Vite environment
  // (`dist/ssr`), React Router looks for `<buildDirectory>/server`. Saying
  // it once here settles it, and the Cloudflare plugin takes an explicit
  // outDir over its own default.
  environments: { ssr: { build: { outDir: "dist/server" } } },
  server: { host: "0.0.0.0", port: 8058 },
});
