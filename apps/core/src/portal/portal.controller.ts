import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Request } from "express";
import { PortalService } from "./portal.service";

/**
 * The two things a patient needs before they have an account.
 *
 * Everything else the portal does, it does as the patient — their own
 * Directus token, their own permissions, no filtering by this service and
 * so no filtering by this service to get wrong. These two cannot work that
 * way: listing the practices happens before anybody has signed in, and
 * registration is the act of creating the account itself.
 *
 * So this is the only unauthenticated surface in the system, and it is
 * shaped accordingly: two endpoints, both rate-limited by IP, neither able
 * to read an existing patient.
 */
@Controller("portal")
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  private ip(req: Request): string {
    return req.ip ?? "unknown";
  }

  /**
   * The practices somebody could register with.
   *
   * Public, and deliberately thin: a name and a town. Enough to choose
   * between two surgeries, nothing that would help an attacker enumerate
   * the deployment.
   */
  @Get("practices")
  async practices() {
    return this.portal.practices();
  }

  @Post("register")
  async register(@Body() body: Record<string, unknown>, @Req() req: Request) {
    if (!this.portal.allow(this.ip(req))) {
      // Nest has no TooManyRequestsException; 429 is the honest status and
      // a 400 here would read as "your details are wrong".
      throw new HttpException(
        "Too many attempts. Try again in a few minutes.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const str = (key: string, max = 120): string => {
      const v = body[key];
      return typeof v === "string" ? v.trim().slice(0, max) : "";
    };

    const email = str("email").toLowerCase();
    const password = typeof body["password"] === "string" ? body["password"] : "";
    const first = str("first_name", 60);
    const last = str("last_name", 60);
    const dob = str("date_of_birth", 10);

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
      throw new BadRequestException("That does not look like an email address.");
    }
    // Long rather than complex: a length rule is the one that actually
    // helps, and complexity rules mostly produce Password1!.
    if (password.length < 12) {
      throw new BadRequestException("Please choose a password of at least 12 characters.");
    }
    if (!first || !last) throw new BadRequestException("We need your first and last name.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      throw new BadRequestException("Please give your date of birth as YYYY-MM-DD.");
    }
    if (new Date(dob) > new Date()) {
      throw new BadRequestException("That date of birth is in the future.");
    }

    try {
      return await this.portal.register({ email, password, first, last, dob });
    } catch (e) {
      if (e instanceof ServiceUnavailableException || e instanceof BadRequestException) throw e;
      throw new BadRequestException(e instanceof Error ? e.message : "Could not create that account.");
    }
  }
}
