/**
 * Naming a provider you have not configured must stop the service.
 *
 * The failure this exists to prevent is the quiet one. Set
 * `SMS_PROVIDER=twilio`, forget the auth token, and the obvious
 * implementations all do the same thing: fall back to the mock, log a
 * warning nobody reads, and carry on. The practice then believes it is
 * texting patients about appointments. Nothing in the system says
 * otherwise — the `messages` rows say `sent`, because as far as the
 * mock is concerned they were.
 *
 * That is worse than not having SMS at all, so it is not a warning here.
 * The process refuses to start and says exactly which variables are
 * missing. A container that will not boot is a problem somebody fixes in
 * five minutes; a practice that quietly stopped reminding patients is a
 * problem somebody notices in a month, from the empty chairs.
 *
 * The same rule covers a **misspelt** provider. `SMS_PROVIDER=twillio` is
 * not a request for the mock, it is a typo, and answering it with the
 * mock is the same silent failure by another route.
 */

export type Needed = {
  /** Every one of these must be set. */
  all?: Record<string, string>;
  /**
   * At least one of these must be set — Twilio will take either a `From`
   * number or a Messaging Service, and requiring both would be wrong.
   */
  oneOf?: Record<string, string>;
  /** Set if present, left undefined if not. Regional endpoints, mostly. */
  optional?: Record<string, string>;
};

export class ProviderNotConfigured extends Error {}

/**
 * Read a provider's credentials, or refuse to start.
 *
 * `why` is the setting that asked for this provider, quoted back in the
 * message — because the person reading the log is looking for what to
 * change, and "SMS_PROVIDER=twilio" is that, while "Twilio is not
 * configured" is not.
 */
export function credentials<T extends Needed>(
  why: string,
  needed: T,
): Record<string, string | undefined> {
  const read = (name: string): string | undefined => {
    const value = process.env[name];
    return value && value.trim() ? value.trim() : undefined;
  };

  const out: Record<string, string | undefined> = {};
  const missing: string[] = [];

  for (const [key, name] of Object.entries(needed.all ?? {})) {
    const value = read(name);
    if (!value) missing.push(name);
    out[key] = value;
  }

  const alternatives = Object.entries(needed.oneOf ?? {});
  if (alternatives.length) {
    let any = false;
    for (const [key, name] of alternatives) {
      const value = read(name);
      if (value) any = true;
      out[key] = value;
    }
    if (!any) missing.push(`one of ${alternatives.map(([, n]) => n).join(" or ")}`);
  }

  for (const [key, name] of Object.entries(needed.optional ?? {})) {
    out[key] = read(name);
  }

  if (missing.length) {
    throw new ProviderNotConfigured(
      `\n\n  ${why}, but the credentials it needs are not set:\n` +
        missing.map((m) => `    - ${m}`).join("\n") +
        `\n\n  The service will not start on a half-configured provider. Falling back\n` +
        `  to the mock would mean the practice believes it is reaching patients\n` +
        `  when it is not, and every message row would say "sent".\n\n` +
        `  Set them, or put the setting back to "mock".\n`,
    );
  }

  return out;
}

/**
 * A named provider that does not exist is a typo, not a request for the mock.
 *
 * Generic in the option list so the return type is the **literal union**
 * rather than `string`. That is what lets the factory in
 * `adapters/select.ts` switch exhaustively with no `default` branch: a
 * provider added to the list and not handled is a compile error, which is
 * a better place to find it than a practice's outbox.
 */
export function known<T extends string>(setting: string, value: string, options: readonly T[]): T {
  if ((options as readonly string[]).includes(value)) return value as T;
  throw new ProviderNotConfigured(
    `\n\n  ${setting}=${value} is not a provider this service has.\n` +
      `  Known values: ${options.join(", ")}.\n\n` +
      `  Refused rather than defaulted: a misspelt provider name answered with\n` +
      `  the mock is the same silent failure as a missing credential.\n`,
  );
}
