import { Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { config } from "../config/config";
import { DirectusService } from "../directus/directus.service";
import { QueueAccessService } from "./queue-access.service";
import { QueueAdminGuard, type AdminRequest } from "./queue-admin.guard";

@Controller("queues")
export class QueuesController {
  constructor(
    private readonly access: QueueAccessService,
    private readonly directus: DirectusService,
  ) {}

  /**
   * A one-time link into the board.
   *
   * Called by the Directus module with the token that browser already
   * holds, so nobody types a second password and no credential is shared
   * between people. What comes back is good for one visit and about a
   * minute — see `QueueAccessService` for why it is a ticket rather than
   * the token itself.
   *
   * POST, not GET. It changes state (a ticket now exists), it must not be
   * prefetched by a browser that is being helpful, and it must not end up
   * in a history entry somebody can re-open.
   */
  @Post("ticket")
  @UseGuards(QueueAdminGuard)
  async ticket(@Req() req: AdminRequest): Promise<{ url: string; expiresInSeconds: number }> {
    const ticket = await this.access.issueTicket(req.viewer);
    return {
      url: `${config.publicBase}${config.queues.route}?ticket=${ticket}`,
      expiresInSeconds: config.queues.ticketSeconds,
    };
  }

  /**
   * Whether the board is worth offering, and whether it is worth offering
   * *to you*.
   *
   * Asked by the Directus module before it draws anything, so a dentist
   * is told the rule instead of being shown a button that fails when they
   * press it. A control somebody can click and cannot use is a worse
   * answer than no control.
   *
   * The token is optional and the endpoint never refuses: no token, or a
   * token belonging to anybody but an administrator, simply gets
   * `youMayOpen: false`. What it reports is a fact about the deployment
   * and about the caller's own access — nothing about what is in a queue,
   * which is the other side of the door entirely.
   */
  @Get("board")
  async board(@Req() req: Request): Promise<{
    enabled: boolean;
    route: string;
    sessionMinutes: number;
    youMayOpen: boolean;
  }> {
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const youMayOpen = token
      ? await this.directus.mayOpenQueues(token).catch(() => false)
      : false;

    return {
      enabled: config.queues.boardEnabled,
      route: config.queues.route,
      sessionMinutes: config.queues.sessionMinutes,
      youMayOpen,
    };
  }
}
