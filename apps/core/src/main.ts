import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { config } from "./config/config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });

  /**
   * Who the caller actually is, when the caller is a server.
   *
   * The patient site is server-rendered, so every request it makes to
   * this service arrives from the site's container — one address for the
   * entire patient population. That is not an inconvenience, it is a
   * hole: the registration limiter counts attempts per IP, and with one
   * IP for everybody the twenty-first person to sign up in an hour is
   * refused because of the twenty before them. A control that limits the
   * whole internet as a single bucket is not a control.
   *
   * So the site forwards the real client address and Express resolves it
   * — but only from a peer on this list. `trust proxy` is exactly the
   * setting people enable as `true` and turn into a spoofing hole:
   * anybody who can reach this port then sets their own
   * `x-forwarded-for` and is whoever they like. The default below is the
   * compose network and nothing else.
   */
  app.set("trust proxy", config.trustedProxies);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // The admin extension calls this from the browser, on the Directus
  // origin rather than this one. Credentials are not used — the token
  // travels in the Authorization header — so a permissive origin here
  // grants nothing a caller could not already do with that token.
  app.enableCors({ origin: true, credentials: false });

  // Nothing in this service is reachable without a Directus token except
  // /health, so a prefix is about routing rather than protection.
  //
  // The queue board is excluded because it is a web page rather than an
  // API route — `/queues` is what somebody has open in a tab. The
  // exclusion matches that path exactly, so the endpoints that *issue* a
  // way in keep the prefix and land at `/api/queues/ticket` and
  // `/api/queues/board`, well clear of the board's own router.
  app.setGlobalPrefix("api", { exclude: ["health", config.queues.route.replace(/^\//, "")] });

  await app.listen(config.port, "0.0.0.0");
  new Logger("bootstrap").log(`core service listening on ${config.port}`);
}

void bootstrap();
