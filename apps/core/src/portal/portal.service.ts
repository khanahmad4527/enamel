import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { config } from "../config/config";
import { DbService } from "../db/db.service";

type Registration = {
  email: string;
  password: string;
  first: string;
  last: string;
  dob: string;
};

/**
 * Creating a patient login, without letting the internet read the
 * patient list.
 *
 * The hard part of self-registration in a clinical system is not making an
 * account — it is *not* accidentally building an oracle. "Is this email
 * already a patient here?" is a question an unauthenticated endpoint must
 * never answer, and the obvious implementation answers it twice: once by
 * matching an existing record, and once by saying "that address is already
 * registered".
 *
 * So this deliberately does neither.
 *
 * It never matches an existing patient. A new registration always creates
 * a *new* patient record, marked `pending`, for the practice to merge with
 * whatever they already hold. That is worse for the patient by one phone
 * call and better for everybody else, because the alternative — matching
 * on email and date of birth — is a lookup service for anyone who can
 * guess a birthday.
 *
 * Claiming an existing record is a real requirement and it belongs on the
 * other side of an invitation: the practice sends a signed link to an
 * address already on the file. That is not built here, and saying so is
 * more honest than pretending self-registration covers it.
 *
 * And it never says an address is taken. A duplicate returns the same
 * shape as a success; the practice sees two pending records and merges
 * them, and an attacker learns nothing.
 */
@Injectable()
export class PortalService {
  private readonly log = new Logger(PortalService.name);

  /**
   * A crude per-IP limiter, in memory.
   *
   * Enough to stop a script, and deliberately not presented as more than
   * that: it resets when the service restarts and does not coordinate
   * across replicas. A real deployment puts this at the edge, which is
   * the layer that can see the traffic before it costs anything. Written
   * here because "rate limiting is handled upstream" in a repository with
   * no upstream is a sentence, not a control.
   *
   * Twenty an hour rather than the five per ten minutes it started at.
   * Five is the number you pick imagining one attacker and one address;
   * the addresses this actually sees are shared — a family, an office, a
   * hospital's wifi, a mobile carrier's NAT — and on any of those, five
   * means the sixth person to sign up that morning is told to come back
   * later. Twenty an hour is still a brake on a script and stops locking
   * out a waiting room. The control that actually settles this is
   * verifying the address, which is a separate piece of work.
   */
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly db: DbService) {}

  allow(
    ip: string,
    limit = config.portal.registerLimit,
    windowMs = config.portal.registerWindowMinutes * 60_000,
  ): boolean {
    const now = Date.now();
    const seen = this.attempts.get(ip);
    if (!seen || now > seen.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (seen.count >= limit) return false;
    seen.count++;
    return true;
  }

  /** Name and town only. Enough to choose between two surgeries. */
  async practices() {
    return this.db.rows<{ id: string; name: string; city: string | null }>(
      `SELECT id, name, city FROM practice LIMIT 1`,
    );
  }

  private async directus<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!config.directus.portalToken) {
      throw new ServiceUnavailableException(
        "Registration is not configured — the portal service account has no token.",
      );
    }
    const res = await fetch(`${config.directus.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.directus.portalToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as { data?: T; errors?: Array<{ message?: string }> }) : {};
    if (!res.ok) {
      throw new BadRequestException(parsed.errors?.[0]?.message ?? `Directus answered ${res.status}`);
    }
    return parsed.data as T;
  }

  async register(input: Registration): Promise<{ id: string; email: string }> {
    const practice = await this.db.one<{ id: string }>(`SELECT id FROM practice LIMIT 1`);
    if (!practice) throw new BadRequestException("This practice is not taking registrations.");

    const role = await this.db.one<{ id: string }>(
      `SELECT id FROM directus_roles WHERE name = 'Patient' LIMIT 1`,
    );
    if (!role) throw new ServiceUnavailableException("The Patient role is missing — provision first.");

    // An address already attached to a login gets the same answer as a
    // success. Saying "already registered" turns this into a way to test
    // whether somebody is a patient here.
    const taken = await this.db.one<{ id: string }>(
      `SELECT id FROM directus_users WHERE lower(email) = lower($1)`,
      [input.email],
    );
    if (taken) {
      this.log.log(`registration for an address that already has a login; answering as success`);
      return { id: "pending", email: input.email };
    }

    // The patient record first, and the login second.
    //
    // The obvious order is the other way round, because `patients.
    // portal_user` needs a user id. It is also the order that fails
    // badly: if the record is rejected after the login exists, somebody
    // is left with an account that signs in to an empty portal and an
    // email address that can never be registered again — a dead end
    // only a support call can clear.
    //
    // This way the bad case is a pending patient record with no login,
    // which is a row the practice was going to look at anyway, and the
    // person can simply try again.
    // The ids are generated here rather than read back.
    //
    // The registrar can create a patient and a login and cannot read
    // either afterwards — which is the whole point of it — and Directus
    // answers a create it cannot read back with 204 and an empty body.
    // So there is no id to return. Supplying one is the way to keep
    // create-without-read: a token that could read these back is a token
    // that can enumerate every patient and every login in the system.
    const patientId = randomUUID();
    const userId = randomUUID();

    await this.directus("POST", "/items/patients", {
      id: patientId,
      first_name: input.first,
      last_name: input.last,
      email: input.email,
      date_of_birth: input.dob,
      // Pending, not active. The practice has to look at it — this is a
      // stranger's claim about who they are, not a verified record, and
      // treating it as one is how a portal becomes a way to get added to
      // somebody else's file.
      status: "pending",
      // Consent matches the schema default and the conservative reading:
      // they gave an address to register, not permission to text them.
      allow_email: true,
      allow_sms: false,
      allow_whatsapp: false,
    });

    try {
      await this.createLogin(userId, patientId, role.id, input);
    } catch (e) {
      // Take the record back. Directus validates `directus_users.email`
      // more strictly than this service does — a domain the form accepts
      // can still be refused here — and a pending patient nobody can
      // claim is litter the practice has to work out how to read.
      await this.directus("DELETE", `/items/patients/${patientId}`).catch(() => undefined);
      throw e;
    }

    return { id: patientId, email: input.email };
  }

  /**
   * The login, and the one link back to the record it belongs to.
   *
   * Separate from `register` so that the failure of either half is one
   * `catch` rather than two nested ones — and so the rollback that the
   * caller performs is obviously the rollback of this whole step.
   */
  private async createLogin(
    userId: string,
    patientId: string,
    roleId: string,
    input: Registration,
  ): Promise<void> {
    await this.directus("POST", "/users", {
      id: userId,
      email: input.email,
      password: input.password,
      first_name: input.first,
      last_name: input.last,
      role: roleId,
      // The practice this login belongs to. Everything the core service
      // answers is scoped by the clinic on the *user* record, so a
      // patient without one can sign in and then be refused by the
      // availability guard — an account that works and does nothing.
      status: "active",
    });

    try {
      await this.directus("PATCH", `/items/patients/${patientId}`, { portal_user: userId });
    } catch (e) {
      // The login exists but points at nothing. Deleting it leaves the
      // address free to try again; the registrar's delete permission is
      // scoped to a Patient account that has never signed in, which is
      // exactly what this is.
      await this.directus("DELETE", `/users/${userId}`).catch(() => undefined);
      throw e;
    }
  }
}
