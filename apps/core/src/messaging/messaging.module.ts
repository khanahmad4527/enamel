import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Module } from "@nestjs/common";
import { MESSAGES_QUEUE, MessagesService } from "./messages.service";
import { MessagesProcessor } from "./messages.processor";
import { ChannelRegistry } from "./registry";
import { messagingAdapterProviders } from "./adapters/select";
import { MessagingController } from "./messaging.controller";
import { CampaignsSweep, CAMPAIGNS_QUEUE, CampaignsProcessor } from "./campaigns.sweep";

@Module({
  imports: [
    BullModule.registerQueue({ name: MESSAGES_QUEUE }),
    BullModule.registerQueue({ name: CAMPAIGNS_QUEUE }),
    BullBoardModule.forFeature(
      {
        name: MESSAGES_QUEUE,
        adapter: BullMQAdapter,
        options: {
          description:
            "Everything outbound — email, SMS, WhatsApp. A job here carries " +
            "the recipient and the body, which is why this board is not " +
            "reachable without an administrator's token.",
        },
      },
      {
        name: CAMPAIGNS_QUEUE,
        adapter: BullMQAdapter,
        options: {
          description:
            "The timers behind recalls and overdue-invoice chasing. Repeating " +
            "jobs; the work they find goes onto the messages queue.",
        },
      },
    ),
  ],
  controllers: [MessagingController],
  providers: [
    MessagesService, MessagesProcessor, ChannelRegistry,
    // Which class answers for SMS and WhatsApp is the environment's
    // decision, resolved in one place. See `adapters/select.ts`.
    ...messagingAdapterProviders,
    CampaignsSweep, CampaignsProcessor,
  ],
  exports: [MessagesService, ChannelRegistry, CampaignsSweep],
})
export class MessagingModule {}
