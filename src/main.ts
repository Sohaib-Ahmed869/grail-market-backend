import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// minimal .env loader (apps/api/.env): KEY=VALUE lines, no quoting rules
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

import { AppModule } from "./app.module.js";
import { initStore, storeConfigured } from "./cards.store.js";
import { warmSearchIndex } from "./scans/search.js";

const PORT = Number(process.env.PORT ?? 8180);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  app.use("/storage", express.static(join(process.cwd(), "storage")));
  // shared card store — best-effort, a scan still works without it
  if (storeConfigured()) await initStore();
  else console.log("[store] DATABASE_URL not set — using local cache only");

  await app.listen(PORT);
  console.log(`grailcard api listening on http://localhost:${PORT}`);
  // not awaited: the server is already answering, this just fills a cache
  warmSearchIndex();
}

bootstrap();
