import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Environment } from "../../config/env.js";
import { database } from "../../db/client.js";
import {
  communities,
  dailyAnalytics,
  posts,
  reports,
  users,
} from "../../db/schema.js";
import { hasAllowedOrigin, invalidRequest, requireAdmin } from "./shared.js";

const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
});
const dimensionSchema = z
  .string()
  .trim()
  .max(80)
  .regex(/^[A-Za-z0-9._ -]*$/);
const trackableMarketingRoutes = new Set([
  "/",
  "/about",
  "/flameborns",
  "/nations",
  "/studio",
  "/journal",
  "/partnership",
  "/roadmap",
  "/reach-us",
]);
const pageViewSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(160)
    .regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/)
    .refine(
      (path) =>
        !path.includes("..") &&
        (trackableMarketingRoutes.has(path) ||
          /^\/journal\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path)),
    ),
  source: dimensionSchema.default(""),
  medium: dimensionSchema.default(""),
  campaign: dimensionSchema.default(""),
});

export async function coreAnalyticsRoutes(
  app: FastifyInstance,
  config: Environment,
): Promise<void> {
  app.post(
    "/api/v1/analytics/pageview",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!hasAllowedOrigin(request, reply, config)) return;
      const parsedBody = pageViewSchema.safeParse(request.body);
      if (!parsedBody.success) return invalidRequest(reply);

      const day = new Date().toISOString().slice(0, 10);
      const { path, source, medium, campaign } = parsedBody.data;
      await database
        .insert(dailyAnalytics)
        .values({ day, path, source, medium, campaign, pageViews: 1 })
        .onConflictDoUpdate({
          target: [
            dailyAnalytics.day,
            dailyAnalytics.path,
            dailyAnalytics.source,
            dailyAnalytics.medium,
            dailyAnalytics.campaign,
          ],
          set: {
            pageViews: sql`${dailyAnalytics.pageViews} + 1`,
            updatedAt: new Date(),
          },
        });
      return reply.code(204).send();
    },
  );

  app.get("/api/v1/core/analytics", async (request, reply) => {
    if (!(await requireAdmin(request, reply, config))) return;
    const parsedQuery = analyticsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const startDay = new Date(
      Date.now() - (parsedQuery.data.days - 1) * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);

    const [
      daily,
      topPages,
      campaigns,
      [activeUsers],
      [activeCommunities],
      [activePosts],
      [openReports],
    ] = await Promise.all([
      database
        .select({
          day: dailyAnalytics.day,
          pageViews: sql<number>`sum(${dailyAnalytics.pageViews})`,
        })
        .from(dailyAnalytics)
        .where(gte(dailyAnalytics.day, startDay))
        .groupBy(dailyAnalytics.day)
        .orderBy(asc(dailyAnalytics.day)),
      database
        .select({
          path: dailyAnalytics.path,
          pageViews: sql<number>`sum(${dailyAnalytics.pageViews})`,
        })
        .from(dailyAnalytics)
        .where(gte(dailyAnalytics.day, startDay))
        .groupBy(dailyAnalytics.path)
        .orderBy(desc(sql`sum(${dailyAnalytics.pageViews})`))
        .limit(10),
      database
        .select({
          source: dailyAnalytics.source,
          medium: dailyAnalytics.medium,
          campaign: dailyAnalytics.campaign,
          pageViews: sql<number>`sum(${dailyAnalytics.pageViews})`,
        })
        .from(dailyAnalytics)
        .where(
          and(
            gte(dailyAnalytics.day, startDay),
            sql`${dailyAnalytics.campaign} <> ''`,
          ),
        )
        .groupBy(
          dailyAnalytics.source,
          dailyAnalytics.medium,
          dailyAnalytics.campaign,
        )
        .orderBy(desc(sql`sum(${dailyAnalytics.pageViews})`))
        .limit(10),
      database
        .select({
          total: sql<number>`count(*)`,
        })
        .from(users)
        .where(
          and(
            sql`${users.deletedAt} is null`,
            sql`${users.suspendedAt} is null`,
          ),
        ),
      database
        .select({ total: sql<number>`count(*)` })
        .from(communities)
        .where(eq(communities.status, "active")),
      database
        .select({ total: sql<number>`count(*)` })
        .from(posts)
        .innerJoin(communities, eq(communities.id, posts.communityId))
        .innerJoin(users, eq(users.id, posts.authorId))
        .where(
          and(
            sql`${posts.deletedAt} is null`,
            sql`${users.deletedAt} is null`,
            eq(communities.status, "active"),
          ),
        ),
      database
        .select({ total: sql<number>`count(*)` })
        .from(reports)
        .where(eq(reports.status, "open")),
    ]);

    return {
      days: parsedQuery.data.days,
      pageViews: daily.reduce((total, row) => total + Number(row.pageViews), 0),
      daily: daily.map((row) => ({
        day: row.day,
        pageViews: Number(row.pageViews),
      })),
      topPages: topPages.map((row) => ({
        path: row.path,
        pageViews: Number(row.pageViews),
      })),
      campaigns: campaigns.map((row) => ({
        ...row,
        pageViews: Number(row.pageViews),
      })),
      community: {
        activeUsers: Number(activeUsers?.total ?? 0),
        activeCommunities: Number(activeCommunities?.total ?? 0),
        posts: Number(activePosts?.total ?? 0),
        openReports: Number(openReports?.total ?? 0),
      },
    };
  });
}
