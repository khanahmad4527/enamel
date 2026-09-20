/**
 * The four places this system touches something outside itself.
 *
 * Same shape as the messaging channel adapters next door, and for the
 * same reason: everything above an adapter knows there is a thing you can
 * hand a request to, which either accepts it and returns the other
 * side's id, or refuses and says why. Swapping a provider is writing one
 * of these; nothing else moves.
 *
 * Every adapter says out loud what it is. Two of the four here are mocks
 * and two are real, and a demo that quietly pretends to hold a payment
 * gateway account is worse than one with no payments at all — so
 * `describe` is logged at boot, returned by the API, and printed in the
 * README.
 *
 * `kind` is the honest label, and there are three rather than two:
 *
 *   real    — it does the thing, here, with no account anywhere. The
 *             journal CSV and the calendar feed are genuinely real; they
 *             are files, and a file is not a simulation of a file.
 *   manual  — it records something a person did. The desk terminal is
 *             this: a receptionist took forty euros in cash, and writing
 *             that down is the entire integration. Calling it `real`
 *             would overclaim and calling it `mock` would be wrong —
 *             nothing is being simulated.
 *   mock    — it stands in for a provider this repo has no account with.
 *             Every id it returns is visibly prefixed `mock:`, because an
 *             id that looks like a real one will end up quoted in a
 *             support email one day.
 */
export type AdapterKind = "real" | "manual" | "mock";

export type IntegrationResult<T = Record<string, unknown>> =
  | ({ ok: true; reference: string } & T)
  | { ok: false; reason: string; retryable: boolean };

export interface Integration {
  /** `payments.mock-gateway`, `accounting.journal-csv`, and so on. */
  readonly id: string;
  readonly kind: AdapterKind;
  /** One sentence, for the boot log, the API and the README. */
  readonly describe: string;
}

/**
 * A mock id, marked as one.
 *
 * Not cosmetic. The first time somebody reads one of these out to a
 * provider's support line, the prefix is what saves the conversation.
 */
export function mockReference(prefix: string, seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return `mock:${prefix}_${hash.toString(36).padStart(7, "0")}`;
}
