import { useEffect, useId, useRef, useState } from "react";
import type { FieldErrors } from "~/lib/schema";

/**
 * The form pieces, so the accessibility is written once.
 *
 * Every one of these was previously hand-rolled per form, which is how a
 * site ends up with `required` in the HTML and no visible marker, and an
 * error banner a screen reader never announces. A `<Field>` cannot be
 * rendered without a label, an id, and an error wired to the input by
 * `aria-describedby` — because those are what it is made of.
 *
 * Target is WCAG 2.2 AA.
 */

export function Field({
  name, label, error, hint, required, children,
}: {
  name: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  required?: boolean;
  children: (props: {
    id: string;
    name: string;
    required: boolean;
    "aria-invalid": boolean | undefined;
    "aria-describedby": string | undefined;
  }) => React.ReactNode;
}) {
  const id = `f-${name}`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  // Both, in reading order: the hint explains, the error corrects.
  const describedBy = [hint ? hintId : null, error ? errorId : null]
    .filter(Boolean).join(" ") || undefined;

  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? <span className="req" aria-hidden="true">*</span> : null}
      </label>
      {children({
        id,
        name,
        required: Boolean(required),
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
      })}
      {hint ? <p className="hint" id={hintId}>{hint}</p> : null}
      {error ? <p className="field__error" id={errorId}>{error}</p> : null}
    </div>
  );
}

/**
 * A password input with a reveal.
 *
 * Typing a twelve-character passphrase blind on a phone keyboard is how
 * people end up choosing six characters instead. The button is a real
 * button, announces its state, and never submits the form.
 */
export function Secret({
  autoComplete, ...field
}: {
  id: string;
  name: string;
  required: boolean;
  autoComplete: string;
  "aria-invalid": boolean | undefined;
  "aria-describedby": string | undefined;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="secret">
      <input {...field} type={shown ? "text" : "password"} autoComplete={autoComplete} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-pressed={shown}
        aria-label={shown ? "Hide password" : "Show password"}
      >
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  );
}

/**
 * Everything wrong with the form, at the top, as links.
 *
 * The part that makes it work is the focus move. An `aria-live` region is
 * announced once and then gone; a focused heading is somewhere the reader
 * is, that they can then read down from and tab into. Linking each
 * message to its field means the summary is a way to get there rather
 * than just a list of complaints.
 */
export function ErrorSummary({ errors, order }: { errors: FieldErrors; order: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const keys = order.filter((k) => errors[k]);
  const count = keys.length;

  useEffect(() => {
    if (count > 0) ref.current?.focus();
  }, [count, errors]);

  if (count === 0) return null;

  return (
    <div className="summary" ref={ref} tabIndex={-1} role="alert" aria-labelledby="summary-title">
      <h2 id="summary-title">
        {count === 1 ? "There is one thing to fix" : `There are ${count} things to fix`}
      </h2>
      <ul>
        {keys.map((key) => (
          <li key={key}>
            <a href={`#f-${key}`}>{errors[key]}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A status message that a screen reader will actually announce. */
export function Announce({ children, tone = "good" }: {
  children: React.ReactNode;
  tone?: "good" | "bad" | "warn";
}) {
  return (
    <p
      className={`notice notice--${tone}`}
      role={tone === "bad" ? "alert" : "status"}
      aria-live={tone === "bad" ? "assertive" : "polite"}
    >
      {children}
    </p>
  );
}

/** Stable ids for anything repeated, without reaching for an index. */
export function useFieldId(prefix: string): string {
  const id = useId();
  return `${prefix}-${id}`;
}

/**
 * Errors as somebody types, from the same schema the server uses.
 *
 * The rule this follows is the one that makes inline validation helpful
 * rather than hostile: **complain on blur, forgive on input**. Flagging a
 * half-typed email address while somebody is still typing it is a form
 * shouting at a person for not having finished, and it is the single
 * commonest way client-side validation makes a form worse. So a field is
 * checked when it is left, and any message on it is cleared the moment
 * they go back to fix it — which is also the moment the message has
 * stopped being true.
 *
 * The server's errors still win. These are a courtesy that saves a round
 * trip; the action re-checks everything and is what actually decides,
 * because anything else is a validation you can turn off with devtools.
 */
export function useLiveErrors<T>(
  schema: T,
  check: (schema: T, name: string, value: string, all: Record<string, string>) => string | undefined,
  serverErrors: FieldErrors,
) {
  const [live, setLive] = useState<FieldErrors>({});

  /*
   * A server answer is newer than anything typed before it, so it
   * replaces the local state rather than merging with it. Without this a
   * field the server has just accepted keeps a stale local complaint.
   *
   * Compared by *content*, and that is the whole of this comment's
   * reason for existing. The caller writes `actionData?.errors ?? {}`,
   * which is a new object on every render, so an identity comparison is
   * always unequal — the effect ran on every render, cleared the local
   * state, and every message this hook produced was erased in the same
   * frame it appeared. The symptom was a validation that silently did
   * nothing, which is the worst kind: the code was all there and looked
   * right.
   */
  const key = JSON.stringify(serverErrors);
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current !== key) {
      seen.current = key;
      setLive({});
    }
  }, [key]);

  const valuesOf = (el: { closest(s: string): HTMLFormElement | null }): Record<string, string> => {
    const form = el.closest("form");
    if (!form) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of new FormData(form).entries()) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  };

  return {
    /** Server first, then anything found since. */
    errors: { ...serverErrors, ...live } as FieldErrors,

    /** Spread onto an input: `{...live.on("email")}`. */
    on(name: string) {
      return {
        onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
          const message = check(schema, name, e.currentTarget.value, valuesOf(e.currentTarget));
          setLive((prev) => {
            const next = { ...prev };
            if (message) next[name] = message;
            else delete next[name];
            return next;
          });
        },
        onInput: () => {
          setLive((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
          });
        },
      };
    },
  };
}
