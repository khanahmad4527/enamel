import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { DirectusService, type DirectusUser } from "../directus/directus.service";

export type AuthedRequest = Request & {
  caller: DirectusUser;
  callerToken: string;
};

/**
 * There is no second login.
 *
 * This service has its own database connection and its own port, and
 * neither of those is a reason to have its own idea of who anybody is.
 * The caller presents the Directus token they already have and it is
 * validated by asking Directus, so this service has no idea of identity
 * of its own.
 *
 * The alternative — a shared secret between the app and this service, or
 * a service token used for every request — would mean the carefully
 * tested permission model next door applied to Directus but not to this.
 *
 * This guard used to refuse any account with no `clinic`, which is how
 * the administrator was kept out of a practice's diary. That column is
 * gone with multi-tenancy; what this guard asserts now is only that the
 * token is real and names somebody.
 *
 * That is deliberately not the whole access decision, and it is worth
 * being exact about where the rest of it lives, because the imprecise
 * version of this sentence cost a leak. Everything this service *writes*
 * goes back through the Directus API as the caller, so their policy
 * applies with no help from here. Most of what it *reads* does too. The
 * exception is the handful of reads that are assembled in SQL because the
 * items API cannot express them — those consult no policy at all, and a
 * route like that needs a guard of its own saying who it is for. See
 * `DiaryGuard`, which exists because the day sheet did not have one.
 */
@Injectable()
export class DirectusAuthGuard implements CanActivate {
  constructor(private readonly directus: DirectusService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();

    const header = request.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      throw new UnauthorizedException("Send the Directus access token you already have.");
    }

    let user: DirectusUser;
    try {
      user = await this.directus.whoami(token);
    } catch {
      throw new UnauthorizedException("That token is not valid.");
    }

    request.caller = user;
    request.callerToken = token;
    return true;
  }
}
