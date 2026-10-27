import type { FastifyInstance } from "fastify";
import type { Environment } from "../config/env.js";
import { coreAnalyticsRoutes } from "./core/analytics.js";
import { coreBannerRoutes } from "./core/banners.js";
import { coreCommunityRoutes } from "./core/communities.js";
import { coreMarketingRoutes } from "./core/marketing.js";
import { coreModerationRoutes } from "./core/moderation.js";
import { coreOverviewRoutes } from "./core/overview.js";
import { coreUserRoutes } from "./core/users.js";

export async function coreRoutes(
  app: FastifyInstance,
  config: Environment,
): Promise<void> {
  await coreOverviewRoutes(app, config);
  await coreUserRoutes(app, config);
  await coreCommunityRoutes(app, config);
  await coreModerationRoutes(app, config);
  await coreMarketingRoutes(app, config);
  await coreBannerRoutes(app, config);
  await coreAnalyticsRoutes(app, config);
}
