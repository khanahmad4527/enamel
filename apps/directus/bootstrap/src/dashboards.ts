import { api, must } from "./client.js";
import { log } from "./log.js";

/**
 * The half of the reporting that Directus already does.
 *
 * A panel runs one aggregate over one collection with one filter, which is
 * exactly the shape of "revenue invoiced this month" or "patients who
 * joined this year". Rebuilding those in a custom module would be writing
 * a worse version of a feature that ships in the box — so the module next
 * door does only the ratios, which a panel genuinely cannot express
 * because it cannot divide one aggregate by another.
 *
 * The nice part is tenancy, and it is free here. A panel queries through
 * the items API as the person looking at it, so the same policy filter
 * that stops a Kadehuis receptionist reading Marina's invoices also stops
 * her aggregating them. The core service had to re-implement that check by
 * hand — it reads Postgres directly and has no policy layer underneath —
 * and here it costs nothing.
 */

type Panel = {
  name: string;
  icon: string;
  type: string;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  options: Record<string, unknown>;
  /** Without this a metric panel is a number with nothing saying what of. */
  show_header?: boolean;
  note?: string;
};

/*
 * Literal text, not `$t:` keys, and the colour comes from the brand.
 *
 * Directus resolves `$t:` in collection names, field labels, notes and
 * choice values. It does **not** resolve it on a dashboard, a panel or a
 * folder — those render the key itself, so the Insights list read
 * "$t:enamel_dash_practice" and the dashboard's own title read the same.
 * Four languages of translation existed for a string the platform was
 * never going to look up.
 *
 * The keys stay in the dictionary: they cost nothing, and if Directus
 * ever does resolve these the change here is one line each. What is not
 * kept is the pretence that they were working.
 */
const DASHBOARD = {
  name: "Practice",
  icon: "query_stats",
  color: process.env["BRAND_COLOUR"] ?? "#1978bb",
  note:
    "The figures a panel can compute. The ratios are in the Practice report " +
    "module, because a panel cannot divide one aggregate by another.",
};

/**
 * `$NOW` in a panel filter resolves per request, so these stay correct
 * without anything rewriting them nightly.
 */
const PANELS: Panel[] = [
  {
    name: "Invoiced, 30 days",
    icon: "receipt_long",
    type: "metric",
    show_header: true,
    position_x: 1,  position_y: 1,  width: 18, height: 6,
    options: {
      collection: "invoices",
      field: "total",
      function: "sum",
      filter: { issued_at: { _gte: "$NOW(-30 days)" } },
      // Abbreviated because "65,019" at the size a metric panel chooses is
      // wider than a quarter of the canvas, and ran into the tile beside
      // it. A KPI is read at a glance; the exact figure is a click away in
      // Billing. Only the two money tiles need it — a count of overdue
      // invoices is never going to be six digits.
      abbreviate: true,
      conditionalFormatting: [],
    },
  },
  {
    name: "Outstanding",
    icon: "account_balance_wallet",
    type: "metric",
    show_header: true,
    position_x: 19, position_y: 1,  width: 18, height: 6,
    options: {
      collection: "invoices",
      field: "total",
      function: "sum",
      // No date filter on purpose: outstanding is a balance, not a flow.
      // Filtering it by a period reports "nothing owed" for any window
      // that happens to exclude the month the invoice went out.
      filter: { status: { _in: ["sent", "overdue"] } },
      abbreviate: true,
      conditionalFormatting: [
        { operator: ">", value: 0, color: "#FFC23B" },
      ],
    },
  },
  {
    name: "Overdue invoices",
    icon: "running_with_errors",
    type: "metric",
    show_header: true,
    position_x: 37, position_y: 1,  width: 12, height: 6,
    options: {
      collection: "invoices",
      field: "id",
      function: "count",
      filter: { status: { _eq: "overdue" } },
      conditionalFormatting: [{ operator: ">", value: 0, color: "#E35169" }],
    },
  },
  {
    name: "New patients, 30 days",
    icon: "person_add",
    type: "metric",
    show_header: true,
    position_x: 49, position_y: 1,  width: 12, height: 6,
    options: {
      collection: "patients",
      field: "id",
      function: "count",
      filter: { date_created: { _gte: "$NOW(-30 days)" } },
    },
  },
  {
    name: "Production",
    icon: "trending_up",
    type: "time-series",
    show_header: true,
    position_x: 1,  position_y: 10, width: 44, height: 22,
    options: {
      collection: "treatment_records",
      dateField: "performed_at",
      valueField: "price",
      function: "sum",
      precision: "day",
      range: "30d",
      filter: { status: { _eq: "completed" } },
      color: "#0D6E63",
      showXAxis: true,
      showYAxis: true,
    },
  },
  {
    name: "Next 24 hours",
    icon: "today",
    type: "metric",
    show_header: true,
    position_x: 45, position_y: 10, width: 16, height: 11,
    options: {
      collection: "appointments",
      field: "id",
      function: "count",
      filter: {
        _and: [
          { starts_at: { _gte: "$NOW(-0 hours)" } },
          { starts_at: { _lte: "$NOW(+24 hours)" } },
          { status: { _in: ["scheduled", "confirmed"] } },
        ],
      },
    },
  },
  {
    name: "Recalls not booked",
    icon: "event_repeat",
    type: "metric",
    show_header: true,
    position_x: 45, position_y: 21, width: 16, height: 11,
    options: {
      collection: "recalls",
      field: "id",
      function: "count",
      filter: {
        _and: [
          { date_due: { _lte: "$NOW" } },
          { date_scheduled: { _null: true } },
          { is_disabled: { _eq: false } },
        ],
      },
      conditionalFormatting: [{ operator: ">", value: 0, color: "#FFC23B" }],
    },
  },
];

