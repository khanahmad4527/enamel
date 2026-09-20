import type { Provider } from "@nestjs/common";
import { config, providers } from "../../config/config";
import { DeskAdapter } from "./desk.adapter";
import { MockGatewayAdapter } from "./mock-gateway.adapter";
import { StripeGatewayAdapter } from "./stripe-gateway.adapter";
import type { PaymentGateway } from "./gateway";

/**
 * Which gateway a *card* goes to. Cash and bank transfers never leave the
 * building and are recorded by the desk adapter whatever this says.
 *
 * Same shape as the messaging selection next door, and the same reason:
 * the choice belongs to a deployment, and Nest resolves a class by
 * identity — so injecting `MockGatewayAdapter` anywhere welds the mock
 * into the type of everything above it.
 */
export const CARD_GATEWAY = Symbol("card gateway");

export const paymentAdapterProviders: Provider[] = [
  DeskAdapter,
  MockGatewayAdapter,
  {
    provide: CARD_GATEWAY,
    useFactory: (): PaymentGateway => {
      switch (config.payments.provider) {
        case "stripe":
          return new StripeGatewayAdapter(providers.stripe!);
        case "mock":
          return new MockGatewayAdapter();
      }
    },
  },
];
