import { CollectionController } from "./listings/collection.controller.js";
import { ListingsController } from "./listings/listings.controller.js";
import { SellersController } from "./listings/sellers.controller.js";
import { CommunityController } from "./community/community.controller.js";
import { WatchlistController } from "./watchlist/watchlist.controller.js";
import { RatingsController } from "./ratings/ratings.controller.js";
import { MessagesController } from "./messages/messages.controller.js";
import { NotificationsController } from "./notifications/notifications.controller.js";
import { SalesController } from "./sales/sales.controller.js";
import { AuthController } from "./auth/auth.controller.js";
import { BillingController } from "./billing/billing.controller.js";
import { IdentityController } from "./identity/identity.controller.js";
import { Module } from "@nestjs/common";
import { EbayController } from "./ebay/ebay.controller.js";
import { MarketController } from "./scans/market.controller.js";
import { ScansController } from "./scans/scans.controller.js";
import { ScansService } from "./scans/scans.service.js";

@Module({
  controllers: [ScansController, MarketController, EbayController, IdentityController, BillingController, AuthController, SalesController, ListingsController, CollectionController, SellersController, CommunityController, WatchlistController, RatingsController, MessagesController, NotificationsController],
  providers: [ScansService],
})
export class AppModule {}
