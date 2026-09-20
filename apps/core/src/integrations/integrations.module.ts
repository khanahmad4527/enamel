import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { DirectusModule } from "../directus/directus.module";
import { IntegrationsController } from "./integrations.controller";
import { PaymentsService } from "./payments/payments.service";
import { paymentAdapterProviders } from "./payments/select";
import { AccountingService } from "./accounting/accounting.service";
import { JournalCsvAdapter } from "./accounting/journal-csv.adapter";
import { LabService } from "./lab/lab.service";
import { DocketAdapter } from "./lab/docket.adapter";
import { MockLabAdapter } from "./lab/mock-lab.adapter";
import { CalendarService } from "./calendar/calendar.service";
import { MessagingModule } from "../messaging/messaging.module";
import { QueuesModule } from "../queues/queues.module";

@Module({
  // MessagingModule for the channel registry, which this module's
  // `/adapters` and `/preflight` both report on; QueuesModule for the
  // administrator guard, which is the same rule as the queue board's and
  // belongs in one place rather than two.
  imports: [DbModule, DirectusModule, MessagingModule, QueuesModule],
  controllers: [IntegrationsController],
  providers: [
    PaymentsService,
    // Which gateway takes a card is the environment's decision.
    ...paymentAdapterProviders,
    AccountingService, JournalCsvAdapter,
    LabService, DocketAdapter, MockLabAdapter,
    CalendarService,
  ],
  exports: [PaymentsService, AccountingService, LabService, CalendarService],
})
export class IntegrationsModule {}
