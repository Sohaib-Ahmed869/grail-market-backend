import { Controller, Get, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { listFor, markAllRead, unreadCount } from "./store.js";

@Controller("notifications")
export class NotificationsController {
  @Get()
  async list(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", items: [], unread: 0 };
    return { items: await listFor(me), unread: await unreadCount(me) };
  }

  @Get("unread")
  async unread(@Req() req: Request) {
    const me = callerId(req);
    return { unread: me ? await unreadCount(me) : 0 };
  }

  /** Opening the list is reading it. A separate "mark read" the client has to
   *  remember to call is a badge that drifts from what is on screen. */
  @Post("read")
  async read(@Req() req: Request) {
    const me = callerId(req);
    if (me) await markAllRead(me);
    return { ok: true };
  }
}
