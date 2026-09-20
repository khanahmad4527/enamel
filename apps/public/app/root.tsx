import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from "react-router";
import type { Route } from "./+types/root";
import stylesheet from "./app.css?url";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    // Spectral for headings and IBM Plex Sans for everything else.
    // Deliberately not Inter, and deliberately not a display serif paired
    // with it — that combination is the generated default. Spectral is a
    // text serif with open shapes that stays calm at 40px, and Plex has
    // real tabular figures, which this site needs for times and money.
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Spectral:wght@500;600&display=swap",
  },
  { rel: "stylesheet", href: stylesheet },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // `lang` is what tells a screen reader which voice to use. Hard-coded
    // to British English for now; once the portal honours the patient's
    // `preferred_language` this has to move with it, because a Dutch
    // name read in an English voice is close to unintelligible.
    <html lang="en-GB">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {/* First thing in the tab order, visible only when focused. A
            keyboard user should not have to tab through the whole
            masthead on every page to reach the content. */}
        <a className="skip" href="#main">Skip to content</a>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * What a patient sees when something breaks.
 *
 * Deliberately without the stack trace, and deliberately without "an
 * unexpected error occurred". Someone trying to move an appointment
 * needs to know whether to try again or to ring the practice, and those
 * are the two things this says.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const known = isRouteErrorResponse(error);
  const title = known && error.status === 404 ? "That page is not here" : "Something went wrong";
  // The thrown Response's body, when there is one. A 404 from the site's
  // own routing says something specific and useful — "No practice answers
  // on that address" — and replacing it with the generic line throws away
  // the only sentence that tells a visitor what they got wrong.
  const said = known && typeof error.data === "string" ? error.data.trim() : "";
  const detail = known
    ? said ||
      (error.status === 404
        ? "The link may be old, or the page may have moved."
        : "The practice's system refused that request.")
    : "We could not reach the practice's system. Please try again in a moment.";

  return (
    <main className="shell shell--narrow">
      <div className="card">
        <h1 className="h1">{title}</h1>
        <p className="lede">{detail}</p>
        <a className="btn btn--primary" href="/">Back to the start</a>
      </div>
    </main>
  );
}
