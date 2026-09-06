import { api, must } from "./client.js";
import { log } from "./log.js";

/**
 * Flows.
 *
 * Each is a linear chain of operations; `applyFlows` creates them, wires
 * each step's `resolve` to the next, and reconciles both on later runs.
 * Doing it here rather than by hand in the UI means the automation is
 * reviewable in a pull request, which is the whole argument for
 * provisioning as code.
 *
 * None of these use the `exec` ("Run Script") operation. In the
 * directus/directus:11 image it neither runs nor reports an error — the
 * flow simply completes with no effect, which is a miserable thing to
 * debug. Everything here is done with native operations instead:
 * `item-read` supports `aggregate`, and `trigger` iterates a flow over an
 * array, which together cover most of what a script gets reached for.
 *
 * Two operation semantics are worth knowing before reading these, both
 * taken from the shipped source rather than the docs:
 *
 *   - `item-update` validates `key` as an array of strings or numbers.
 *     Handing it the result of an `item-read` — an array of row *objects*
 *     — throws. Pass `query` instead, or read ids and pass those.
 *   - An empty `key` on 12.3.0+ makes the operation a no-op, but on 11 it
 *     falls through to updateByQuery with an empty query and rewrites
 *     every row in the collection. A scheduled flow that finds nothing to
 *     do must therefore never reach `item-update` with an empty key.
 */

type Op = {
  key: string;
  name: string;
  type: string;
  options: Record<string, unknown>;
};

type FlowDef = {
  name: string;
  icon: string;
  color: string;
  description: string;
  trigger: "schedule" | "event" | "operation" | "manual";
  options: Record<string, unknown>;
  accountability?: "all" | "activity" | null;
  operations: Op[];
};

/** Resolved to a flow id by name at apply time; see `applyFlows`. */
const FLOW_REF = "$flow:";

/** The window the reminder flow works on, shared so it cannot drift. */
const DUE_SOON = {
  _and: [
    { reminder_sent: { _eq: false } },
    { status: { _in: ["scheduled", "confirmed"] } },
    { starts_at: { _gte: "$NOW" } },
    { starts_at: { _lte: "$NOW(+24 hours)" } },
  ],
};

