import { Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import Redis from "ioredis";
import { config } from "../config/config";

/**
 * A service-wide limiter, counted in Redis.
 *
 * In memory would be simpler and would be wrong for the reason that keeps
 * catching people: this service can be run as more than one container,
 * and an in-memory counter then gives every replica its own budget. Three
 * replicas behind a load balancer means the configured limit is three
 * times what somebody thought they set, and the number in the config file
 * quietly stops describing the system. Redis is already here for the
 * message queue, so counting there costs one round trip and is correct
 * however many copies are running.
 *
 * `INCR` then `EXPIRE` on first write is a fixed window, and a fixed
 * window has a known flaw: a caller can spend the whole budget at the end
 * of one window and the whole budget at the start of the next, so the
 * worst case is twice the limit over a short span. A sliding window fixes
 * that and costs a sorted set per caller. For a backstop whose job is to
 * stop a script rather than to shape traffic precisely, twice the limit
 * for one second is not worth the memory — and saying which one this is
 * beats implying it is the other.
 *
 * Redis being unreachable does **not** refuse the request. A limiter that
 * fails closed turns a cache outage into an outage of the practice's
 * diary, which is a worse day than the one it was protecting against.
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly log = new Logger(RateLimitMiddleware.name);
  private readonly redis: Redis | null;
  private warned = false;

  constructor() {
    this.redis = config.rateLimit.enabled
      ? new Redis({
          host: config.redis.host,
          port: config.redis.port,
          db: config.redis.db,
          // Not the queue's `null`. A limiter that retries forever holds
          // the request open while Redis is down; one that gives up
          // immediately falls through to allowing it, which is the
          // behaviour this wants.
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          lazyConnect: false,
        })
      : null;

    // ioredis emits `error` on every reconnect attempt, and an
    // unhandled one takes the process down. Logged once, then quiet:
    // this is a backstop, and a cache outage should not also be a log
    // flood.
    this.redis?.on("error", (e) => {
      if (this.warned) return;
      this.warned = true;
      this.log.warn(`rate limiting is degraded — Redis said: ${e.message}`);
    });
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!this.redis) return next();

    // `req.ip` and not `req.socket.remoteAddress`: Express resolves the
    // forwarded chain against the trusted-proxy list set in main.ts, so
    // this is the patient's address when the patient site forwarded it
    // and the caller's own otherwise. Without that list it would be
    // whatever the caller claimed.
    const who = req.ip ?? "unknown";
    const window = config.rateLimit.windowSeconds;
    const key = `enamel:rl:${Math.floor(Date.now() / 1000 / window)}:${who}`;

    let used: number;
    try {
      const [incr] = (await this.redis
        .multi()
        .incr(key)
        .expire(key, window)
        .exec()) as Array<[Error | null, number]>;
      used = incr?.[1] ?? 0;
    } catch {
      // Fail open. See the note above.
      return next();
    }

    const remaining = Math.max(0, config.rateLimit.points - used);
    res.setHeader("RateLimit-Limit", String(config.rateLimit.points));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(window - (Math.floor(Date.now() / 1000) % window)));

    if (used > config.rateLimit.points) {
      // `Retry-After` is the part a well-behaved client acts on, and the
      // part most limiters forget to send.
      res.setHeader("Retry-After", String(window));
      res.status(429).json({
        statusCode: 429,
        error: "Too Many Requests",
        message: "Too many requests. Try again in a moment.",
      });
      return;
    }

    next();
  }
}
