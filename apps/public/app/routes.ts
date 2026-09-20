import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  /**
   * The practice's public website.
   *
   * Every path here used to begin with an optional `:clinic?` segment,
   * so one deployment could serve several practices and `/` was a list
   * of them. One practice now: `/` is the front page.
   *
   * `pages/:slug` is last inside the layout and every other route is
   * static, which matters — React Router matches static segments before
   * dynamic ones, so a page called "contact" cannot shadow the real
   * contact route, and `/login` is the sign-in rather than a page
   * somebody named "login".
   */
  layout("routes/site.tsx", [
    index("routes/site.home.tsx", { id: "site-home" }),
    route("services", "routes/site.services.tsx"),
    route("services/:slug", "routes/site.service.tsx"),
    route("team", "routes/site.team.tsx"),
    route("contact", "routes/site.contact.tsx"),
    route("privacy", "routes/site.privacy.tsx"),
    // Anything the practice writes in Directus — terms, a complaints
    // procedure, an accessibility statement. Adding one is a row, not a
    // deployment.
    route("pages/:slug", "routes/site.page.tsx"),
  ]),

  // Answered as text, not as pages, so they sit outside the layout.
  route("sitemap.xml", "routes/sitemap.tsx"),
  route("robots.txt", "routes/robots.tsx"),

  // Bytes rather than a page: the one place this site streams a file it
  // did not compose. Outside the clinic layout because a logo is the same
  // image whichever practice's page asked for it.
  route("brand/:id", "routes/brand.tsx"),

  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),
  route("logout", "routes/logout.tsx"),

  // Everything inside this layout requires a session; the layout is where
  // the token is resolved and the patient record is loaded once.
  layout("routes/portal.tsx", [
    route("portal", "routes/portal.home.tsx"),
    route("portal/book", "routes/portal.book.tsx"),
    route("portal/profile", "routes/portal.profile.tsx"),
  ]),
] satisfies RouteConfig;
