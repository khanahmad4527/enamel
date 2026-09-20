import { Injectable, Logger } from "@nestjs/common";
import { config } from "../config/config";

/**
 * The policy that opens the job board without opening anything else.
 *
 * The string is the coupling between this service and the provisioning
 * source, and it is asserted by the check suite in both directions.
 */
export const QUEUE_OPERATOR_POLICY = "Queue operator";

export type DirectusUser = {
  id: string;
  first_name: string | null;
  last_name: string | null;
};

export class DirectusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The only way this service writes anything.
 *
 * Reads go straight to Postgres because slot search needs them to; writes
 * come back through here on purpose. A booking made by talking to the
 * database directly would skip the permission model, the scheduling hook
 * that turns a constraint violation into a sentence, and the `user_created`
 * stamp that makes an appointment traceable to whoever made it. None of
 * those are optional in a clinical system.
 *
 * Which token is used matters as much as the fact of going through the
 * API. A request handler forwards the caller's own, so this service can
 * never be a way to reach something Directus would refuse. Only the
 * background worker falls back to the service token, because a cron job
 * has no user to borrow one from.
 */
@Injectable()
export class DirectusService {
  private readonly log = new Logger(DirectusService.name);

  private async call<T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${config.directus.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as { data?: T; errors?: Array<{ message?: string }> }) : {};

