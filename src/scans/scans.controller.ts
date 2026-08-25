import {
  BadRequestException,
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
import { ScansService } from "./scans.service.js";

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
  ) {
    const front = files?.front?.[0] ?? files?.file?.[0];
    if (!front) {
      throw new BadRequestException("multipart field 'front' is required");
    }
    return this.scans.createFromUpload(front, files?.back?.[0]);
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
}
