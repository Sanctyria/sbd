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
  action: z.enum(["archive", "restore"]),
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
        createdAt: communities.createdAt,
        ownerUsername: profiles.username,
        ownerDisplayName: profiles.displayName,
        memberCount: sql<number>`count(distinct ${communityMemberships.userId}) filter (where ${users.deletedAt} is null and ${users.suspendedAt} is null)`,
        postCount: sql<number>`count(distinct ${posts.id}) filter (where ${posts.deletedAt} is null)`,
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
      (action === "restore" && community.status === "active")
    ) {
      return reply.code(409).send({
        error: {
          code: "INVALID_COMMUNITY_STATE",
          message: "The community is already in that state.",
        },
      });
    }

    await database.transaction(async (transaction) => {
      const status = action === "archive" ? "archived" : "active";
      await transaction
        .update(communities)
        .set({ status, updatedAt: new Date() })
        .where(eq(communities.id, community.id));
      await transaction.insert(coreAdminActions).values({
        actorId,
        targetType: "community",
        targetId: community.id,
        action,
        details: { reason },
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
      status: action === "archive" ? "archived" : "active",
    };
  });
}
