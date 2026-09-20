import { Module } from "@nestjs/common";
import { DirectusModule } from "../directus/directus.module";
import { QueueAccessService } from "./queue-access.service";
import { QueueDoorMiddleware } from "./queue-door.middleware";
import { QueuesController } from "./queues.controller";
import { QueueAdminGuard } from "./queue-admin.guard";

/**
 * The door and the doorkeeper.
 *
 * The board itself is mounted by `BullBoardModule.forRoot` in
 * `app.module.ts`, which is where the queues are wired in; this module
 * owns everything that decides who reaches it. `QueueDoorMiddleware` is
 * exported because that root module is the thing that applies it.
 */
@Module({
  imports: [DirectusModule],
  controllers: [QueuesController],
  providers: [QueueAccessService, QueueDoorMiddleware, QueueAdminGuard],
  exports: [QueueAccessService, QueueDoorMiddleware, QueueAdminGuard],
})
export class QueuesModule {}
