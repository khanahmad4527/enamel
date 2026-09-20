/**
 * The real adapters, against a server speaking the providers' documented
 * wire formats.
 *
 * This repository has no Twilio account, no Meta business, and no Stripe
 * key, and it is not going to get them. That is normally where an
 * integration stops being testable and starts being a comment saying "the
 * real implementation is about fifteen lines".
 *
 * It does not have to. Every one of these adapters takes its base URL
 * from the environment — because a real deployment needs that anyway, for
 * Twilio's regional endpoints, for Meta's pinned Graph version, and for
 * `stripe-mock`. So the *actual* adapter classes can be pointed at a
 * server that answers the way each provider's reference says it does, and
 * the things worth asserting can be asserted:
 *
 *   - the method, path, auth scheme and content type
 *   - the exact parameter names each API requires
 *   - and the judgement the queue depends on: which failures are worth
 *     retrying and which are facts that will not change
 *
 * What it does **not** prove is that the provider agrees. A stub answers
 * how the documentation says it will; a live account is the only thing
 * that shows it does. That is the honest boundary of this file and it is
 * written here rather than implied.
 *
 * Run: pnpm --filter @enamel/core test:adapters
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

type Seen = { method: string; url: string; headers: Record<string, string>; body: string };

/*
 * `config.ts` reads the whole environment at import, and refuses to load
 * without a database password. That is right for the service and
 * irrelevant here — nothing below touches a database. Set before the first
 * import of anything that reaches config, which is why it is up here and
 * not in a `beforeEach`.
 */
process.env["DB_PASSWORD"] ||= "not-used-by-this-test";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A server that records what it was asked and answers what it was told to. */
async function stub(
  reply: (seen: Seen) => { status: number; body: unknown },
): Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const record: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]),
        ),
        body,
      };
      seen.push(record);
      const answer = reply(record);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const outbound = (to: string, body = "Your appointment is on Tuesday at 10:00.") => ({
  to, body, reference: "msg-1",
});

