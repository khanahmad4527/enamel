import { useState } from "react";
import { Form, data, redirect, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/portal.book";
import { api, ApiError, type Env } from "~/lib/api.server";
import { requireToken, sessions } from "~/lib/session.server";
import { usePatient, usePractice } from "./portal";
import { addDays, dayLabel, personName, todayIn } from "~/lib/format";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Book an appointment" }];
}

/** How far ahead to offer. Beyond a month the rota is mostly guesswork. */
const HORIZON_DAYS = 28;

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const storage = sessions(env);
  const session = await storage.getSession(request.headers.get("cookie"));
  const token = await requireToken(session, env.DIRECTUS_URL, storage);

  const url = new URL(request.url);
  const treatmentId = url.searchParams.get("treatment") ?? "";
  const practitioner = url.searchParams.get("practitioner") ?? "";

  const [treatments, practitioners] = await Promise.all([
    api.treatments(env, token.access).catch(() => []),
    api.practitioners(env, token.access).catch(() => []),
  ]);

  const chosen = treatments.find((t) => t.id === treatmentId);
  // The catalogue decides how long a check-up takes, not the patient and
  // not this page. Without a treatment chosen, ask for the shortest thing
  // the practice offers so the grid is not empty on first load.
  const duration = chosen?.duration_minutes ?? 30;

  let slots: Awaited<ReturnType<typeof api.slots>> | null = null;
  let problem: string | null = null;
  try {
    const from = todayIn("UTC");
    slots = await api.slots(env, token.access, {
      from,
      to: addDays(from, HORIZON_DAYS),
      duration: String(duration),
      limit: "120",
      ...(practitioner ? { practitioner } : {}),
    });
  } catch (e) {
    problem = e instanceof ApiError ? e.message : "Could not look up available times.";
  }

  return data(
    { treatments, practitioners, slots, problem, treatmentId, practitioner, duration },
    token.changed
      ? { headers: { "set-cookie": await storage.commitSession(session) } }
      : undefined,
  );
}

