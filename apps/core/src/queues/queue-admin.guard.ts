import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { DirectusService } from "../directus/directus.service";

export type AdminRequest = Request & { viewer: { id: string; name: string } };

/**
 * Who may open the job board.
 *
 * Two kinds of caller: an administrator, and anyone holding the "Queue
 * operator" policy. It used to be administrators alone, and that was the
 * wrong shape — `admin_access` is not "may see the job board", it is
 * every clinical note, every radiograph and the audit log. Watching a
 * failing reminder queue should not cost that, so the operator policy
 * grants no collection permissions at all and this guard recognises it
 * by name.
 *
 * The board still cannot be handed to a clinician unchanged, and the
 * reason survived the removal of multi-tenancy in a narrower form: a job
 * payload carries a patient's name, their appointment time and the
 * message body, and BullMQ has no notion of who may read which job. So
 * the grant is deliberate and the list of who holds it is short — not
 * "any signed-in member of staff".
 *
 * Failing closed is the property to preserve here. Every branch below
 * throws unless something positively says yes: no token, an invalid
 * token, a Directus that cannot be reached, a policy lookup that errors —
 * all of them refuse.
 */
@Injectable()
export class QueueAdminGuard implements CanActivate {
  constructor(private readonly directus: DirectusService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const header = request.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new UnauthorizedException("Send the Directus access token you already have.");

    let name = "an administrator";
    try {
      const me = await this.directus.whoami(token);
      name = [me.first_name, me.last_name].filter(Boolean).join(" ").trim() || name;
      request.viewer = { id: me.id, name };
    } catch {
      throw new UnauthorizedException("That token is not valid.");
    }

    // `.catch(() => false)` is the fail-closed half: a Directus that is
    // down, or a malformed answer, refuses rather than admits.
    if (!(await this.directus.mayOpenQueues(token).catch(() => false))) {
      throw new ForbiddenException(
        "Job payloads carry patients' names, so the board is not open to every " +
          "signed-in account. An administrator, or somebody with the Queue " +
          "operator policy, can open it.",
      );
    }
    return true;
  }
}
