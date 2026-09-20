import { defineHook } from "@directus/extensions-sdk";
import { InvalidPayloadError } from "@directus/errors";

/**
 * Scheduling rules, on the way in.
 *
 * Postgres already refuses to hold the same dentist or the same chair in
 * two overlapping appointments — see `appointments_no_practitioner_overlap`
 * and `appointments_no_room_overlap` in the bootstrap's constraints step.
 * That is the rule, and it is deliberately in the database, where no
 * client can route around it.
 *
 * What it is not is an error anybody can act on. A violation surfaces as
 * HTTP 500 with the raw insert statement in the message — it leaks the
 * schema to any authenticated caller, and it tells a receptionist trying
 * to book a filling precisely nothing. This hook runs before the write,
 * finds the appointment that is already in the way, and rejects with its
 * time and whose it is.
 *
 * Two layers on purpose. The hook is the readable one and it races: two
 * requests can both pass the check before either inserts. The constraint
 * is the one that cannot be raced, because Postgres serialises it. Losing
 * the race now costs you the ugly 500 instead of a double-booked chair,
 * which is the right way round.
 */

/** A slot is only held by an appointment that is still going to happen. */
const HOLDS_A_SLOT = ["scheduled", "confirmed"];

type Payload = Record<string, unknown>;

type Appointment = {
  id?: string;
  practitioner?: string | null;
  room?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  status?: string | null;
  treatment?: string | null;
};