/**
 * Booking, through exactly the same door as the front desk.
 *
 * The core service writes back through Directus with the patient's own
 * token, so the create permission, the scheduling hook and the exclusion
 * constraints all apply. If the slot went in the two minutes since the
 * page was drawn, Postgres refuses and the sentence the receptionist
 * would read — "Dr Visser is already booked from 09:30 to 10:15" — is
 * the sentence shown here. That is the point of not having a second
 * booking path.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.env as unknown as Env;
  const storage = sessions(env);
  const session = await storage.getSession(request.headers.get("cookie"));
  const token = await requireToken(session, env.DIRECTUS_URL, storage);

  const form = await request.formData();
  const slot = String(form.get("slot") ?? "");
  if (!slot) {
    return data({ error: "Please choose a time." }, { status: 400 });
  }

  // "<starts_at>|<ends_at>|<practitioner>|<room>" — the slot exactly as
  // the search returned it, so nothing is recomputed between drawing the
  // grid and writing the row.
  const [starts_at, ends_at, practitioner, room] = slot.split("|");
  if (!starts_at || !ends_at) {
    return data({ error: "That time is no longer valid. Please pick another." }, { status: 400 });
  }

  // The patient id comes from the record this token can read, never from
  // the form. The create permission would refuse a forged one anyway —
  // this is the belt to that pair of braces.
  const record = await api.record(env, token.access);
  if (!record) {
    return data({ error: "This login is not linked to a patient record yet." }, { status: 400 });
  }

  const treatment = String(form.get("treatment") ?? "");
  const reason = String(form.get("reason") ?? "").trim().slice(0, 200);

  try {
    await api.book(env, token.access, {
      patient: record.id,
      starts_at,
      ends_at,
      ...(practitioner ? { practitioner } : {}),
      ...(room ? { room } : {}),
      ...(treatment ? { treatment } : {}),
      ...(reason ? { reason } : {}),
    });
  } catch (e) {
    return data(
      { error: e instanceof ApiError ? e.message : "That time could not be booked." },
      { status: 400 },
    );
  }

  return redirect("/portal?booked=1");
}

export default function Book({ loaderData, actionData }: Route.ComponentProps) {
  const patient = usePatient();
  const practice = usePractice();
  const [params] = useSearchParams();
  const [picked, setPicked] = useState("");
  const busy = useNavigation().state === "submitting";

  const zone = loaderData.slots?.timezone ?? practice?.timezone ?? "UTC";
  const byDay = new Map<string, NonNullable<typeof loaderData.slots>["slots"]>();
  for (const s of loaderData.slots?.slots ?? []) {
    const list = byDay.get(s.date) ?? [];
    list.push(s);
    byDay.set(s.date, list);
  }

  return (
    <main className="shell" id="main">
      <div className="stack stack--loose">
        <header>
          <p className="eyebrow">{practice?.name ?? "Your practice"}</p>
          <h1 className="h1">Book an appointment</h1>
          <p className="lede">
            These are real openings in the practice diary, drawn in {zone.replace("_", " ")} time —
            the clinician's rota, the chair, and everything already booked are all accounted for.
          </p>
        </header>

        {/* Filters are a GET: the URL holds what you are looking at, so the
            back button and a shared link both work. */}
        <Form method="get" className="feature">
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field--half">
              <label htmlFor="treatment">What do you need?</label>
              <select id="treatment" name="treatment" defaultValue={loaderData.treatmentId}>
                <option value="">A check-up or something short (30 minutes)</option>
                {loaderData.treatments.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {t.duration_minutes} min
                  </option>
                ))}
              </select>
            </div>
            <div className="field--half">
              <label htmlFor="practitioner">Anyone in particular?</label>
              <select id="practitioner" name="practitioner" defaultValue={loaderData.practitioner}>
                <option value="">No preference</option>
                {loaderData.practitioners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {personName(p, "A clinician")}
                    {p.job_title ? ` — ${p.job_title}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn" type="submit">Show times</button>
          </div>
        </Form>

        {actionData?.error ? (
          <p className="notice notice--bad" role="alert">{actionData.error}</p>
        ) : null}
        {loaderData.problem ? (
          <p className="notice notice--warn">{loaderData.problem}</p>
        ) : null}

        <Form method="post" className="stack">
          <input type="hidden" name="treatment" value={loaderData.treatmentId} />

          {byDay.size === 0 && !loaderData.problem ? (
            <p className="empty">
              No openings in the next {HORIZON_DAYS} days for that. Try a different clinician,
              or ring the practice.
            </p>
          ) : (
            <div className="days">
              {[...byDay.entries()].map(([date, list]) => (
                // A fieldset per day, so a screen reader announces which
                // date a time belongs to when it enters the group. All
                // the radios share one `name`, so they remain a single
                // choice across every day — arrow keys move through the
                // lot, which is what a person expects.
                <fieldset key={date}>
                  <legend className="day__head">
                    <span className="day__date">{dayLabel(date)}</span>
                    {/* A separator that exists only in the accessible
                        name. The two spans are flex children with a gap
                        between them, which is a space to look at and
                        nothing at all to a screen reader — the group was
                        being announced as "Monday 14 September29 times
                        available". Found by dumping the accessibility
                        tree; axe has no rule for it, and it is invisible
                        on screen. */}
                    <span className="sr-only">, </span>
                    <span className="small muted">
                      {list.length} {list.length === 1 ? "time available" : "times available"}
                    </span>
                  </legend>
                  <div className="slots">
                    {list.map((s) => {
                      const value = `${s.starts_at}|${s.ends_at}|${s.practitioner}|${s.room}`;
                      return (
                        <label key={value} className="slot">
                          <input
                            type="radio"
                            name="slot"
                            value={value}
                            checked={picked === value}
                            onChange={() => setPicked(value)}
                            /*
                             * The name a screen reader reads, written
                             * rather than assembled.
                             *
                             * The two spans below are a time over a name,
                             * which is right to look at and came out as
                             * "10:15Hannah Prins" in the accessibility
                             * tree — adjacent elements with a CSS gap
                             * between them and no text node. The day was
                             * missing too: these radios all share one
                             * `name` so the group spans every day, and
                             * "10:15" alone does not say which one.
                             */
                            aria-label={`${dayLabel(date)} at ${s.local_start} with ${s.practitioner_name}`}
                          />
                          <span className="slot__time" aria-hidden="true">{s.local_start}</span>
                          <span className="slot__who" aria-hidden="true">{s.practitioner_name}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
          )}

          {byDay.size > 0 ? (
            <div className="feature stack stack--tight">
              <div>
                <label htmlFor="reason">Anything the practice should know? (optional)</label>
                <input
                  id="reason"
                  name="reason"
                  maxLength={200}
                  placeholder="e.g. a sore tooth on the lower left"
                />
              </div>
              <div className="row">
                <button className="btn btn--primary" type="submit" disabled={busy || !picked}>
                  {busy ? "Booking…" : picked ? "Confirm this time" : "Choose a time above"}
                </button>
                {params.get("treatment") ? (
                  <span className="small muted">
                    {loaderData.duration} minutes with the clinician shown.
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </Form>
      </div>
    </main>
  );
}