const flows: FlowDef[] = [
  {
    // The create event carries the whole payload, so the file id and the
    // kind are both already in hand and no read is needed.
    name: "Classify a filed document",
    icon: "shield_lock",
    color: "#0D6E63",
    description:
      "Copies a new document's kind onto the file behind it. That copy is what keeps radiographs out of reception's file library — see directus_files.document_kind.",
    trigger: "event",
    accountability: "all",
    options: {
      type: "action",
      scope: ["items.create"],
      collections: ["documents"],
    },
    operations: [
      {
        key: "classify",
        name: "Mark the file",
        type: "item-update",
        options: {
          collection: "directus_files",
          key: "{{$trigger.payload.file}}",
          payload: { document_kind: "{{$trigger.payload.kind}}" },
          // As the system, not as whoever filed the document. An event
          // flow inherits the triggering user's accountability, and no
          // clinician may write a readonly field on directus_files — so
          // without this the flow ran, was refused, and left the file
          // unclassified and readable by reception. It failed silently,
          // because a rejected operation only ends the chain.
          permissions: "$full",
          emitEvents: false,
        },
      },
    ],
  },
  {
    // Split from the create flow for the same reason as the invoice
    // totals pair: items.update carries `keys` and only the fields that
    // changed, so the document has to be read back. Re-filing a
    // radiograph as correspondence has to reopen the file, or a misfiled
    // document stays hidden for good.
    name: "Reclassify a refiled document",
    icon: "shield_lock",
    color: "#0D6E63",
    description:
      "Keeps the file's copy of the document kind in step when a document is edited.",
    trigger: "event",
    accountability: "all",
    options: {
      type: "action",
      scope: ["items.update"],
      collections: ["documents"],
    },
    operations: [
      {
        key: "doc",
        name: "Read the document back",
        type: "item-read",
        options: {
          collection: "documents",
          // A filter rather than `key`, because item-read hands back a
          // single object when given one key and an array when given
          // several — and every downstream mustache here indexes with
          // [0]. A filter always returns a list, whatever the count.
          query: { filter: { id: { _in: "{{$trigger.keys}}" } }, fields: ["id", "file", "kind"] },
        },
      },
      {
        key: "classify",
        name: "Mark the file",
        type: "item-update",
        options: {
          collection: "directus_files",
          key: "{{doc[0].file}}",
          payload: { document_kind: "{{doc[0].kind}}" },
          permissions: "$full",
          emitEvents: false,
        },
      },
    ],
  },
  {
    // Directus has no per-item loop inside a flow. What it has is a
    // `trigger` operation that runs another flow once per element of an
    // array, so the per-patient work lives in its own flow and the
    // scheduled one just hands it the list.
    name: "Send appointment reminder",
    icon: "mail",
    color: "#0D6E63",
    description:
      "One patient, one reminder. Called by the hourly flow once per appointment, and stamps its own row so nobody is mailed twice.",
    trigger: "operation",
    options: { return: "$last" },
    operations: [
      {
        key: "notify",
        name: "Email the patient",
        type: "mail",
        options: {
          to: "{{$trigger.patient.email}}",
          subject: "Your appointment at {{$trigger.clinic.name}}",
          type: "template",
          template: "base",
          data: {
            title: "See you soon",
            body: "Hello {{$trigger.patient.first_name}}, this is a reminder of your appointment on {{$trigger.starts_at}}.",
          },
        },
      },
      {
        // Stamped per appointment rather than in bulk upstream, so the
        // row that is marked is the row this run actually handled.
        //
        // It does NOT mean "stamped only if the mail went out". The mail
        // operation calls send() without awaiting it and swallows the
        // rejection into a log line — read its handler if you want to be
        // sure — so it resolves whether or not anything was delivered. A
        // reminder that fails at the SMTP server is still marked sent,
        // and the only place that shows is the Directus log.
        key: "stamp",
        name: "Mark as reminded",
        type: "item-update",
        options: {
          collection: "appointments",
          key: "{{$trigger.id}}",
          payload: { reminder_sent: true },
          emitEvents: false,
        },
      },
    ],
  },
  {
    name: "Appointment reminders",
    icon: "notifications_active",
    color: "#0D6E63",
    description:
      "Hourly: finds appointments starting within 24 hours that have not been reminded, and runs the reminder flow once for each.",
    trigger: "schedule",
    options: { cron: "0 * * * *" },
    operations: [
      {
        key: "due",
        name: "Find appointments due",
        type: "item-read",
        options: {
          collection: "appointments",
          query: {
            filter: DUE_SOON,
            fields: ["id", "starts_at", "patient.first_name", "patient.email", "clinic.name"],
            limit: 100,
          },
        },
      },
      {
        // Serial, not parallel: an SMTP server being hit by a hundred
        // concurrent sends is how a practice gets rate-limited.
        key: "fanout",
        name: "Remind each patient",
        type: "trigger",
        options: {
          flow: `${FLOW_REF}Send appointment reminder`,
          payload: "{{due}}",
          iterationMode: "serial",
        },
      },
    ],
  },
  {
    name: "Invoice totals (line added)",
    icon: "calculate",
    color: "#B4762A",
    description:
      "Recalculates an invoice's subtotal when a line is added. The new line's payload carries its invoice, so the sum needs nothing else.",
    trigger: "event",
    accountability: "all",
    options: {
      type: "action",
      scope: ["items.create"],
      collections: ["invoice_lines"],
    },
    operations: [
      {
        // `aggregate` does the sum inside the database, so no script is
        // needed and the whole invoice never has to be loaded.
        key: "sum",
        name: "Sum the lines",
        type: "item-read",
        options: {
          collection: "invoice_lines",
          query: {
            filter: { invoice: { _eq: "{{$trigger.payload.invoice}}" } },
            aggregate: { sum: ["amount"] },
          },
        },
      },
      {
        key: "write",
        name: "Write the subtotal back",
        type: "item-update",
        options: {
          collection: "invoices",
          key: "{{$trigger.payload.invoice}}",
          payload: { subtotal: "{{sum[0].sum.amount}}" },
          // Same reason as the classify flows: a hygienist adding a line
          // has no write on invoices, and the recalculation would be
          // refused rather than wrong — which is worse, because the
          // header would simply stay stale.
          permissions: "$full",
          emitEvents: false,
        },
      },
    ],
  },
  {
    // Split from the create flow rather than merged with it, because the
    // two events carry different shapes: `items.create` gives `key` and a
    // full payload, `items.update` gives `keys` and only the fields that
    // changed — which almost never includes `invoice`. Reading the line
    // back is the only way to learn which invoice it belongs to.
    name: "Invoice totals (line changed)",
    icon: "calculate",
    color: "#B4762A",
    description:
      "Recalculates an invoice's subtotal when a line is edited, so the header can never drift from the lines.",
    trigger: "event",
    accountability: "all",
    options: {
      // Delete is absent on purpose: Directus hands the flow the deleted
      // keys but not the row, so there is no way to learn which invoice
      // it belonged to — the parent is already gone from the event. The
      // practice workflow is to void an invoice and reissue it rather
      // than delete lines, which is also why invoice_lines is hidden.
      type: "action",
      scope: ["items.update"],
      collections: ["invoice_lines"],
    },
    operations: [
      {
        key: "line",
        name: "Which invoice was it",
        type: "item-read",
        options: {
          collection: "invoice_lines",
          // Filter, not key — see "Reclassify a refiled document".
          query: { filter: { id: { _in: "{{$trigger.keys}}" } }, fields: ["id", "invoice"] },
        },
      },
      {
        key: "sum",
        name: "Sum the lines",
        type: "item-read",
        options: {
          collection: "invoice_lines",
          query: {
            filter: { invoice: { _eq: "{{line[0].invoice}}" } },
            aggregate: { sum: ["amount"] },
          },
        },
      },
      {
        key: "write",
        name: "Write the subtotal back",
        type: "item-update",
        options: {
          collection: "invoices",
          key: "{{line[0].invoice}}",
          payload: { subtotal: "{{sum[0].sum.amount}}" },
          permissions: "$full",
          emitEvents: false,
        },
      },
    ],
  },
  {
    // One operation, not two. Reading the overdue invoices and feeding
    // the result to item-update is the shape that breaks: on a night with
    // nothing past due the key collapses to empty, and on 11 that means
    // every invoice in every practice gets marked overdue. A scoped
    // `query` cannot do that — an empty match updates nothing.
    name: "Flag overdue invoices",
    icon: "running_with_errors",
    color: "#E35169",
    description:
      "Nightly: moves sent invoices past their due date to Overdue, which is what the Unpaid invoices bookmark surfaces.",
    trigger: "schedule",
    options: { cron: "0 2 * * *" },
    operations: [
      {
        key: "mark",
        name: "Mark overdue",
        type: "item-update",
        options: {
          collection: "invoices",
          query: {
            filter: {
              _and: [{ status: { _eq: "sent" } }, { due_at: { _lt: "$NOW" } }],
            },
            limit: 500,
          },
          payload: { status: "overdue" },
          emitEvents: false,
        },
      },
    ],
  },
];

