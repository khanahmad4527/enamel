import { Controller, Get } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { DirectusService } from "../directus/directus.service";

/**
 * Unauthenticated on purpose, and it says nothing a stranger could use.
 *
 * Compose needs something to poll before it will route traffic here, and
 * requiring a Directus token for that would mean the healthcheck could
 * only pass once Directus was already up — which is precisely the
 * dependency a healthcheck exists to break.
 */
@Controller("health")
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly directus: DirectusService,
  ) {}

  @Get()
  async health() {
    const [database, directus] = await Promise.all([
      this.db.ping(),
      this.directus.healthy(),
    ]);
    return { ok: database && directus, database, directus };
  }
}
