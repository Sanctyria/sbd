import { and, eq, isNull, sql } from "drizzle-orm";
import { database } from "../db/client.js";
import { emberEvents, posts, profiles, replies } from "../db/schema.js";

type DatabaseTransaction = Parameters<
  Parameters<typeof database.transaction>[0]
>[0];
export type EmberSourceType = "post" | "reply";

export function emberFromReactions(
  reactionCount: number,
  downvoteCount = 0,
): number {
  return Math.floor(
    10 * Math.log1p(Math.max(0, reactionCount - downvoteCount)),
  );
}

async function recordDelta(
  transaction: DatabaseTransaction,
  input: {
    recipientId: string;
    actorId: string;
    communityId: string;
    sourceType: EmberSourceType;
    sourceId: string;
    delta: number;
  },
): Promise<void> {
  if (!input.delta) return;
  await transaction.insert(emberEvents).values(input);
  await transaction
    .update(profiles)
    .set({ ember: sql`${profiles.ember} + ${input.delta}` })
    .where(eq(profiles.userId, input.recipientId));
}

export async function recordEmberScoreChange(
  transaction: DatabaseTransaction,
  input: {
    recipientId: string;
    actorId: string;
    communityId: string;
    sourceType: EmberSourceType;
    sourceId: string;
    previousReactionCount: number;
    nextReactionCount: number;
    previousDownvoteCount?: number;
    nextDownvoteCount?: number;
  },
): Promise<void> {
  const delta =
    emberFromReactions(input.nextReactionCount, input.nextDownvoteCount) -
    emberFromReactions(
      input.previousReactionCount,
      input.previousDownvoteCount,
    );
  await recordDelta(transaction, {
    recipientId: input.recipientId,
    actorId: input.actorId,
    communityId: input.communityId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    delta,
  });
}

export async function recordEmberScoreRemoval(
  transaction: DatabaseTransaction,
  input: {
    recipientId: string;
    actorId: string;
    communityId: string;
    sourceType: EmberSourceType;
    sourceId: string;
    reactionCount: number;
    downvoteCount?: number;
  },
): Promise<void> {
  const delta = -emberFromReactions(input.reactionCount, input.downvoteCount);
  await recordDelta(transaction, {
    recipientId: input.recipientId,
    actorId: input.actorId,
    communityId: input.communityId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    delta,
  });
}

export async function recordPostEmberRemoval(
  transaction: DatabaseTransaction,
  input: {
    postId: string;
    actorId: string;
    communityId: string;
  },
): Promise<void> {
  const [post] = await transaction
    .select({
      authorId: posts.authorId,
      voteCount: posts.voteCount,
      downvoteCount: posts.downvoteCount,
    })
    .from(posts)
    .where(eq(posts.id, input.postId))
    .limit(1);
  if (post) {
    await recordEmberScoreRemoval(transaction, {
      recipientId: post.authorId,
      actorId: input.actorId,
      communityId: input.communityId,
      sourceType: "post",
      sourceId: input.postId,
      reactionCount: post.voteCount,
      downvoteCount: post.downvoteCount,
    });
  }

  const activeReplies = await transaction
    .select({
      id: replies.id,
      authorId: replies.authorId,
      voteCount: replies.voteCount,
    })
    .from(replies)
    .where(and(eq(replies.postId, input.postId), isNull(replies.deletedAt)));
  for (const item of activeReplies) {
    await recordEmberScoreRemoval(transaction, {
      recipientId: item.authorId,
      actorId: input.actorId,
      communityId: input.communityId,
      sourceType: "reply",
      sourceId: item.id,
      reactionCount: item.voteCount,
    });
  }
}

export async function recordReplyEmberRemoval(
  transaction: DatabaseTransaction,
  input: {
    replyId: string;
    actorId: string;
    communityId: string;
  },
): Promise<void> {
  const [item] = await transaction
    .select({ authorId: replies.authorId, voteCount: replies.voteCount })
    .from(replies)
    .where(eq(replies.id, input.replyId))
    .limit(1);
  if (!item) return;
  await recordEmberScoreRemoval(transaction, {
    recipientId: item.authorId,
    actorId: input.actorId,
    communityId: input.communityId,
    sourceType: "reply",
    sourceId: input.replyId,
    reactionCount: item.voteCount,
  });
}
