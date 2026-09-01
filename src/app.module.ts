import { BillingController } from "./billing/billing.controller.js";
import { IdentityController } from "./identity/identity.controller.js";
import { Module } from "@nestjs/common";
import { EbayController } from "./ebay/ebay.controller.js";
import { MarketController } from "./scans/market.controller.js";
import { ScansController } from "./scans/scans.controller.js";
import { ScansService } from "./scans/scans.service.js";

@Module({
  controllers: [ScansController, MarketController, EbayController, IdentityController, BillingController],
  providers: [ScansService],
})
export class AppModule {}
