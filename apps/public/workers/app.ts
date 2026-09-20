import { createRequestHandler } from "react-router";

/**
 * The Worker entry.
 *
 * Cloudflare bindings arrive on `env`, and React Router hands them to
 * loaders through the context — which is how `api.server.ts` reaches
 * Directus and the core service without importing `process.env`, a thing
 * that does not exist in a Worker.
 */
declare module "react-router" {
  interface AppLoadContext {
    env: Env;
  }
}

const handler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  fetch(request: Request, env: Env) {
    return handler(request, { env });
  },
} satisfies ExportedHandler<Env>;
