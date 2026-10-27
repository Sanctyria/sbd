import { and, count, desc, eq, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Environment } from "../../config/env.js";
import { database } from "../../db/client.js";
import {
  communities,
  communityMemberships,
  coreAdminActions,
  moderationActions,
  posts,
  profiles,
  users,
} from "../../db/schema.js";
import {
  COMMUNITY_INDEX_ACTIVITY_DAYS,
  isCommunityQualityEligible,
} from "../../lib/searchIndexing.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import {
  hasAllowedOrigin,
  invalidCursor,
  invalidRequest,
  listQuerySchema,
  requireAdmin,
} from "./shared.js";

const communityParamsSchema = z.object({ id: z.string().uuid() });
const communityActionSchema = z.object({
  action: z.enum(["archive", "restore", "enable_indexing", "disable_indexing"]),
  reason: z.string().trim().min(10).max(500),
});

export async function coreCommunityRoutes(
  app: FastifyInstance,
  config: Environment,
): Promise<void> {
  app.get("/api/v1/core/communities", async (request, reply) => {
    if (!(await requireAdmin(request, reply, config))) return;
    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const filters = [];
    if (parsedQuery.data.query) {
      const match = `%${parsedQuery.data.query}%`;
      filters.push(
        or(ilike(communities.name, match), ilike(communities.slug, match))!,
      );
    }
    if (cursor) {
      filters.push(
        or(
          lt(communities.createdAt, cursor.createdAt),
          and(
            eq(communities.createdAt, cursor.createdAt),
            lt(communities.id, cursor.id),
          ),
        )!,
      );
    }

    const rows = await database
      .select({
        id: communities.id,
        name: communities.name,
        slug: communities.slug,
        description: communities.description,
        status: communities.status,
        isPublic: communities.isPublic,
        indexingApproved: communities.indexingApproved,
        createdAt: communities.createdAt,
        ownerUsername: profiles.username,
        ownerDisplayName: profiles.displayName,
        memberCount: sql<number>`count(distinct ${communityMemberships.userId}) filter (where ${users.deletedAt} is null and ${users.suspendedAt} is null)`,
        postCount: sql<number>`count(distinct ${posts.id}) filter (where ${posts.deletedAt} is null)`,
        eligiblePostCount: sql<number>`(
          select count(*)::int
          from ${posts} as seo_posts
          inner join ${users} as seo_authors on seo_authors.id = seo_posts.author_id
          where seo_posts.community_id = ${communities.id}
            and seo_posts.deleted_at is null
            and seo_authors.deleted_at is null
            and seo_authors.suspended_at is null
            and seo_posts.created_at >= now() - (${COMMUNITY_INDEX_ACTIVITY_DAYS} * interval '1 day')
        )`,
        eligibleAuthorCount: sql<number>`(
          select count(distinct seo_posts.author_id)::int
          from ${posts} as seo_posts
          inner join ${users} as seo_authors on seo_authors.id = seo_posts.author_id
          where seo_posts.community_id = ${communities.id}
            and seo_posts.deleted_at is null
            and seo_authors.deleted_at is null
            and seo_authors.suspended_at is null
            and seo_posts.created_at >= now() - (${COMMUNITY_INDEX_ACTIVITY_DAYS} * interval '1 day')
        )`,
      })
      .from(communities)
      .leftJoin(
        communityMemberships,
        eq(communityMemberships.communityId, communities.id),
      )
      .leftJoin(users, eq(users.id, communityMemberships.userId))
      .leftJoin(profiles, eq(profiles.userId, communities.creatorId))
      .leftJoin(posts, eq(posts.communityId, communities.id))
      .where(filters.length ? and(...filters) : undefined)
      .groupBy(
        communities.id,
        communities.name,
        communities.slug,
        communities.description,
        communities.status,
        communities.isPublic,
        communities.indexingApproved,
        communities.createdAt,
        profiles.username,
        profiles.displayName,
      )
      .orderBy(desc(communities.createdAt), desc(communities.id))
      .limit(parsedQuery.data.limit + 1);
    const hasMore = rows.length > parsedQuery.data.limit;
    const items = rows.slice(0, parsedQuery.data.limit);
    const lastItem = items.at(-1);
    return {
      items: items.map((community) => ({
        ...community,
        memberCount: Number(community.memberCount),
        postCount: Number(community.postCount),
        eligiblePostCount: Number(community.eligiblePostCount),
        eligibleAuthorCount: Number(community.eligibleAuthorCount),
      })),
      nextCursor:
        hasMore && lastItem
          ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
          : null,
    };
  });

  app.patch("/api/v1/core/communities/:id", async (request, reply) => {
    const actorId = await requireAdmin(request, reply, config);
    if (!actorId) return;
    if (!hasAllowedOrigin(request, reply, config)) return;
    const parsedParams = communityParamsSchema.safeParse(request.params);
    const parsedBody = communityActionSchema.safeParse(request.body);
    if (!parsedParams.success || !parsedBody.success)
      return invalidRequest(reply);

    const [community] = await database
      .select({
        id: communities.id,
        status: communities.status,
        isPublic: communities.isPublic,
        indexingApproved: communities.indexingApproved,
      })
      .from(communities)
      .where(eq(communities.id, parsedParams.data.id))
      .limit(1);
    if (!community) {
      return reply.code(404).send({
        error: {
          code: "NOT_FOUND",
          message: "The community could not be found.",
        },
      });
    }

    const { action, reason } = parsedBody.data;
    if (
      (action === "archive" && community.status === "archived") ||
      (action === "restore" && community.status === "active") ||
      (action === "enable_indexing" && community.indexingApproved) ||
      (action === "disable_indexing" && !community.indexingApproved)
    ) {
      return reply.code(409).send({
        error: {
          code: "INVALID_COMMUNITY_STATE",
          message: "The community is already in that state.",
        },
      });
    }

    if (
      action === "enable_indexing" &&
      !(await isCommunityQualityEligible(community.id))
    ) {
      return reply.code(409).send({
        error: {
          code: "COMMUNITY_NOT_SEO_ELIGIBLE",
          message:
            "The community must be public, active, have a meaningful description, and meet the recent post and author thresholds before indexing can be enabled.",
        },
      });
    }

    await database.transaction(async (transaction) => {
      const status =
        action === "archive"
          ? "archived"
          : action === "restore"
            ? "active"
            : community.status;
      const indexingApproved =
        action === "enable_indexing"
          ? true
          : action === "disable_indexing"
            ? false
            : community.indexingApproved;
      await transaction
        .update(communities)
        .set({ status, indexingApproved, updatedAt: new Date() })
        .where(eq(communities.id, community.id));
      await transaction.insert(coreAdminActions).values({
        actorId,
        targetType: "community",
        targetId: community.id,
        action,
        details: {
          reason,
          indexingApproved,
          status,
        },
      });
      await transaction.insert(moderationActions).values({
        actorId,
        communityId: community.id,
        targetType: "community",
        targetId: community.id,
        action: `global_admin_${action}`,
        reason,
      });
    });
    return {
      success: true,
      status:
        action === "archive"
          ? "archived"
          : action === "restore"
            ? "active"
            : community.status,
      indexingApproved:
        action === "enable_indexing"
          ? true
          : action === "disable_indexing"
            ? false
            : community.indexingApproved,
    };
  });
}
