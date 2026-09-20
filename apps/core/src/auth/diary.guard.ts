import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { DirectusService } from "../directus/directus.service";
import type { AuthedRequest } from "./directus-auth.guard";

/**
 * May this caller see a day's diary, patients' names and all.
 *
 * `DirectusAuthGuard` establishes that a token is real and names
 * somebody. For almost everything this service does that is enough,
 * because the work then goes back through the Directus API as the caller
 * and their policy decides what they get. The day sheet is the exception:
 * it is assembled in SQL, straight from Postgres, because drawing a chair
 * grid means asking questions about overlap that the items API cannot
 * express. Nothing about that query consults a policy.
 *
 * So for one endpoint the permission model has to be asked explicitly,
 * and the honest way to ask is to put the real question to Directus
 * rather than to re-implement it here: *may you read an appointment?* A
 * caller who cannot is not shown a day's worth of them.
 *
 * This was reachable, and briefly it was reached. Before there was a
 * Queue operator, every account that could sign in was clinical, so "any
 * valid token" and "somebody who may see the diary" happened to describe
 * the same people and nothing distinguished the check that was being made
 * from the check that was meant. Adding one deliberately non-clinical
 * account made the difference visible: it held no collection permissions
 * whatsoever and was served the day sheet in full — patient names, what
 * each was in for, and which chair they would be in. A latent hole, found
 * because something finally walked through it.
 *
 * Fails closed on every branch. A Directus that cannot be reached refuses
 * rather than admits, because the failure mode of guessing wrong here is
 * handing a stranger a list of patients.
 */
@Injectable()
export class DiaryGuard implements CanActivate {
  constructor(private readonly directus: DirectusService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = request.callerToken ?? "";

    if (!(await this.directus.maySeeTheDiary(token).catch(() => false))) {
      throw new ForbiddenException(
        "A day sheet lists patients by name and what each of them is in for, " +
          "so it is shown to the people who may read an appointment. Your role " +
          "does not include that.",
      );
    }
    return true;
  }
}
