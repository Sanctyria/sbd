import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const communityRoleEnum = pgEnum("community_role", [
  "member",
  "moderator",
  "owner",
]);
export const communityStatusEnum = pgEnum("community_status", [
  "active",
  "archived",
]);
export const postKindEnum = pgEnum("post_kind", [
  "text",
  "link",
  "image_url",
  "video_url",
]);
export const notificationTypeEnum = pgEnum("notification_type", [
  "reply",
  "mention",
  "reaction",
  "community",
  "system",
]);
export const reportStatusEnum = pgEnum("report_status", [
  "open",
  "reviewing",
  "resolved",
  "dismissed",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  authSubject: text("auth_subject").unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
});

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    response: jsonb("response").$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.scope, table.key] }),
    index("idempotency_records_expiry_idx").on(table.expiresAt),
  ],
);

export const userCredentials = pgTable("user_credentials", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userSessions = pgTable(
  "user_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("user_sessions_user_idx").on(table.userId, table.expiresAt),
    index("user_sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const profiles = pgTable(
  "profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    bio: text("bio").notNull().default(""),
    avatarUrl: text("avatar_url"),
    avatarVersion: text("avatar_version"),
    initials: text("initials"),
    avatarColor: text("avatar_color"),
    isVerified: boolean("is_verified").notNull().default(false),
    ember: integer("ember").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("profiles_username_uidx").on(table.username)],
);

export const userFollows = pgTable(
  "user_follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followedId: uuid("followed_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.followerId, table.followedId] }),
    index("user_follows_follower_idx").on(table.followerId, table.createdAt),
    index("user_follows_followed_idx").on(table.followedId, table.createdAt),
  ],
);

export const userBlocks = pgTable(
  "user_blocks",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerId, table.blockedId] }),
    index("user_blocks_blocked_idx").on(table.blockedId, table.createdAt),
  ],
);

export const userMutes = pgTable(
  "user_mutes",
  {
    muterId: uuid("muter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mutedId: uuid("muted_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.muterId, table.mutedId] }),
    index("user_mutes_muted_idx").on(table.mutedId, table.createdAt),
  ],
);

export const communityMemberMutes = pgTable(
  "community_member_mutes",
  {
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    moderatorId: uuid("moderator_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.communityId, table.userId] }),
    index("community_member_mutes_user_idx").on(table.userId, table.createdAt),
  ],
);

export const communities = pgTable(
  "communities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    avatarUrl: text("avatar_url"),
    bannerUrl: text("banner_url"),
    websiteUrl: text("website_url"),
    creatorId: uuid("creator_id").references(() => users.id, {
      onDelete: "set null",
    }),
    isPublic: boolean("is_public").notNull().default(true),
    status: communityStatusEnum("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("communities_slug_uidx").on(table.slug),
    index("communities_public_status_idx").on(table.isPublic, table.status),
    index("communities_public_cursor_idx").on(
      table.isPublic,
      table.status,
      table.createdAt,
      table.id,
    ),
  ],
);

export const communitySlugAliases = pgTable(
  "community_slug_aliases",
  {
    slug: text("slug").primaryKey(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("community_slug_aliases_community_idx").on(table.communityId),
  ],
);

export const communityMemberships = pgTable(
  "community_memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    role: communityRoleEnum("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.communityId] }),
    index("community_memberships_community_idx").on(
      table.communityId,
      table.createdAt,
    ),
  ],
);

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "restrict" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: postKindEnum("kind").notNull().default("text"),
    body: text("body").notNull(),
    url: text("url"),
    linkTitle: text("link_title"),
    linkDescription: text("link_description"),
    linkDomain: text("link_domain"),
    voteCount: integer("vote_count").notNull().default(0),
    downvoteCount: integer("downvote_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("posts_feed_idx").on(table.communityId, table.createdAt, table.id),
    index("posts_public_feed_idx").on(table.createdAt, table.id),
    index("posts_author_idx").on(table.authorId, table.createdAt, table.id),
  ],
);

