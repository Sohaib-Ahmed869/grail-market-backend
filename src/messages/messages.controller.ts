import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { messagesIn, openThread, react, say, threadsFor, unreadCount } from "./store.js";

@Controller("messages")
export class MessagesController {
  /** Every conversation this person is in, newest first. */
  @Get()
  async threads(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    return { threads: await threadsFor(me), unread: await unreadCount(me) };
  }

  /** The badge on the header. Cheap enough to poll. */
  @Get("unread")
  async unread(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { unread: 0 };
    return { unread: await unreadCount(me) };
  }

  @Get(":threadId")
  async one(@Param("threadId") threadId: string, @Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const messages = await messagesIn(threadId, me);
    if (messages == null) return { error: "not-found" };
    return { messages };
  }

  /** Start (or reopen) the conversation about a listing. */
  @Post("open")
  async open(@Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to message a seller." };
    if (!b?.listingId) return { error: "invalid" };
    const t = await openThread(String(b.listingId), me);
    if (!t) return { error: "not-found", message: "That listing can't be messaged." };
    return { threadId: t.threadId };
  }

  /** The small set. A picker with a thousand emoji is a toy; five covers
   *  "yes", "no", "thanks", "that is funny" and "I am interested", which is
   *  the entire emotional range of a card negotiation. */
  @Post("react/:messageId")
  async addReaction(@Param("messageId") messageId: string, @Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const allowed = ["👍", "👌", "🔥", "😂", "🤝"];
    const emoji = b?.emoji == null ? null : String(b.emoji);
    if (emoji !== null && !allowed.includes(emoji)) return { error: "invalid" };
    const ok = await react(messageId, me, emoji);
    return ok ? { ok: true, emoji } : { error: "not-found" };
  }

  @Post(":threadId")
  async send(@Param("threadId") threadId: string, @Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const body = String(b?.body ?? "").trim();
    if (!body) return { error: "invalid" };
    const r = await say(threadId, me, body.slice(0, 4000));
    if (!r) return { error: "not-found" };
    return {
      messageId: r.messageId,
      masked: r.masked,
      notice: r.masked
        ? "Contact details were removed. Arranging the handover here keeps the record — and the record is what a dispute is decided on."
        : null,
    };
  }
}
