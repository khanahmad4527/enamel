import type { Provider } from "@nestjs/common";
import { config, providers } from "../../config/config";
import type { ChannelAdapter } from "../channel";
import { EmailAdapter } from "./email.adapter";
import { MockSmsAdapter } from "./mock-sms.adapter";
import { MockWhatsAppAdapter } from "./mock-whatsapp.adapter";
import { TwilioSmsAdapter } from "./twilio-sms.adapter";
import { MetaWhatsAppAdapter } from "./meta-whatsapp.adapter";

/**
 * Which class answers for which channel, decided once, from the
 * environment.
 *
 * Injection tokens rather than concrete classes, because the choice is a
 * deployment's to make and Nest resolves a class by identity. With
 * `constructor(sms: SmsAdapter)` the mock is welded into the type of
 * everything above it, and "swap the provider" becomes "edit a
 * constructor" — which is the opposite of the claim this file exists to
 * support.
 *
 * The switch is exhaustive with no `default`. A provider name that is not
 * handled here is a compile error rather than a silent mock, and the
 * *names* were already refused at config time by `known()`.
 */
export const SMS_ADAPTER = Symbol("sms adapter");
export const WHATSAPP_ADAPTER = Symbol("whatsapp adapter");

export const messagingAdapterProviders: Provider[] = [
  EmailAdapter,
  MockSmsAdapter,
  MockWhatsAppAdapter,

  {
    provide: SMS_ADAPTER,
    useFactory: (): ChannelAdapter => {
      switch (config.messaging.smsProvider) {
        case "twilio":
          return new TwilioSmsAdapter(providers.twilio!);
        case "mock":
          return new MockSmsAdapter();
      }
    },
  },
  {
    provide: WHATSAPP_ADAPTER,
    useFactory: (): ChannelAdapter => {
      switch (config.messaging.whatsappProvider) {
        case "meta":
          return new MetaWhatsAppAdapter(providers.whatsapp!);
        case "mock":
          return new MockWhatsAppAdapter();
      }
    },
  },
];
