import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { Req, ForbiddenException } from "@nestjs/common";
import { ScansService } from "./scans.service.js";
import { chargeScanQuota, scanQuota } from "./scanquota.store.js";
import { callerId } from "../auth/auth.controller.js";

const LIMITS = { fileSize: 25 * 1024 * 1024 };

@Controller("scans")
export class ScansController {
  // explicit token: tsx/esbuild doesn't emit design:paramtypes for Nest DI
  constructor(@Inject(ScansService) private readonly scans: ScansService) {}

  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "front", maxCount: 1 },
        { name: "back", maxCount: 1 },
        { name: "file", maxCount: 1 }, // legacy alias for front
      ],
      { limits: LIMITS },
    ),
  )
  async create(
    @UploadedFiles()
    files?: {
      front?: Express.Multer.File[];
      back?: Express.Multer.File[];
      file?: Express.Multer.File[];
    },
    @Req() req?: Request,
  ) {
    const front = files?.front?.[0] ?? files?.file?.[0];
    if (!front) {
      throw new BadRequestException("multipart field 'front' is required");
    }

    // Counted before the work, not after: a scan that reaches the vision box
    // has cost us whether or not it succeeds, and charging on success would
    // make a failing photograph free to retry forever.
    //
    // Anonymous scans are not metered. Somebody has to be able to try the
    // thing that makes this app worth paying for, and the rate limiter is
    // what stands between that and a script.
    const me = callerId(req as Request);
    if (me) {
      const { ok, quota } = await chargeScanQuota(me);
      if (!ok) {
        throw new ForbiddenException({
          error: "scan-quota",
          message: `You've used all ${quota.limit} scans this month. They reset on ${quota.resetsOn}.`,
          quota,
        });
      }
    }
    return this.scans.createFromUpload(front, files?.back?.[0]);
  }

  /** How many are left. The scan screen asks before it opens the camera, so
   *  the answer arrives before somebody has taken a photograph they cannot
   *  use. */
  @Get("quota")
  async quota(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { plan: "free", used: 0, limit: null, remaining: null, anonymous: true };
    return scanQuota(me);
  }

  @Get()
  list() {
    return this.scans.listRecent();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    const scan = this.scans.getById(id);
    if (!scan) throw new NotFoundException();
    return scan;
  }

  /** "No, it's the other one."
   *
   *  Before this, a wrong identification had no route out except scanning
   *  again — which produces the same wrong identification, because the input
   *  has not changed. */
  @Post(":id/pick")
  pick(@Param("id") id: string, @Body() b: { cardId?: string }) {
    if (!b?.cardId) throw new BadRequestException("cardId is required");
    const scan = this.scans.pickCandidate(id, String(b.cardId));
    if (!scan) throw new NotFoundException();
    return scan;
  }
}
