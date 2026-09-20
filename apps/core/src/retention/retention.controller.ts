import { Controller, ForbiddenException, Get, Req, UseGuards } from "@nestjs/common";
import { DirectusAuthGuard, type AuthedRequest } from "../auth/directus-auth.guard";
import { RetentionService } from "./retention.service";

@Controller("retention")
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  /**
   * What has passed its retention period at this practice.
   *
   * Scoped to the caller's own practice, from their token — never from a
   * query parameter. The pool underneath bypasses Directus permissions
   * entirely, so this is the only thing standing between one practice and
   * another's records.
   *
   * It lists and it does not delete. See the service for why building the
   * half that destroys records without the half that authorises it would
   * be the wrong half to build.
   */
  @Get("due")
  @UseGuards(DirectusAuthGuard)
  async due(@Req() req: AuthedRequest) {
    /*
     * 403, and checked here rather than assumed from a role.
     *
     * The sample rows carry labels like "clinical note (examination)" and
     * "finding: penicillin allergy", and this service reads Postgres
     * directly — so there is no permission layer underneath to catch a
     * missing check. Without this a receptionist could read a list of
     * clinical notes, with patient ids, through a page about
     * housekeeping.
     */
    const denied = await this.retention.denied(req.callerToken);
    if (denied.length) {
      throw new ForbiddenException({
        message:
          "This lists records you are not allowed to read. It names clinical notes, findings " +
          "and payments, so it is shown only to somebody who can already open them.",
        denied,
      });
    }

    const review = await this.retention.review();
    return {
      ...review,
      note:
        "Nothing here is deleted by this system. A retention period is the minimum a practice " +
        "must keep, not a deadline to destroy — a record under a complaint or a claim is kept " +
        "past its period precisely because the period elapsed. Disposal is a decision somebody " +
        "reviews and signs for.",
    };
  }
}
