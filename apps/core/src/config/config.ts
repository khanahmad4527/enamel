/**
 * Everything the service needs from the environment, read once.
 *
 * Read here rather than scattered through the modules so that a missing
 * value fails at boot with the name of the variable, instead of at three
 * in the morning when the first reminder tries to send.
 *
 * That applies twice over to the provider blocks at the bottom. Naming a
 * real provider without its credentials **stops the process** — see
 * `credentials.ts` for why that is the only acceptable answer.
 */

import { credentials, known } from "../integrations/credentials";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — the core service cannot start without it`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const SMS_PROVIDERS = ["mock", "twilio"] as const;
export const WHATSAPP_PROVIDERS = ["mock", "meta"] as const;
export const PAYMENT_PROVIDERS = ["mock", "stripe"] as const;

const smsProvider = known("SMS_PROVIDER", process.env["SMS_PROVIDER"] || "mock", SMS_PROVIDERS);
const whatsappProvider = known(
  "WHATSAPP_PROVIDER", process.env["WHATSAPP_PROVIDER"] || "mock", WHATSAPP_PROVIDERS,
);
const paymentProvider = known(
  "PAYMENTS_PROVIDER", process.env["PAYMENTS_PROVIDER"] || "mock", PAYMENT_PROVIDERS,
);

/**
 * The credentials for whichever provider was named, read at import.
 *
 * Each block is `null` when the channel is mocked, and an object when it
 * is not — so "is this real" is a null check rather than a string compare
 * repeated in four files. Reading them here is what makes a
 * half-configured provider a boot failure: this module is imported before
 * Nest builds anything, so the process dies with the variable names in
 * the message rather than starting and pretending.
 */
export const providers = {
  /**
   * Twilio Programmable Messaging.
   * https://www.twilio.com/docs/messaging/api/message-resource
   *
   * `From` **or** `MessagingServiceSid` — the API takes either, and a
   * Messaging Service is what a practice sending at any volume actually
   * uses, because it carries the sender pool and the opt-out handling.
   */
  twilio: smsProvider === "twilio"
    ? credentials("SMS_PROVIDER=twilio", {
        all: { accountSid: "TWILIO_ACCOUNT_SID", authToken: "TWILIO_AUTH_TOKEN" },
        oneOf: { from: "TWILIO_FROM", messagingServiceSid: "TWILIO_MESSAGING_SERVICE_SID" },
        // Twilio publishes regional endpoints (api.au1.twilio.com and
        // others) for data-residency reasons, and a practice in the EU
        // may be obliged to use one.
        optional: { apiBase: "TWILIO_API_BASE", statusCallback: "TWILIO_STATUS_CALLBACK" },
      })
    : null,

  /**
   * WhatsApp Cloud API.
   * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
   *
   * The template is a required setting rather than an optional one, and
   * that is the whole caveat of this channel — see the adapter.
   */
  whatsapp: whatsappProvider === "meta"
    ? credentials("WHATSAPP_PROVIDER=meta", {
        all: {
          phoneNumberId: "WHATSAPP_PHONE_NUMBER_ID",
          token: "WHATSAPP_TOKEN",
          template: "WHATSAPP_TEMPLATE",
        },
        optional: {
          language: "WHATSAPP_TEMPLATE_LANGUAGE",
          apiBase: "WHATSAPP_API_BASE",
          version: "WHATSAPP_API_VERSION",
        },
      })
    : null,

  /**
   * Stripe PaymentIntents.
   * https://docs.stripe.com/api/payment_intents/create
   */
  stripe: paymentProvider === "stripe"
    ? credentials("PAYMENTS_PROVIDER=stripe", {
        all: { secretKey: "STRIPE_SECRET_KEY" },
        // stripe-mock listens on 12111 and speaks the real API, which is
        // how this adapter is exercised without an account.
        optional: { apiBase: "STRIPE_API_BASE" },
      })
    : null,
} as const;

export const config = {
  port: Number(optional("CORE_PORT", "8057")),

  /**
   * How this service is reached from outside.
   *
   * Only used to *print* a URL — the calendar feed one, which somebody
   * pastes into Google Calendar. A container's own host and port are the
   * wrong thing to hand out the moment there is anything in front of it,
   * and a feed URL that only works from inside the network is a feed
   * nobody can subscribe to.
   */
  publicBase: optional("CORE_PUBLIC_URL", `http://localhost:${optional("CORE_PORT", "8057")}`),

  /**
   * Peers whose `x-forwarded-for` this service will believe.
   *
   * A list, never `true`. Express's `trust proxy` set to `true` means
   * "believe whatever anybody claims about their own address", which
   * turns every per-IP control in this service into decoration — an
   * attacker sets a new header per request and each one is a fresh
   * bucket.
   *
   * The default is the private ranges, which is where the compose
   * network lives. A deployment where the load balancer is the only thing
   * that can reach this port narrows it to that balancer's address.
   */
  trustedProxies: optional("TRUSTED_PROXIES", "loopback, linklocal, uniquelocal")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * The service-wide limiter.
   *
   * Separate from the registration limiter in PortalService, which is
   * tighter and exists for a different reason. This one is the blunt
   * backstop: a caller hammering slot search with a valid token is still
   * a caller who should be slowed down, and nothing above this decides
   * that per endpoint.
   */
  rateLimit: {
    enabled: optional("CORE_RATE_LIMIT_ENABLED", "true") !== "false",
    points: Number(optional("CORE_RATE_LIMIT_POINTS", "300")),
    windowSeconds: Number(optional("CORE_RATE_LIMIT_WINDOW", "60")),
  },

  /**
   * Direct database access, for reading availability.
   *
   * Slot search reads five tables across a date range and intersects
   * them. Through the API that is dozens of round trips; in SQL it is
   * four queries. Reads only — every write goes back through Directus so
   * that policies, the scheduling hook and the audit trail all apply.
   *
   * This connection bypasses Directus permissions entirely, which is why
   * `AvailabilityService` filters every query by the clinic resolved from
   * the caller's own token. See the note on `scopeToClinic` there.
   */
  db: {
    host: optional("DB_HOST", "database"),
    port: Number(optional("DB_PORT", "5432")),
    database: optional("DB_DATABASE", "enamel"),
    user: optional("DB_USER", "enamel"),
    password: required("DB_PASSWORD"),
  },

  directus: {
    url: optional("DIRECTUS_URL", "http://directus:8055"),
    /**
     * The reminder sweep's own credential.
     *
     * Named for the job, not for this process, and that is the design
     * rather than an accident of naming. A background job with no user to
     * borrow a token from needs a static one, and a static token is the
     * credential most likely to end up in a log or a container image —
     * so what it can do if that happens is the only thing standing behind
     * it. This one reads the diary and sets one boolean.
     *
     * When this service grows a second job, that job gets its own
     * narrowly-scoped account rather than sharing this one. "The service's
     * token" is how a credential ends up able to do everything the service
     * can, which is everything.
     *
     * Request handlers never touch it: they use the caller's own token, so
     * a receptionist cannot reach anything through here that Directus
     * would refuse them directly.
     */
    reminderToken: process.env.REMINDER_TOKEN || "",

    /**
     * The portal's own account, for the one thing a patient cannot do as
     * themselves: create the login they do not yet have.
     *
     * A second narrowly-scoped credential rather than reusing the reminder
     * sweep's, for the same reason that one exists — a token that can
     * create users and a token that can mark a reminder sent should not be
     * the same token, because the blast radius of a leak is whatever the
     * token can do.
     */
    portalToken: process.env.PORTAL_TOKEN || "",
  },

  /**
   * Self-registration, which is the only unauthenticated surface here.
   *
   * Configurable because the right number depends on what sits in front
   * of it. Behind a WAF that already rate-limits by address these can be
   * tight; with nothing in front, they are the only brake there is.
   */
  portal: {
    registerLimit: Number(process.env.PORTAL_REGISTER_LIMIT ?? 20),
    registerWindowMinutes: Number(process.env.PORTAL_REGISTER_WINDOW_MINUTES ?? 60),
  },

  redis: {
    host: optional("REDIS_HOST", "cache"),
    port: Number(optional("REDIS_PORT", "6379")),
    /**
     * Database 1, not 0.
     *
     * Directus uses the same Redis for its cache, and a cache is a thing
     * you are allowed to throw away. Queue jobs are not. Separate logical
     * databases means a cache flush cannot take the reminder backlog with
     * it, which is the kind of coupling nobody notices until the day it
     * matters.
     */
    db: Number(optional("REDIS_QUEUE_DB", "1")),
  },

  mail: {
    host: optional("EMAIL_SMTP_HOST", "mail"),
    port: Number(optional("EMAIL_SMTP_PORT", "1025")),
    from: optional("EMAIL_FROM", "reception@enamel.dev"),
  },

  /**
   * Which provider each channel talks to.
   *
   * `mock` is the honest default: email goes to Mailpit, which is a real
   * SMTP server that never forwards, and SMS and WhatsApp are recorded
   * with a visible `mock:` id and never sent. Naming the provider here
   * rather than inferring it from whether credentials happen to be set
   * means a misconfigured deployment says "mock" out loud instead of
   * silently not texting anybody.
   *
   * A name this service does not have is refused rather than defaulted:
   * `SMS_PROVIDER=twillio` is a typo, and answering a typo with the mock
   * is the silent failure this whole arrangement exists to prevent.
   */
  messaging: {
    smsProvider: known("SMS_PROVIDER", optional("SMS_PROVIDER", "mock"), SMS_PROVIDERS),
    whatsappProvider: known(
      "WHATSAPP_PROVIDER", optional("WHATSAPP_PROVIDER", "mock"), WHATSAPP_PROVIDERS,
    ),
    /** How often the sweeps look for messages that have come due. */
    sweepMinutes: Number(optional("MESSAGING_SWEEP_MINUTES", "15")),
    /** How long past due before an invoice gets chased. */
    paymentChaseDays: Number(optional("PAYMENT_CHASE_DAYS", "7")),
    /**
     * The secret a provider's webhook presents when posting a reply.
     *
     * Separate from the operator token on purpose: Twilio has no Directus
     * account and never will, and reusing the operator credential would
     * hand a third party something that can also read the queue. Empty by
     * default, and the endpoint refuses everything until it is set —
     * an unauthenticated inbox is a spam sink attached to patient records.
     */
    inboundSecret: process.env.MESSAGING_INBOUND_SECRET || "",
  },

  /**
   * The queue board, and how a browser gets through a door that only
   * takes bearer tokens.
   *
   * Off by a single environment variable, because a deployment that has
   * no reason to expose a queue UI should not have to firewall one.
   */
  queues: {
    boardEnabled: optional("QUEUE_BOARD_ENABLED", "true") !== "false",
    route: optional("QUEUE_BOARD_ROUTE", "/queues"),
    /**
     * How long a one-time link stays redeemable.
     *
     * Sixty seconds is the time between clicking in Directus and the
     * browser arriving, not the time somebody needs to read a page. It is
     * also destroyed on first use, so this only bounds a link that was
     * never opened.
     */
    ticketSeconds: Number(optional("QUEUE_BOARD_TICKET_SECONDS", "60")),
    /** And how long the session it becomes lasts. Not extended on use. */
    sessionMinutes: Number(optional("QUEUE_BOARD_SESSION_MINUTES", "30")),
    /**
     * `secure` on the session cookie. Off for local http, where a secure
     * cookie is simply never sent — which presents as "the board signs me
     * out immediately" rather than as anything to do with TLS.
     */
    secureCookie: optional("QUEUE_BOARD_SECURE", "0") === "1",
  },

  /** Which gateway a card payment goes to. Cash and transfers never leave. */
  payments: {
    provider: paymentProvider,
  },

  reminders: {
    /** How far ahead of an appointment the reminder goes out. */
    leadHours: Number(optional("REMINDER_LEAD_HOURS", "24")),
    /** How often the sweep looks for appointments that have come due. */
    sweepMinutes: Number(optional("REMINDER_SWEEP_MINUTES", "15")),
    /**
     * Attempts before a job is left on the failed set for a human.
     *
     * The Directus flow this replaces had one attempt and no way to know
     * it had failed: the mail operation calls send() without awaiting it
     * and swallows the rejection, so a bounced reminder looked exactly
     * like a delivered one.
     */
    attempts: Number(optional("REMINDER_ATTEMPTS", "5")),
  },
} as const;

export type Config = typeof config;