async function twilio(): Promise<void> {
  let answer: { status: number; body: unknown } = {
    status: 201,
    body: { sid: "SM0123456789abcdef0123456789abcdef", status: "queued", error_code: null },
  };
  const server = await stub(() => answer);

  const { TwilioSmsAdapter } = await import("../src/messaging/adapters/twilio-sms.adapter");
  const adapter = new TwilioSmsAdapter({
    accountSid: "ACtest0000000000000000000000000000",
    authToken: "secret-auth-token",
    from: "+31201234567",
    apiBase: server.base,
  });

  const sent = await adapter.send(outbound("+31612345678"));
  const req = server.seen[0]!;
  const form = new URLSearchParams(req.body);

  check("twilio: POSTs to the documented Messages resource",
    req.method === "POST" &&
      req.url === "/2010-04-01/Accounts/ACtest0000000000000000000000000000/Messages.json",
    `${req.method} ${req.url}`);
  check("twilio: basic auth with the account SID and auth token",
    req.headers["authorization"] ===
      `Basic ${Buffer.from("ACtest0000000000000000000000000000:secret-auth-token").toString("base64")}`);
  check("twilio: form-encoded, as the API requires",
    (req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded"),
    req.headers["content-type"]);
  check("twilio: sends To, From and Body",
    form.get("To") === "+31612345678" && form.get("From") === "+31201234567" &&
      (form.get("Body") ?? "").startsWith("Your appointment"),
    [...form.keys()].join(","));
  check("twilio: returns the message SID as the provider id",
    sent.ok && sent.providerId === "SM0123456789abcdef0123456789abcdef");

  // A Messaging Service replaces From — sending both is rejected by the API.
  const withService = new TwilioSmsAdapter({
    accountSid: "ACtest0000000000000000000000000000",
    authToken: "secret-auth-token",
    from: "+31201234567",
    messagingServiceSid: "MGtest0000000000000000000000000000",
    apiBase: server.base,
  });
  await withService.send(outbound("+31612345678"));
  const second = new URLSearchParams(server.seen[1]!.body);
  check("twilio: a Messaging Service replaces From rather than joining it",
    second.get("MessagingServiceSid") === "MGtest0000000000000000000000000000" && !second.has("From"),
    [...second.keys()].join(","));

  // The judgement the queue depends on.
  answer = { status: 400, body: { code: 21610, message: "The recipient has opted out." } };
  const stopped = await adapter.send(outbound("+31612345678"));
  check("twilio: an opted-out recipient (21610) is NOT retried",
    !stopped.ok && stopped.retryable === false,
    stopped.ok ? "accepted" : stopped.reason);

  answer = { status: 429, body: { code: 20429, message: "Too many requests" } };
  const throttled = await adapter.send(outbound("+31612345678"));
  check("twilio: a 429 IS retried", !throttled.ok && throttled.retryable === true);

  answer = { status: 500, body: { message: "Internal error" } };
  const broken = await adapter.send(outbound("+31612345678"));
  check("twilio: a 500 IS retried", !broken.ok && broken.retryable === true);

  // A 201 is not a delivery: Twilio reports `failed` on this same response.
  answer = {
    status: 201,
    body: { sid: "SMfailed", status: "failed", error_code: 21614, error_message: "Not a mobile number" },
  };
  const failed = await adapter.send(outbound("+31612345678"));
  check("twilio: a 201 carrying status=failed is a failure, not a send",
    !failed.ok && failed.retryable === false,
    failed.ok ? "reported as sent" : failed.reason);

  // ...and the same path with a code that IS worth another attempt, so
  // the list is asserted in both directions. Sabotaging it must fail more
  // than one assertion, or half of it is never exercised.
  answer = {
    status: 201,
    body: { sid: "SMqueued", status: "failed", error_code: 30001, error_message: "Queue overflow" },
  };
  const overflowed = await adapter.send(outbound("+31612345678"));
  check("twilio: a queue overflow (30001) reported the same way IS retried",
    !overflowed.ok && overflowed.retryable === true,
    overflowed.ok ? "accepted" : overflowed.reason);

  // Never leaves the building if the number cannot work.
  const local = await adapter.send(outbound("07700 900123"));
  check("twilio: a number with no country code is refused before the call",
    !local.ok && local.retryable === false && server.seen.length === 7,
    `${server.seen.length} requests reached the stub`);

  await server.close();
}

async function whatsapp(): Promise<void> {
  let answer: { status: number; body: unknown } = {
    status: 200,
    body: { messaging_product: "whatsapp", contacts: [{ wa_id: "31612345678" }], messages: [{ id: "wamid.TEST" }] },
  };
  const server = await stub(() => answer);

  const { MetaWhatsAppAdapter } = await import("../src/messaging/adapters/meta-whatsapp.adapter");
  const adapter = new MetaWhatsAppAdapter({
    phoneNumberId: "1234567890",
    token: "EAAG-test-token",
    template: "appointment_reminder_v1",
    language: "nl",
    apiBase: server.base,
    version: "v21.0",
  });

  const sent = await adapter.send(outbound("+31612345678", "Your appointment\nis on Tuesday."));
  const req = server.seen[0]!;
  const body = JSON.parse(req.body) as {
    messaging_product?: string; to?: string; type?: string;
    template?: { name?: string; language?: { code?: string }; components?: Array<{ parameters?: Array<{ text?: string }> }> };
  };

  check("whatsapp: POSTs to /{version}/{phone-number-id}/messages",
    req.method === "POST" && req.url === "/v21.0/1234567890/messages", `${req.method} ${req.url}`);
  check("whatsapp: bearer token and JSON",
    req.headers["authorization"] === "Bearer EAAG-test-token" &&
      (req.headers["content-type"] ?? "").startsWith("application/json"));
  check("whatsapp: sends the approved template, not free text",
    body.messaging_product === "whatsapp" && body.type === "template" &&
      body.template?.name === "appointment_reminder_v1" && body.template.language?.code === "nl",
    JSON.stringify(body.template?.language));
  check("whatsapp: the number loses its leading + for Meta",
    body.to === "31612345678", String(body.to));
  check("whatsapp: newlines are folded out of the template parameter",
    !(body.template?.components?.[0]?.parameters?.[0]?.text ?? "").includes("\n"),
    JSON.stringify(body.template?.components?.[0]?.parameters?.[0]?.text));
  check("whatsapp: returns the wamid as the provider id", sent.ok && sent.providerId === "wamid.TEST");

  answer = { status: 400, body: { error: { message: "Template does not exist", code: 132001 } } };
  const noTemplate = await adapter.send(outbound("+31612345678"));
  check("whatsapp: an unapproved template (132001) is NOT retried",
    !noTemplate.ok && noTemplate.retryable === false,
    noTemplate.ok ? "accepted" : noTemplate.reason);

  answer = { status: 400, body: { error: { message: "Re-engagement message", code: 131047 } } };
  const window = await adapter.send(outbound("+31612345678"));
  check("whatsapp: outside the 24-hour window (131047) is NOT retried",
    !window.ok && window.retryable === false);

  answer = { status: 429, body: { error: { message: "Rate limit hit", code: 130429 } } };
  const throttled = await adapter.send(outbound("+31612345678"));
  check("whatsapp: a rate limit IS retried", !throttled.ok && throttled.retryable === true);

  answer = { status: 401, body: { error: { message: "Session expired", code: 190 } } };
  const expired = await adapter.send(outbound("+31612345678"));
  check("whatsapp: an expired token (190) is NOT retried — retrying cannot fix it",
    !expired.ok && expired.retryable === false);

  await server.close();
}

async function stripe(): Promise<void> {
  let answer: { status: number; body: unknown } = {
    status: 200,
    body: { id: "pi_test123", status: "succeeded", created: 1_757_800_000 },
  };
  const server = await stub(() => answer);

  const { StripeGatewayAdapter } = await import("../src/integrations/payments/stripe-gateway.adapter");
  const adapter = new StripeGatewayAdapter({ secretKey: "sk_test_abc123", apiBase: server.base });

  const base = {
    amountMinor: 4000, currency: "EUR", patient: "pat-1",
    description: "Check-up", idempotencyKey: "key-1",
  };

  // No card presented. Nothing about waiting makes one appear.
  const noCard = await adapter.charge(base);
  check("stripe: a charge with no PaymentMethod is refused and NOT retried",
    !noCard.ok && noCard.retryable === false && server.seen.length === 0,
    noCard.ok ? "accepted" : `${server.seen.length} requests reached the stub`);

  const charged = await adapter.charge({ ...base, paymentMethod: "pm_card_visa" });
  const req = server.seen[0]!;
  const form = new URLSearchParams(req.body);

  check("stripe: POSTs to /v1/payment_intents",
    req.method === "POST" && req.url === "/v1/payment_intents", `${req.method} ${req.url}`);
  check("stripe: the secret key is the basic-auth username with no password",
    req.headers["authorization"] === `Basic ${Buffer.from("sk_test_abc123:").toString("base64")}`);
  check("stripe: the caller's idempotency key travels as the documented header",
    req.headers["idempotency-key"] === "key-1", req.headers["idempotency-key"]);
  check("stripe: amount is integer minor units and currency is lowercase",
    form.get("amount") === "4000" && form.get("currency") === "eur",
    `${form.get("amount")} ${form.get("currency")}`);
  check("stripe: created and confirmed in one call, off-session",
    form.get("confirm") === "true" && form.get("off_session") === "true" &&
      form.get("payment_method") === "pm_card_visa");
  check("stripe: redirects are disallowed — nobody is at the keyboard",
    form.get("automatic_payment_methods[allow_redirects]") === "never");
  check("stripe: returns the PaymentIntent id as the reference",
    charged.ok && charged.reference === "pi_test123");

  answer = {
    status: 402,
    body: { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } },
  };
  const declined = await adapter.charge({ ...base, paymentMethod: "pm_card_visa", idempotencyKey: "key-2" });
  check("stripe: a decline is NOT retried, and the decline code is kept",
    !declined.ok && declined.retryable === false && declined.reason.includes("insufficient_funds"),
    declined.ok ? "accepted" : declined.reason);

  answer = { status: 429, body: { error: { type: "rate_limit_error", message: "Too many requests" } } };
  const throttled = await adapter.charge({ ...base, paymentMethod: "pm_card_visa", idempotencyKey: "key-3" });
  check("stripe: a rate limit IS retried", !throttled.ok && throttled.retryable === true);

  answer = { status: 500, body: { error: { type: "api_error", message: "Something went wrong" } } };
  const broken = await adapter.charge({ ...base, paymentMethod: "pm_card_visa", idempotencyKey: "key-4" });
  check("stripe: a 500 IS retried — the key makes that safe",
    !broken.ok && broken.retryable === true);

  answer = { status: 401, body: { error: { type: "authentication_error", message: "Invalid API Key" } } };
  const badKey = await adapter.charge({ ...base, paymentMethod: "pm_card_visa", idempotencyKey: "key-5" });
  check("stripe: a bad key is NOT retried", !badKey.ok && badKey.retryable === false);

  // A PaymentIntent that needs the patient to do something is not a payment.
  answer = { status: 200, body: { id: "pi_action", status: "requires_action", created: 1 } };
  const needsAction = await adapter.charge({ ...base, paymentMethod: "pm_card_visa", idempotencyKey: "key-6" });
  check("stripe: requires_action is a failure, not a payment",
    !needsAction.ok && needsAction.retryable === false,
    needsAction.ok ? "reported as taken" : needsAction.reason);

  await server.close();
}

/*
 * Wrapped rather than top-level `await`: this package compiles to
 * CommonJS, and esbuild refuses top-level await in a CJS output. Worth a
 * line because the error it gives names the format rather than the cause.
 */
async function main(): Promise<void> {
  await twilio();
  await whatsapp();
  await stripe();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
