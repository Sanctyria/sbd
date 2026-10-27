import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Environment } from "../../config/env.js";
import { database } from "../../db/client.js";
import {
  bookmarks,
  communities,
  communityMemberships,
  communityMemberMutes,
  coreAdminActions,
  idempotencyRecords,
  moderationActions,
  notifications,
  outboxEvents,
  postReactions,
  posts,
  profiles,
  replyReactions,
  replies,
  userBlocks,
  userCredentials,
  userFollows,
  userMutes,
  userSessions,
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
import { recordEmberScoreChange } from "../../lib/ember.js";

const userParamsSchema = z.object({ id: z.string().uuid() });
const userActionSchema = z.object({
  action: z.enum(["suspend", "reactivate", "delete"]),
  reason: z.string().trim().min(10).max(500),
});

export async function coreUserRoutes(
  app: FastifyInstance,
  config: Environment,
): Promise<void> {
  app.get("/api/v1/core/users", async (request, reply) => {
    if (!(await requireAdmin(request, reply, config))) return;
    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const filters = [];
    if (parsedQuery.data.query) {
      const match = `%${parsedQuery.data.query}%`;
      filters.push(
        or(
          ilike(profiles.username, match),
          ilike(profiles.displayName, match),
        )!,
      );
    }
    if (cursor) {
      filters.push(
        or(
          lt(users.createdAt, cursor.createdAt),
          and(eq(users.createdAt, cursor.createdAt), lt(users.id, cursor.id)),
        )!,
      );
    }

    const rows = await database
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        createdAt: users.createdAt,
        deletedAt: users.deletedAt,
        suspendedAt: users.suspendedAt,
        ember: profiles.ember,
        communityCount: sql<number>`count(distinct ${communityMemberships.communityId})`,
      })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .leftJoin(communityMemberships, eq(communityMemberships.userId, users.id))
      .where(filters.length ? and(...filters) : undefined)
      .groupBy(
        users.id,
        profiles.username,
        profiles.displayName,
        profiles.ember,
      )
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(parsedQuery.data.limit + 1);

    const hasMore = rows.length > parsedQuery.data.limit;
    const items = rows.slice(0, parsedQuery.data.limit);
    const lastItem = items.at(-1);
    return {
      items: items.map((user) => ({
        ...user,
        communityCount: Number(user.communityCount),
        status: user.deletedAt
          ? "deleted"
          : user.suspendedAt
            ? "suspended"
            : "active",
      })),
      nextCursor:
        hasMore && lastItem
          ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
          : null,
    };
  });

  app.patch("/api/v1/core/users/:id", async (request, reply) => {
    const actorId = await requireAdmin(request, reply, config);
    if (!actorId) return;
    if (!hasAllowedOrigin(request, reply, config)) return;
    const parsedParams = userParamsSchema.safeParse(request.params);
    const parsedBody = userActionSchema.safeParse(request.body);
    if (!parsedParams.success || !parsedBody.success)
      return invalidRequest(reply);
    if (
      parsedBody.data.action === "delete" &&
      !config.CORE_SUPER_ADMIN_USER_IDS.includes(actorId)
    ) {
      return reply.code(403).send({
        error: {
          code: "SUPER_ADMIN_REQUIRED",
          message:
            "Only a super administrator can permanently delete accounts.",
        },
      });
    }
    if (parsedParams.data.id === actorId) {
      return reply.code(409).send({
        error: {
          code: "SELF_ACTION_NOT_ALLOWED",
          message:
            "You cannot change or delete your own administrator account.",
        },
      });
    }

    const targetId = parsedParams.data.id;
    const [target] = await database
      .select({
        id: users.id,
        deletedAt: users.deletedAt,
        suspendedAt: users.suspendedAt,
      })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1);
    if (!target) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "The user could not be found." },
      });
    }

    const { action, reason } = parsedBody.data;
    if (
      (action === "delete" && target.deletedAt) ||
      (action === "suspend" && (target.deletedAt || target.suspendedAt)) ||
      (action === "reactivate" && (target.deletedAt || !target.suspendedAt))
    ) {
      return reply.code(409).send({
        error: {
          code: "INVALID_ACCOUNT_STATE",
          message: "The account is not in a valid state for this action.",
        },
      });
    }

    const mutationResult = await database.transaction(async (transaction) => {
      const [lockedTarget] = await transaction
        .select({
          deletedAt: users.deletedAt,
          suspendedAt: users.suspendedAt,
        })
        .from(users)
        .where(eq(users.id, targetId))
        .for("update")
        .limit(1);
      if (!lockedTarget) return "not-found" as const;
      if (
        (action === "delete" && lockedTarget.deletedAt) ||
        (action === "suspend" &&
          (lockedTarget.deletedAt || lockedTarget.suspendedAt)) ||
        (action === "reactivate" &&
          (lockedTarget.deletedAt || !lockedTarget.suspendedAt))
      ) {
        return "invalid-state" as const;
      }

      if (action === "delete") {
        const ownedCommunities = await transaction
          .select({
            id: communities.id,
          })
          .from(communityMemberships)
          .innerJoin(
            communities,
            eq(communities.id, communityMemberships.communityId),
          )
          .where(
            and(
              eq(communityMemberships.userId, targetId),
              eq(communityMemberships.role, "owner"),
              eq(communities.status, "active"),
            ),
          );

        for (const community of ownedCommunities) {
          const [successor] = await transaction
            .select({ userId: communityMemberships.userId })
            .from(communityMemberships)
            .innerJoin(users, eq(users.id, communityMemberships.userId))
            .where(
              and(
                eq(communityMemberships.communityId, community.id),
                ne(communityMemberships.userId, targetId),
                isNull(users.deletedAt),
                isNull(users.suspendedAt),
              ),
            )
            .orderBy(
              sql`case ${communityMemberships.role} when 'moderator' then 0 else 1 end`,
              asc(communityMemberships.createdAt),
            )
            .limit(1);

          if (successor) {
            await transaction
              .update(communityMemberships)
              .set({ role: "owner" })
              .where(
                and(
                  eq(communityMemberships.communityId, community.id),
                  eq(communityMemberships.userId, successor.userId),
                ),
              );
            await transaction.insert(moderationActions).values({
              actorId,
              communityId: community.id,
              targetType: "user",
              targetId,
              action: "global_admin_transfer_owner",
              reason:
                "Ownership transferred during administrator account deletion.",
            });
          } else {
            await transaction
              .update(communities)
              .set({ status: "archived", updatedAt: new Date() })
              .where(eq(communities.id, community.id));
          }
        }

        await transaction
          .delete(communityMemberMutes)
          .where(
            or(
              eq(communityMemberMutes.userId, targetId),
              eq(communityMemberMutes.moderatorId, targetId),
            ),
          );
        await transaction
          .delete(communityMemberships)
          .where(eq(communityMemberships.userId, targetId));
        await transaction
          .delete(userSessions)
          .where(eq(userSessions.userId, targetId));
        await transaction
          .delete(idempotencyRecords)
          .where(eq(idempotencyRecords.userId, targetId));
        await transaction
          .delete(userCredentials)
          .where(eq(userCredentials.userId, targetId));
        await transaction
          .delete(userFollows)
          .where(
            or(
              eq(userFollows.followerId, targetId),
              eq(userFollows.followedId, targetId),
            ),
          );
        await transaction
          .delete(userBlocks)
          .where(
            or(
              eq(userBlocks.blockerId, targetId),
              eq(userBlocks.blockedId, targetId),
            ),
          );
        await transaction
          .delete(userMutes)
          .where(
            or(
              eq(userMutes.muterId, targetId),
              eq(userMutes.mutedId, targetId),
            ),
          );
        const affectedPosts = await transaction
          .select({
            id: posts.id,
            authorId: posts.authorId,
            communityId: posts.communityId,
            voteCount: posts.voteCount,
            downvoteCount: posts.downvoteCount,
          })
          .from(postReactions)
          .innerJoin(posts, eq(posts.id, postReactions.postId))
          .where(
            and(
              eq(postReactions.userId, targetId),
              inArray(postReactions.type, ["like", "downvote"]),
            ),
          )
          .for("update", { of: posts });
        await transaction
          .delete(postReactions)
          .where(eq(postReactions.userId, targetId));
        if (affectedPosts.length) {
          const postIds = affectedPosts.map((post) => post.id);
          for (let offset = 0; offset < postIds.length; offset += 500) {
            const batchIds = postIds.slice(offset, offset + 500);
            const remainingPostVotes = await transaction
              .select({
                postId: postReactions.postId,
                voteCount: sql<number>`count(*) filter (where ${postReactions.type} = 'like')::int`,
                downvoteCount: sql<number>`count(*) filter (where ${postReactions.type} = 'downvote')::int`,
              })
              .from(postReactions)
              .where(
                and(
                  inArray(postReactions.postId, batchIds),
                  inArray(postReactions.type, ["like", "downvote"]),
                ),
              )
              .groupBy(postReactions.postId);
            const votesByPostId = new Map(
              remainingPostVotes.map((vote) => [vote.postId, vote]),
            );
            for (const post of affectedPosts.slice(offset, offset + 500)) {
              const remaining = votesByPostId.get(post.id);
              const voteCount = remaining?.voteCount ?? 0;
              const downvoteCount = remaining?.downvoteCount ?? 0;
              await transaction
                .update(posts)
                .set({ voteCount, downvoteCount })
                .where(eq(posts.id, post.id));
              await recordEmberScoreChange(transaction, {
                recipientId: post.authorId,
                actorId: targetId,
                communityId: post.communityId,
                sourceType: "post",
                sourceId: post.id,
                previousReactionCount: post.voteCount,
                nextReactionCount: voteCount,
                previousDownvoteCount: post.downvoteCount,
                nextDownvoteCount: downvoteCount,
              });
              await transaction.insert(outboxEvents).values({
                topic: "post.reaction.changed",
                communityId: post.communityId,
                entityId: post.id,
                payload: { postId: post.id, voteCount, downvoteCount },
              });
            }
          }
        }

        const affectedReplies = await transaction
          .select({
            id: replies.id,
            postId: replies.postId,
            authorId: replies.authorId,
            communityId: posts.communityId,
            voteCount: replies.voteCount,
          })
          .from(replyReactions)
          .innerJoin(replies, eq(replies.id, replyReactions.replyId))
          .innerJoin(posts, eq(posts.id, replies.postId))
          .where(
            and(
              eq(replyReactions.userId, targetId),
              eq(replyReactions.type, "like"),
            ),
          )
          .for("update", { of: replies });
        await transaction
          .delete(replyReactions)
          .where(eq(replyReactions.userId, targetId));
        if (affectedReplies.length) {
          const replyIds = affectedReplies.map((item) => item.id);
          for (let offset = 0; offset < replyIds.length; offset += 500) {
            const batchIds = replyIds.slice(offset, offset + 500);
            const remainingReplyVotes = await transaction
              .select({
                replyId: replyReactions.replyId,
                voteCount: sql<number>`count(*)::int`,
              })
              .from(replyReactions)
              .where(inArray(replyReactions.replyId, batchIds))
              .groupBy(replyReactions.replyId);
            const votesByReplyId = new Map(
              remainingReplyVotes.map((vote) => [vote.replyId, vote.voteCount]),
            );
            for (const item of affectedReplies.slice(offset, offset + 500)) {
              const voteCount = votesByReplyId.get(item.id) ?? 0;
              await transaction
                .update(replies)
                .set({ voteCount })
                .where(eq(replies.id, item.id));
              await recordEmberScoreChange(transaction, {
                recipientId: item.authorId,
                actorId: targetId,
                communityId: item.communityId,
                sourceType: "reply",
                sourceId: item.id,
                previousReactionCount: item.voteCount,
                nextReactionCount: voteCount,
              });
              await transaction.insert(outboxEvents).values({
                topic: "reply.reaction.changed",
                communityId: item.communityId,
                entityId: item.postId,
                payload: {
                  postId: item.postId,
                  replyId: item.id,
                  reactionCount: voteCount,
                },
              });
            }
          }
        }
        await transaction
          .delete(bookmarks)
          .where(eq(bookmarks.userId, targetId));
        await transaction
          .delete(notifications)
          .where(eq(notifications.recipientId, targetId));
        await transaction
          .delete(outboxEvents)
          .where(eq(outboxEvents.recipientId, targetId));
        await transaction
          .update(profiles)
          .set({
            username: `deleted-${targetId}`,
            displayName: "Deleted account",
            bio: "",
            avatarUrl: null,
            avatarVersion: null,
            initials: null,
            avatarColor: null,
            isVerified: false,
            updatedAt: new Date(),
          })
          .where(eq(profiles.userId, targetId));
        await transaction
          .update(users)
          .set({
            authSubject: null,
            deletedAt: new Date(),
            suspendedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, targetId));
      } else {
        const suspendedAt = action === "suspend" ? new Date() : null;
        await transaction
          .update(users)
          .set({ suspendedAt, updatedAt: new Date() })
          .where(eq(users.id, targetId));
        if (action === "suspend") {
          await transaction
            .delete(userSessions)
            .where(eq(userSessions.userId, targetId));
        }
      }

      await transaction.insert(coreAdminActions).values({
        actorId,
        targetType: "user",
        targetId,
        action,
        details: { reason },
      });
      return "updated" as const;
    });
    if (mutationResult === "not-found") {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "The user could not be found." },
      });
    }
    if (mutationResult === "invalid-state") {
      return reply.code(409).send({
        error: {
          code: "INVALID_ACCOUNT_STATE",
          message: "The account is not in a valid state for this action.",
        },
      });
    }
    return { success: true, action };
  });
}
