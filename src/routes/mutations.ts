import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { environment } from "../config/env.js";
import { database } from "../db/client.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import {
  recordEmberScoreChange,
  recordPostEmberRemoval,
  recordReplyEmberRemoval,
} from "../lib/ember.js";
import { extractMentionUsernames } from "../lib/mentions.js";
import {
  bookmarks,
  communities,
  communitySlugAliases,
  communityMemberships,
  communityMemberMutes,
  idempotencyRecords,
  moderationActions,
  notifications,
  outboxEvents,
  postReactions,
  replyReactions,
  posts,
  profiles,
  reports,
  replies,
  userFollows,
  userBlocks,
  userMutes,
  userSessions,
  users,
} from "../db/schema.js";
import { communitySlugFromName } from "../lib/communitySlug.js";

type DatabaseTransaction = Parameters<
  Parameters<typeof database.transaction>[0]
>[0];
type IdempotencyContext = {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
};
type IdempotencyClaim =
  | { kind: "fresh" }
  | { kind: "conflict" }
  | { kind: "replay"; status: number; body: Record<string, unknown> };

const MAX_ACTIVE_EVENT_STREAMS = 100;
const MAX_EVENT_STREAM_DURATION_MS = 15 * 60 * 1000;
let activeEventStreamCount = 0;

const idParamsSchema = z.object({ id: z.string().uuid() });
const slugParamsSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});
const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use an HTTPS URL.");
const inlineCommunityImageSchema = z
  .string()
  .max(1_400_000)
  .refine((value) => {
    const match =
      /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        value,
      );
    const encodedImage = match?.[1];
    if (!encodedImage || encodedImage.length % 4 !== 0) return false;
    const imageBytes = Buffer.from(encodedImage, "base64");
    return (
      imageBytes.byteLength <= 1_000_000 &&
      imageBytes.toString("base64") === encodedImage
    );
  }, "Use a JPEG, PNG, WebP, or GIF image under 1 MB.");
const communityImageSchema = z.union([
  httpsUrlSchema,
  inlineCommunityImageSchema,
]);
const postBodySchema = z
  .object({
    community: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    kind: z.enum(["text", "link", "image_url", "video_url"]),
    body: z.string().trim().max(1000).default(""),
    url: httpsUrlSchema.optional(),
  })
  .superRefine((value, context) => {
    if (!value.body && !value.url) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "Post content is required.",
      });
    }
    if (value.kind === "text" && !value.body) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "Text posts need a body.",
      });
    }
    if (value.kind !== "text" && !value.url) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "This post type needs a URL.",
      });
    }
  });
const postUpdateSchema = z
  .object({
    body: z.string().trim().max(1000).optional(),
    url: httpsUrlSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
const replyBodySchema = z.object({ body: z.string().trim().min(1).max(1000) });
const createReplySchema = replyBodySchema.extend({
  parentReplyId: z.string().uuid().optional(),
});
const notificationReadSchema = z.object({ read: z.literal(true) });
const moderationQueueQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  status: z
    .enum(["open", "reviewing", "resolved", "dismissed"])
    .default("open"),
});
const moderationHistoryQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const moderationDecisionSchema = z
  .object({
    status: z.enum(["reviewing", "resolved", "dismissed"]),
    reason: z.string().trim().min(10).max(500),
    removeContent: z.boolean().default(false),
  })
  .refine((value) => !value.removeContent || value.status === "resolved");
const reportBodySchema = z.object({
  targetType: z.enum(["post", "reply"]),
  targetId: z.string().uuid(),
  reason: z.string().trim().min(10).max(500),
});
const profileUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    bio: z.string().trim().max(300).optional(),
    avatarUrl: httpsUrlSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
const createCommunitySchema = z.object({
  name: z.string().trim().min(3).max(60),
  description: z.string().trim().max(500).default(""),
});
const updateCommunitySchema = z
  .object({
    name: z.string().trim().min(3).max(60).optional(),
    description: z.string().trim().max(500).optional(),
    avatarUrl: communityImageSchema.nullable().optional(),
    bannerUrl: communityImageSchema.nullable().optional(),
    websiteUrl: httpsUrlSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
const ownerTransferSchema = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,29}$/),
});
const memberRoleUpdateSchema = z.object({
  role: z.enum(["member", "moderator"]),
});
const memberModerationSchema = z.object({
  action: z.enum(["warn", "mute", "unmute", "remove"]),
  reason: z.string().trim().min(10).max(500),
});

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function idempotencyContext(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  scope: string,
  body: unknown,
): IdempotencyContext | null | undefined {
  const key = request.headers["idempotency-key"];
  if (key === undefined) return null;
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    invalidRequest(reply);
    return undefined;
  }
  return {
    userId,
    scope,
    key,
    requestHash: createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex"),
  };
}

async function claimIdempotency(
  transaction: DatabaseTransaction,
  context: IdempotencyContext,
): Promise<IdempotencyClaim> {
  const now = new Date();
  await transaction
    .delete(idempotencyRecords)
    .where(lt(idempotencyRecords.expiresAt, now));
  await transaction
    .insert(idempotencyRecords)
    .values({
      ...context,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    })
    .onConflictDoNothing();
  const [record] = await transaction
    .select({
      requestHash: idempotencyRecords.requestHash,
      responseStatus: idempotencyRecords.responseStatus,
      response: idempotencyRecords.response,
    })
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.userId, context.userId),
        eq(idempotencyRecords.scope, context.scope),
        eq(idempotencyRecords.key, context.key),
      ),
    )
    .for("update")
    .limit(1);
  if (!record) throw new Error("Idempotency record could not be locked.");
  if (record.requestHash !== context.requestHash) return { kind: "conflict" };
  if (record.responseStatus !== null && record.response !== null) {
    return {
      kind: "replay",
      status: record.responseStatus,
      body: record.response,
    };
  }
  return { kind: "fresh" };
}

async function storeIdempotencyResponse(
  transaction: DatabaseTransaction,
  context: IdempotencyContext,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await transaction
    .update(idempotencyRecords)
    .set({ responseStatus: status, response: body })
    .where(
      and(
        eq(idempotencyRecords.userId, context.userId),
        eq(idempotencyRecords.scope, context.scope),
        eq(idempotencyRecords.key, context.key),
      ),
    );
}

function sendIdempotencyClaim(
  reply: FastifyReply,
  claim: Exclude<IdempotencyClaim, { kind: "fresh" }>,
) {
  if (claim.kind === "replay") {
    reply.header("idempotency-replayed", "true");
    return reply.code(claim.status).send(claim.body);
  }
  return reply.code(409).send({
    error: {
      code: "IDEMPOTENCY_KEY_REUSED",
      message:
        "This idempotency key was already used with a different request.",
    },
  });
}

