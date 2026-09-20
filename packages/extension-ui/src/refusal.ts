/**
 * What went wrong, said to the person looking at the screen.
 *
 * Every extension here talks to an API that refuses things on purpose,
 * and the refusals arrive written for an API caller: "Your account is not
 * attached to a practice, so there is no diary to read." That sentence is
 * correct and it is addressed to a program. A human who has just clicked
 * Day sheet needs to know what to do next, and that it is not broken.
 *
 * The distinction this file exists to make is between an **error** and a
 * **condition**. A network timeout is an error — something failed, red is
 * right, "try again" is the action. Being signed in as an administrator,
 * which deliberately belongs to no practice, is not a failure of anything:
 * it is the access model working exactly as designed. Rendering it in red
 * with an alert icon tells the reader the software is broken, which is
 * both untrue and the opposite of the point this project is making.
 */

export type StateKind = "error" | "condition" | "empty";

export type Refusal = {
  kind: StateKind;
  title: string;
  body: string;
  /** A concrete next step, when there is one worth naming. */
  hint?: string;
};

/**
 * Demo credentials in a message, on purpose.
 *
 * This is a demonstration repository whose whole argument is "sign in as
 * one role, then another, and compare". Telling somebody which account to
 * use is the single most useful sentence the screen can carry. A product
 * would say "ask your practice administrator" instead; the shape of the
 * message is the same either way.
 */
const STAFF_ACCOUNT = "desk@kadehuis.example.com";

type ApiLike = {
  response?: { status?: number; data?: { errors?: Array<{ message?: string }> } };
  message?: string;
  status?: number;
};

/** The sentence out of whichever shape the failure arrived in. */
export function messageOf(e: unknown): string {
  const err = e as ApiLike | null;
  return (
    err?.response?.data?.errors?.[0]?.message ??
    err?.message ??
    "Something went wrong."
  );
}

export function statusOf(e: unknown): number | undefined {
  const err = e as ApiLike | null;
  return err?.response?.status ?? err?.status;
}

/**
 * Classify a failure into something worth rendering.
 *
 * Ordered by how specific the answer is. The first case is the one that
 * sent two modules into an error state for every administrator who ever
 * opened them.
 */
export function refusalFrom(e: unknown): Refusal {
  const message = messageOf(e);
  const status = statusOf(e);

  // The account has no practice. Almost always the Administrator, which
  // has none by design — "the superuser sees every practice" is exactly
  // the default that turns into a tenancy bug.
  if (/not attached to a practice/i.test(message)) {
    return {
      kind: "condition",
      title: "This view belongs to a practice",
      body:
        "You are signed in as an administrator, which deliberately does not belong to " +
        "any one practice — every query here is scoped to the practice on your account, " +
        "and a superuser who could see all of them is how a multi-tenant system stops " +
        "being one.",
      hint: `Sign in as a member of staff to use it — ${STAFF_ACCOUNT} for the demo.`,
    };
  }

  if (status === 401) {
    return {
      kind: "condition",
      title: "Your session has expired",
      body: "Sign in again to carry on.",
    };
  }

  if (status === 403) {
    return {
      kind: "condition",
      title: "Your role does not open this",
      body: message,
      hint: "This is the access model working, not a fault.",
    };
  }

  // No response at all: the service is down or unreachable. The one case
  // where "try again" is honest advice.
  if (status === undefined && /network|fetch|failed/i.test(message)) {
    return {
      kind: "error",
      title: "Cannot reach the practice service",
      body: "The core service did not answer.",
      hint: "It may be starting up. Try again in a moment.",
    };
  }

  return { kind: "error", title: "Something went wrong", body: message };
}
