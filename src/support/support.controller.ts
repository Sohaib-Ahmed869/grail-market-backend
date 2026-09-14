import {
  Body, Controller, Get, Param, Post, Req, UploadedFiles, UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { photosConfigured, putPhoto } from "../photos/s3.js";
import {
  KINDS, myTicket, myTickets, raiseTicket, replyAsMember, type TicketKind,
} from "../admin/support.store.js";

// The member's side of the support desk.
//
// The console has read and worked tickets since it shipped; nothing could
// raise one. Every ticket in the database was invented by a seed script, which
// is why the queue looked healthy and no member had ever been able to ask us
// anything.
//
// Two things arrive here and they are not the same errand:
//
//   support   a question. Starts at tier 1, the outsourced desk.
//   report    an accusation about a person or a listing. Skips tier 1
//             entirely and lands with trust & safety, because tier 1 has no
//             member records and no ID data — routing a scam report through
//             them means the first human to read it cannot look up either
//             party.
//
// Both take photographs, and for a report the photographs usually ARE the
// case: a screenshot of the message, the card that arrived, the packaging.

/** Ten images is more than anybody needs and few enough to store. */
const MAX_FILES = 10;
const LIMITS = { fileSize: 12 * 1024 * 1024, files: MAX_FILES };

const CATEGORIES = [
  "A listing", "A member", "Payment", "Delivery", "My account", "Something else",
];

@Controller("support")
export class SupportController {
  /** The categories and kinds this build accepts, so the app never offers a
   *  choice the server will reject. */
  @Get("options")
  options() {
    return { kinds: KINDS, categories: CATEGORIES };
  }

  @Get()
  async mine(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", tickets: [] };
    return { tickets: await myTickets(me) };
  }

  @Get(":id")
  async one(@Param("id") id: string, @Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const found = await myTicket(me, id);
    // Same answer for "no such ticket" and "not yours": the difference tells a
    // caller whether an id exists, which is not theirs to learn.
    if (!found) return { error: "not-found" };
    return found;
  }

  /** Raise a ticket. Multipart, so the photographs come with it.
   *
   *  Multipart rather than a presigned round trip because React Native cannot
   *  reliably PUT a local file — the listing photos failed silently that way
   *  for months. This is the shape the phone can actually send. */
  @Post()
  @UseInterceptors(FilesInterceptor("photos", MAX_FILES, { limits: LIMITS }))
  async raise(
    @Req() req: Request,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() b: any,
  ) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in first." };

    const kind: TicketKind =
      (KINDS as readonly string[]).includes(String(b?.kind)) ? b.kind : "support";
    const subject = String(b?.subject ?? "").trim();
    const body = String(b?.body ?? "").trim();
    if (subject.length < 3) {
      return { error: "invalid", message: "Give it a subject we can read at a glance." };
    }
    if (body.length < 10) {
      return { error: "invalid", message: "Tell us what happened — a line or two at least." };
    }
    // Reporting nobody and nothing is not a report.
    if (kind === "report" && !b?.aboutUserId && !b?.listingId) {
      return {
        error: "invalid",
        message: "A report needs a member or a listing attached to it.",
      };
    }

    const photos = await store(files, me);
    const made = await raiseTicket({
      memberId: me,
      kind,
      subject,
      category: String(b?.category ?? "Something else"),
      body,
      listingId: b?.listingId ? String(b.listingId) : null,
      aboutUserId: b?.aboutUserId ? String(b.aboutUserId) : null,
      photos,
    });
    if (!made) return { error: "failed", message: "That could not be filed. Try again." };
    return {
      ticketId: made.ticketId,
      photos: photos.length,
      // Said plainly, because "we got it" and "somebody is looking" are
      // different promises and only one of them is true at this moment.
      message:
        kind === "report"
          ? "Filed with trust and safety. You will hear back on this ticket."
          : "Filed. You will hear back on this ticket.",
    };
  }

  @Post(":id/reply")
  @UseInterceptors(FilesInterceptor("photos", MAX_FILES, { limits: LIMITS }))
  async reply(
    @Param("id") id: string,
    @Req() req: Request,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() b: any,
  ) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const body = String(b?.body ?? "").trim();
    if (!body) return { error: "invalid", message: "Nothing to send." };
    const photos = await store(files, me);
    const ok = await replyAsMember(me, id, body, photos);
    return ok ? { ok: true } : { error: "not-found" };
  }
}

/** Put the attachments away, and carry on without the ones that fail.
 *
 *  A photograph that will not store must not lose the words with it: somebody
 *  reporting a scam has typed the important part already. */
async function store(
  files: Express.Multer.File[] | undefined, ownerId: string,
): Promise<string[]> {
  if (!files?.length || !photosConfigured()) return [];
  const out: string[] = [];
  for (const [i, f] of files.entries()) {
    if (!f?.buffer?.length) continue;
    try {
      const up = await putPhoto(
        ownerId, `support-${i}`, f.buffer, f.mimetype || "image/jpeg", "disputes",
      );
      out.push(up.publicUrl);
    } catch (e) {
      console.warn("[support] attachment failed:", (e as Error).message);
    }
  }
  return out;
}
