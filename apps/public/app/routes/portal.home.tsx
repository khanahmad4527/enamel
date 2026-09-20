import { Form, Link, data, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/portal.home";
import { api, ApiError, type Env } from "~/lib/api.server";
import { requireToken, sessions } from "~/lib/session.server";
import { usePatient, usePractice } from "./portal";
import { Announce } from "~/components/form";
import { dateIn, longDateIn, money, personName, statusLabel, timeIn, tone } from "~/lib/format";

export function meta(_: Route.MetaArgs) {
  return [{ title: "My visits" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.env as unknown as Env;
  const storage = sessions(env);
  const session = await storage.getSession(request.headers.get("cookie"));
  const token = await requireToken(session, env.DIRECTUS_URL, storage);

  // Four independent reads, so one slow one does not serialise the page.
  // Each is permitted separately by the portal policy, and each is
  // allowed to fail on its own: a broken invoice list should not blank
  // out the appointments somebody came here to check.
  const [appointments, invoices, messages, documents] = await Promise.all([
    api.appointments(env, token.access).catch(() => []),
    api.invoices(env, token.access).catch(() => []),
    api.messages(env, token.access).catch(() => []),
    api.documents(env, token.access).catch(() => []),
  ]);

  return data(
    { appointments, invoices, messages, documents, directusUrl: env.DIRECTUS_URL },
    token.changed
      ? { headers: { "set-cookie": await storage.commitSession(session) } }
      : undefined,
  );
}

/**
 * Cancelling.
 *
 * The whole rule is a Directus permission — their own row, still in the
 * future, not already finished, and `status` the only writable field. So
 * this action does almost nothing: it forwards the patient's own token
 * and shows whatever sentence comes back.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.env as unknown as Env;
  const storage = sessions(env);
  const session = await storage.getSession(request.headers.get("cookie"));
  const token = await requireToken(session, env.DIRECTUS_URL, storage);

  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  if (!id) return data({ error: "Which appointment?", cancelled: false }, { status: 400 });

  try {
    await api.cancel(env, token.access, id);
  } catch (e) {
    const forbidden = e instanceof ApiError && (e.status === 403 || e.status === 404);
    return data(
      {
        error: forbidden
          ? "That appointment can no longer be cancelled online. Please ring the practice."
          : e instanceof ApiError
            ? e.message
            : "That appointment could not be cancelled.",
        cancelled: false,
      },
      { status: 400 },
    );
  }

  return { error: null, cancelled: true };
}

const OVER = new Set(["completed", "cancelled", "no_show"]);

export default function PortalHome({ loaderData, actionData }: Route.ComponentProps) {
  const patient = usePatient();
  const practice = usePractice();
  const zone = practice?.timezone ?? "UTC";
  const currency = practice?.currency ?? "EUR";
  const busy = useNavigation().state === "submitting";
  const justBooked = useSearchParams()[0].get("booked") === "1";
  const now = Date.now();

  const upcoming = loaderData.appointments
    .filter((a) => !OVER.has(a.status) && new Date(a.starts_at).getTime() > now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const [next, ...later] = upcoming;
  const past = loaderData.appointments.filter((a) => !upcoming.includes(a));
  const owing = loaderData.invoices.filter((i) => i.status !== "paid" && i.status !== "draft");

  return (
    <main className="shell" id="main">
      <div className="stack stack--loose">
        <header>
          <p className="eyebrow">
            {practice?.name ?? "Your practice"}
            {patient.reference ? ` · ${patient.reference}` : ""}
          </p>
          <h1 className="h1">Hello, {patient.first_name}</h1>
          {patient.status === "pending" ? (
            <p className="notice notice--warn" style={{ marginTop: 14 }}>
              The practice has not confirmed your record yet, so your past visits may not be
              listed. Anything you book here is real and will show on their diary.
            </p>
          ) : null}
        </header>

        {justBooked ? (
          <Announce>That is booked. It is on the practice diary now, and it is listed below.</Announce>
        ) : null}
        {actionData?.error ? <Announce tone="bad">{actionData.error}</Announce> : null}
        {actionData?.cancelled ? (
          <Announce>That appointment has been cancelled. The practice has been told.</Announce>
        ) : null}

        {/* The next appointment is the only thing on this page that
            lifts. Everything a patient opens this for is "when am I next
            in" — and in the first version it was the fifteenth identical
            row in a list, indistinguishable from an appointment three
            months away. */}
        {next ? (
          <section className="feature stack" aria-labelledby="next-title">
            <div className="row row--split">
              <p className="eyebrow" style={{ margin: 0 }}>Your next appointment</p>
              <span className={`pill ${tone(next.status)}`}>{statusLabel(next.status)}</span>
            </div>
            <h2 className="h1" id="next-title" style={{ fontSize: "clamp(24px, 3.5vw, 32px)" }}>
              {dateIn(next.starts_at, zone)}
            </h2>
            <p className="lede" style={{ marginTop: 0 }}>
              {timeIn(next.starts_at, zone)}–{timeIn(next.ends_at, zone)} with{" "}
              {personName(next.practitioner)}
              {next.reason ? ` · ${next.reason}` : ""}
            </p>
            <div className="row">
              <Link className="btn btn--primary" to="/portal/book">Book another</Link>
              <Form method="post">
                <input type="hidden" name="id" value={next.id} />
                <button className="btn" type="submit" disabled={busy}>Cancel this one</button>
              </Form>
            </div>
          </section>
        ) : (
          <section className="feature stack" aria-labelledby="next-title">
            <h2 className="h2" id="next-title">Nothing booked</h2>
            <p className="lede" style={{ marginTop: 0 }}>
              You can choose a time from the practice diary — these are real openings, not a
              request form.
            </p>
            <div className="row">
              <Link className="btn btn--primary" to="/portal/book">Book an appointment</Link>
            </div>
          </section>
        )}

        {later.length > 0 ? (
          <section className="panel" aria-labelledby="later-title">
            <h2 className="h2" id="later-title" style={{ marginBottom: 12 }}>
              Also booked
            </h2>
            <ul className="list">
              {later.map((a) => (
                <li key={a.id}>
                  <div className="entry">
                    <div className="entry__when">
                      {timeIn(a.starts_at, zone)}
                      <div className="small muted" style={{ fontWeight: 400 }}>
                        {dateIn(a.starts_at, zone)}
                      </div>
                    </div>
                    <div className="entry__what">
                      <div>{a.reason || "Appointment"}</div>
                      <div className="small muted">with {personName(a.practitioner)}</div>
                    </div>
                    <div className="entry__aside">
                      <span className={`pill ${tone(a.status)}`}>{statusLabel(a.status)}</span>
                      <Form method="post">
                        <input type="hidden" name="id" value={a.id} />
                        <button className="btn btn--quiet" type="submit" disabled={busy}>
                          Cancel
                        </button>
                      </Form>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <p className="hint">
              To move an appointment, cancel it and book the new time — that way the slot you
              are giving up goes back on the diary for somebody else straight away.
            </p>
          </section>
        ) : null}

        {owing.length > 0 ? (
          <section className="panel">
            <h2 className="h2" style={{ marginBottom: 12 }}>To pay</h2>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Issued</th>
                    <th>Due</th>
                    <th></th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {owing.map((i) => (
                    <tr key={i.id}>
                      <td>{i.number}</td>
                      <td>{i.issued_at?.slice(0, 10)}</td>
                      <td>{i.due_at?.slice(0, 10) ?? "—"}</td>
                      <td><span className={`pill ${tone(i.status)}`}>{statusLabel(i.status)}</span></td>
                      <td className="num">{money(i.total, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">
              Payment is taken at the practice. This site shows what is outstanding; it does
              not collect card details.
            </p>
          </section>
        ) : null}

        {past.length > 0 ? (
          <section className="panel">
            <div className="row row--split" style={{ marginBottom: 12 }}>
              <h2 className="h2">Previous visits</h2>
              {past.length > 8 ? (
                <span className="small muted">showing 8 of {past.length}</span>
              ) : null}
            </div>
            <ul className="list">
              {past.slice(0, 8).map((a) => (
                <li key={a.id}>
                  <div className="entry">
                    <div className="entry__when small">{longDateIn(a.starts_at, zone)}</div>
                    <div className="entry__what small">
                      {a.reason || "Appointment"} · {personName(a.practitioner)}
                    </div>
                    <div className="entry__aside">
                      <span className={`pill ${tone(a.status)}`}>{statusLabel(a.status)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {loaderData.messages.length > 0 ? (
          <section className="panel">
            <h2 className="h2" style={{ marginBottom: 12 }}>From the practice</h2>
            <ul className="list">
              {loaderData.messages.slice(0, 4).map((m) => (
                <li key={m.id}>
                  <div className="small muted">
                    {(m.sent_at ?? m.date_created).slice(0, 10)} · {m.channel}
                    {m.direction === "inbound" ? " · your reply" : ""}
                  </div>
                  {m.subject ? <div style={{ fontWeight: 500 }}>{m.subject}</div> : null}
                  <div className="small">{m.body}</div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {loaderData.documents.length > 0 ? (
          <section className="panel">
            <h2 className="h2" style={{ marginBottom: 12 }}>Your documents</h2>
            <ul className="list">
              {loaderData.documents.map((d) => (
                <li key={d.id}>
                  <div className="entry">
                    <div className="entry__when small">{(d.taken_on ?? d.date_created).slice(0, 10)}</div>
                    <div className="entry__what small">
                      {d.note || statusLabel(d.kind)}
                      <span className="pill" style={{ marginLeft: 8 }}>{statusLabel(d.kind)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <p className="hint">
              Consent forms and letters only. Radiographs and clinical images are not shown
              here — they are read with your dentist, not alone on a phone.
            </p>
          </section>
        ) : null}
      </div>
    </main>
  );
}