    if (!res.ok) {
      // Directus puts the useful sentence in errors[0].message — including
      // the ones the scheduling hook raises, which are written to be read
      // by a receptionist. Passing that through verbatim is the whole
      // point of routing writes here.
      throw new DirectusError(res.status, parsed.errors?.[0]?.message ?? `HTTP ${res.status}`);
    }
    return parsed.data as T;
  }

  /**
   * Who a token belongs to.
   *
   * This used to resolve a `clinic` as well, and that was the
   * load-bearing part: every query this service made was filtered by it,
   * because taking it from the request would have let any authenticated
   * caller read another practice's diary by changing a parameter. There
   * is one practice now and the column is gone.
   */
  async whoami(token: string): Promise<DirectusUser> {
    // Ask for exactly what is needed, and nothing a caller might not be
    // allowed to read. Directus does not refuse an un-permitted field on
    // /users/me — it answers 200 with `id` alone and silently drops every
    // other field in the list, including the permitted ones. Naming one
    // field a role cannot read is how the rest of them vanish.
    return this.call<DirectusUser>(
      token,
      "GET",
      "/users/me?fields=id,first_name,last_name",
    );
  }

  /**
   * Whether Directus considers this token an administrator.
   *
   * A **separate** call rather than more fields on `whoami`, and that is
   * not tidiness. Directus does not refuse an un-permitted field on
   * `/users/me` — it answers 200 and silently drops it *along with the
   * permitted fields beside it*, so `admin_access` cannot ride along on
   * the query above; that exact bug is already recorded there.
   *
   * The test is what it looks like: does a policy attached to this user,
   * or to their role, carry `admin_access`. What makes it reliable is the
   * same degradation. A non-administrator cannot read
   * `directus_policies.admin_access`, so the nested object collapses to a
   * bare foreign key — `"role": "844c7bdd-…"` rather than
   * `"role": { "policies": [...] }` — and anything that is not an
   * explicit `true` is refused. Measured across all five roles in this
   * system, and asserted in the verify suite rather than assumed.
   */
  /**
   * Whether Directus considers this token an administrator.
   *
   * A **separate** call rather than more fields on `whoami`. Directus
   * does not refuse an un-permitted field on `/users/me` — it answers 200
   * and silently drops it *along with the permitted fields beside it*, so
   * `admin_access` cannot ride along on the query that resolves a name.
   *
   * The test is what it looks like: does a policy attached to this user,
   * directly or through their role, carry `admin_access`.
   */
  async isAdministrator(token: string): Promise<boolean> {
    return (await this.policyFlags(token)).admin;
  }

  /**
   * May this caller open the job board?
   *
   * Administrators, and holders of the "Queue operator" policy — which
   * grants no collection permissions at all and exists so that watching a
   * failing reminder queue does not require god-mode over every patient
   * record. See the policy's own note in the provisioning source.
   *
   * Matched on the policy's **name**, and that is a real coupling worth
   * stating: rename the policy in Directus and this stops recognising it,
   * which fails *closed* — the board refuses rather than opens. A check
   * in the suite asserts the name still exists so the rename is caught at
   * provisioning time rather than by a developer locked out at 2am.
   */
  async mayOpenQueues(token: string): Promise<boolean> {
    const flags = await this.policyFlags(token);
    return flags.admin || flags.queueOperator;
  }

  /**
   * One request, both answers.
   *
   * Asked as two calls this cost two round trips on every board request
   * and could disagree with itself between them.
   */
  /**
   * Which of the caller's policies matter here, asked in two questions
   * rather than one.
   *
   * The obvious version was a single `/users/me` with both shapes in the
   * field list: `policies.policy.name` for a policy granted straight to
   * the person, `role.policies.policy.name` for one granted through their
   * role. It answered 200 and returned neither, for the one account it
   * existed to serve.
   *
   * The reason is worth writing down, because it is silent and it is not
   * specific to this endpoint. Directus does not refuse a query that
   * names a field the caller cannot read — it drops that field **and the
   * permitted fields beside it**. `directus_users.policies` is not
   * readable by a non-administrator at all, so naming it cost the answer
   * to the other half of the question, and the service concluded the
   * caller held no policies rather than that it had asked badly. A
   * permission check that cannot tell "no" from "I could not see" fails
   * open or closed by accident; this one happened to fail closed, which
   * is luck, not design.
   *
   * So each shape is asked for on its own and a failure of either is
   * survivable. Two round trips against a local Directus, on a path a
   * person walks once to open a board.
   */
  /**
   * Whether the caller may read an appointment at all.
   *
   * Asked of Directus rather than worked out here, so there is one
   * answer to "who may see the diary" and it is the one the admin
   * enforces. A policy change takes effect without a deploy, which is the
   * whole reason for paying the round trip.
   *
   * The distinction that matters is refused-versus-empty. Directus
   * answers 403 for a collection the caller has no read rule on, and 200
   * with an empty array for one they may read that happens to hold
   * nothing — a practice with an empty diary is not a practice whose
   * staff have lost access to it. Only the first is a no.
   */
  async maySeeTheDiary(token: string): Promise<boolean> {
    try {
      await this.call<unknown[]>(token, "GET", "/items/appointments?limit=1&fields=id");
      return true;
    } catch (e) {
      if (e instanceof DirectusError && e.status === 403) return false;
      // Anything else — Directus down, a malformed answer — is not a
      // "yes". The caller of this method treats a throw as a refusal.
      throw e;
    }
  }

  /**
   * Of these appointments, the ones this caller is actually allowed.
   *
   * `maySeeTheDiary` answers a coarser question — may you read an
   * appointment *at all* — and on its own it was not enough, in a way
   * worth recording. A patient may read an appointment: their own. The
   * Patient portal policy does not refuse the collection, it filters the
   * rows, so the coarse check said yes and a patient was handed the
   * practice's whole day, twenty-three people by name. The guard was
   * asking a question whose answer it then over-read.
   *
   * So the fine-grained question is put to Directus as well, and put in
   * the only form that cannot drift from the policy: hand it the ids and
   * see which come back. Row filters, field permissions and any future
   * rule all apply, because it is Directus applying them rather than this
   * service modelling them. Staff get the day; a patient gets their own
   * appointment and no neighbours; an account with no read at all never
   * reaches here, having been refused by the guard.
   *
   * Chunked because a filter is a query string and a busy Monday is a lot
   * of uuids. An id that comes back from none of the chunks is simply not
   * in the returned set — there is no branch where an error is read as
   * permission.
   */
  async visibleAppointments(token: string, ids: string[]): Promise<Set<string>> {
    const allowed = new Set<string>();
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const rows = await this.call<Array<{ id: string }>>(
        token,
        "GET",
        `/items/appointments?limit=-1&fields=id&filter[id][_in]=${chunk.join(",")}`,
      );
      for (const row of rows) allowed.add(row.id);
    }
    return allowed;
  }

  private async policyFlags(token: string): Promise<{ admin: boolean; queueOperator: boolean }> {
    type Policied = { policy?: { admin_access?: boolean; name?: string } | null } | null;

    const direct = await this.call<{ policies?: Policied[] | null }>(
      token,
      "GET",
      "/users/me?fields=id,policies.policy.admin_access,policies.policy.name",
    ).then((me) => me.policies ?? []).catch(() => [] as Policied[]);

    const viaRole = await this.call<{ role?: { policies?: Policied[] | null } | string | null }>(
      token,
      "GET",
      "/users/me?fields=id,role.policies.policy.admin_access,role.policies.policy.name",
    ).then((me) =>
      typeof me.role === "object" && me.role !== null ? (me.role.policies ?? []) : [],
    ).catch(() => [] as Policied[]);

    const all = [...direct, ...viaRole];
    return {
      admin: all.some((p) => p?.policy?.admin_access === true),
      queueOperator: all.some((p) => p?.policy?.name === QUEUE_OPERATOR_POLICY),
    };
  }

  async createAppointment(token: string, payload: Record<string, unknown>): Promise<{ id: string }> {
    return this.call<{ id: string }>(token, "POST", "/items/appointments", payload);
  }

  async updateAppointment(
    token: string,
    id: string,
    payload: Record<string, unknown>,
  ): Promise<{ id: string }> {
    return this.call<{ id: string }>(token, "PATCH", `/items/appointments/${id}`, payload);
  }

  /** Marks a reminder as sent. Worker-only, hence the service token. */
  async markReminded(id: string): Promise<void> {
    if (!config.directus.reminderToken) {
      this.log.warn(`no REMINDER_TOKEN — cannot mark appointment ${id} as reminded`);
      return;
    }
    await this.call(config.directus.reminderToken, "PATCH", `/items/appointments/${id}`, {
      reminder_sent: true,
    });
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${config.directus.url}/server/ping`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