async function authenticatedUserId(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const origin = request.headers.origin;
  if (origin && origin !== environment.WEB_ORIGIN) {
    reply.code(403).send({
      error: {
        code: "ORIGIN_NOT_ALLOWED",
        message: "Request origin is not allowed.",
      },
    });
    return null;
  }

  const token = request.cookies[environment.SESSION_COOKIE_NAME];
  if (!token) {
    reply.code(401).send({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
    return null;
  }

  const [session] = await database
    .select({ userId: userSessions.userId })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(
      and(
        eq(userSessions.tokenHash, hashSessionToken(token)),
        gt(userSessions.expiresAt, new Date()),
        isNull(users.deletedAt),
        isNull(users.suspendedAt),
      ),
    )
    .limit(1);

  if (!session) {
    reply.code(401).send({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
    return null;
  }
  return session.userId;
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_REQUEST", message: "The request is invalid." },
  });
}

function invalidCursor(reply: FastifyReply) {
  return reply.code(400).send({
    error: {
      code: "INVALID_CURSOR",
      message: "The pagination cursor is invalid.",
    },
  });
}

async function activePostCommunityId(postId: string): Promise<string | null> {
  const [post] = await database
    .select({ communityId: posts.communityId })
    .from(posts)
    .innerJoin(communities, eq(communities.id, posts.communityId))
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(
      and(
        eq(posts.id, postId),
        isNull(posts.deletedAt),
        isNull(users.deletedAt),
        eq(communities.isPublic, true),
        eq(communities.status, "active"),
      ),
    )
    .limit(1);
  return post?.communityId ?? null;
}

async function manageablePost(userId: string, postId: string) {
  const [post] = await database
    .select({
      id: posts.id,
      authorId: posts.authorId,
      communityId: posts.communityId,
      voteCount: posts.voteCount,
      kind: posts.kind,
      body: posts.body,
      url: posts.url,
      role: communityMemberships.role,
    })
    .from(posts)
    .innerJoin(communities, eq(communities.id, posts.communityId))
    .innerJoin(users, eq(users.id, posts.authorId))
    .leftJoin(
      communityMemberships,
      and(
        eq(communityMemberships.communityId, posts.communityId),
        eq(communityMemberships.userId, userId),
      ),
    )
    .where(
      and(
        eq(posts.id, postId),
        isNull(posts.deletedAt),
        isNull(users.deletedAt),
        eq(communities.isPublic, true),
        eq(communities.status, "active"),
      ),
    )
    .limit(1);
  if (
    !post ||
    (post.authorId !== userId &&
      !["owner", "moderator"].includes(post.role ?? ""))
  ) {
    return null;
  }
  return post;
}

async function manageableReply(userId: string, replyId: string) {
  const [target] = await database
    .select({
      id: replies.id,
      authorId: replies.authorId,
      postId: replies.postId,
      communityId: posts.communityId,
      voteCount: replies.voteCount,
      role: communityMemberships.role,
    })
    .from(replies)
    .innerJoin(posts, eq(posts.id, replies.postId))
    .innerJoin(communities, eq(communities.id, posts.communityId))
    .leftJoin(
      communityMemberships,
      and(
        eq(communityMemberships.communityId, posts.communityId),
        eq(communityMemberships.userId, userId),
      ),
    )
    .where(
      and(
        eq(replies.id, replyId),
        isNull(replies.deletedAt),
        isNull(posts.deletedAt),
        eq(communities.isPublic, true),
        eq(communities.status, "active"),
      ),
    )
    .limit(1);
  if (
    !target ||
    (target.authorId !== userId &&
      !["owner", "moderator"].includes(target.role ?? ""))
  ) {
    return null;
  }
  return target;
}

async function moderatorForReportTarget(
  userId: string,
  targetType: string,
  targetId: string,
): Promise<{ communityId: string; postId: string } | null> {
  let communityId: string | null = null;
  let postId = targetId;
  if (targetType === "post") {
    const [target] = await database
      .select({ communityId: posts.communityId, postId: posts.id })
      .from(posts)
      .innerJoin(communities, eq(communities.id, posts.communityId))
      .where(
        and(
          eq(posts.id, targetId),
          eq(communities.isPublic, true),
          eq(communities.status, "active"),
        ),
      )
      .limit(1);
    communityId = target?.communityId ?? null;
    postId = target?.postId ?? targetId;
  } else if (targetType === "reply") {
    const [target] = await database
      .select({ communityId: posts.communityId, postId: posts.id })
      .from(replies)
      .innerJoin(posts, eq(posts.id, replies.postId))
      .innerJoin(communities, eq(communities.id, posts.communityId))
      .where(
        and(
          eq(replies.id, targetId),
          eq(communities.isPublic, true),
          eq(communities.status, "active"),
        ),
      )
      .limit(1);
    communityId = target?.communityId ?? null;
    postId = target?.postId ?? targetId;
  }
  if (!communityId) return null;

  const [membership] = await database
    .select({ userId: communityMemberships.userId })
    .from(communityMemberships)
    .where(
      and(
        eq(communityMemberships.userId, userId),
        eq(communityMemberships.communityId, communityId),
        inArray(communityMemberships.role, ["owner", "moderator"]),
      ),
    )
    .limit(1);
  return membership ? { communityId, postId } : null;
}

type PostVoteDirection = "up" | "down" | null;

async function setPostVote(
  userId: string,
  postId: string,
  communityId: string,
  direction: PostVoteDirection,
  options: { toggleCurrent?: boolean; removeOnlyUp?: boolean } = {},
) {
  return database.transaction(async (transaction) => {
    const [post] = await transaction
      .select({
        authorId: posts.authorId,
        voteCount: posts.voteCount,
        downvoteCount: posts.downvoteCount,
      })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1)
      .for("update");
    if (!post) return null;
    if (post.authorId === userId) {
      return { error: "SELF_REACTION_NOT_ALLOWED" as const };
    }

    const [existing] = await transaction
      .select({ type: postReactions.type })
      .from(postReactions)
      .where(
        and(
          eq(postReactions.userId, userId),
          eq(postReactions.postId, postId),
          inArray(postReactions.type, ["like", "downvote"]),
        ),
      )
      .limit(1);
    const currentDirection: PostVoteDirection =
      existing?.type === "like"
        ? "up"
        : existing?.type === "downvote"
          ? "down"
          : null;
    const nextDirection = options.removeOnlyUp
      ? currentDirection === "up"
        ? null
        : currentDirection
      : direction === null
        ? null
        : options.toggleCurrent && currentDirection === direction
          ? null
          : direction;
    if (nextDirection === currentDirection) {
      return {
        voteDirection: currentDirection,
        voteCount: post.voteCount,
        downvoteCount: post.downvoteCount,
      };
    }

    await transaction
      .delete(postReactions)
      .where(
        and(
          eq(postReactions.userId, userId),
          eq(postReactions.postId, postId),
          inArray(postReactions.type, ["like", "downvote"]),
        ),
      );
    if (nextDirection) {
      await transaction.insert(postReactions).values({
        userId,
        postId,
        type: nextDirection === "up" ? "like" : "downvote",
      });
    }

    const voteCount =
      post.voteCount -
      (currentDirection === "up" ? 1 : 0) +
      (nextDirection === "up" ? 1 : 0);
    const downvoteCount =
      post.downvoteCount -
      (currentDirection === "down" ? 1 : 0) +
      (nextDirection === "down" ? 1 : 0);
    await transaction
      .update(posts)
      .set({ voteCount, downvoteCount })
      .where(eq(posts.id, postId));

    await recordEmberScoreChange(transaction, {
      recipientId: post.authorId,
      actorId: userId,
      communityId,
      sourceType: "post",
      sourceId: postId,
      previousReactionCount: post.voteCount,
      nextReactionCount: voteCount,
      previousDownvoteCount: post.downvoteCount,
      nextDownvoteCount: downvoteCount,
    });
    await transaction.insert(outboxEvents).values({
      topic: "post.reaction.changed",
      communityId,
      entityId: postId,
      payload: { postId, voteCount, downvoteCount },
    });
    if (nextDirection === "up" && currentDirection !== "up") {
      const [postAuthor] = await transaction
        .select({
          userId: posts.authorId,
          username: profiles.username,
          displayName: profiles.displayName,
        })
        .from(posts)
        .innerJoin(profiles, eq(profiles.userId, posts.authorId))
        .where(eq(posts.id, postId))
        .limit(1);
      const [actor] = await transaction
        .select({
          username: profiles.username,
          displayName: profiles.displayName,
        })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);
      if (postAuthor && postAuthor.userId !== userId) {
        const [notification] = await transaction
          .insert(notifications)
          .values({
            recipientId: postAuthor.userId,
            type: "reaction",
            entityId: postId,
            payload: {
              actorUsername: actor?.username ?? "member",
              actorName: actor?.displayName ?? "A community member",
              preview: "Reacted to your post",
            },
          })
          .returning({ id: notifications.id });
        if (notification) {
          await transaction.insert(outboxEvents).values({
            topic: "notification.created",
            recipientId: postAuthor.userId,
            entityId: notification.id,
            payload: { notificationId: notification.id },
          });
        }
      }
    }
    return { voteDirection: nextDirection, voteCount, downvoteCount };
  });
}