export default defineHook(({ filter }, { services, getSchema }) => {
  const { ItemsService } = services as {
    ItemsService: new (collection: string, opts: Record<string, unknown>) => {
      readByQuery(query: Record<string, unknown>): Promise<Record<string, unknown>[]>;
      readOne(key: string, query?: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  };
  // Thrown from `@directus/errors`, not from the hook context. Directus
  // 11 dropped the `exceptions` argument that older guides still reach
  // for, and reading it registers nothing: the hook fails to load with a
  // TypeError and every rule in this file silently stops applying. The
  // package is a devDependency because the bundler inlines it — it is
  // not resolvable inside the container at runtime.
  const reject = (message: string): never => {
    throw new InvalidPayloadError({ reason: message });
  };

  /**
   * A time as the practice would say it.
   *
   * The timezone argument is not optional in practice, only in the
   * signature. Without it this renders in the *container's* zone, which
   * is UTC — so a clash at eight in the morning in Amsterdam was reported
   * to the receptionist standing in Amsterdam as six in the morning. The
   * message was accurate about the collision and wrong about every digit
   * a human would check it against.
   */
  const time = (iso: string, tz?: string): string =>
    new Date(iso).toLocaleString("en-GB", {
      ...(tz ? { timeZone: tz } : {}),
      weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });

  /**
   * A clash as a person would say it: the day once, then the times.
   *
   * Both ends used to go through `time()`, which names the weekday and
   * the date, so a forty-five minute overlap was reported as "from Sat 19
   * Sept, 09:45 to Sat 19 Sept, 10:30" — the same date twice in a
   * sentence a receptionist reads while somebody waits on the phone.
   *
   * The long form is kept for the case that actually needs it. An
   * appointment that crosses midnight has two different dates and saying
   * only the times would be ambiguous; nothing in a dental diary should
   * do that, which is exactly why it must not be assumed away.
   */
  const span = (from: string, to: string, tz?: string): string => {
    const day = (iso: string): string =>
      new Date(iso).toLocaleDateString("en-GB", {
        ...(tz ? { timeZone: tz } : {}),
        weekday: "short", day: "numeric", month: "short",
      });
    const clock = (iso: string): string =>
      new Date(iso).toLocaleTimeString("en-GB", {
        ...(tz ? { timeZone: tz } : {}),
        hour: "2-digit", minute: "2-digit", hour12: false,
      });
    return day(from) === day(to)
      ? `${day(from)}, ${clock(from)}–${clock(to)}`
      : `from ${time(from, tz)} to ${time(to, tz)}`;
  };

  /** The practice's timezone, or UTC if it has none on file. */
  async function zoneOf(schema: unknown): Promise<string> {
    try {
      const rows = (await new ItemsService("practice", { schema, accountability: null })
        .readByQuery({ fields: ["timezone"], limit: 1 })) as Array<{ timezone?: string }>;
      return rows[0]?.timezone || "UTC";
    } catch {
      return "UTC";
    }
  }

  /**
   * The appointment being written, merged over the one already stored.
   *
   * An update carries only the fields that changed: moving an appointment
   * sends `starts_at` alone, and checking that against a null practitioner
   * would clear every conflict. The stored row supplies the rest.
   */
  async function resolve(
    payload: Payload,
    key: string | undefined,
    schema: unknown,
    accountability: unknown,
  ): Promise<Appointment> {
    if (!key) return payload as Appointment;
    // Admin read, like `clash` below. Whether the *caller* may read
    // `treatment` has nothing to do with whether the rule applies to
    // them, and reading as them meant the reminder sweep's service account —
    // which is granted one field on purpose — could not mark a reminder
    // sent without tripping over a field it has no business seeing.
    const appointments = new ItemsService("appointments", { schema, accountability: null });
    const stored = await appointments.readOne(key, {
      fields: ["practitioner", "room", "starts_at", "ends_at", "status", "treatment"],
    });
    return { ...(stored as Appointment), ...(payload as Appointment), id: key };
  }

  /**
   * Finds an appointment already holding the dentist or the chair.
   *
   * Half-open on both sides, matching the exclusion constraint's `[)`:
   * an appointment that ends at 10:00 does not collide with one starting
   * at 10:00, which is the difference between a full diary and a diary
   * that refuses every back-to-back booking a practice actually runs.
   */
  async function clash(
    appointment: Appointment,
    schema: unknown,
  ): Promise<{ label: string; starts_at: string; ends_at: string } | null> {
    const { practitioner, room, starts_at, ends_at, status, id } = appointment;
    if (!starts_at || !ends_at) return null;
    if (!HOLDS_A_SLOT.includes(String(status ?? "scheduled"))) return null;

    const resources: Array<Record<string, unknown>> = [];
    if (practitioner) resources.push({ practitioner: { _eq: practitioner } });
    if (room) resources.push({ room: { _eq: room } });
    if (resources.length === 0) return null;

    // Read without accountability: a receptionist who cannot see a
    // colleague's appointment must still be told the chair is taken.
    // Reporting "free" because the caller lacks read access would hand
    // them a booking the database then refuses.
    const appointments = new ItemsService("appointments", { schema, accountability: null });

    const filters: Record<string, unknown>[] = [
      { status: { _in: HOLDS_A_SLOT } },
      { starts_at: { _lt: ends_at } },
      { ends_at: { _gt: starts_at } },
      { _or: resources },
    ];
    if (id) filters.push({ id: { _neq: id } });

    const found = await appointments.readByQuery({
      filter: { _and: filters },
      fields: [
        "starts_at", "ends_at",
        "practitioner.first_name", "practitioner.last_name",
        "room.name",
      ],
      limit: 1,
    });

    const hit = found[0] as
      | {
          starts_at: string;
          ends_at: string;
          practitioner?: { first_name?: string; last_name?: string } | null;
          room?: { name?: string } | null;
        }
      | undefined;
    if (!hit) return null;

    // Name whichever resource actually collided. Saying "the chair is
    // busy" when it is the dentist who is busy sends somebody to move a
    // booking that was never the problem.
    const samePractitioner =
      practitioner && hit.practitioner
        ? `${hit.practitioner.first_name ?? ""} ${hit.practitioner.last_name ?? ""}`.trim()
        : "";
    const sameRoom = room && hit.room?.name ? hit.room.name : "";
    const label = samePractitioner || sameRoom || "That slot";

    return { label, starts_at: hit.starts_at, ends_at: hit.ends_at };
  }

  /**
   * Fills `ends_at` from the treatment when the caller did not give one.
   *
   * `treatments.duration_minutes` exists and nothing was reading it, so
   * every appointment was 45 minutes whatever was being done in it — a
   * 15-minute fluoride varnish and a 90-minute crown booked identically.
   * A flow cannot do this: Directus flows have no arithmetic, which is
   * why the field sat unused.
   */
  async function deriveEnd(appointment: Appointment, schema: unknown): Promise<string | null> {
    if (appointment.ends_at || !appointment.starts_at || !appointment.treatment) return null;
    const treatments = new ItemsService("treatments", { schema, accountability: null });
    const treatment = (await treatments.readOne(appointment.treatment, {
      fields: ["duration_minutes"],
    })) as { duration_minutes?: number | null };
    const minutes = Number(treatment?.duration_minutes ?? 0);
    if (!minutes) return null;
    return new Date(new Date(appointment.starts_at).getTime() + minutes * 60_000).toISOString();
  }

  /**
   * The four availability rules, asked before Postgres asks them.
   *
   * The trigger is the enforcement; this is the explanation. Left to the
   * trigger alone a receptionist gets HTTP 500 and the word ENAMEL_CLOSED
   * wrapped in an insert statement, which is worse than no rule at all —
   * it looks like the software is broken rather than like the practice is
   * shut.
   *
   * Ordered the way a person would ask: is the practice open, is this
   * clinician in, is anyone away, is the chair usable. The first answer
   * that is "no" is the one worth giving; listing all four would bury it.
   */
  async function available(
    appointment: Appointment,
    schema: unknown,
  ): Promise<string | null> {
    const { practitioner, room, starts_at, ends_at, status } = appointment;
    if (!starts_at || !ends_at) return null;
    if (!HOLDS_A_SLOT.includes(String(status ?? "scheduled"))) return null;

    const svc = (collection: string) =>
      new ItemsService(collection, { schema, accountability: null });

    const practices = (await svc("practice")
      .readByQuery({ fields: ["timezone", "name"], limit: 1 })
      .catch(() => [])) as Array<{ timezone?: string; name?: string }>;
    const tz = practices[0]?.timezone || "UTC";

    // Wall-clock in the practice's own town. Comparing a UTC instant
    // against "09:00" is an hour out for half the year without it.
    const local = (iso: string) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, hour12: false,
        weekday: "short", hour: "2-digit", minute: "2-digit",
      }).formatToParts(new Date(iso))
        .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});

    const from = local(starts_at);
    const to = local(ends_at);
    const day = String(from["weekday"] ?? "").slice(0, 3).toLowerCase();
    const hhmm = (p: Record<string, string>) => `${p["hour"]}:${p["minute"]}`;
    const startTime = hhmm(from);
    const endTime = hhmm(to);

    const hours = (await svc("clinic_hours").readByQuery({
      filter: {},
      fields: ["weekday", "closed", "opens_at", "closes_at"],
      limit: -1,
    })) as Array<{ weekday: string; closed: boolean; opens_at: string | null; closes_at: string | null }>;

    // A practice with no hours on file has not declared itself shut — it
    // has an unfinished rota, and refusing every booking until somebody
    // fills it in would make the feature impossible to adopt. Same rule
    // the trigger applies, stated in both places on purpose.
    if (hours.length > 0) {
      const today = hours.find((h) => h.weekday === day);
      if (!today || today.closed || !today.opens_at || !today.closes_at) {
        return `The practice is closed on a ${from["weekday"]}`;
      }
      if (startTime < today.opens_at.slice(0, 5) || endTime > today.closes_at.slice(0, 5)) {
        return `The practice is open ${today.opens_at.slice(0, 5)}–${today.closes_at.slice(0, 5)} on a ${from["weekday"]}`;
      }
    }

    if (practitioner) {
      const sessions = (await svc("practitioner_hours").readByQuery({
        filter: { practitioner: { _eq: practitioner } },
        fields: ["weekday", "starts_at", "ends_at"],
        limit: -1,
      })) as Array<{ weekday: string; starts_at: string; ends_at: string }>;
      if (sessions.length > 0) {
        const fits = sessions.some(
          (x) => x.weekday === day &&
            startTime >= x.starts_at.slice(0, 5) &&
            endTime <= x.ends_at.slice(0, 5),
        );
        if (!fits) {
          const onThatDay = sessions.filter((x) => x.weekday === day);
          return onThatDay.length
            ? `They work ${onThatDay.map((x) => `${x.starts_at.slice(0, 5)}–${x.ends_at.slice(0, 5)}`).join(", ")} on a ${from["weekday"]}`
            : `They do not work on a ${from["weekday"]}`;
        }
      }
    }

    // Unlike the patterns above, a recorded absence always blocks. There
    // is no reading of an empty absences table that should let a booking
    // through one somebody entered on purpose.
    const away = (await svc("absences").readByQuery({
      filter: {
        _and: [
          { status: { _neq: "cancelled" } },
          { starts_at: { _lt: ends_at } },
          { ends_at: { _gt: starts_at } },
          practitioner
            ? { _or: [{ practitioner: { _null: true } }, { practitioner: { _eq: practitioner } }] }
            : { practitioner: { _null: true } },
        ],
      },
      fields: ["kind", "practitioner"],
      limit: 1,
    })) as Array<{ kind: string; practitioner: string | null }>;
    if (away[0]) {
      return away[0].practitioner
        ? "That clinician is away then"
        : "The practice is closed then";
    }

    if (room) {
      const closed = (await svc("room_closures").readByQuery({
        filter: {
          _and: [
            { room: { _eq: room } },
            { starts_at: { _lt: ends_at } },
            { ends_at: { _gt: starts_at } },
          ],
        },
        fields: ["reason"],
        limit: 1,
      })) as Array<{ reason: string }>;
      if (closed[0]) return "That chair is out of service then";
    }

    return null;
  }

  /**
   * The columns that can make an appointment illegal.
   *
   * Mirrors the database trigger's `BEFORE UPDATE OF` list on purpose. A
   * patch that only sets `reminder_sent` or edits a note cannot create a
   * clash, and running the rules over it is not merely wasted work — it
   * would let a booking that has since become invalid (a chair closed
   * underneath it, a clinician who left) block an unrelated edit to a row
   * somebody is trying to correct.
   */
  const SCHEDULING_FIELDS = ["starts_at", "ends_at", "practitioner", "room", "status", "treatment"];

  /**
   * A portal login may only book on the record it belongs to.
   *
   * This is not belt-and-braces, it is the only place the rule can live.
   *
   * The Patient policy says it — `permissions: { patient: { portal_user:
   * { _eq: "$CURRENT_USER" } } }` on create — and **Directus ignores
   * `permissions` on a create**, because there is no existing row to
   * filter. The payload is checked against `validation` instead, and
   * `validation` cannot express `patient.portal_user` at all: it sees the
   * payload, and the payload has a patient *id*, not a patient.
   *
   * So a patient could book an appointment onto somebody else's record.
   * Both ways in: through the core service, and straight to
   * `/items/appointments` with their own token, which answered 204 —
   * created, and unreadable to the caller, which is how it stayed
   * invisible. The verify suite had a check for exactly this and it had
   * been passing for the wrong reason: the slot it tried was one the
   * patient had already booked in the line above, so the refusal it saw
   * was a double-booking clash rather than a permission.
   *
   * The rule is written without naming a role. A member of staff is
   * nobody's `portal_user`, so this does not apply to them; a portal
   * login is exactly one patient's, so it must match. Nothing here breaks
   * when somebody renames the Patient role.
   */
  async function ownRecordOnly(
    payload: Payload,
    key: string | undefined,
    schema: unknown,
    accountability: unknown,
  ): Promise<void> {
    const user = (accountability as { user?: string | null } | null)?.user;
    // No user means the service token or the hook's own admin context,
    // neither of which is a patient.
    if (!user) return;

    const patients = new ItemsService("patients", { schema, accountability: null });
    const mine = (await patients.readByQuery({
      filter: { portal_user: { _eq: user } },
      fields: ["id"],
      limit: 1,
    })) as Array<{ id?: string }>;
    const own = mine[0]?.id;
    if (!own) return; // Not a portal login.

    /*
     * On an update, only a payload that *moves* the appointment.
     *
     * Reading the stored row and checking that instead looked more
     * thorough and was worse: a patient cancelling somebody else's
     * appointment is refused by the permission layer with a 403, and this
     * hook runs first — so it turned an authorisation refusal into
     * "Invalid payload", which is both less true and less useful. The
     * permission filter already covers rows the caller cannot see, because
     * on an update there *is* an existing row to filter. What it cannot
     * cover is the payload, and the payload is this function's business.
     */
    const target = payload["patient"] as string | undefined;
    if (target && target !== own) {
      reject("you can only book and change appointments on your own record");
    }
  }

  async function guard(
    payload: Payload,
    key: string | undefined,
    ctx: { schema?: unknown; accountability?: unknown },
  ): Promise<Payload> {
    const schema = ctx.schema ?? (await getSchema());

    // Before the early return below, not after. A payload that touches no
    // scheduling field can still move an appointment onto somebody else's
    // record — `{ "patient": "<someone else>" }` mentions none of them.
    await ownRecordOnly(payload, key, schema, ctx.accountability);

    if (key && !SCHEDULING_FIELDS.some((f) => f in payload)) return payload;
    const appointment = await resolve(payload, key, schema, ctx.accountability);

    const derived = await deriveEnd(appointment, schema);
    if (derived) {
      payload["ends_at"] = derived;
      appointment.ends_at = derived;
    }

    if (appointment.starts_at && appointment.ends_at) {
      if (new Date(appointment.ends_at) <= new Date(appointment.starts_at)) {
        reject("an appointment has to end after it starts");
      }
    }

    // Availability before collision: "the practice is shut" is a more
    // useful answer than "that chair is taken", and on a closed day both
    // are true.
    const unavailable = await available(appointment, schema);
    if (unavailable) reject(unavailable);

    const conflict = await clash(appointment, schema);
    if (conflict) {
      const tz = await zoneOf(schema);
      reject(
        `${conflict.label} is already booked ${span(conflict.starts_at, conflict.ends_at, tz)}` +
          ` — pick another time, chair or clinician`,
      );
    }

    return payload;
  }

  filter("appointments.items.create", async (input, _meta, ctx) =>
    guard(input as Payload, undefined, ctx),
  );

  // An update can move one appointment or a hundred. Each key is checked
  // against the same merged view, because a batch that moves two
  // appointments onto the same slot is a conflict the payload alone
  // cannot show — both rows look fine in isolation.
  filter("appointments.items.update", async (input, meta, ctx) => {
    const keys = ((meta as { keys?: string[] }).keys ?? []) as string[];
    if (keys.length === 0) return guard(input as Payload, undefined, ctx);
    for (const key of keys) await guard({ ...(input as Payload) }, key, ctx);
    return input;
  });
});