export async function applyDashboards(): Promise<void> {
  const existing = await must<Array<{ id: string; name: string }>>(
    "list dashboards",
    api.get("/dashboards?limit=-1&fields=id,name"),
  );

  /*
   * Found under its current name or the one it used to have.
   *
   * The dashboard was called "$t:enamel_dash_practice" — a translation key
   * Directus never resolved — and renaming it to something readable is
   * exactly the change that, matched on name alone, silently produces a
   * second dashboard beside the first. The old name is looked for too, and
   * the row is patched rather than skipped so the note and the colour
   * follow the source instead of being frozen at creation.
   */
  const FORMER_NAMES = ["$t:enamel_dash_practice"];
  let dashboard = existing.find(
    (d) => d.name === DASHBOARD.name || FORMER_NAMES.includes(d.name),
  );
  if (!dashboard) {
    dashboard = await must<{ id: string; name: string }>(
      "create dashboard",
      api.post("/dashboards", DASHBOARD),
    );
    log.made(`dashboard "${DASHBOARD.name}"`);
  } else {
    await must("update dashboard", api.patch(`/dashboards/${dashboard.id}`, DASHBOARD));
    log.skip(`dashboard "${DASHBOARD.name}"`);
  }

  const panels = await must<Array<{ id: string; name: string }>>(
    "list panels",
    api.get(`/panels?limit=-1&fields=id,name&filter[dashboard][_eq]=${dashboard.id}`),
  );
  const byName = new Map(panels.map((p) => [p.name, p.id]));

  let made = 0, updated = 0;
  for (const panel of PANELS) {
    const body = { ...panel, dashboard: dashboard.id };
    const id = byName.get(panel.name);
    // Patched rather than skipped: a corrected filter has to reach an
    // instance that already has the panel, or every existing demo quietly
    // keeps the old definition.
    const r = id ? await api.patch(`/panels/${id}`, body) : await api.post("/panels", body);
    if (!r.ok) log.fail(`panel ${panel.name}: ${r.error.message}`);
    else if (id) updated++;
    else made++;
  }

  /*
   * Anything on this dashboard that the source no longer describes is
   * removed.
   *
   * Panels are matched by name, so renaming all seven from `$t:` keys to
   * readable text would otherwise have left the originals in place and
   * added seven more on top of them — fourteen panels overlapping in a
   * grid built for seven, and the provisioning reporting success. This is
   * the same shape as a preset or a permission that outlives its
   * definition: an upsert without a sweep is half a reconciliation.
   */
  const wanted = new Set(PANELS.map((p) => p.name));
  let removed = 0;
  for (const p of panels) {
    if (wanted.has(p.name)) continue;
    const r = await api.delete(`/panels/${p.id}`);
    if (r.ok) removed++;
    else log.fail(`remove stale panel ${p.name}: ${r.error.message}`);
  }
  log.made(
    `${made} panels${updated ? `, ${updated} updated` : ""}` +
      `${removed ? `, ${removed} stale removed` : ""}`,
  );
}