/**
 * Flows this repo has shipped under a name it no longer uses.
 *
 * `applyFlows` matches on name, so renaming one in this file creates a
 * second flow and leaves the original running — which for an event flow
 * means the old, broken version keeps firing next to the new one. There
 * is no marker on directus_flows saying "the bootstrap made this", so
 * retirements are listed rather than inferred: deleting every flow this
 * file does not know about would take somebody's own work with it.
 */
const RETIRED = ["Invoice totals"];

type OpRow = { id: string; key: string; type: string; options: unknown; resolve: string | null };

/** Two operation chains are the same if every step matches, in order. */
function sameOps(existing: OpRow[], desired: Op[], resolveRef: (o: Op) => Op): boolean {
  if (existing.length !== desired.length) return false;
  return desired.every((op, i) => {
    const have = existing[i];
    if (!have || have.key !== op.key || have.type !== op.type) return false;
    return JSON.stringify(have.options ?? {}) === JSON.stringify(resolveRef(op).options);
  });
}

export async function applyFlows(): Promise<void> {
  const existing = await must<Array<{ id: string; name: string }>>(
    "list flows",
    api.get("/flows?limit=-1&fields=id,name"),
  );
  const byName = new Map(existing.map((f) => [f.name, f.id]));

  for (const name of RETIRED) {
    const id = byName.get(name);
    if (!id) continue;
    await must(`retire flow ${name}`, api.delete(`/flows/${id}`));
    byName.delete(name);
    log.made(`retired flow ${name}`);
  }

  // A flow that calls another flow needs its id, and ids only exist once
  // the callee has been created. Definitions name it instead, and the
  // reference is resolved here — which also means the order of `flows`
  // carries meaning: a callee must be defined before its caller.
  const resolveRef = (op: Op): Op => {
    const flow = op.options["flow"];
    if (typeof flow !== "string" || !flow.startsWith(FLOW_REF)) return op;
    const target = byName.get(flow.slice(FLOW_REF.length));
    if (!target) throw new Error(`flow ${op.key}: no flow named ${flow.slice(FLOW_REF.length)} yet`);
    return { ...op, options: { ...op.options, flow: target } };
  };

  for (const flow of flows) {
    let flowId = byName.get(flow.name);

    if (flowId) {
      // Attributes are cheap to re-send and this is the only way an
      // edited cron, description or scope reaches an instance that
      // already has the flow.
      await must(
        `update flow ${flow.name}`,
        api.patch(`/flows/${flowId}`, {
          icon: flow.icon,
          color: flow.color,
          description: flow.description,
          trigger: flow.trigger,
          accountability: flow.accountability ?? null,
          options: flow.options,
        }),
      );
    } else {
      const created = await must<{ id: string }>(
        `create flow ${flow.name}`,
        api.post("/flows", {
          name: flow.name,
          icon: flow.icon,
          color: flow.color,
          description: flow.description,
          status: "active",
          trigger: flow.trigger,
          accountability: flow.accountability ?? null,
          options: flow.options,
        }),
      );
      flowId = created.id;
      byName.set(flow.name, flowId);
    }

    const current = await must<OpRow[]>(
      `read operations of ${flow.name}`,
      api.get(`/operations?limit=-1&sort=position_x&fields=id,key,type,options,resolve&filter[flow][_eq]=${flowId}`),
    );

    if (sameOps(current, flow.operations, resolveRef)) {
      log.skip(`flow ${flow.name}`);
      continue;
    }

    // Rebuilt rather than patched in place: an edit can add, remove or
    // reorder steps, and rewiring a partially-changed chain is more code
    // than throwing it away. The flow row itself survives, so its id,
    // logs and any external reference to it are untouched.
    if (current.length) {
      await must(`detach operations of ${flow.name}`, api.patch(`/flows/${flowId}`, { operation: null }));
      for (const op of current) await api.delete(`/operations/${op.id}`);
    }

    const ids: string[] = [];
    for (const [i, op] of flow.operations.entries()) {
      const made = await must<{ id: string }>(
        `create operation ${op.key}`,
        api.post("/operations", {
          flow: flowId,
          key: op.key,
          name: op.name,
          type: op.type,
          position_x: 19 + i * 18,
          position_y: 1,
          options: resolveRef(op).options,
        }),
      );
      ids.push(made.id);
    }
    for (let i = 0; i < ids.length - 1; i++) {
      await must(`wire ${flow.name}`, api.patch(`/operations/${ids[i]}`, { resolve: ids[i + 1] }));
    }
    if (ids[0]) await must(`entry point ${flow.name}`, api.patch(`/flows/${flowId}`, { operation: ids[0] }));

    log.made(`flow ${flow.name} (${ids.length} operations)`);
  }
}
