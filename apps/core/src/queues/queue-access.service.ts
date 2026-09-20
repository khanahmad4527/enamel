import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { config } from "../config/config";

export type QueueViewer = { id: string; name: string };

/**
 * Getting a browser through a door that only takes bearer tokens.
 *
 * Bull Board is a web page, and a browser following a link sends no
 * `Authorization` header. Every other endpoint here is protected by the
 * caller's Directus token, which is exactly the thing a `<a href>` cannot
 * carry. So the board needs a different way in, and the ways available
 * are worse than they look:
 *
 *   **Basic auth with its own credential.** A second login, which is the
 *   one thing this service has refused from the beginning. It would also
 *   be a password shared by everybody who ever needs to see a queue.
 *
 *   **`?token=<directus token>` in the URL.** It works, and it writes a
 *   live credential into browser history, the referrer of every outbound
 *   link, and any proxy log on the way. A token that can read every
 *   practice's data should not be recoverable by pressing Up in the
 *   address bar.
 *
 *   **A cookie set by a cross-origin fetch from the Directus admin.**
 *   Needs `SameSite=None; Secure`, which means it does not work over
 *   plain http at all — so the local stack and the deployment would
 *   behave differently in the one area where that is least acceptable.
 *
 * What is here instead: a **single-use ticket**. The admin extension asks
 * this service for one using the token it already holds; the service
 * checks with Directus that the caller is an administrator and returns a
 * URL good for sixty seconds and one visit. Opening it is a first-party
 * request to this origin, so the session cookie it sets has none of the
 * cross-site problems, and the ticket is destroyed in the same breath —
 * a URL left in history is already dead when somebody finds it.
 *
 * Both halves live in Redis rather than in memory, for the reason the
 * rate limiter does: this service can run as more than one container, and
 * a ticket issued by one replica has to be redeemable at another.
 */
@Injectable()
export class QueueAccessService implements OnModuleDestroy {
  private readonly log = new Logger(QueueAccessService.name);
  private readonly redis: Redis;
  private warned = false;

  constructor() {
    this.redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      db: config.redis.db,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on("error", (e) => {
      if (this.warned) return;
      this.warned = true;
      this.log.warn(`queue sign-in is degraded — Redis said: ${e.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  /** 256 bits from the system CSPRNG. Guessing is not the attack here. */
  private static secret(): string {
    return randomBytes(32).toString("base64url");
  }

  async issueTicket(viewer: QueueViewer): Promise<string> {
    const ticket = QueueAccessService.secret();
    await this.redis.set(
      `queueboard:ticket:${ticket}`,
      JSON.stringify(viewer),
      "EX",
      config.queues.ticketSeconds,
    );
    return ticket;
  }

  /**
   * Redeem a ticket, exactly once.
   *
   * `GETDEL` rather than a read followed by a delete: two commands is a
   * race, and the race is somebody replaying a ticket from a log while
   * the first visit is still in flight. One command means the second
   * caller gets nothing.
   */
  async redeemTicket(ticket: string): Promise<QueueViewer | null> {
    const raw = await this.redis.getdel(`queueboard:ticket:${ticket}`);
    if (!raw) return null;
    return JSON.parse(raw) as QueueViewer;
  }

  async openSession(viewer: QueueViewer): Promise<string> {
    const id = QueueAccessService.secret();
    await this.redis.set(
      `queueboard:session:${id}`,
      JSON.stringify(viewer),
      "EX",
      config.queues.sessionMinutes * 60,
    );
    return id;
  }

  /**
   * Whose session this is, if it is still one.
   *
   * Deliberately **not** sliding: the expiry is not extended on use. A
   * window onto every practice's patient names that stays open as long as
   * the tab does is a window somebody leaves open. Half an hour, then
   * back through Directus — which is one click, because the token is
   * already in that browser.
   */
  async readSession(id: string): Promise<QueueViewer | null> {
    const raw = await this.redis.get(`queueboard:session:${id}`);
    return raw ? (JSON.parse(raw) as QueueViewer) : null;
  }
}
