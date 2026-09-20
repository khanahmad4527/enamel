import { renderToReadableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import type { AppLoadContext, EntryContext } from "react-router";
import { isbot } from "isbot";

/**
 * Rendering, in a Worker.
 *
 * `renderToReadableStream` rather than the Node pipe API, because there
 * are no Node streams at the edge. The bot branch waits for the whole
 * tree so a crawler gets complete HTML; a person gets the shell as soon
 * as it is ready.
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  let status = responseStatusCode;

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: request.signal,
      onError(error: unknown) {
        // Logged, not shown. The ErrorBoundary says what a patient can do
        // about it; the stack is for whoever is reading the logs.
        status = 500;
        console.error(error);
      },
    },
  );

  if (isbot(request.headers.get("user-agent") ?? "")) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  // The portal renders somebody's clinical history. It has no business in
  // a frame on another site, and no business being sniffed as anything
  // other than what it is.
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("X-Frame-Options", "DENY");
  responseHeaders.set("Referrer-Policy", "same-origin");

  return new Response(body, { headers: responseHeaders, status });
}