export const replies = pgTable(
  "replies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    parentReplyId: uuid("parent_reply_id"),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    voteCount: integer("vote_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("replies_post_idx").on(table.postId, table.createdAt, table.id),
    index("replies_parent_idx").on(table.parentReplyId),
  ],
);

export const postReactions = pgTable(
  "post_reactions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("like"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.postId, table.type] }),
    uniqueIndex("post_reactions_single_vote_idx")
      .on(table.userId, table.postId)
      .where(sql`${table.type} in ('like', 'downvote')`),
    index("post_reactions_post_idx").on(table.postId),
  ],
);

export const replyReactions = pgTable(
  "reply_reactions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    replyId: uuid("reply_id")
      .notNull()
      .references(() => replies.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("like"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.replyId, table.type] }),
    index("reply_reactions_reply_idx").on(table.replyId),
  ],
);

export const emberEvents = pgTable(
  "ember_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    communityId: uuid("community_id").references(() => communities.id, {
      onDelete: "set null",
    }),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    delta: integer("delta").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("ember_events_recipient_created_idx").on(
      table.recipientId,
      table.createdAt,
    ),
    index("ember_events_community_created_idx").on(
      table.communityId,
      table.createdAt,
    ),
    index("ember_events_source_idx").on(table.sourceType, table.sourceId),
  ],
);

export const bookmarks = pgTable(
  "bookmarks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.postId] })],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    entityId: uuid("entity_id"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    index("notifications_recipient_cursor_idx").on(
      table.recipientId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    reason: text("reason").notNull(),
    status: reportStatusEnum("status").notNull().default("open"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("reports_status_created_idx").on(table.status, table.createdAt),
  ],
);
export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    communityId: uuid("community_id").references(() => communities.id, {
      onDelete: "set null",
    }),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("moderation_actions_target_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
    index("moderation_actions_community_idx").on(
      table.communityId,
      table.createdAt,
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    topic: text("topic").notNull(),
    recipientId: uuid("recipient_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    communityId: uuid("community_id").references(() => communities.id, {
      onDelete: "cascade",
    }),
    entityId: uuid("entity_id").notNull(),
    payloadVersion: text("payload_version").notNull().default("v1"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    index("outbox_unpublished_idx").on(table.publishedAt, table.createdAt),
  ],
);

export const coreAdminActions = pgTable(
  "core_admin_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    action: text("action").notNull(),
    details: jsonb("details")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index("core_admin_actions_created_idx").on(table.createdAt, table.id),
    index("core_admin_actions_target_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
  ],
);

export const marketingArticles = pgTable(
  "marketing_articles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    dek: text("dek").notNull(),
    category: text("category").notNull(),
    date: text("date").notNull(),
    readTime: text("read_time").notNull(),
    image: text("image").notNull(),
    imageAlt: text("image_alt").notNull(),
    imageNote: text("image_note").notNull(),
    sections: jsonb("sections")
      .$type<{ heading?: string; paragraphs: string[] }[]>()
      .notNull()
      .default([]),
    pullQuote: text("pull_quote").notNull(),
    isPublished: boolean("is_published").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("marketing_articles_slug_uidx").on(table.slug),
    index("marketing_articles_published_idx").on(
      table.isPublished,
      table.publishedAt,
    ),
  ],
);

export const communityBanners = pgTable(
  "community_banners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eyebrow: text("eyebrow").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    action: text("action").notNull(),
    href: text("href").notNull(),
    image: text("image").notNull(),
    imageAlt: text("image_alt").notNull().default(""),
    accent: text("accent").notNull().default("#f4a261"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("community_banners_sort_order_idx").on(table.sortOrder)],
);

export const dailyAnalytics = pgTable(
  "daily_analytics",
  {
    day: date("day", { mode: "string" }).notNull(),
    path: text("path").notNull(),
    source: text("source").notNull().default(""),
    medium: text("medium").notNull().default(""),
    campaign: text("campaign").notNull().default(""),
    pageViews: integer("page_views").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.day,
        table.path,
        table.source,
        table.medium,
        table.campaign,
      ],
    }),
    index("daily_analytics_day_idx").on(table.day),
  ],
);
