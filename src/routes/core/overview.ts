import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Environment } from "../../config/env.js";
import { database } from "../../db/client.js";
import {
  communities,
  dailyAnalytics,
  marketingArticles,
  posts,
  reports,
  users,
} from "../../db/schema.js";
import { requireAdmin } from "./shared.js";

export async function coreOverviewRoutes(
  app: FastifyInstance,
  config: Environment,
): Promise<void> {
  app.get("/api/v1/core/overview", async (request, reply) => {
    if (!(await requireAdmin(request, reply, config))) return;

    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [
      [userCounts],
      [communityCounts],
      [postCounts],
      [openReportCount],
      [articleCount],
      [pageViewCount],
      recentCommunities,
      recentArticles,
    ] = await Promise.all([
      database
        .select({
          total: count(),
          active: sql<number>`count(*) filter (where ${users.deletedAt} is null and ${users.suspendedAt} is null)`,
          newThisMonth: sql<number>`count(*) filter (where ${users.createdAt} >= ${monthAgo})`,
        })
        .from(users),
      database
        .select({
          total: count(),
          active: sql<number>`count(*) filter (where ${communities.status} = 'active')`,
        })
        .from(communities),
      database
        .select({
          total: count(),
          thisMonth: sql<number>`count(*) filter (where ${posts.createdAt} >= ${monthAgo})`,
        })
        .from(posts)
        .innerJoin(users, eq(users.id, posts.authorId))
        .innerJoin(communities, eq(communities.id, posts.communityId))
        .where(
          and(
            isNull(posts.deletedAt),
            isNull(users.deletedAt),
            eq(communities.status, "active"),
          ),
        ),
      database
        .select({ total: count() })
        .from(reports)
        .where(eq(reports.status, "open")),
      database
        .select({ total: count() })
        .from(marketingArticles)
        .where(eq(marketingArticles.isPublished, true)),
      database
        .select({
          total: sql<number>`coalesce(sum(${dailyAnalytics.pageViews}), 0)`,
        })
        .from(dailyAnalytics)
        .where(gte(dailyAnalytics.day, monthAgo.toISOString().slice(0, 10))),
      database
        .select({
          id: communities.id,
          name: communities.name,
          slug: communities.slug,
          status: communities.status,
          createdAt: communities.createdAt,
        })
        .from(communities)
        .orderBy(desc(communities.createdAt))
        .limit(5),
      database
        .select({
          slug: marketingArticles.slug,
          title: marketingArticles.title,
          updatedAt: marketingArticles.updatedAt,
          isPublished: marketingArticles.isPublished,
        })
        .from(marketingArticles)
        .orderBy(desc(marketingArticles.updatedAt))
        .limit(5),
    ]);

    return {
      metrics: {
        users: {
          total: Number(userCounts?.total ?? 0),
          active: Number(userCounts?.active ?? 0),
          newThisMonth: Number(userCounts?.newThisMonth ?? 0),
        },
        communities: {
          total: Number(communityCounts?.total ?? 0),
          active: Number(communityCounts?.active ?? 0),
        },
        posts: {
          total: Number(postCounts?.total ?? 0),
          thisMonth: Number(postCounts?.thisMonth ?? 0),
        },
        openReports: Number(openReportCount?.total ?? 0),
        publishedArticles: Number(articleCount?.total ?? 0),
        pageViews30Days: Number(pageViewCount?.total ?? 0),
      },
      recentCommunities,
      recentArticles,
    };
  });
}
