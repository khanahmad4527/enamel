import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { ExpressAdapter } from "@bull-board/express";
import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config/config";
import { DbModule } from "./db/db.module";
import { AuditModule } from "./audit/audit.module";
import { DirectusModule } from "./directus/directus.module";
import { AvailabilityModule } from "./availability/availability.module";
import { ReportsModule } from "./reports/reports.module";
import { MessagingModule } from "./messaging/messaging.module";
import { PortalModule } from "./portal/portal.module";
import { ImagingModule } from "./imaging/imaging.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { RemindersModule } from "./reminders/reminders.module";
import { HealthModule } from "./health/health.module";
import { SubjectAccessModule } from "./subject-access/subject-access.module";
import { RetentionModule } from "./retention/retention.module";
import { RateLimitMiddleware } from "./limits/rate-limit.middleware";
import { QueuesModule } from "./queues/queues.module";
import { QueueDoorMiddleware } from "./queues/queue-door.middleware";

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: config.redis.host,
        port: config.redis.port,
        db: config.redis.db,
        // BullMQ blocks on BRPOPLPUSH for its whole lifetime. ioredis's
        // default retry ceiling kills a connection that is doing exactly
        // what it is supposed to, so the docs require this to be null.
        maxRetriesPerRequest: null,
      },
    }),
    DbModule,
    AuditModule,
    DirectusModule,
    AvailabilityModule,
    ReportsModule,
    MessagingModule,
    PortalModule,
    ImagingModule,
    IntegrationsModule,
    RemindersModule,
    HealthModule,
    SubjectAccessModule,
    RetentionModule,
    QueuesModule,

    /**
     * Bull Board, behind the door in `QueuesModule`.
     *
     * `forRootAsync` rather than `forRoot`, and the reason is dependency
     * injection. The `middleware` option is applied by Bull Board's own
     * root module, which does not import this one — so handing it the
     * `QueueDoorMiddleware` *class* asks Nest to resolve a provider from a
     * container that has never heard of it. A factory can inject the
     * instance here and pass a plain function that closes over it.
     *
     * The rejection is forwarded to `next` rather than dropped: an
     * unhandled promise rejection in Express middleware leaves the request
     * hanging until the client gives up, which looks like the service is
     * down rather than like Redis is.
     */
    ...(config.queues.boardEnabled
      ? [
          BullBoardModule.forRootAsync({
            imports: [QueuesModule],
            inject: [QueueDoorMiddleware],
            useFactory: (door: QueueDoorMiddleware) => ({
              route: config.queues.route,
              adapter: ExpressAdapter,
              middleware: (req: Request, res: Response, next: NextFunction) => {
                void door.use(req, res, next).catch(next);
              },
            }),
          }),
        ]
      : []),
  ],
  providers: [RateLimitMiddleware],
})
export class AppModule implements NestModule {
  /**
   * Everything except `/health`.
   *
   * The health endpoint is what the container orchestrator polls, several
   * times a minute, forever. Counting those against the same budget as
   * real traffic means a busy minute makes the service look unhealthy and
   * gets it restarted — a limiter that causes the outage it was meant to
   * prevent.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RateLimitMiddleware).exclude("health").forRoutes("*");
  }
}