export async function mutationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/moderation/actions", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const parsedQuery = moderationHistoryQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const managedCommunities = await database
      .select({ id: communityMemberships.communityId })
      .from(communityMemberships)
      .where(
        and(
          eq(communityMemberships.userId, userId),
          inArray(communityMemberships.role, ["owner", "moderator"]),
        ),
      );
    if (!managedCommunities.length) {
      return reply.code(403).send({
        error: {
          code: "MODERATOR_REQUIRED",
          message: "Community moderator access is required.",
        },
      });
    }

    const conditions = [
      inArray(
        moderationActions.communityId,
        managedCommunities.map((community) => community.id),
      ),
    ];
    if (cursor) {
      conditions.push(
        or(
          lt(moderationActions.createdAt, cursor.createdAt),
          and(
            eq(moderationActions.createdAt, cursor.createdAt),
            lt(moderationActions.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await database
      .select({
        id: moderationActions.id,
        targetType: moderationActions.targetType,
        targetId: moderationActions.targetId,
        action: moderationActions.action,
        reason: moderationActions.reason,
        createdAt: moderationActions.createdAt,
        actorUsername: profiles.username,
        actorDisplayName: profiles.displayName,
        communitySlug: communities.slug,
        communityName: communities.name,
      })
      .from(moderationActions)
      .innerJoin(users, eq(users.id, moderationActions.actorId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .innerJoin(communities, eq(communities.id, moderationActions.communityId))
      .where(and(...conditions))
      .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
      .limit(parsedQuery.data.limit + 1);
    const hasMore = rows.length > parsedQuery.data.limit;
    const items = hasMore ? rows.slice(0, parsedQuery.data.limit) : rows;
    const lastItem = items.at(-1);
    reply.header("cache-control", "private, no-store");
    return {
      items,
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
    };
  });

  app.get("/api/v1/moderation/reports", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const parsedQuery = moderationQueueQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const conditions = [
      eq(reports.status, parsedQuery.data.status),
      sql`(
        exists (
          select 1 from ${posts} as reported_post
          inner join ${communityMemberships} as post_manager
            on post_manager.community_id = reported_post.community_id
          where ${reports.targetType} = 'post'
            and reported_post.id = ${reports.targetId}
            and post_manager.user_id = ${userId}
            and post_manager.role in ('owner', 'moderator')
        )
        or exists (
          select 1 from ${replies} as reported_reply
          inner join ${posts} as reply_post on reply_post.id = reported_reply.post_id
          inner join ${communityMemberships} as reply_manager
            on reply_manager.community_id = reply_post.community_id
          where ${reports.targetType} = 'reply'
            and reported_reply.id = ${reports.targetId}
            and reply_manager.user_id = ${userId}
            and reply_manager.role in ('owner', 'moderator')
        )
      )`,
    ];
    if (cursor) {
      conditions.push(
        or(
          gt(reports.createdAt, cursor.createdAt),
          and(
            eq(reports.createdAt, cursor.createdAt),
            gt(reports.id, cursor.id),
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
        targetBody: sql<string | null>`case
          when ${reports.targetType} = 'post' then (
            select ${posts.body} from ${posts} where ${posts.id} = ${reports.targetId}
          )
          else (
            select ${replies.body} from ${replies} where ${replies.id} = ${reports.targetId}
          )
        end`,
        postId: sql<string | null>`case
          when ${reports.targetType} = 'post' then ${reports.targetId}
          else (
            select ${replies.postId} from ${replies} where ${replies.id} = ${reports.targetId}
          )
        end`,
      })
      .from(reports)
      .innerJoin(users, eq(users.id, reports.reporterId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(and(...conditions))
      .orderBy(asc(reports.createdAt), asc(reports.id))
      .limit(parsedQuery.data.limit + 1);
    const hasMore = rows.length > parsedQuery.data.limit;
    const items = hasMore ? rows.slice(0, parsedQuery.data.limit) : rows;
    const lastItem = items.at(-1);
    reply.header("cache-control", "private, no-store");
    return {
      items,
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
    };
  });

  app.patch("/api/v1/moderation/reports/:id", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    const body = moderationDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply);

    const [report] = await database
      .select({
        id: reports.id,
        targetType: reports.targetType,
        targetId: reports.targetId,
      })
      .from(reports)
      .where(eq(reports.id, params.data.id))
      .limit(1);
    if (!report || !["post", "reply"].includes(report.targetType)) {
      return reply.code(404).send({
        error: { code: "REPORT_NOT_FOUND", message: "Report not found." },
      });
    }
    const manageable = await moderatorForReportTarget(
      userId,
      report.targetType,
      report.targetId,
    );
    if (!manageable) {
      return reply.code(404).send({
        error: { code: "REPORT_NOT_FOUND", message: "Report not found." },
      });
    }

    const [updatedReport] = await database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(reports)
        .set({ status: body.data.status, updatedAt: new Date() })
        .where(eq(reports.id, report.id))
        .returning({
          id: reports.id,
          status: reports.status,
          updatedAt: reports.updatedAt,
        });
      if (updated) {
        await transaction.insert(moderationActions).values({
          actorId: userId,
          communityId: manageable.communityId,
          targetType: "report",
          targetId: report.id,
          action: body.data.status,
          reason: body.data.reason,
        });
        if (body.data.removeContent) {
          const deletedAt = new Date();
          if (report.targetType === "post") {
            const [removed] = await transaction
              .update(posts)
              .set({ deletedAt, updatedAt: deletedAt })
              .where(
                and(eq(posts.id, report.targetId), isNull(posts.deletedAt)),
              )
              .returning({ id: posts.id });
            if (removed) {
              await recordPostEmberRemoval(transaction, {
                postId: removed.id,
                actorId: userId,
                communityId: manageable.communityId,
              });
            }
          } else {
            const [removed] = await transaction
              .update(replies)
              .set({ deletedAt, updatedAt: deletedAt })
              .where(
                and(eq(replies.id, report.targetId), isNull(replies.deletedAt)),
              )
              .returning({ id: replies.id });
            if (removed) {
              await recordReplyEmberRemoval(transaction, {
                replyId: removed.id,
                actorId: userId,
                communityId: manageable.communityId,
              });
            }
          }
          await transaction.insert(outboxEvents).values({
            topic:
              report.targetType === "post" ? "post.deleted" : "reply.deleted",
            communityId: manageable.communityId,
            entityId:
              report.targetType === "post"
                ? report.targetId
                : manageable.postId,
            payload:
              report.targetType === "post"
                ? { postId: report.targetId }
                : { postId: manageable.postId, replyId: report.targetId },
          });
          await transaction.insert(moderationActions).values({
            actorId: userId,
            communityId: manageable.communityId,
            targetType: report.targetType,
            targetId: report.targetId,
            action: "content_removed",
            reason: body.data.reason,
          });
        }
      }
      return [updated];
    });
    if (!updatedReport) {
      return reply.code(404).send({
        error: { code: "REPORT_NOT_FOUND", message: "Report not found." },
      });
    }
    return { report: updatedReport };
  });

  app.patch("/api/v1/notifications/:id", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    const body = notificationReadSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply);

    const [notification] = await database
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(
        and(
          eq(notifications.id, params.data.id),
          eq(notifications.recipientId, userId),
        ),
      )
      .returning({ id: notifications.id, readAt: notifications.readAt });
    if (!notification) {
      return reply.code(404).send({
        error: {
          code: "NOTIFICATION_NOT_FOUND",
          message: "Notification not found.",
        },
      });
    }
    return { notification };
  });

  app.post("/api/v1/notifications/read-all", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const updated = await database
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.recipientId, userId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return { updatedCount: updated.length };
  });

  app.post(
    "/api/v1/reports",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const userId = await authenticatedUserId(request, reply);
      if (!userId) return;
      const body = reportBodySchema.safeParse(request.body);
      if (!body.success) return invalidRequest(reply);

      const targetConditions =
        body.data.targetType === "post"
          ? and(
              eq(posts.id, body.data.targetId),
              isNull(posts.deletedAt),
              eq(communities.isPublic, true),
              eq(communities.status, "active"),
            )
          : and(
              eq(replies.id, body.data.targetId),
              isNull(replies.deletedAt),
              isNull(posts.deletedAt),
              eq(communities.isPublic, true),
              eq(communities.status, "active"),
            );
      const targetQuery = database
        .select({ id: body.data.targetType === "post" ? posts.id : replies.id })
        .from(body.data.targetType === "post" ? posts : replies);
      const target =
        body.data.targetType === "post"
          ? await targetQuery
              .innerJoin(communities, eq(communities.id, posts.communityId))
              .innerJoin(users, eq(users.id, posts.authorId))
              .where(and(targetConditions, isNull(users.deletedAt)))
              .limit(1)
          : await targetQuery
              .innerJoin(posts, eq(posts.id, replies.postId))
              .innerJoin(communities, eq(communities.id, posts.communityId))
              .innerJoin(users, eq(users.id, replies.authorId))
              .where(and(targetConditions, isNull(users.deletedAt)))
              .limit(1);
      if (!target.length) {
        return reply.code(404).send({
          error: {
            code: "REPORT_TARGET_NOT_FOUND",
            message: "That content is not available.",
          },
        });
      }

      const [report] = await database
        .insert(reports)
        .values({
          reporterId: userId,
          targetType: body.data.targetType,
          targetId: body.data.targetId,
          reason: body.data.reason,
        })
        .returning({ id: reports.id, status: reports.status });
      return reply.code(201).send({ report });
    },
  );

  app.patch(
    "/api/v1/communities/:slug/members/:username/role",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const userId = await authenticatedUserId(request, reply);
      if (!userId) return;
      const params = z
        .object({
          slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,29}$/),
        })
        .safeParse(request.params);
      const body = memberRoleUpdateSchema.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);

      const [community] = await database
        .select({
          id: communities.id,
          slug: communities.slug,
          name: communities.name,
        })
        .from(communities)
        .where(
          and(
            eq(communities.slug, params.data.slug),
            eq(communities.isPublic, true),
            eq(communities.status, "active"),
          ),
        )
        .limit(1);
      if (!community) {
        return reply.code(404).send({
          error: {
            code: "COMMUNITY_NOT_FOUND",
            message: "Community not found.",
          },
        });
      }

      const [manager] = await database
        .select({ role: communityMemberships.role })
        .from(communityMemberships)
        .where(
          and(
            eq(communityMemberships.communityId, community.id),
            eq(communityMemberships.userId, userId),
          ),
        )
        .limit(1);
      if (manager?.role !== "owner") {
        return reply.code(403).send({
          error: {
            code: "OWNER_REQUIRED",
            message: "Only the community owner can assign moderators.",
          },
        });
      }

      const [target] = await database
        .select({
          userId: profiles.userId,
          username: profiles.username,
          displayName: profiles.displayName,
        })
        .from(profiles)
        .innerJoin(users, eq(users.id, profiles.userId))
        .where(
          and(
            eq(profiles.username, params.data.username),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
      if (!target) {
        return reply.code(404).send({
          error: {
            code: "MEMBER_NOT_FOUND",
            message: "Community member not found.",
          },
        });
      }
      const [membership] = await database
        .select({ role: communityMemberships.role })
        .from(communityMemberships)
        .where(
          and(
            eq(communityMemberships.communityId, community.id),
            eq(communityMemberships.userId, target.userId),
          ),
        )
        .limit(1);
      if (!membership) {
        return reply.code(404).send({
          error: {
            code: "MEMBER_NOT_FOUND",
            message: "Community member not found.",
          },
        });
      }
      if (membership.role === "owner") {
        return reply.code(409).send({
          error: {
            code: "OWNER_TRANSFER_REQUIRED",
            message:
              "Owner roles cannot be changed through moderator assignment.",
          },
        });
      }

      const [actor] = await database
        .select({
          username: profiles.username,
          displayName: profiles.displayName,
        })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);
      const [updated] = await database.transaction(async (transaction) => {
        const [result] = await transaction
          .update(communityMemberships)
          .set({ role: body.data.role })
          .where(
            and(
              eq(communityMemberships.communityId, community.id),
              eq(communityMemberships.userId, target.userId),
            ),
          )
          .returning({ role: communityMemberships.role });
        if (result && result.role !== membership.role) {
          await transaction.insert(moderationActions).values({
            actorId: userId,
            communityId: community.id,
            targetType: "membership",
            targetId: target.userId,
            action: `role_${result.role}`,
            reason: `Community owner ${actor?.username ?? "unknown"} changed the member role.`,
          });
          const [notification] = await transaction
            .insert(notifications)
            .values({
              recipientId: target.userId,
              type: "community",
              entityId: community.id,
              payload: {
                action: "role_changed",
                title: `Your role in ${community.name} changed to ${result.role}`,
                detail: `Updated by ${actor?.displayName ?? "the community owner"}.`,
                communitySlug: community.slug,
              },
            })
            .returning({ id: notifications.id });
          if (notification) {
            await transaction.insert(outboxEvents).values({
              topic: "notification.created",
              recipientId: target.userId,
              entityId: notification.id,
              payload: { notificationId: notification.id },
            });
          }
        }
        return [result];
      });
      return {
        member: {
          username: target.username,
          role: updated?.role ?? membership.role,
        },
      };
    },
  );

  app.post(
    "/api/v1/communities/:slug/members/:username/actions",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const userId = await authenticatedUserId(request, reply);
      if (!userId) return;
      const params = z
        .object({
          slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,29}$/),
        })
        .safeParse(request.params);
      const body = memberModerationSchema.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);

      const [community] = await database
        .select({
          id: communities.id,
          slug: communities.slug,
          name: communities.name,
        })
        .from(communities)
        .where(
          and(
            eq(communities.slug, params.data.slug),
            eq(communities.isPublic, true),
            eq(communities.status, "active"),
          ),
        )
        .limit(1);
      if (!community) {
        return reply.code(404).send({
          error: {
            code: "COMMUNITY_NOT_FOUND",
            message: "Community not found.",
          },
        });
      }

      const [actorMembership] = await database
        .select({ role: communityMemberships.role })
        .from(communityMemberships)
        .where(
          and(
            eq(communityMemberships.communityId, community.id),
            eq(communityMemberships.userId, userId),
          ),
        )
        .limit(1);
      if (
        actorMembership?.role !== "owner" &&
        actorMembership?.role !== "moderator"
      ) {
        return reply.code(403).send({
          error: {
            code: "MODERATOR_REQUIRED",
            message:
              "Only community owners and moderators can take member actions.",
          },
        });
      }

      const [target] = await database
        .select({
          id: users.id,
          username: profiles.username,
          displayName: profiles.displayName,
        })
        .from(profiles)
        .innerJoin(users, eq(users.id, profiles.userId))
        .where(
          and(
            eq(profiles.username, params.data.username),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
      if (!target) {
        return reply.code(404).send({
          error: {
            code: "MEMBER_NOT_FOUND",
            message: "Community member not found.",
          },
        });
      }

      const [targetMembership] = await database
        .select({ role: communityMemberships.role })
        .from(communityMemberships)
        .where(
          and(
            eq(communityMemberships.communityId, community.id),
            eq(communityMemberships.userId, target.id),
          ),
        )
        .limit(1);
      if (!targetMembership) {
        return reply.code(404).send({
          error: {
            code: "MEMBER_NOT_FOUND",
            message: "Community member not found.",
          },
        });
      }
      if (
        targetMembership.role === "owner" ||
        (targetMembership.role === "moderator" &&
          actorMembership.role !== "owner")
      ) {
        return reply.code(403).send({
          error: {
            code: "MEMBER_ACTION_FORBIDDEN",
            message:
              "You cannot take this action against a community owner or moderator.",
          },
        });
      }
      if (target.id === userId) {
        return reply.code(400).send({
          error: {
            code: "CANNOT_MODERATE_SELF",
            message: "You cannot moderate yourself.",
          },
        });
      }

      const actionName = {
        warn: "member_warned",
        mute: "member_muted",
        unmute: "member_unmuted",
        remove: "member_removed",
      }[body.data.action];
      await database.transaction(async (transaction) => {
        if (body.data.action === "remove") {
          await transaction
            .delete(communityMemberships)
            .where(
              and(
                eq(communityMemberships.communityId, community.id),
                eq(communityMemberships.userId, target.id),
              ),
            );
        } else if (body.data.action === "mute") {
          await transaction
            .insert(communityMemberMutes)
            .values({
              communityId: community.id,
              userId: target.id,
              moderatorId: userId,
              reason: body.data.reason,
            })
            .onConflictDoUpdate({
              target: [
                communityMemberMutes.communityId,
                communityMemberMutes.userId,
              ],
              set: {
                moderatorId: userId,
                reason: body.data.reason,
                createdAt: new Date(),
              },
            });
        } else if (body.data.action === "unmute") {
          await transaction
            .delete(communityMemberMutes)
            .where(
              and(
                eq(communityMemberMutes.communityId, community.id),
                eq(communityMemberMutes.userId, target.id),
              ),
            );
        }
        await transaction.insert(moderationActions).values({
          actorId: userId,
          communityId: community.id,
          targetType: "membership",
          targetId: target.id,
          action: actionName,
          reason: body.data.reason,
        });
        const [notification] = await transaction
          .insert(notifications)
          .values({
            recipientId: target.id,
            type: "community",
            entityId: community.id,
            payload: {
              action: actionName,
              title:
                body.data.action === "warn"
                  ? `A moderator sent you a warning in ${community.name}`
                  : body.data.action === "mute"
                    ? `You were muted in ${community.name}`
                    : body.data.action === "unmute"
                      ? `Your mute was lifted in ${community.name}`
                      : `You were removed from ${community.name}`,
              detail: body.data.reason,
              communitySlug: community.slug,
            },
          })
          .returning({ id: notifications.id });
        if (notification) {
          await transaction.insert(outboxEvents).values({
            topic: "notification.created",
            recipientId: target.id,
            entityId: notification.id,
            payload: { notificationId: notification.id },
          });
        }
        if (body.data.action === "remove") {
          await transaction.insert(outboxEvents).values({
            topic: "community.membership.changed",
            communityId: community.id,
            entityId: community.id,
            payload: { userId: target.id, removed: true },
          });
        }
      });

      return {
        action: body.data.action,
        member: { username: target.username, displayName: target.displayName },
      };
    },
  );

  app.patch(
    "/api/v1/communities/:slug",
    { bodyLimit: 5_000_000 },
    async (request, reply) => {
      const userId = await authenticatedUserId(request, reply);
      if (!userId) return;
      const params = slugParamsSchema.safeParse(request.params);
      const body = updateCommunitySchema.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);

      const requestedSlug =
        body.data.name === undefined
          ? undefined
          : communitySlugFromName(body.data.name);
      if (requestedSlug === null) return invalidRequest(reply);

      const result = await database.transaction(async (transaction) => {
        const [community] = await transaction
          .select({
            id: communities.id,
            creatorId: communities.creatorId,
            slug: communities.slug,
            name: communities.name,
            description: communities.description,
            avatarUrl: communities.avatarUrl,
            bannerUrl: communities.bannerUrl,
            websiteUrl: communities.websiteUrl,
          })
          .from(communities)
          .where(
            and(
              eq(communities.slug, params.data.slug),
              eq(communities.isPublic, true),
              eq(communities.status, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (!community) return { kind: "notFound" as const };
        const [membership] = await transaction
          .select({ role: communityMemberships.role })
          .from(communityMemberships)
          .where(
            and(
              eq(communityMemberships.communityId, community.id),
              eq(communityMemberships.userId, userId),
            ),
          )
          .limit(1);
        if (community.creatorId !== userId && membership?.role !== "owner") {
          return { kind: "forbidden" as const };
        }

        const nextSlug = requestedSlug ?? community.slug;
        if (nextSlug !== community.slug) {
          const [slugTaken] = await transaction
            .select({ id: communities.id })
            .from(communities)
            .where(eq(communities.slug, nextSlug))
            .limit(1);
          const [aliasTaken] = await transaction
            .select({ communityId: communitySlugAliases.communityId })
            .from(communitySlugAliases)
            .where(eq(communitySlugAliases.slug, nextSlug))
            .limit(1);
          if (slugTaken || aliasTaken) return { kind: "slugTaken" as const };

          await transaction.insert(communitySlugAliases).values({
            slug: community.slug,
            communityId: community.id,
          });
        }

        const [updated] = await transaction
          .update(communities)
          .set({
            ...(body.data.name === undefined ? {} : { name: body.data.name }),
            ...(body.data.description === undefined
              ? {}
              : { description: body.data.description }),
            ...(body.data.avatarUrl === undefined
              ? {}
              : { avatarUrl: body.data.avatarUrl }),
            ...(body.data.bannerUrl === undefined
              ? {}
              : { bannerUrl: body.data.bannerUrl }),
            ...(body.data.websiteUrl === undefined
              ? {}
              : { websiteUrl: body.data.websiteUrl }),
            slug: nextSlug,
            updatedAt: new Date(),
          })
          .where(eq(communities.id, community.id))
          .returning({
            id: communities.id,
            slug: communities.slug,
            name: communities.name,
            description: communities.description,
            avatarUrl: communities.avatarUrl,
            bannerUrl: communities.bannerUrl,
            websiteUrl: communities.websiteUrl,
          });
        if (updated) {
          await transaction.insert(outboxEvents).values({
            topic: "community.updated",
            communityId: updated.id,
            entityId: updated.id,
            payload: { slug: updated.slug, previousSlug: community.slug },
          });
        }
        return { kind: "updated" as const, community: updated };
      });

      if (result.kind === "notFound") {
        return reply.code(404).send({
          error: {
            code: "COMMUNITY_NOT_FOUND",
            message: "Community not found.",
          },
        });
      }
      if (result.kind === "forbidden") {
        return reply.code(403).send({
          error: {
            code: "OWNER_REQUIRED",
            message: "Only this community's owner can edit it.",
          },
        });
      }
      if (result.kind === "slugTaken") {
        return reply.code(409).send({
          error: {
            code: "COMMUNITY_SLUG_TAKEN",
            message: "That community name is already in use.",
          },
        });
      }
      return { community: result.community };
    },
  );

  app.post(
    "/api/v1/communities/:slug/owner",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const userId = await authenticatedUserId(request, reply);
      if (!userId) return;
      const params = slugParamsSchema.safeParse(request.params);
      const body = ownerTransferSchema.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);

      const result = await database.transaction(async (transaction) => {
        const [community] = await transaction
          .select({
            id: communities.id,
            creatorId: communities.creatorId,
            slug: communities.slug,
            name: communities.name,
          })
          .from(communities)
          .where(
            and(
              eq(communities.slug, params.data.slug),
              eq(communities.isPublic, true),
              eq(communities.status, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (!community) return { kind: "notFound" as const };

        const [ownerMembership] = await transaction
          .select({ role: communityMemberships.role })
          .from(communityMemberships)
          .where(
            and(
              eq(communityMemberships.communityId, community.id),
              eq(communityMemberships.userId, userId),
            ),
          )
          .limit(1);
        if (
          community.creatorId !== userId &&
          ownerMembership?.role !== "owner"
        ) {
          return { kind: "forbidden" as const };
        }

        const [target] = await transaction
          .select({
            id: users.id,
            username: profiles.username,
            displayName: profiles.displayName,
          })
          .from(profiles)
          .innerJoin(users, eq(users.id, profiles.userId))
          .where(
            and(
              eq(profiles.username, body.data.username),
              isNull(users.deletedAt),
            ),
          )
          .limit(1);
        if (!target) return { kind: "memberNotFound" as const };
        if (target.id === userId) return { kind: "sameOwner" as const };

        const [targetMembership] = await transaction
          .select({ role: communityMemberships.role })
          .from(communityMemberships)
          .where(
            and(
              eq(communityMemberships.communityId, community.id),
              eq(communityMemberships.userId, target.id),
            ),
          )
          .for("update")
          .limit(1);
        if (!targetMembership) return { kind: "memberNotFound" as const };

        const [actor] = await transaction
          .select({
            displayName: profiles.displayName,
            username: profiles.username,
          })
          .from(profiles)
          .where(eq(profiles.userId, userId))
          .limit(1);
        const previousOwnerId = community.creatorId ?? userId;

        await transaction
          .update(communityMemberships)
          .set({ role: "member" })
          .where(
            and(
              eq(communityMemberships.communityId, community.id),
              eq(communityMemberships.userId, userId),
            ),
          );
        await transaction
          .update(communityMemberships)
          .set({ role: "owner" })
          .where(
            and(
              eq(communityMemberships.communityId, community.id),
              eq(communityMemberships.userId, target.id),
            ),
          );
        await transaction
          .update(communities)
          .set({ creatorId: target.id, updatedAt: new Date() })
          .where(eq(communities.id, community.id));

        await transaction.insert(moderationActions).values({
          actorId: userId,
          communityId: community.id,
          targetType: "membership",
          targetId: target.id,
          action: "owner_transferred",
          reason: `Ownership transferred to ${target.username}.`,
        });

        const affectedUsers = [...new Set([target.id, previousOwnerId])];
        for (const recipientId of affectedUsers) {
          const [notification] = await transaction
            .insert(notifications)
            .values({
              recipientId,
              type: "community",
              entityId: community.id,
              payload: {
                action: "owner_transferred",
                title:
                  recipientId === target.id
                    ? `You are now the owner of ${community.name}`
                    : `Ownership of ${community.name} was transferred`,
                detail: `Updated by ${actor?.displayName ?? "the community owner"}.`,
                communitySlug: community.slug,
              },
            })
            .returning({ id: notifications.id });
          if (notification) {
            await transaction.insert(outboxEvents).values({
              topic: "notification.created",
              recipientId,
              entityId: notification.id,
              payload: { notificationId: notification.id },
            });
          }
        }
        await transaction.insert(outboxEvents).values({
          topic: "community.owner_changed",
          communityId: community.id,
          entityId: community.id,
          payload: { slug: community.slug },
        });
        return {
          kind: "transferred" as const,
          owner: { username: target.username, displayName: target.displayName },
        };
      });

      if (result.kind === "notFound") {
        return reply.code(404).send({
          error: {
            code: "COMMUNITY_NOT_FOUND",
            message: "Community not found.",
          },
        });
      }
      if (result.kind === "forbidden") {
        return reply.code(403).send({
          error: {
            code: "OWNER_REQUIRED",
            message: "Only the community owner can transfer ownership.",
          },
        });
      }
      if (result.kind === "memberNotFound") {
        return reply.code(404).send({
          error: {
            code: "COMMUNITY_MEMBER_NOT_FOUND",
            message:
              "The new owner must be an active member of this community.",
          },
        });
      }
      if (result.kind === "sameOwner") {
        return reply.code(400).send({
          error: {
            code: "OWNER_TRANSFER_TO_SELF",
            message: "Choose another active community member.",
          },
        });
      }
      return { owner: result.owner };
    },
  );

  app.delete(
    "/api/v1/communities/:slug",
    { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const userId = await authenticatedUserId(request, reply);
      if (!userId) return;
      const params = slugParamsSchema.safeParse(request.params);
      if (!params.success) return invalidRequest(reply);

      const result = await database.transaction(async (transaction) => {
        const [community] = await transaction
          .select({
            id: communities.id,
            creatorId: communities.creatorId,
            name: communities.name,
          })
          .from(communities)
          .where(
            and(
              eq(communities.slug, params.data.slug),
              eq(communities.isPublic, true),
              eq(communities.status, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (!community) return { kind: "notFound" as const };
        const [membership] = await transaction
          .select({ role: communityMemberships.role })
          .from(communityMemberships)
          .where(
            and(
              eq(communityMemberships.communityId, community.id),
              eq(communityMemberships.userId, userId),
            ),
          )
          .limit(1);
        if (community.creatorId !== userId && membership?.role !== "owner") {
          return { kind: "forbidden" as const };
        }
        const [archived] = await transaction
          .update(communities)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(communities.id, community.id))
          .returning({ id: communities.id, slug: communities.slug });
        if (archived) {
          await transaction.insert(moderationActions).values({
            actorId: userId,
            communityId: community.id,
            targetType: "community",
            targetId: community.id,
            action: "community_archived",
            reason: "Community owner archived the community.",
          });
          await transaction.insert(outboxEvents).values({
            topic: "community.archived",
            communityId: community.id,
            entityId: community.id,
            payload: { slug: archived.slug },
          });
        }
        return { kind: "archived" as const, name: community.name };
      });

      if (result.kind === "notFound") {
        return reply.code(404).send({
          error: {
            code: "COMMUNITY_NOT_FOUND",
            message: "Community not found.",
          },
        });
      }
      if (result.kind === "forbidden") {
        return reply.code(403).send({
          error: {
            code: "OWNER_REQUIRED",
            message: "Only the community owner can delete it.",
          },
        });
      }
      return reply.code(204).send();
    },
  );

  app.patch("/api/v1/me/profile", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const body = profileUpdateSchema.safeParse(request.body);
    if (!body.success) return invalidRequest(reply);

    const updates: Partial<typeof profiles.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.data.displayName !== undefined) {
      updates.displayName = body.data.displayName;
      updates.initials = body.data.displayName
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("");
    }
    if (body.data.bio !== undefined) updates.bio = body.data.bio;
    if (Object.hasOwn(body.data, "avatarUrl")) {
      updates.avatarUrl = body.data.avatarUrl ?? null;
      updates.avatarVersion = new Date().toISOString();
    }
    const [profile] = await database.transaction(async (transaction) => {
      const [updatedProfile] = await transaction
        .update(profiles)
        .set(updates)
        .where(eq(profiles.userId, userId))
        .returning({
          username: profiles.username,
          displayName: profiles.displayName,
          bio: profiles.bio,
          avatarUrl: profiles.avatarUrl,
          avatarVersion: profiles.avatarVersion,
          initials: profiles.initials,
          avatarColor: profiles.avatarColor,
        });
      if (updatedProfile) {
        await transaction.insert(outboxEvents).values({
          topic: "profile.updated",
          recipientId: userId,
          entityId: userId,
          payload: { username: updatedProfile.username },
        });
      }
      return [updatedProfile];
    });
    if (!profile) {
      return reply.code(404).send({
        error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
      });
    }
    return { profile };
  });

  app.post("/api/v1/profiles/:username/follow", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = z
      .object({ username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,29}$/) })
      .safeParse(request.params);
    if (!params.success) return invalidRequest(reply);

    const [target] = await database
      .select({ userId: profiles.userId, username: profiles.username })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(
        and(
          eq(profiles.username, params.data.username),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!target) {
      return reply.code(404).send({
        error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
      });
    }
    if (target.userId === userId) {
      return reply.code(400).send({
        error: {
          code: "CANNOT_FOLLOW_SELF",
          message: "You cannot follow yourself.",
        },
      });
    }
    const [block] = await database
      .select({ blockerId: userBlocks.blockerId })
      .from(userBlocks)
      .where(
        or(
          and(
            eq(userBlocks.blockerId, userId),
            eq(userBlocks.blockedId, target.userId),
          ),
          and(
            eq(userBlocks.blockerId, target.userId),
            eq(userBlocks.blockedId, userId),
          ),
        ),
      )
      .limit(1);
    if (block) {
      return reply.code(403).send({
        error: {
          code: "PROFILE_INTERACTION_BLOCKED",
          message: "You cannot follow this profile.",
        },
      });
    }

    const [followerProfile] = await database
      .select({
        username: profiles.username,
        displayName: profiles.displayName,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    await database.transaction(async (transaction) => {
      const [follow] = await transaction
        .insert(userFollows)
        .values({ followerId: userId, followedId: target.userId })
        .onConflictDoNothing()
        .returning({ followedId: userFollows.followedId });
      if (follow) {
        await transaction.insert(outboxEvents).values({
          topic: "profile.followed",
          recipientId: target.userId,
          entityId: target.userId,
          payload: { followedBy: userId },
        });
        const [notification] = await transaction
          .insert(notifications)
          .values({
            recipientId: target.userId,
            type: "system",
            entityId: userId,
            payload: {
              action: "follow",
              actorUsername: followerProfile?.username ?? "member",
              actorName: followerProfile?.displayName ?? "A community member",
            },
          })
          .returning({ id: notifications.id });
        if (notification) {
          await transaction.insert(outboxEvents).values({
            topic: "notification.created",
            recipientId: target.userId,
            entityId: notification.id,
            payload: { notificationId: notification.id },
          });
        }
      }
    });
    const [followerCount] = await database
      .select({ value: sql<number>`count(*)::int` })
      .from(userFollows)
      .where(eq(userFollows.followedId, target.userId));
    return { following: true, followerCount: followerCount?.value ?? 0 };
  });

  app.delete("/api/v1/profiles/:username/follow", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = z
      .object({ username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,29}$/) })
      .safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    const [target] = await database
      .select({ userId: profiles.userId })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(
        and(
          eq(profiles.username, params.data.username),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!target) {
      return reply.code(404).send({
        error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
      });
    }
    if (target.userId === userId) {
      return reply.code(400).send({
        error: {
          code: "CANNOT_FOLLOW_SELF",
          message: "You cannot follow yourself.",
        },
      });
    }

    await database.transaction(async (transaction) => {
      const [follow] = await transaction
        .delete(userFollows)
        .where(
          and(
            eq(userFollows.followerId, userId),
            eq(userFollows.followedId, target.userId),
          ),
        )
        .returning({ followedId: userFollows.followedId });
      if (follow) {
        await transaction.insert(outboxEvents).values({
          topic: "profile.unfollowed",
          recipientId: target.userId,
          entityId: target.userId,
          payload: { followedBy: userId },
        });
      }
    });
    const [followerCount] = await database
      .select({ value: sql<number>`count(*)::int` })
      .from(userFollows)
      .where(eq(userFollows.followedId, target.userId));
    return { following: false, followerCount: followerCount?.value ?? 0 };
  });

  const profileSafetyAction = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: "block" | "mute",
    remove: boolean,
  ) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = z
      .object({ username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,29}$/) })
      .safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    const [target] = await database
      .select({ userId: profiles.userId })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(
        and(
          eq(profiles.username, params.data.username),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!target) {
      return reply.code(404).send({
        error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
      });
    }
    if (target.userId === userId) {
      return reply.code(400).send({
        error: {
          code: "CANNOT_CHANGE_OWN_SAFETY_STATE",
          message: `You cannot ${remove ? "remove" : "add"} a ${action} for your own account.`,
        },
      });
    }

    await database.transaction(async (transaction) => {
      if (action === "block") {
        if (remove) {
          await transaction
            .delete(userBlocks)
            .where(
              and(
                eq(userBlocks.blockerId, userId),
                eq(userBlocks.blockedId, target.userId),
              ),
            );
        } else {
          await transaction
            .insert(userBlocks)
            .values({ blockerId: userId, blockedId: target.userId })
            .onConflictDoNothing();
          await transaction
            .delete(userFollows)
            .where(
              or(
                and(
                  eq(userFollows.followerId, userId),
                  eq(userFollows.followedId, target.userId),
                ),
                and(
                  eq(userFollows.followerId, target.userId),
                  eq(userFollows.followedId, userId),
                ),
              ),
            );
        }
      } else if (remove) {
        await transaction
          .delete(userMutes)
          .where(
            and(
              eq(userMutes.muterId, userId),
              eq(userMutes.mutedId, target.userId),
            ),
          );
      } else {
        await transaction
          .insert(userMutes)
          .values({ muterId: userId, mutedId: target.userId })
          .onConflictDoNothing();
      }
    });
    return { [action === "block" ? "blocked" : "muted"]: !remove };
  };

  app.post(
    "/api/v1/profiles/:username/block",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request, reply) =>
      profileSafetyAction(request, reply, "block", false),
  );
  app.delete("/api/v1/profiles/:username/block", async (request, reply) =>
    profileSafetyAction(request, reply, "block", true),
  );
  app.post(
    "/api/v1/profiles/:username/mute",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request, reply) =>
      profileSafetyAction(request, reply, "mute", false),
  );
  app.delete("/api/v1/profiles/:username/mute", async (request, reply) =>
    profileSafetyAction(request, reply, "mute", true),
  );

  app.post(
    "/api/v1/communities",
    { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const userId = await authenticatedUserId(request, reply);
      if (!userId) return;
      const body = createCommunitySchema.safeParse(request.body);
      if (!body.success) return invalidRequest(reply);
      const slug = communitySlugFromName(body.data.name);
      if (!slug) return invalidRequest(reply);
      const idempotency = idempotencyContext(
        request,
        reply,
        userId,
        "community.create",
        body.data,
      );
      if (idempotency === undefined) return;

      try {
        const result = await database.transaction(async (transaction) => {
          await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .for("update");
          if (idempotency) {
            const claim = await claimIdempotency(transaction, idempotency);
            if (claim.kind !== "fresh") {
              return { kind: "idempotency" as const, claim };
            }
          }
          const [ownedCount] = await transaction
            .select({ value: sql<number>`count(*)::int` })
            .from(communities)
            .where(
              and(
                eq(communities.creatorId, userId),
                eq(communities.status, "active"),
              ),
            );
          if ((ownedCount?.value ?? 0) >= 5) {
            if (idempotency) {
              await storeIdempotencyResponse(transaction, idempotency, 409, {
                error: {
                  code: "COMMUNITY_LIMIT_REACHED",
                  message: "You can own up to five active communities.",
                },
              });
            }
            return { kind: "limit" as const };
          }
          const [slugAlias] = await transaction
            .select({ slug: communitySlugAliases.slug })
            .from(communitySlugAliases)
            .where(eq(communitySlugAliases.slug, slug))
            .limit(1);
          if (slugAlias) {
            if (idempotency) {
              await storeIdempotencyResponse(transaction, idempotency, 409, {
                error: {
                  code: "COMMUNITY_SLUG_TAKEN",
                  message: "That community name is already in use.",
                },
              });
            }
            return { kind: "slugTaken" as const };
          }

          const [created] = await transaction
            .insert(communities)
            .values({
              slug,
              name: body.data.name,
              description: body.data.description,
              creatorId: userId,
            })
            .returning({
              id: communities.id,
              slug: communities.slug,
              name: communities.name,
              description: communities.description,
              createdAt: communities.createdAt,
            });
          if (!created) return { kind: "limit" as const };
          await transaction.insert(communityMemberships).values({
            userId,
            communityId: created.id,
            role: "owner",
          });
          await transaction.insert(outboxEvents).values({
            topic: "community.created",
            communityId: created.id,
            entityId: created.id,
            payload: { slug: created.slug },
          });
          const response = { community: created };
          if (idempotency) {
            await storeIdempotencyResponse(
              transaction,
              idempotency,
              201,
              response,
            );
          }
          return { kind: "created" as const, community: created };
        });
        if (result.kind === "idempotency") {
          return sendIdempotencyClaim(reply, result.claim);
        }
        if (result.kind === "limit") {
          return reply.code(409).send({
            error: {
              code: "COMMUNITY_LIMIT_REACHED",
              message: "You can own up to five active communities.",
            },
          });
        }
        if (result.kind === "slugTaken") {
          return reply.code(409).send({
            error: {
              code: "COMMUNITY_SLUG_TAKEN",
              message: "That community name is already in use.",
            },
          });
        }
        return reply.code(201).send({ community: result.community });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505"
        ) {
          return reply.code(409).send({
            error: {
              code: "COMMUNITY_SLUG_TAKEN",
              message: "That community name is already in use.",
            },
          });
        }
        throw error;
      }
    },
  );

  app.post("/api/v1/communities/:slug/membership", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = slugParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);

    const [community] = await database
      .select({
        id: communities.id,
        slug: communities.slug,
        name: communities.name,
      })
      .from(communities)
      .where(
        and(
          eq(communities.slug, params.data.slug),
          eq(communities.isPublic, true),
          eq(communities.status, "active"),
        ),
      )
      .limit(1);
    if (!community) {
      return reply.code(404).send({
        error: { code: "COMMUNITY_NOT_FOUND", message: "Community not found." },
      });
    }

    const [actor] = await database
      .select({
        username: profiles.username,
        displayName: profiles.displayName,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    await database.transaction(async (transaction) => {
      const [membership] = await transaction
        .insert(communityMemberships)
        .values({ userId, communityId: community.id })
        .onConflictDoNothing()
        .returning({ userId: communityMemberships.userId });
      if (membership) {
        await transaction.insert(outboxEvents).values({
          topic: "community.membership.changed",
          communityId: community.id,
          entityId: community.id,
          payload: { userId, joined: true },
        });
        const managers = await transaction
          .select({ recipientId: communityMemberships.userId })
          .from(communityMemberships)
          .where(
            and(
              eq(communityMemberships.communityId, community.id),
              inArray(communityMemberships.role, ["owner", "moderator"]),
            ),
          );
        const recipients = managers.filter(
          (manager) => manager.recipientId !== userId,
        );
        if (recipients.length) {
          const createdNotifications = await transaction
            .insert(notifications)
            .values(
              recipients.map((recipient) => ({
                recipientId: recipient.recipientId,
                type: "community" as const,
                entityId: community.id,
                payload: {
                  action: "joined",
                  title: `${actor?.displayName ?? "A member"} joined ${community.name}`,
                  detail: `@${actor?.username ?? "member"} joined this community.`,
                  actorUsername: actor?.username ?? "member",
                  actorName: actor?.displayName ?? "A community member",
                  communitySlug: community.slug,
                },
              })),
            )
            .returning({
              id: notifications.id,
              recipientId: notifications.recipientId,
            });
          if (createdNotifications.length) {
            await transaction.insert(outboxEvents).values(
              createdNotifications.map((notification) => ({
                topic: "notification.created",
                recipientId: notification.recipientId,
                entityId: notification.id,
                payload: { notificationId: notification.id },
              })),
            );
          }
        }
      }
    });
    return reply.code(204).send();
  });

  app.delete("/api/v1/communities/:slug/membership", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = slugParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);

    const [community] = await database
      .select({
        id: communities.id,
        slug: communities.slug,
        name: communities.name,
      })
      .from(communities)
      .where(eq(communities.slug, params.data.slug))
      .limit(1);
    if (!community) {
      return reply.code(404).send({
        error: { code: "COMMUNITY_NOT_FOUND", message: "Community not found." },
      });
    }

    const [actor] = await database
      .select({
        username: profiles.username,
        displayName: profiles.displayName,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    await database.transaction(async (transaction) => {
      const [membership] = await transaction
        .delete(communityMemberships)
        .where(
          and(
            eq(communityMemberships.userId, userId),
            eq(communityMemberships.communityId, community.id),
          ),
        )
        .returning({ userId: communityMemberships.userId });
      if (membership) {
        await transaction.insert(outboxEvents).values({
          topic: "community.membership.changed",
          communityId: community.id,
          entityId: community.id,
          payload: { userId, joined: false },
        });
        const managers = await transaction
          .select({ recipientId: communityMemberships.userId })
          .from(communityMemberships)
          .where(
            and(
              eq(communityMemberships.communityId, community.id),
              inArray(communityMemberships.role, ["owner", "moderator"]),
            ),
          );
        const recipients = managers.filter(
          (manager) => manager.recipientId !== userId,
        );
        if (recipients.length) {
          const createdNotifications = await transaction
            .insert(notifications)
            .values(
              recipients.map((recipient) => ({
                recipientId: recipient.recipientId,
                type: "community" as const,
                entityId: community.id,
                payload: {
                  action: "left",
                  title: `${actor?.displayName ?? "A member"} left ${community.name}`,
                  detail: `@${actor?.username ?? "member"} left this community.`,
                  actorUsername: actor?.username ?? "member",
                  actorName: actor?.displayName ?? "A community member",
                  communitySlug: community.slug,
                },
              })),
            )
            .returning({
              id: notifications.id,
              recipientId: notifications.recipientId,
            });
          if (createdNotifications.length) {
            await transaction.insert(outboxEvents).values(
              createdNotifications.map((notification) => ({
                topic: "notification.created",
                recipientId: notification.recipientId,
                entityId: notification.id,
                payload: { notificationId: notification.id },
              })),
            );
          }
        }
      }
    });
    return reply.code(204).send();
  });

  app.post(
    "/api/v1/posts",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const userId = await authenticatedUserId(request, reply);
      if (!userId) return;
      const body = postBodySchema.safeParse(request.body);
      if (!body.success) return invalidRequest(reply);

      const [community] = await database
        .select({ id: communities.id })
        .from(communities)
        .where(
          and(
            eq(communities.slug, body.data.community),
            eq(communities.isPublic, true),
            eq(communities.status, "active"),
          ),
        )
        .limit(1);
      if (!community) {
        return reply.code(404).send({
          error: {
            code: "COMMUNITY_NOT_FOUND",
            message: "Community not found.",
          },
        });
      }

      const [membership] = await database
        .select({ userId: communityMemberships.userId })
        .from(communityMemberships)
        .where(
          and(
            eq(communityMemberships.userId, userId),
            eq(communityMemberships.communityId, community.id),
          ),
        )
        .limit(1);
      if (!membership) {
        return reply.code(403).send({
          error: {
            code: "MEMBERSHIP_REQUIRED",
            message: "Join this community to post.",
          },
        });
      }
      const [memberMute] = await database
        .select({ userId: communityMemberMutes.userId })
        .from(communityMemberMutes)
        .where(
          and(
            eq(communityMemberMutes.communityId, community.id),
            eq(communityMemberMutes.userId, userId),
          ),
        )
        .limit(1);
      if (memberMute) {
        return reply.code(403).send({
          error: {
            code: "COMMUNITY_MEMBER_MUTED",
            message: "You are muted in this community and cannot create posts.",
          },
        });
      }
      const idempotency = idempotencyContext(
        request,
        reply,
        userId,
        `post.create:${community.id}`,
        body.data,
      );
      if (idempotency === undefined) return;

      const url = body.data.url ?? null;
      const [postAuthor] = await database
        .select({
          username: profiles.username,
          displayName: profiles.displayName,
        })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);
      const result = await database.transaction(async (transaction) => {
        if (idempotency) {
          const claim = await claimIdempotency(transaction, idempotency);
          if (claim.kind !== "fresh")
            return { kind: "idempotency" as const, claim };
        }
        const [post] = await transaction
          .insert(posts)
          .values({
            communityId: community.id,
            authorId: userId,
            kind: body.data.kind,
            body: body.data.body,
            url,
            linkDomain: url ? new URL(url).hostname : null,
          })
          .returning({ id: posts.id, communityId: posts.communityId });
        if (post) {
          await transaction.insert(outboxEvents).values({
            topic: "post.created",
            communityId: post.communityId,
            entityId: post.id,
            payload: { postId: post.id },
          });
          const mentionedUsernames = extractMentionUsernames(body.data.body);
          if (mentionedUsernames.length) {
            const mentionedProfiles = await transaction
              .select({ recipientId: profiles.userId })
              .from(profiles)
              .innerJoin(users, eq(users.id, profiles.userId))
              .where(
                and(
                  inArray(profiles.username, mentionedUsernames),
                  isNull(users.deletedAt),
                ),
              );
            const recipients = mentionedProfiles.filter(
              (profile) => profile.recipientId !== userId,
            );
            if (recipients.length) {
              const createdNotifications = await transaction
                .insert(notifications)
                .values(
                  recipients.map((recipient) => ({
                    recipientId: recipient.recipientId,
                    type: "mention" as const,
                    entityId: post.id,
                    payload: {
                      actorUsername: postAuthor?.username ?? "member",
                      actorName:
                        postAuthor?.displayName ?? "A community member",
                      preview: body.data.body.slice(0, 180),
                    },
                  })),
                )
                .returning({
                  id: notifications.id,
                  recipientId: notifications.recipientId,
                });
              if (createdNotifications.length) {
                await transaction.insert(outboxEvents).values(
                  createdNotifications.map((notification) => ({
                    topic: "notification.created",
                    recipientId: notification.recipientId,
                    entityId: notification.id,
                    payload: { notificationId: notification.id },
                  })),
                );
              }
            }
          }
        }
        const response = { post };
        if (idempotency) {
          await storeIdempotencyResponse(
            transaction,
            idempotency,
            201,
            response,
          );
        }
        return { kind: "created" as const, post };
      });
      if (result.kind === "idempotency") {
        return sendIdempotencyClaim(reply, result.claim);
      }
      return reply.code(201).send({ post: result.post });
    },
  );

  app.patch("/api/v1/posts/:id", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    const body = postUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply);

    const post = await manageablePost(userId, params.data.id);
    if (!post) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }

    const nextBody = body.data.body ?? post.body;
    const nextUrl = body.data.url === undefined ? post.url : body.data.url;
    if (
      (post.kind === "text" && !nextBody) ||
      (post.kind !== "text" && !nextUrl)
    ) {
      return invalidRequest(reply);
    }

    const [updatedPost] = await database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(posts)
        .set({
          body: nextBody,
          url: nextUrl,
          linkDomain: nextUrl ? new URL(nextUrl).hostname : null,
          updatedAt: new Date(),
        })
        .where(and(eq(posts.id, post.id), isNull(posts.deletedAt)))
        .returning({
          id: posts.id,
          body: posts.body,
          url: posts.url,
          updatedAt: posts.updatedAt,
        });
      if (updated) {
        await transaction.insert(outboxEvents).values({
          topic: "post.updated",
          communityId: post.communityId,
          entityId: post.id,
          payload: { postId: post.id },
        });
      }
      return [updated];
    });
    if (!updatedPost) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    return { post: updatedPost };
  });

  app.delete("/api/v1/posts/:id", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);

    const post = await manageablePost(userId, params.data.id);
    if (!post) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }

    const deleted = await database.transaction(async (transaction) => {
      const [removed] = await transaction
        .update(posts)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(posts.id, post.id), isNull(posts.deletedAt)))
        .returning({ id: posts.id });
      if (removed) {
        await recordPostEmberRemoval(transaction, {
          postId: post.id,
          actorId: userId,
          communityId: post.communityId,
        });
        await transaction.insert(outboxEvents).values({
          topic: "post.deleted",
          communityId: post.communityId,
          entityId: post.id,
          payload: { postId: post.id },
        });
      }
      return removed;
    });
    if (!deleted) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    return reply.code(204).send();
  });

  app.post(
    "/api/v1/posts/:id/replies",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const userId = await authenticatedUserId(request, reply);
      if (!userId) return;
      const params = idParamsSchema.safeParse(request.params);
      const body = createReplySchema.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);
      const communityId = await activePostCommunityId(params.data.id);
      if (!communityId) {
        return reply.code(404).send({
          error: { code: "POST_NOT_FOUND", message: "Post not found." },
        });
      }
      const [memberMute] = await database
        .select({ userId: communityMemberMutes.userId })
        .from(communityMemberMutes)
        .where(
          and(
            eq(communityMemberMutes.communityId, communityId),
            eq(communityMemberMutes.userId, userId),
          ),
        )
        .limit(1);
      if (memberMute) {
        return reply.code(403).send({
          error: {
            code: "COMMUNITY_MEMBER_MUTED",
            message: "You are muted in this community and cannot reply.",
          },
        });
      }

      const [postAuthor] = await database
        .select({ userId: posts.authorId })
        .from(posts)
        .innerJoin(profiles, eq(profiles.userId, posts.authorId))
        .where(eq(posts.id, params.data.id))
        .limit(1);
      const parentAuthor = body.data.parentReplyId
        ? await database
            .select({ userId: replies.authorId })
            .from(replies)
            .innerJoin(users, eq(users.id, replies.authorId))
            .where(
              and(
                eq(replies.id, body.data.parentReplyId),
                eq(replies.postId, params.data.id),
                isNull(replies.deletedAt),
                isNull(users.deletedAt),
              ),
            )
            .limit(1)
        : [];
      if (body.data.parentReplyId && !parentAuthor.length) {
        return reply.code(404).send({
          error: {
            code: "PARENT_REPLY_NOT_FOUND",
            message: "Parent reply not found.",
          },
        });
      }
      const idempotency = idempotencyContext(
        request,
        reply,
        userId,
        `reply.create:${params.data.id}`,
        body.data,
      );
      if (idempotency === undefined) return;
      const [replyAuthor] = await database
        .select({
          username: profiles.username,
          displayName: profiles.displayName,
        })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);

      const result = await database.transaction(async (transaction) => {
        if (idempotency) {
          const claim = await claimIdempotency(transaction, idempotency);
          if (claim.kind !== "fresh")
            return { kind: "idempotency" as const, claim };
        }
        const [newReply] = await transaction
          .insert(replies)
          .values({
            postId: params.data.id,
            authorId: userId,
            body: body.data.body,
            parentReplyId: body.data.parentReplyId ?? null,
          })
          .returning({ id: replies.id });
        if (newReply) {
          await transaction.insert(outboxEvents).values({
            topic: "reply.created",
            communityId,
            entityId: params.data.id,
            payload: { postId: params.data.id, replyId: newReply.id },
          });
          const parentAuthorId = parentAuthor[0]?.userId;
          const notificationTargets = new Map<string, "post" | "reply">();
          if (postAuthor && postAuthor.userId !== userId) {
            notificationTargets.set(
              postAuthor.userId,
              parentAuthorId === postAuthor.userId ? "reply" : "post",
            );
          }
          if (parentAuthorId && parentAuthorId !== userId) {
            notificationTargets.set(parentAuthorId, "reply");
          }
          if (notificationTargets.size) {
            const createdNotifications = await transaction
              .insert(notifications)
              .values(
                [...notificationTargets].map(([recipientId, targetKind]) => ({
                  recipientId,
                  type: "reply" as const,
                  entityId: params.data.id,
                  payload: {
                    targetKind,
                    replyId: targetKind === "reply" ? newReply.id : undefined,
                    actorUsername: replyAuthor?.username ?? "member",
                    actorName: replyAuthor?.displayName ?? "A community member",
                    preview: body.data.body.slice(0, 180),
                  },
                })),
              )
              .returning({
                id: notifications.id,
                recipientId: notifications.recipientId,
              });
            if (createdNotifications.length) {
              await transaction.insert(outboxEvents).values(
                createdNotifications.map((notification) => ({
                  topic: "notification.created",
                  recipientId: notification.recipientId,
                  entityId: notification.id,
                  payload: { notificationId: notification.id },
                })),
              );
            }
          }
          const mentionedUsernames = extractMentionUsernames(body.data.body);
          if (mentionedUsernames.length) {
            const mentionedProfiles = await transaction
              .select({ recipientId: profiles.userId })
              .from(profiles)
              .innerJoin(users, eq(users.id, profiles.userId))
              .where(
                and(
                  inArray(profiles.username, mentionedUsernames),
                  isNull(users.deletedAt),
                ),
              );
            const recipients = mentionedProfiles.filter(
              (profile) =>
                profile.recipientId !== userId &&
                profile.recipientId !== postAuthor?.userId &&
                profile.recipientId !== parentAuthorId,
            );
            if (recipients.length) {
              const createdNotifications = await transaction
                .insert(notifications)
                .values(
                  recipients.map((recipient) => ({
                    recipientId: recipient.recipientId,
                    type: "mention" as const,
                    entityId: params.data.id,
                    payload: {
                      actorUsername: replyAuthor?.username ?? "member",
                      actorName:
                        replyAuthor?.displayName ?? "A community member",
                      preview: body.data.body.slice(0, 180),
                    },
                  })),
                )
                .returning({
                  id: notifications.id,
                  recipientId: notifications.recipientId,
                });
              if (createdNotifications.length) {
                await transaction.insert(outboxEvents).values(
                  createdNotifications.map((notification) => ({
                    topic: "notification.created",
                    recipientId: notification.recipientId,
                    entityId: notification.id,
                    payload: { notificationId: notification.id },
                  })),
                );
              }
            }
          }
        }
        const response = { reply: newReply };
        if (idempotency) {
          await storeIdempotencyResponse(
            transaction,
            idempotency,
            201,
            response,
          );
        }
        return { kind: "created" as const, reply: newReply };
      });
      if (result.kind === "idempotency") {
        return sendIdempotencyClaim(reply, result.claim);
      }
      return reply.code(201).send({ reply: result.reply });
    },
  );

  app.patch("/api/v1/replies/:id", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    const body = replyBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply);

    const target = await manageableReply(userId, params.data.id);
    if (!target) {
      return reply.code(404).send({
        error: { code: "REPLY_NOT_FOUND", message: "Reply not found." },
      });
    }

    const [updated] = await database.transaction(async (transaction) => {
      const [result] = await transaction
        .update(replies)
        .set({ body: body.data.body, updatedAt: new Date() })
        .where(and(eq(replies.id, target.id), isNull(replies.deletedAt)))
        .returning({
          id: replies.id,
          body: replies.body,
          updatedAt: replies.updatedAt,
        });
      if (result) {
        await transaction.insert(outboxEvents).values({
          topic: "reply.updated",
          communityId: target.communityId,
          entityId: target.postId,
          payload: { postId: target.postId, replyId: target.id },
        });
      }
      return [result];
    });
    if (!updated) {
      return reply.code(404).send({
        error: { code: "REPLY_NOT_FOUND", message: "Reply not found." },
      });
    }
    return { reply: updated };
  });

  app.delete("/api/v1/replies/:id", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);

    const target = await manageableReply(userId, params.data.id);
    if (!target) {
      return reply.code(404).send({
        error: { code: "REPLY_NOT_FOUND", message: "Reply not found." },
      });
    }

    const [deleted] = await database.transaction(async (transaction) => {
      const [result] = await transaction
        .update(replies)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(replies.id, target.id), isNull(replies.deletedAt)))
        .returning({ id: replies.id });
      if (result) {
        await recordReplyEmberRemoval(transaction, {
          replyId: target.id,
          actorId: userId,
          communityId: target.communityId,
        });
        await transaction.insert(outboxEvents).values({
          topic: "reply.deleted",
          communityId: target.communityId,
          entityId: target.postId,
          payload: { postId: target.postId, replyId: target.id },
        });
      }
      return [result];
    });
    if (!deleted) {
      return reply.code(404).send({
        error: { code: "REPLY_NOT_FOUND", message: "Reply not found." },
      });
    }
    return reply.code(204).send();
  });

  app.post("/api/v1/posts/:id/vote", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    const body = z
      .object({ direction: z.enum(["up", "down"]) })
      .safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply);
    const communityId = await activePostCommunityId(params.data.id);
    if (!communityId) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    const result = await setPostVote(
      userId,
      params.data.id,
      communityId,
      body.data.direction,
      { toggleCurrent: true },
    );
    if (!result) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    if ("error" in result) {
      return reply.code(409).send({
        error: {
          code: result.error,
          message: "You cannot react to your own post.",
        },
      });
    }
    return result;
  });

  app.post("/api/v1/posts/:id/reaction", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    const communityId = await activePostCommunityId(params.data.id);
    if (!communityId) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    const result = await setPostVote(userId, params.data.id, communityId, "up");
    if (!result) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    if ("error" in result) {
      return reply.code(409).send({
        error: {
          code: result.error,
          message: "You cannot react to your own post.",
        },
      });
    }
    return { ...result, reacted: result.voteDirection === "up" };
  });

  app.delete("/api/v1/posts/:id/reaction", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    const communityId = await activePostCommunityId(params.data.id);
    if (!communityId) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    const result = await setPostVote(
      userId,
      params.data.id,
      communityId,
      null,
      { removeOnlyUp: true },
    );
    if (!result) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    return { ...result, reacted: false };
  });

  app.post("/api/v1/replies/:id/reaction", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);

    const [target] = await database
      .select({
        id: replies.id,
        postId: replies.postId,
        authorId: replies.authorId,
        communityId: posts.communityId,
      })
      .from(replies)
      .innerJoin(posts, eq(posts.id, replies.postId))
      .innerJoin(communities, eq(communities.id, posts.communityId))
      .where(
        and(
          eq(replies.id, params.data.id),
          isNull(replies.deletedAt),
          isNull(posts.deletedAt),
          eq(communities.isPublic, true),
          eq(communities.status, "active"),
        ),
      )
      .limit(1);
    if (!target) {
      return reply.code(404).send({
        error: { code: "REPLY_NOT_FOUND", message: "Reply not found." },
      });
    }
    if (target.authorId === userId) {
      return reply.code(409).send({
        error: {
          code: "SELF_REACTION_NOT_ALLOWED",
          message: "You cannot react to your own reply.",
        },
      });
    }

    return database.transaction(async (transaction) => {
      const [reaction] = await transaction
        .insert(replyReactions)
        .values({ userId, replyId: target.id, type: "like" })
        .onConflictDoNothing()
        .returning({ replyId: replyReactions.replyId });
      const [updated] = reaction
        ? await transaction
            .update(replies)
            .set({ voteCount: sql`${replies.voteCount} + 1` })
            .where(eq(replies.id, target.id))
            .returning({ voteCount: replies.voteCount })
        : await transaction
            .select({ voteCount: replies.voteCount })
            .from(replies)
            .where(eq(replies.id, target.id))
            .limit(1);
      if (reaction && updated) {
        await recordEmberScoreChange(transaction, {
          recipientId: target.authorId,
          actorId: userId,
          communityId: target.communityId,
          sourceType: "reply",
          sourceId: target.id,
          previousReactionCount: updated.voteCount - 1,
          nextReactionCount: updated.voteCount,
        });
        await transaction.insert(outboxEvents).values({
          topic: "reply.reaction.changed",
          communityId: target.communityId,
          entityId: target.postId,
          payload: {
            postId: target.postId,
            replyId: target.id,
            reactionCount: updated.voteCount,
          },
        });
      }
      return {
        reacted: true,
        reactionCount: updated?.voteCount ?? 0,
      };
    });
  });

  app.delete("/api/v1/replies/:id/reaction", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);

    const [target] = await database
      .select({
        id: replies.id,
        postId: replies.postId,
        authorId: replies.authorId,
        communityId: posts.communityId,
      })
      .from(replies)
      .innerJoin(posts, eq(posts.id, replies.postId))
      .innerJoin(communities, eq(communities.id, posts.communityId))
      .where(
        and(
          eq(replies.id, params.data.id),
          isNull(replies.deletedAt),
          isNull(posts.deletedAt),
          eq(communities.isPublic, true),
          eq(communities.status, "active"),
        ),
      )
      .limit(1);
    if (!target) {
      return reply.code(404).send({
        error: { code: "REPLY_NOT_FOUND", message: "Reply not found." },
      });
    }

    return database.transaction(async (transaction) => {
      const [reaction] = await transaction
        .delete(replyReactions)
        .where(
          and(
            eq(replyReactions.userId, userId),
            eq(replyReactions.replyId, target.id),
            eq(replyReactions.type, "like"),
          ),
        )
        .returning({ replyId: replyReactions.replyId });
      const [updated] = reaction
        ? await transaction
            .update(replies)
            .set({ voteCount: sql`greatest(${replies.voteCount} - 1, 0)` })
            .where(eq(replies.id, target.id))
            .returning({ voteCount: replies.voteCount })
        : await transaction
            .select({ voteCount: replies.voteCount })
            .from(replies)
            .where(eq(replies.id, target.id))
            .limit(1);
      if (reaction && updated) {
        await recordEmberScoreChange(transaction, {
          recipientId: target.authorId,
          actorId: userId,
          communityId: target.communityId,
          sourceType: "reply",
          sourceId: target.id,
          previousReactionCount: updated.voteCount + 1,
          nextReactionCount: updated.voteCount,
        });
        await transaction.insert(outboxEvents).values({
          topic: "reply.reaction.changed",
          communityId: target.communityId,
          entityId: target.postId,
          payload: {
            postId: target.postId,
            replyId: target.id,
            reactionCount: updated.voteCount,
          },
        });
      }
      return {
        reacted: false,
        reactionCount: updated?.voteCount ?? 0,
      };
    });
  });

  app.post("/api/v1/posts/:id/bookmark", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    const communityId = await activePostCommunityId(params.data.id);
    if (!communityId) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    return database.transaction(async (transaction) => {
      await transaction
        .insert(bookmarks)
        .values({ userId, postId: params.data.id })
        .onConflictDoNothing();
      return { saved: true };
    });
  });

  app.delete("/api/v1/posts/:id/bookmark", async (request, reply) => {
    const userId = await authenticatedUserId(request, reply);
    if (!userId) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    const communityId = await activePostCommunityId(params.data.id);
    if (!communityId) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    const [bookmark] = await database
      .delete(bookmarks)
      .where(
        and(eq(bookmarks.userId, userId), eq(bookmarks.postId, params.data.id)),
      )
      .returning({ postId: bookmarks.postId });
    if (bookmark) {
      await database.insert(outboxEvents).values({
        topic: "post.bookmark.changed",
        communityId,
        entityId: params.data.id,
        payload: { postId: params.data.id },
      });
    }
    return { saved: false };
  });

  app.get("/api/v1/events", async (request, reply) => {
    if (activeEventStreamCount >= MAX_ACTIVE_EVENT_STREAMS) {
      return reply
        .header("retry-after", "30")
        .code(503)
        .send({
          error: {
            code: "EVENT_STREAM_CAPACITY_REACHED",
            message: "The event stream is temporarily at capacity.",
          },
        });
    }

    activeEventStreamCount += 1;
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      activeEventStreamCount -= 1;
    };

    let viewerId: string | null = null;
    try {
      const token = request.cookies[environment.SESSION_COOKIE_NAME];
      if (token) {
        const [session] = await database
          .select({ userId: userSessions.userId })
          .from(userSessions)
          .innerJoin(users, eq(users.id, userSessions.userId))
          .where(
            and(
              eq(userSessions.tokenHash, hashSessionToken(token)),
              gt(userSessions.expiresAt, new Date()),
              isNull(users.deletedAt),
              isNull(users.suspendedAt),
            ),
          )
          .limit(1);
        viewerId = session?.userId ?? null;
      }
    } catch (error) {
      releaseSlot();
      throw error;
    }

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write("retry: 3000\n\n");

    let closed = false;
    const initialCursorTime = new Date();
    let cursorTime: string | null = null;
    let cursorId: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    let durationTimer: NodeJS.Timeout | undefined;
    const closeStream = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (durationTimer) clearTimeout(durationTimer);
      releaseSlot();
    };
    response.once("close", closeStream);
    response.once("finish", closeStream);
    durationTimer = setTimeout(() => response.end(), MAX_EVENT_STREAM_DURATION_MS);

    const poll = async () => {
      if (closed) return;
      try {
        const eventScope = viewerId
          ? or(
              inArray(outboxEvents.topic, [
                "post.created",
                "post.updated",
                "post.deleted",
                "reply.created",
                "reply.updated",
                "reply.deleted",
                "post.reaction.changed",
                "reply.reaction.changed",
              ]),
              and(
                eq(outboxEvents.topic, "notification.created"),
                eq(outboxEvents.recipientId, viewerId),
              ),
            )!
          : inArray(outboxEvents.topic, [
              "post.created",
              "post.updated",
              "post.deleted",
              "reply.created",
              "reply.updated",
              "reply.deleted",
              "post.reaction.changed",
              "reply.reaction.changed",
            ]);
        const events = await database
          .select({
            id: outboxEvents.id,
            topic: outboxEvents.topic,
            communityId: outboxEvents.communityId,
            entityId: outboxEvents.entityId,
            payload: outboxEvents.payload,
            cursorTime: sql<string>`${outboxEvents.createdAt}::text`,
          })
          .from(outboxEvents)
          .where(
            and(
              cursorId
                ? sql`(${outboxEvents.createdAt}, ${outboxEvents.id}) > (${cursorTime}::timestamptz, ${cursorId}::uuid)`
                : gte(outboxEvents.createdAt, initialCursorTime),
              eventScope,
            ),
          )
          .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
          .limit(100);

        for (const event of events) {
          if (closed) return;
          cursorTime = event.cursorTime;
          cursorId = event.id;
          response.write(
            `event: community\ndata: ${JSON.stringify({
              topic: event.topic,
              communityId: event.communityId,
              entityId: event.entityId,
              payload: event.payload,
            })}\n\n`,
          );
        }
      } catch {
        if (!closed) response.write(": update check unavailable\n\n");
      }
      if (!closed) {
        response.write(": keep-alive\n\n");
        timer = setTimeout(() => void poll(), 1500);
      }
    };

    void poll();
  });
}
