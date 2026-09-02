import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import {
  addComment, commentsFor, createCommunity, createPost, feed, getPost,
  listCommunities, setMembership, vote,
} from "./store.js";

@Controller("community")
export class CommunityController {
  /** Every community, with whether this member is in it. Open to anyone —
   *  reading the forum needs no account, same rule as browsing the market. */
  @Get()
  async communities(@Req() req: Request) {
    return { communities: await listCommunities(callerId(req)) };
  }

  /** A member making a community. */
  @Post()
  async make(@Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to make a community." };
    const r = await createCommunity({
      slug: String(b?.slug ?? ""), name: String(b?.name ?? ""),
      tagline: b?.tagline ?? null, description: b?.description ?? null,
      accent: b?.accent ?? null, userId: me,
    });
    if (r.ok) return { slug: r.slug };
    const message = {
      taken: "That name is already taken.",
      reserved: "That name is reserved.",
      "bad-slug": "Addresses are 3–21 characters: lower case letters, numbers, - or _.",
      "bad-name": "Give it a name between 3 and 60 characters.",
      "no-store": "The store is unavailable.",
    }[r.why];
    return { error: r.why, message };
  }

  /** The feed. `slug` narrows it to one community; without it, everything. */
  @Get("feed")
  async posts(
    @Req() req: Request,
    @Query("slug") slug?: string,
    @Query("sort") sort?: string,
  ) {
    return {
      posts: await feed({ slug: slug ?? null, sort: sort ?? "hot", userId: callerId(req) }),
      sort: sort ?? "hot",
    };
  }

  @Get("post/:postId")
  async post(@Param("postId") postId: string, @Req() req: Request) {
    const me = callerId(req);
    const p = await getPost(postId, me);
    if (!p || p.removed) return { error: "not-found" };
    return { post: p, comments: await commentsFor(postId, me) };
  }

  @Post("post")
  async write(@Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to post." };
    const title = String(b?.title ?? "").trim();
    if (title.length < 3) return { error: "invalid", message: "Give the post a title." };
    if (!b?.slug) return { error: "invalid", message: "Pick a community." };

    const id = await createPost({
      slug: String(b.slug), authorId: me, title: title.slice(0, 300),
      body: b.body ? String(b.body).slice(0, 8000) : null,
      imageUrl: b.imageUrl ?? null,
      catalogId: b.catalogId ?? null, listingId: b.listingId ?? null,
    });
    return id ? { postId: id } : { error: "no-community", message: "That community does not exist." };
  }

  @Post("post/:postId/comment")
  async comment(@Param("postId") postId: string, @Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to reply." };
    const body = String(b?.body ?? "").trim();
    if (!body) return { error: "invalid", message: "Write something first." };
    const id = await addComment({
      postId, authorId: me, body: body.slice(0, 8000), parentId: b?.parentId ?? null,
    });
    return id ? { commentId: id } : { error: "no-store" };
  }

  /** Up, down, or take it back. `value` is 1, -1, or 0. */
  @Post("vote")
  async cast(@Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to vote." };
    const kind = b?.kind === "comment" ? "comment" : "post";
    const value = b?.value === 1 ? 1 : b?.value === -1 ? -1 : 0;
    if (!b?.id) return { error: "invalid" };
    const score = await vote(kind, String(b.id), me, value as 1 | 0 | -1);
    return { score, value };
  }

  @Post(":slug/join")
  async join(@Param("slug") slug: string, @Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to join." };
    const ok = await setMembership(slug, me, b?.leave !== true);
    return ok ? { joined: b?.leave !== true } : { error: "not-found" };
  }
}
