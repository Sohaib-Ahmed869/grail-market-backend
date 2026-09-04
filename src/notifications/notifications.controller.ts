import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { KINDS, listFor, markAllRead, unreadCount, type Kind } from "./store.js";
import { mutedFor, setMuted } from "./prefs.js";

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

  /** What a member has asked not to be interrupted about.
   *
   *  Returns the kinds that can push at all alongside what is muted, so the
   *  screen lists exactly what the server sends rather than a copy of the list
   *  that goes stale the first time a kind is added. */
  @Get("prefs")
  async prefs(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", kinds: [], muted: [] };
    return { kinds: KINDS, muted: await mutedFor(me) };
  }

  @Post("prefs")
  async savePrefs(@Req() req: Request, @Body() b: { kind?: string; push?: boolean }) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const kind = String(b?.kind ?? "") as Kind;
    if (!KINDS.includes(kind)) return { error: "bad-kind", message: "Unknown notification." };
    // `push: true` means send it, so it is the OPPOSITE of muted. Naming the
    // field for what the member sees on the switch rather than for how it is
    // stored keeps the inversion in one place instead of in every caller.
    return { muted: await setMuted(me, kind, b?.push === false) };
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
