import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Module } from "@nestjs/common";
import { REMINDERS_QUEUE, RemindersProcessor } from "./reminders.processor";
import { SWEEP_QUEUE, RemindersSweep, SweepProcessor } from "./reminders.sweep";
import { RemindersController } from "./reminders.controller";
import { MessagingModule } from "../messaging/messaging.module";

@Module({
  imports: [
    MessagingModule,
    BullModule.registerQueue({ name: REMINDERS_QUEUE }),
    BullModule.registerQueue({ name: SWEEP_QUEUE }),
    // On the board, with a sentence each. A list of queue names tells
    // somebody looking at a stuck job nothing about which one matters.
    BullBoardModule.forFeature(
      {
        name: REMINDERS_QUEUE,
        adapter: BullMQAdapter,
        options: {
          description:
            "One job per appointment reminder. Retried five times; what is " +
            "left on the failed set is a patient who has not been told.",
        },
      },
      {
        name: SWEEP_QUEUE,
        adapter: BullMQAdapter,
        options: {
          description:
            "The timer that looks for appointments coming due. One repeating " +
            "job — if this is empty, no reminders are being found at all.",
        },
      },
    ),
  ],
  controllers: [RemindersController],
  providers: [RemindersProcessor, RemindersSweep, SweepProcessor],
  exports: [RemindersSweep],
})
export class RemindersModule {}
