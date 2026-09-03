import "reflect-metadata";
import { loadEnvFile } from "./env.js";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

loadEnvFile();

import { AppModule } from "./app.module.js";
import { initStore, storeConfigured } from "./cards.store.js";
import { warmSearchIndex } from "./scans/search.js";
import { initIdentity } from "./identity/store.js";
import { initBilling } from "./billing/store.js";
import { initAuth } from "./auth/store.js";
import { initSales } from "./sales/ledger.js";
import { initListings } from "./listings/store.js";
import { initCommunity } from "./community/store.js";
import { initWatchlist } from "./watchlist/store.js";
import { initPush } from "./push/store.js";
import { initRatings } from "./ratings/store.js";
import { initDisputes } from "./disputes/store.js";
import { initScanQuota } from "./scans/scanquota.store.js";
import { initMessages } from "./messages/store.js";
import { initNotifications } from "./notifications/store.js";
import { initAdmin } from "./admin/store.js";
import { reloadKeys } from "./scans/pptkeys.js";
import { rateLimit } from "./limits/middleware.js";

const PORT = Number(process.env.PORT ?? 8180);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  // The Didit webhook signature is computed over the body, so the raw text has
  // to survive JSON parsing. Express discards it by default and the signature
  // then cannot be checked at all.
  app.use(
    express.json({
      limit: "2mb",
      verify: (req: any, _res, buf) => {
        if (buf?.length) req.rawBody = buf.toString("utf8");
      },
    }),
  );
  // After the body parser — a rule keyed on the caller needs the auth header,
  // which is on the request either way, but a 429 should not be paid for by
  // parsing a 2MB body first. Before the routes, so nothing reaches a handler.
  app.use(rateLimit);
  app.use("/storage", express.static(join(process.cwd(), "storage")));
  // shared card store — best-effort, a scan still works without it
  if (storeConfigured()) {
    await initStore();
    await initIdentity();
    await initBilling();
    await initAuth();
    await initSales();
    await initListings();
    await initCommunity();
    await initWatchlist();
    await initPush();
    await initRatings();
    await initDisputes();
    await initScanQuota();
    await initMessages();
    await initNotifications();
    await initAdmin();
  }
  else console.log("[store] DATABASE_URL not set — using local cache only");

  // Provider keys live encrypted in the store. Loaded before we start serving
  // so the first scan has a pool rather than whatever is left in the env var.
  const n = await reloadKeys().catch(() => 0);
  if (n) console.log(`[keys] ${n} provider key(s) loaded from the store`);

  await app.listen(PORT);
  console.log(`grailcard api listening on http://localhost:${PORT}`);
  // not awaited: the server is already answering, this just fills a cache
  warmSearchIndex();
}

bootstrap();
