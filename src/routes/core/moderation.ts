import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Environment } from "../../config/env.js";
import { database } from "../../db/client.js";
import {
  communities,
  coreAdminActions,
  moderationActions,
  outboxEvents,
  posts,
  profiles,
  reports,
  replies,
} from "../../db/schema.js";
import {
  recordPostEmberRemoval,
  recordReplyEmberRemoval,
} from "../../lib/ember.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import {
  hasAllowedOrigin,
  invalidCursor,
  invalidRequest,
  requireAdmin,
} from "./shared.js";

const listQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  status: z.enum(["open", "reviewing", "resolved", "dismissed"]).optional(),
});
const actionQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const reportParamsSchema = z.object({ id: z.string().uuid() });
const decisionSchema = z
  .object({
    status: z.enum(["reviewing", "resolved", "dismissed"]),
    reason: z.string().trim().min(10).max(500),
    removeContent: z.boolean().default(false),
  })
  .refine((value) => !value.removeContent || value.status === "resolved");

export async function coreModerationRoutes(
  app: FastifyInstance,
  config: Environment,
): Promise<void> {
  app.get("/api/v1/core/moderation/reports", async (request, reply) => {
    if (!(await requireAdmin(request, reply, config))) return;
    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);
    const filters = [];
    if (parsedQuery.data.status) {
      filters.push(eq(reports.status, parsedQuery.data.status));
    }
    if (cursor) {
      filters.push(
        or(
          lt(reports.createdAt, cursor.createdAt),
          and(
            eq(reports.createdAt, cursor.createdAt),
            lt(reports.id, cursor.id),
          ),
        )!,
      );
    }

    const rows = await database
      .select({
        id: reports.id,
        targetType: reports.targetType,
        targetId: reports.targetId,
        reason: reports.reason,
        status: reports.status,
        createdAt: reports.createdAt,
        reporterUsername: profiles.username,
        reporterDisplayName: profiles.displayName,
        targetPostId: sql<string | null>`case
          when ${reports.targetType} = 'post' then ${reports.targetId}
          when ${reports.targetType} = 'reply' then (
            select ${replies.postId} from ${replies} where ${replies.id} = ${reports.targetId}
          )
          else null
        end`,
        targetBody: sql<string | null>`case
          when ${reports.targetType} = 'post' then (
            select ${posts.body} from ${posts} where ${posts.id} = ${reports.targetId}
          )
          when ${reports.targetType} = 'reply' then (
            select ${replies.body} from ${replies} where ${replies.id} = ${reports.targetId}
          )
          else null
        end`,
        communitySlug: sql<string | null>`case
          when ${reports.targetType} = 'post' then (
            select ${communities.slug}
            from ${posts} inner join ${communities} on ${communities.id} = ${posts.communityId}
            where ${posts.id} = ${reports.targetId}
          )
          when ${reports.targetType} = 'reply' then (
            select ${communities.slug}
            from ${replies}
            inner join ${posts} on ${posts.id} = ${replies.postId}
            inner join ${communities} on ${communities.id} = ${posts.communityId}
            where ${replies.id} = ${reports.targetId}
          )
          else null
        end`,
      })
      .from(reports)
      .innerJoin(profiles, eq(profiles.userId, reports.reporterId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(parsedQuery.data.limit + 1);
    const hasMore = rows.length > parsedQuery.data.limit;
    const items = rows.slice(0, parsedQuery.data.limit);
    const lastItem = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && lastItem
          ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
          : null,
    };
  });

  app.patch("/api/v1/core/moderation/reports/:id", async (request, reply) => {
    const actorId = await requireAdmin(request, reply, config);
    if (!actorId) return;
    if (!hasAllowedOrigin(request, reply, config)) return;
    const parsedParams = reportParamsSchema.safeParse(request.params);
    const parsedBody = decisionSchema.safeParse(request.body);
    if (!parsedParams.success || !parsedBody.success)
      return invalidRequest(reply);
    const reportId = parsedParams.data.id;
    const decision = parsedBody.data;

    const result = await database.transaction(async (transaction) => {
      const [report] = await transaction
        .select({
          id: reports.id,
          targetId: reports.targetId,
          targetType: reports.targetType,
        })
        .from(reports)
        .where(eq(reports.id, reportId))
        .limit(1);
      if (!report) return null;

      let communityId: string | null = null;
      let postId: string | null = null;
      if (report.targetType === "post") {
        const [post] = await transaction
          .select({ communityId: posts.communityId })
          .from(posts)
          .where(eq(posts.id, report.targetId))
          .limit(1);
        communityId = post?.communityId ?? null;
        postId = report.targetId;
      } else if (report.targetType === "reply") {
        const [replyRecord] = await transaction
          .select({
            communityId: posts.communityId,
            postId: replies.postId,
          })
          .from(replies)
          .innerJoin(posts, eq(posts.id, replies.postId))
          .where(eq(replies.id, report.targetId))
          .limit(1);
        communityId = replyRecord?.communityId ?? null;
        postId = replyRecord?.postId ?? null;
      }

      await transaction
        .update(reports)
        .set({ status: decision.status, updatedAt: new Date() })
        .where(eq(reports.id, reportId));
      if (decision.removeContent) {
        if (report.targetType === "post") {
          const [removed] = await transaction
            .update(posts)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(posts.id, report.targetId),
                sql`${posts.deletedAt} is null`,
              ),
            )
            .returning({ id: posts.id });
          if (removed && communityId) {
            await recordPostEmberRemoval(transaction, {
              postId: removed.id,
              actorId,
              communityId,
            });
            await transaction.insert(outboxEvents).values({
              topic: "post.deleted",
              communityId,
              entityId: removed.id,
              payload: { postId: removed.id },
            });
          }
        } else if (report.targetType === "reply") {
          const [removed] = await transaction
            .update(replies)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(replies.id, report.targetId),
                sql`${replies.deletedAt} is null`,
              ),
            )
            .returning({ id: replies.id });
          if (removed && communityId) {
            await recordReplyEmberRemoval(transaction, {
              replyId: removed.id,
              actorId,
              communityId,
            });
            if (postId) {
              await transaction.insert(outboxEvents).values({
                topic: "reply.deleted",
                communityId,
                entityId: postId,
                payload: { postId, replyId: removed.id },
              });
            }
          }
        }
      }
      if (communityId) {
        await transaction.insert(moderationActions).values({
          actorId,
          communityId,
          targetType: report.targetType,
          targetId: report.targetId,
          action: decision.removeContent
            ? "global_admin_reported_content_removed"
            : "global_admin_report_decision",
          reason: decision.reason,
        });
      }
      await transaction.insert(coreAdminActions).values({
        actorId,
        targetType: "report",
        targetId: reportId,
        action: decision.removeContent
          ? "resolve_and_remove_content"
          : decision.status,
        details: { reason: decision.reason, targetType: report.targetType },
      });
      return { id: reportId, status: decision.status };
    });

    if (!result) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "The report could not be found." },
      });
    }
    return result;
  });

  app.get("/api/v1/core/moderation/actions", async (request, reply) => {
    if (!(await requireAdmin(request, reply, config))) return;
    const parsedQuery = actionQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const filters = cursor
      ? [
          or(
            lt(coreAdminActions.createdAt, cursor.createdAt),
            and(
              eq(coreAdminActions.createdAt, cursor.createdAt),
              lt(coreAdminActions.id, cursor.id),
            ),
          )!,
        ]
      : [];
    const rows = await database
      .select({
        id: coreAdminActions.id,
        targetType: coreAdminActions.targetType,
        targetId: coreAdminActions.targetId,
        action: coreAdminActions.action,
        details: coreAdminActions.details,
        createdAt: coreAdminActions.createdAt,
        actorUsername: profiles.username,
        actorDisplayName: profiles.displayName,
      })
      .from(coreAdminActions)
      .innerJoin(profiles, eq(profiles.userId, coreAdminActions.actorId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(coreAdminActions.createdAt), desc(coreAdminActions.id))
      .limit(parsedQuery.data.limit + 1);
    const hasMore = rows.length > parsedQuery.data.limit;
    const items = rows.slice(0, parsedQuery.data.limit);
    const lastItem = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && lastItem
          ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
          : null,
    };
  });
}
