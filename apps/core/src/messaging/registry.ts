import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Channel, ChannelAdapter } from "./channel";
import { EmailAdapter } from "./adapters/email.adapter";
import { SMS_ADAPTER, WHATSAPP_ADAPTER } from "./adapters/select";

/**
 * Which adapter answers for which channel.
 *
 * Trivial on purpose. The value of the indirection is that everything
 * above it — the queue, the sweeps, the message log — has never heard of
 * Twilio, and adding a fourth channel is one file and one line here.
 *
 * It logs what each channel actually is at boot, because two of the three
 * are mocks and a system that quietly pretends to send text messages is
 * worse than one that admits it has none.
 */
@Injectable()
export class ChannelRegistry {
  private readonly log = new Logger(ChannelRegistry.name);
  private readonly adapters = new Map<Channel, ChannelAdapter>();

  constructor(
    email: EmailAdapter,
    @Inject(SMS_ADAPTER) sms: ChannelAdapter,
    @Inject(WHATSAPP_ADAPTER) whatsapp: ChannelAdapter,
  ) {
    for (const adapter of [email, sms, whatsapp]) {
      this.adapters.set(adapter.channel, adapter);
      this.log.log(`${adapter.channel}: ${adapter.detail ?? adapter.describe}`);
    }
  }

  /**
   * Ask each provider whether its credentials actually work.
   *
   * The missing half of "swap a provider by setting an environment
   * variable": setting one is easy and being sure it took is not. An
   * adapter with no `preflight` has nothing to check — the mocks, and the
   * SMTP transport, which proves itself by the first message arriving in
   * Mailpit.
   */
  async preflight(): Promise<Array<{ channel: Channel; describe: string; ok: boolean | null; detail: string }>> {
    return Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        const probe = (adapter as ChannelAdapter & {
          preflight?: () => Promise<{ ok: boolean; detail: string }>;
        }).preflight;
        if (!probe) {
          return {
            channel: adapter.channel, describe: adapter.describe,
            ok: null, detail: "nothing to check — no provider account is involved",
          };
        }
        const result = await probe.call(adapter).catch((e: unknown) => ({
          ok: false, detail: e instanceof Error ? e.message : String(e),
        }));
        return { channel: adapter.channel, describe: adapter.describe, ...result };
      }),
    );
  }

  for(channel: Channel): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  /**
   * What each channel is. `detail` is where it points and is withheld
   * unless the caller asked for it, because the one caller that does not
   * require a token is the public adapters endpoint.
   */
  describe(withDetail = false): Record<string, string> {
    return Object.fromEntries([...this.adapters].map(([c, a]) => [
      c, withDetail && a.detail ? `${a.describe} — ${a.detail}` : a.describe,
    ]));
  }
}
