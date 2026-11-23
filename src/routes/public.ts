import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { database } from "../db/client.js";
import { environment } from "../config/env.js";
import {
  fetchLinkPreview,
  type LinkPreviewMetadata,
} from "../lib/linkPreview.js";
import {
  bookmarks,
  communityBanners,
  communityChatMessages,
  communityChatMessageReactions,
  communityChatPreferences,
  communities,
  communitySlugAliases,
  communityMemberships,
  communityMemberMutes,
  communityNotificationMutes,
  emberEvents,
  notifications,
  profileBadges,
  postReactions,
  replyReactions,
  posts,
  profiles,
  replies,
  userFollows,
  userBlocks,
  userMutes,
  userSessions,
  users,
} from "../db/schema.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import {
  PROFILE_INDEX_MIN_BIO_LENGTH,
  communityIndexingConditions,
  isCommunityIndexable,
  isProfileIndexable,
} from "../lib/searchIndexing.js";

const pageLimit = 30;
const maxPageLimit = 50;

const pageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(maxPageLimit).default(pageLimit),
});

const communitiesQuerySchema = pageQuerySchema.extend({
  query: z.string().trim().max(100).optional(),
});

const communityMembersQuerySchema = pageQuerySchema.extend({
  usernamePrefix: z.string().regex(/^[A-Za-z0-9_]{0,32}$/).optional(),
});
const communityChatMessagesQuerySchema = pageQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
});
const communityMemberCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
  priority: z.number().int().min(0).max(2),
});

const profileActivityQuerySchema = pageQuerySchema.extend({
  type: z.enum(["posts", "replies"]).default("posts"),
});

const profileConnectionsQuerySchema = pageQuerySchema;
const seoSitemapQuerySchema = z.object({
  limit: z.coerce.number().int().min(0).max(50_000).default(50_000),
});

const notificationsQuerySchema = pageQuerySchema.extend({
  unread: z.enum(["true", "false"]).optional(),
  messages: z.enum(["true", "false"]).optional(),
});
const linkPreviewQuerySchema = z.object({
  url: z.string().trim().min(1).max(2048).url(),
});

function decodeCommunityMemberCursor(
  value?: string,
): { createdAt: Date; id: string; priority: number } | null | undefined {
  if (!value) return undefined;
  try {
    const parsed = communityMemberCursorSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (!parsed.success) return null;
    return {
      createdAt: new Date(parsed.data.createdAt),
      id: parsed.data.id,
      priority: parsed.data.priority,
    };
  } catch {
    return null;
  }
}

function encodeCommunityMemberCursor(cursor: {
  createdAt: Date;
  id: string;
  priority: number;
}): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
      priority: cursor.priority,
    }),
  ).toString("base64url");
}

const feedQuerySchema = pageQuerySchema
  .extend({
    scope: z
      .enum(["following", "community", "profile", "public"])
      .default("public"),
    sort: z.enum(["new", "hot"]).default("new"),
    members: z.enum(["only"]).optional(),
    community: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    news: z.enum(["only", "exclude"]).optional(),
    username: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{2,29}$/)
      .optional(),
    media: z.enum(["video", "audio"]).optional(),
  })
  .superRefine((query, context) => {
    if (query.scope === "community" && !query.community) {
      context.addIssue({
        code: "custom",
        path: ["community"],
        message: "A community slug is required for the community feed.",
      });
    }
    if (query.scope === "profile" && !query.username) {
      context.addIssue({
        code: "custom",
        path: ["username"],
        message: "A username is required for the profile feed.",
      });
    }
    if (query.news && query.scope !== "community") {
      context.addIssue({
        code: "custom",
        path: ["news"],
        message: "News filtering is only available for community feeds.",
      });
    }
    if (query.scope !== "community" && query.sort === "hot") {
      context.addIssue({
        code: "custom",
        path: ["sort"],
        message: "Hot sorting is only available for community feeds.",
      });
    }
    if (query.scope !== "community" && query.members) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "Member filtering is only available for community feeds.",
      });
    }
  });

const slugParamsSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

const usernameParamsSchema = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,29}$/),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

const linkPreviewCache = new Map<
  string,
  { expiresAt: number; metadata: LinkPreviewMetadata }
>();
const globalSearchQuerySchema = z.object({
  query: z.string().trim().min(2).max(100),
});

const hotFeedCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
  voteCount: z.number().int(),
  replyCount: z.number().int().nonnegative(),
});

type HotFeedCursor = {
  createdAt: Date;
  id: string;
  voteCount: number;
  replyCount: number;
};

const moderatorSafePostFields = {
  kind: posts.kind,
  isNews: posts.isNews,
  body: sql<string>`case when ${posts.deletedByModerator} then '' else ${posts.body} end`,
  url: sql<string | null>`case when ${posts.deletedByModerator} then null else ${posts.url} end`,
  audioCoverUrl: sql<string | null>`case when ${posts.deletedByModerator} then null else ${posts.audioCoverUrl} end`,
  linkTitle: sql<string | null>`case when ${posts.deletedByModerator} then null else ${posts.linkTitle} end`,
  linkDescription: sql<string | null>`case when ${posts.deletedByModerator} then null else ${posts.linkDescription} end`,
  linkDomain: sql<string | null>`case when ${posts.deletedByModerator} then null else ${posts.linkDomain} end`,
  isModeratorEdited: posts.moderatorEdited,
  isModeratorRemoved: posts.deletedByModerator,
};

function decodeHotFeedCursor(value?: string): HotFeedCursor | null | undefined {
  if (!value) return undefined;
  try {
    const parsed = hotFeedCursorSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (!parsed.success) return null;
    return {
      createdAt: new Date(parsed.data.createdAt),
      id: parsed.data.id,
      voteCount: parsed.data.voteCount,
      replyCount: parsed.data.replyCount,
    };
  } catch {
    return null;
  }
}

function encodeHotFeedCursor(cursor: HotFeedCursor): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      createdAt: cursor.createdAt.toISOString(),
    }),
  ).toString("base64url");
}

function searchPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: {
      code: "INVALID_REQUEST",
      message: "The request parameters are invalid.",
    },
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

async function currentViewerId(
  request: FastifyRequest,
): Promise<string | null> {
  const token = request.cookies[environment.SESSION_COOKIE_NAME];
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const [session] = await database
    .select({ userId: userSessions.userId })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(
      and(
        eq(userSessions.tokenHash, tokenHash),
        sql`${userSessions.expiresAt} > now()`,
        isNull(users.deletedAt),
        isNull(users.suspendedAt),
      ),
    )
    .limit(1);
  return session?.userId ?? null;
}

function privateCommunityPostsVisibleTo(viewerId: string | null) {
  if (!viewerId) return eq(communities.postsPrivate, false);
  return or(
    eq(communities.postsPrivate, false),
    exists(
      database
        .select({ userId: communityMemberships.userId })
        .from(communityMemberships)
        .where(
          and(
            eq(communityMemberships.communityId, communities.id),
            eq(communityMemberships.userId, viewerId),
          ),
        ),
    ),
  )!;
}

function notificationPrivatePostsVisibleTo(viewerId: string) {
  return sql`not exists (
    select 1
    from ${posts} notification_private_post
    inner join ${communities} notification_private_community
      on notification_private_community.id = notification_private_post.community_id
    where notification_private_post.id = ${notifications.entityId}
      and notification_private_community.posts_private = true
      and not exists (
        select 1
        from ${communityMemberships} notification_private_membership
        where notification_private_membership.community_id =
          notification_private_community.id
          and notification_private_membership.user_id = ${viewerId}
      )
  )`;
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/v1/link-preview",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsedQuery = linkPreviewQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) return invalidRequest(reply);

      let target: URL;
      try {
        target = new URL(parsedQuery.data.url);
      } catch {
        return invalidRequest(reply);
      }
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        (target.port && target.port !== "443")
      ) {
        return invalidRequest(reply);
      }

      const cacheKey = target.href;
      const cached = linkPreviewCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        reply.header("cache-control", "public, max-age=300");
        return cached.metadata;
      }

      const siteHosts = new Set([
        new URL(environment.WEB_ORIGIN).hostname,
        "sanctyria.com",
        "www.sanctyria.com",
      ]);
      const profileMatch = target.pathname.match(
        /^\/u\/([a-z0-9][a-z0-9_-]{2,29})\/?$/i,
      );
      let metadata: LinkPreviewMetadata;
      if (profileMatch && siteHosts.has(target.hostname.toLowerCase())) {
        const [profile] = await database
          .select({
            username: profiles.username,
            displayName: profiles.displayName,
            bio: profiles.bio,
            avatarUrl: profiles.avatarUrl,
            avatarColor: profiles.avatarColor,
            initials: profiles.initials,
          })
          .from(profiles)
          .innerJoin(users, eq(users.id, profiles.userId))
          .where(
            and(
              eq(profiles.username, profileMatch[1]!.toLowerCase()),
              isNull(users.deletedAt),
            ),
          )
          .limit(1);
        if (!profile) {
          return reply.code(404).send({
            error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
          });
        }
        metadata = {
          title: `${profile.displayName} (@${profile.username})`,
          description: profile.bio || null,
          domain: target.hostname,
          imageUrl: profile.avatarUrl,
          profile: {
            displayName: profile.displayName,
            username: profile.username,
            avatarUrl: profile.avatarUrl,
            avatarColor: profile.avatarColor,
            initials: profile.initials,
          },
        };
      } else {
        try {
          metadata = await fetchLinkPreview(target);
        } catch (cause) {
          request.log.info(
            { hostname: target.hostname, err: cause },
            "Unable to load link-preview metadata",
          );
          return reply.code(502).send({
            error: {
              code: "LINK_PREVIEW_UNAVAILABLE",
              message: "Preview metadata could not be loaded for this link.",
            },
          });
        }
      }

      if (linkPreviewCache.size >= 500) {
        const oldestKey = linkPreviewCache.keys().next().value;
        if (oldestKey) linkPreviewCache.delete(oldestKey);
      }
      linkPreviewCache.set(cacheKey, {
        metadata,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      reply.header("cache-control", "public, max-age=300");
      return metadata;
    },
  );

  app.get("/api/v1/ember/weekly", async (request, reply) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(10).default(3) })
      .safeParse(request.query);
    if (!query.success) return invalidRequest(reply);

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weeklyEmber = sql<number>`sum(${emberEvents.delta})`;
    const members = await database
      .select({
        username: profiles.username,
        displayName: profiles.displayName,
        bio: profiles.bio,
        avatarUrl: profiles.avatarUrl,
        initials: profiles.initials,
        avatarColor: profiles.avatarColor,
        ember: weeklyEmber,
      })
      .from(emberEvents)
      .innerJoin(users, eq(users.id, emberEvents.recipientId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(
        and(
          gte(emberEvents.createdAt, since),
          isNull(users.deletedAt),
          isNull(users.suspendedAt),
        ),
      )
      .groupBy(
        profiles.userId,
        profiles.username,
        profiles.displayName,
        profiles.bio,
        profiles.avatarUrl,
        profiles.initials,
        profiles.avatarColor,
      )
      .having(sql`sum(${emberEvents.delta}) > 0`)
      .orderBy(desc(weeklyEmber), asc(profiles.username))
      .limit(query.data.limit);

    reply.header("cache-control", "public, max-age=0, s-maxage=30");
    return { periodDays: 7, items: members };
  });

  app.get("/api/v1/search", async (request, reply) => {
    const parsedQuery = globalSearchQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);

    const viewerId = await currentViewerId(request);
    const pattern = searchPattern(parsedQuery.data.query);
    const [members, communityResults, postResults] = await Promise.all([
      database
        .select({
          username: profiles.username,
          displayName: profiles.displayName,
          avatarUrl: profiles.avatarUrl,
          avatarVersion: profiles.avatarVersion,
          initials: profiles.initials,
          avatarColor: profiles.avatarColor,
        })
        .from(profiles)
        .innerJoin(users, eq(users.id, profiles.userId))
        .where(
          and(
            isNull(users.deletedAt),
            isNull(users.suspendedAt),
            or(
              ilike(profiles.username, pattern),
              ilike(profiles.displayName, pattern),
              ilike(profiles.bio, pattern),
            ),
          ),
        )
        .orderBy(desc(profiles.createdAt), desc(profiles.userId))
        .limit(6),
      database
        .select({
          slug: communities.slug,
          name: communities.name,
          description: communities.description,
          avatarUrl: communities.avatarUrl,
          memberCount: count(communityMemberships.userId),
        })
        .from(communities)
        .leftJoin(
          communityMemberships,
          eq(communityMemberships.communityId, communities.id),
        )
        .where(
          and(
            eq(communities.isPublic, true),
            eq(communities.status, "active"),
            or(
              ilike(communities.name, pattern),
              ilike(communities.description, pattern),
              ilike(communities.slug, pattern),
            ),
          ),
        )
        .groupBy(communities.id)
        .orderBy(
          desc(count(communityMemberships.userId)),
          asc(communities.name),
        )
        .limit(6),
      database
        .select({
          id: posts.id,
          body: posts.body,
          createdAt: posts.createdAt,
          community: {
            slug: communities.slug,
            name: communities.name,
            avatarUrl: communities.avatarUrl,
          },
          author: {
            username: profiles.username,
            displayName: profiles.displayName,
            isFollowing: viewerId
              ? sql<boolean>`exists (select 1 from ${userFollows} where ${userFollows.followerId} = ${viewerId} and ${userFollows.followedId} = ${users.id})`
              : sql<boolean>`false`,
          },
        })
        .from(posts)
        .innerJoin(communities, eq(posts.communityId, communities.id))
        .innerJoin(users, eq(posts.authorId, users.id))
        .innerJoin(profiles, eq(profiles.userId, users.id))
        .where(
          and(
            isNull(posts.deletedAt),
            isNull(users.deletedAt),
            isNull(users.suspendedAt),
            eq(communities.isPublic, true),
            eq(communities.status, "active"),
            privateCommunityPostsVisibleTo(viewerId),
            or(ilike(posts.body, pattern), ilike(posts.linkTitle, pattern)),
          ),
        )
        .orderBy(desc(posts.createdAt), desc(posts.id))
        .limit(6),
    ]);

    reply.header("cache-control", "no-store");
    return { members, communities: communityResults, posts: postResults };
  });

  app.get("/api/v1/community/banners", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const items = await database
      .select({
        id: communityBanners.id,
        eyebrow: communityBanners.eyebrow,
        title: communityBanners.title,
        description: communityBanners.description,
        action: communityBanners.action,
        href: communityBanners.href,
        image: communityBanners.image,
        imageAlt: communityBanners.imageAlt,
        accent: communityBanners.accent,
      })
      .from(communityBanners)
      .orderBy(communityBanners.sortOrder, communityBanners.createdAt);
    return { items };
  });

  app.get("/api/v1/communities", async (request, reply) => {
    const parsedQuery = communitiesQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);

    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const conditions = [
      eq(communities.isPublic, true),
      eq(communities.status, "active"),
    ];
    if (parsedQuery.data.query) {
      const search = `%${parsedQuery.data.query}%`;
      conditions.push(
        or(
          ilike(communities.name, search),
          ilike(communities.description, search),
        )!,
      );
    }

    if (cursor) {
      conditions.push(
        or(
          lt(communities.createdAt, cursor.createdAt),
          and(
            eq(communities.createdAt, cursor.createdAt),
            lt(communities.id, cursor.id),
          ),
        )!,
      );
    }

    const results = await database
      .select({
        id: communities.id,
        creatorId: communities.creatorId,
        slug: communities.slug,
        name: communities.name,
        description: communities.description,
        avatarUrl: communities.avatarUrl,
        bannerUrl: communities.bannerUrl,
        websiteUrl: communities.websiteUrl,
        createdAt: communities.createdAt,
        memberCount: count(communityMemberships.userId),
        activeEmber: sql<number>`coalesce((
          select sum(${emberEvents.delta})::int
          from ${emberEvents}
          where ${emberEvents.communityId} = ${communities.id}
            and ${emberEvents.createdAt} >= now() - interval '7 days'
        ), 0)`,
      })
      .from(communities)
      .leftJoin(
        communityMemberships,
        eq(communityMemberships.communityId, communities.id),
      )
      .where(and(...conditions))
      .groupBy(
        communities.id,
        communities.creatorId,
        communities.slug,
        communities.name,
        communities.description,
        communities.avatarUrl,
        communities.bannerUrl,
        communities.websiteUrl,
        communities.chatEnabled,
        communities.createdAt,
      )
      .orderBy(desc(communities.createdAt), desc(communities.id))
      .limit(parsedQuery.data.limit + 1);

    const hasMore = results.length > parsedQuery.data.limit;
    const items = hasMore ? results.slice(0, parsedQuery.data.limit) : results;
    const lastItem = items.at(-1);
    reply.header(
      "cache-control",
      "public, max-age=0, s-maxage=10, stale-while-revalidate=30",
    );
    return {
      items,
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
    };
  });

  app.get("/api/v1/communities/:slug", async (request, reply) => {
    const parsedParams = slugParamsSchema.safeParse(request.params);
    if (!parsedParams.success) return invalidRequest(reply);
    const viewerId = await currentViewerId(request);

    const [community] = await database
      .select({
        id: communities.id,
        creatorId: communities.creatorId,
        slug: communities.slug,
        name: communities.name,
        description: communities.description,
        avatarUrl: communities.avatarUrl,
        bannerUrl: communities.bannerUrl,
        websiteUrl: communities.websiteUrl,
        chatEnabled: communities.chatEnabled,
        postsPrivate: communities.postsPrivate,
        createdAt: communities.createdAt,
        updatedAt: communities.updatedAt,
        memberCount: viewerId
          ? sql<number>`count(${communityMemberships.userId}) filter (where not exists (
              select 1 from ${userBlocks} as membership_block
              where (membership_block.blocker_id = ${viewerId} and membership_block.blocked_id = ${communityMemberships.userId})
                 or (membership_block.blocker_id = ${communityMemberships.userId} and membership_block.blocked_id = ${viewerId})
            ))`.mapWith(Number)
          : count(communityMemberships.userId),
        viewerRole: viewerId
          ? sql<string | null>`(
              select ${communityMemberships.role}
              from ${communityMemberships}
              where ${communityMemberships.communityId} = ${communities.id}
                and ${communityMemberships.userId} = ${viewerId}
            )`
          : sql<string | null>`null`,
        notificationsMuted: viewerId
          ? sql<boolean>`exists (
              select 1
              from ${communityNotificationMutes}
              where ${communityNotificationMutes.userId} = ${viewerId}
                and ${communityNotificationMutes.communityId} = ${communities.id}
            )`
          : sql<boolean>`false`,
      })
      .from(communities)
      .leftJoin(
        communityMemberships,
        eq(communityMemberships.communityId, communities.id),
      )
      .where(
        and(
          or(
            eq(communities.slug, parsedParams.data.slug),
            inArray(
              communities.id,
              database
                .select({ communityId: communitySlugAliases.communityId })
                .from(communitySlugAliases)
                .where(eq(communitySlugAliases.slug, parsedParams.data.slug)),
            ),
          ),
          eq(communities.isPublic, true),
          eq(communities.status, "active"),
        ),
      )
      .groupBy(
        communities.id,
        communities.creatorId,
        communities.slug,
        communities.name,
        communities.description,
        communities.avatarUrl,
        communities.bannerUrl,
        communities.websiteUrl,
        communities.postsPrivate,
        communities.createdAt,
      )
      .limit(1);

    if (!community) {
      return reply.code(404).send({
        error: { code: "COMMUNITY_NOT_FOUND", message: "Community not found." },
      });
    }

    const indexable = await isCommunityIndexable(community.id);
    reply.header(
      "cache-control",
      viewerId
        ? "private, no-store"
        : "public, max-age=0, s-maxage=10, stale-while-revalidate=30",
    );
    return { community: { ...community, indexable } };
  });

  app.get("/api/v1/me/chats", async (request, reply) => {
    const viewerId = await currentViewerId(request);
    if (!viewerId) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });

    }

    const items = await database
      .select({
        id: communities.id,
        slug: communities.slug,
        name: communities.name,
        avatarUrl: communities.avatarUrl,
        bannerUrl: communities.bannerUrl,
        creatorId: communities.creatorId,
        isPublic: communities.isPublic,
        viewerRole: sql<string>`case
          when ${communities.creatorId} = ${viewerId} then 'owner'
          else ${communityMemberships.role}::text
        end`,
        chatNotificationsEnabled: sql<boolean>`coalesce(${communityChatPreferences.notificationsEnabled}, true)`,
        unreadCount: sql<number>`(
          select count(*)::int
          from ${communityChatMessages} as unread_message
          where unread_message.community_id = ${communities.id}
            and unread_message.author_id <> ${viewerId}
            and unread_message.created_at > coalesce(
              ${communityChatPreferences.lastReadAt},
            ${communityMemberships.createdAt},
              'epoch'::timestamptz
            )
        )`.mapWith(Number),
        memberCount: sql<number>`(
          select count(*)::int
          from ${communityMemberships} as channel_member
          where channel_member.community_id = ${communities.id}
        )`.mapWith(Number),
        lastMessageBody: sql<string | null>`(
          select nullif(chat_message.body, '')
          from community_chat_messages as chat_message
          where chat_message.community_id = ${communities.id}
          order by chat_message.created_at desc, chat_message.id desc
          limit 1
        )`,
        lastMessageMediaUrl: sql<string | null>`(
          select chat_message.media_url
          from community_chat_messages as chat_message
          where chat_message.community_id = ${communities.id}
          order by chat_message.created_at desc, chat_message.id desc
          limit 1
        )`,
        lastMessageMediaKind: sql<string | null>`(
          select chat_message.media_kind
          from community_chat_messages as chat_message
          where chat_message.community_id = ${communities.id}
          order by chat_message.created_at desc, chat_message.id desc
          limit 1
        )`,
        lastMessageAt: sql<Date | null>`(
          select chat_message.created_at
          from community_chat_messages as chat_message
          where chat_message.community_id = ${communities.id}
          order by chat_message.created_at desc, chat_message.id desc
          limit 1
        )`,
      })
      .from(communityMemberships)
      .innerJoin(
        communities,
        eq(communities.id, communityMemberships.communityId),
      )
      .leftJoin(
        communityChatPreferences,
        and(
          eq(communityChatPreferences.userId, viewerId),
          eq(communityChatPreferences.communityId, communities.id),
        ),
      )
      .where(
        and(
          eq(communityMemberships.userId, viewerId),
          eq(communities.chatEnabled, true),
          eq(communities.isPublic, true),
          eq(communities.status, "active"),
        ),
      )
      .orderBy(
        desc(
          sql<Date | null>`(
            select chat_message.created_at
            from community_chat_messages as chat_message
            where chat_message.community_id = ${communities.id}
            order by chat_message.created_at desc, chat_message.id desc
            limit 1
          )`,
        ),
        desc(communities.updatedAt),
      );
    reply.header("cache-control", "private, no-store");
    return { items };
  });

  app.get("/api/v1/me/blocks", async (request, reply) => {
    const viewerId = await currentViewerId(request);
    if (!viewerId) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });
    }
    const items = await database
      .select({
        username: profiles.username,
        displayName: profiles.displayName,
        initials: profiles.initials,
        avatarColor: profiles.avatarColor,
        avatarUrl: profiles.avatarUrl,
      })
      .from(userBlocks)
      .innerJoin(users, eq(users.id, userBlocks.blockedId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(and(eq(userBlocks.blockerId, viewerId), isNull(users.deletedAt)))
      .orderBy(desc(userBlocks.createdAt), desc(profiles.username));
    reply.header("cache-control", "private, no-store");
    return { items };
  });

  app.get(
    "/api/v1/communities/:slug/chat/messages",
    async (request, reply) => {
      const params = slugParamsSchema.safeParse(request.params);
      const parsedQuery = communityChatMessagesQuerySchema.safeParse(
        request.query,
      );
      if (!params.success || !parsedQuery.success) return invalidRequest(reply);
      const cursor = decodeCursor(parsedQuery.data.cursor);
      if (cursor === null) return invalidCursor(reply);
      const viewerId = await currentViewerId(request);
      if (!viewerId) {
        return reply.code(401).send({
          error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
        });
      }

      const [community] = await database
        .select({
          id: communities.id,
          chatEnabled: communities.chatEnabled,
          creatorId: communities.creatorId,
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
      if (!community.chatEnabled) {
        return reply.code(403).send({
          error: {
            code: "COMMUNITY_CHAT_DISABLED",
            message: "Community chat is not enabled.",
          },
        });
      }
      const [membership] = await database
        .select({ userId: communityMemberships.userId })
        .from(communityMemberships)
        .where(
          and(
            eq(communityMemberships.communityId, community.id),
            eq(communityMemberships.userId, viewerId),
          ),
        )
        .limit(1);
      if (!membership) {
        return reply.code(403).send({
          error: {
            code: "MEMBERSHIP_REQUIRED",
            message: "Join this community to view its chat.",
          },
        });
      }

      await database
        .insert(communityChatPreferences)
        .values({
          userId: viewerId,
          communityId: community.id,
          lastReadAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            communityChatPreferences.userId,
            communityChatPreferences.communityId,
          ],
          set: {
            lastReadAt: sql`greatest(${communityChatPreferences.lastReadAt}, excluded.last_read_at)`,
            updatedAt: new Date(),
          },
        });

      const conditions = [eq(communityChatMessages.communityId, community.id)];
      if (parsedQuery.data.search) {
        const searchTerm = parsedQuery.data.search.replace(/[\\%_]/g, "\\$&");
        conditions.push(ilike(communityChatMessages.body, `%${searchTerm}%`));
      }
      if (cursor) {
        conditions.push(
          or(
            lt(communityChatMessages.createdAt, cursor.createdAt),
            and(
              eq(communityChatMessages.createdAt, cursor.createdAt),
              lt(communityChatMessages.id, cursor.id),
            ),
          )!,
        );
      }
      const rows = await database
        .select({
          id: communityChatMessages.id,
          body: communityChatMessages.body,
          mediaUrl: communityChatMessages.mediaUrl,
          mediaKind: communityChatMessages.mediaKind,
          replyToId: communityChatMessages.replyToId,
          replyToBody: sql<string | null>`(
            select parent.body from ${communityChatMessages} parent
            where parent.id = ${communityChatMessages.replyToId}
          )`,
          replyToAuthorName: sql<string | null>`(
            select reply_author.display_name
            from ${communityChatMessages} parent
            inner join ${profiles} reply_author
              on reply_author.user_id = parent.author_id
            where parent.id = ${communityChatMessages.replyToId}
          )`,
          editedAt: communityChatMessages.editedAt,
          sharedItemType: communityChatMessages.sharedItemType,
          sharedItemId: communityChatMessages.sharedItemId,
          sharedItem: sql<Record<string, unknown> | null>`case
            when ${communityChatMessages.sharedItem} is null then null
            else ${communityChatMessages.sharedItem} || jsonb_build_object(
              'viewerVote', (
                select case
                  when ${postReactions.type} = 'like' then 'up'
                  else 'down'
                end
                from ${postReactions}
                where ${postReactions.postId} =
                    (${communityChatMessages.sharedItem}->>'id')::uuid
                  and ${postReactions.userId} = ${viewerId}
                  and ${postReactions.type} in ('like', 'downvote')
                limit 1
              ),
              'isJoined', exists (
                select 1
                from ${communityMemberships}
                inner join ${communities} shared_community
                  on shared_community.id = ${communityMemberships.communityId}
                where shared_community.slug =
                    ${communityChatMessages.sharedItem}->>'slug'
                  and ${communityMemberships.userId} = ${viewerId}
              ),
              'isFollowing', exists (
                select 1
                from ${userFollows}
                inner join ${profiles} shared_profile
                  on shared_profile.user_id = ${userFollows.followedId}
                where shared_profile.username =
                    ${communityChatMessages.sharedItem}->>'username'
                  and ${userFollows.followerId} = ${viewerId}
              )
            )
          end`,
          isPinned: sql<boolean>`${communityChatMessages.pinnedAt} is not null`,
          reactions: sql<
            { emoji: string; count: number; reacted: boolean }[]
          >`coalesce((
            select json_agg(json_build_object(
              'emoji', grouped.emoji,
              'count', grouped.count,
              'reacted', grouped.reacted
            ))
            from (
              select ${communityChatMessageReactions.emoji} as emoji,
                count(*)::int as count,
                bool_or(${communityChatMessageReactions.userId} = ${viewerId}) as reacted
              from ${communityChatMessageReactions}
              where ${communityChatMessageReactions.messageId} = ${communityChatMessages.id}
              group by ${communityChatMessageReactions.emoji}
            ) grouped
          ), '[]'::json)`,
          createdAt: communityChatMessages.createdAt,
          author: {
            id: users.id,
            username: profiles.username,
            displayName: profiles.displayName,
            avatarUrl: profiles.avatarUrl,
            avatarVersion: profiles.avatarVersion,
            initials: profiles.initials,
            avatarColor: profiles.avatarColor,
            verified: profiles.isVerified,
            role: sql<string>`case
              when ${communities.creatorId} = ${users.id} then 'owner'
              else coalesce(${communityMemberships.role}::text, 'member')
            end`,
          },
        })
        .from(communityChatMessages)
        .innerJoin(users, eq(users.id, communityChatMessages.authorId))
        .innerJoin(profiles, eq(profiles.userId, users.id))
        .innerJoin(
          communities,
          eq(communities.id, communityChatMessages.communityId),
        )
        .leftJoin(
          communityMemberships,
          and(
            eq(communityMemberships.userId, users.id),
            eq(communityMemberships.communityId, community.id),
          ),
        )
        .where(and(...conditions, isNull(users.deletedAt)))
        .orderBy(
          desc(sql`case when ${communityChatMessages.pinnedAt} is not null then 1 else 0 end`),
          desc(communityChatMessages.createdAt),
          desc(communityChatMessages.id),
        )
        .limit(parsedQuery.data.limit + 1);
      const hasMore = rows.length > parsedQuery.data.limit;
      const descendingItems = hasMore
        ? rows.slice(0, parsedQuery.data.limit)
        : rows;
      const oldestItem = descendingItems.at(-1);
      reply.header("cache-control", "private, no-store");
      return {
        items: descendingItems.reverse(),
        nextCursor:
          hasMore && oldestItem
            ? encodeCursor({
                createdAt: oldestItem.createdAt,
                id: oldestItem.id,
              })
            : null,
      };
    },
  );

  app.get(
    "/api/v1/seo/sitemap",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedQuery = seoSitemapQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) return invalidRequest(reply);
      let remaining = parsedQuery.data.limit;

      const indexableCommunities = await database
        .select({
          slug: communities.slug,
          updatedAt: communities.updatedAt,
        })
        .from(communities)
        .where(and(...communityIndexingConditions()))
        .orderBy(desc(communities.updatedAt), desc(communities.id))
        .limit(remaining);
      remaining -= indexableCommunities.length;

      const indexablePosts =
        remaining > 0
          ? await database
              .select({
                id: posts.id,
                updatedAt: posts.updatedAt,
              })
              .from(posts)
              .innerJoin(communities, eq(communities.id, posts.communityId))
              .innerJoin(users, eq(users.id, posts.authorId))
              .where(
                and(
                  isNull(posts.deletedAt),
                  isNull(users.deletedAt),
                  isNull(users.suspendedAt),
                  ...communityIndexingConditions(),
                ),
              )
              .orderBy(desc(posts.updatedAt), desc(posts.id))
              .limit(remaining)
          : [];
      remaining -= indexablePosts.length;

      const indexableProfiles =
        remaining > 0
          ? await database
              .select({
                username: profiles.username,
                updatedAt: profiles.updatedAt,
              })
              .from(profiles)
              .innerJoin(users, eq(users.id, profiles.userId))
              .where(
                and(
                  eq(profiles.isIndexingOptedIn, true),
                  isNull(users.deletedAt),
                  isNull(users.suspendedAt),
                  sql`length(btrim(${profiles.bio})) >= ${PROFILE_INDEX_MIN_BIO_LENGTH}`,
                  exists(
                    database
                      .select({ id: posts.id })
                      .from(posts)
                      .innerJoin(
                        communities,
                        eq(communities.id, posts.communityId),
                      )
                      .innerJoin(users, eq(users.id, posts.authorId))
                      .where(
                        and(
                          eq(posts.authorId, profiles.userId),
                          isNull(posts.deletedAt),
                          isNull(users.deletedAt),
                          isNull(users.suspendedAt),
                          ...communityIndexingConditions(),
                        ),
                      ),
                  ),
                ),
              )
              .orderBy(desc(profiles.updatedAt), desc(profiles.userId))
              .limit(remaining)
          : [];

      reply.header(
        "cache-control",
        "public, max-age=300, stale-while-revalidate=600",
      );
      return {
        communities: indexableCommunities,
        posts: indexablePosts,
        profiles: indexableProfiles,
      };
    },
  );

  app.get("/api/v1/communities/:slug/members", async (request, reply) => {
    const parsedParams = slugParamsSchema.safeParse(request.params);
    const parsedQuery = communityMembersQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success)
      return invalidRequest(reply);
    const cursor = decodeCommunityMemberCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);
    const viewerId = await currentViewerId(request);

    const [community] = await database
      .select({
        id: communities.id,
        creatorId: communities.creatorId,
        viewerRole: viewerId
          ? sql<string | null>`(
              select ${communityMemberships.role}
              from ${communityMemberships}
              where ${communityMemberships.communityId} = ${communities.id}
                and ${communityMemberships.userId} = ${viewerId}
            )`
          : sql<string | null>`null`,
      })
      .from(communities)
      .where(
        and(
          or(
            eq(communities.slug, parsedParams.data.slug),
            inArray(
              communities.id,
              database
                .select({ communityId: communitySlugAliases.communityId })
                .from(communitySlugAliases)
                .where(eq(communitySlugAliases.slug, parsedParams.data.slug)),
            ),
          ),
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

    const conditions = [
      eq(communityMemberships.communityId, community.id),
      isNull(users.deletedAt),
    ];
    const memberPriority = sql<number>`case
      when ${communityMemberships.userId} = ${community.creatorId}
        or ${communityMemberships.role} = 'owner' then 0
      when ${communityMemberships.role} = 'moderator' then 1
      else 2
    end`;
    if (parsedQuery.data.usernamePrefix) {
      conditions.push(
        ilike(profiles.username, `${parsedQuery.data.usernamePrefix}%`),
      );
    }
    if (viewerId) {
      conditions.push(
        sql`not exists (
          select 1 from ${userBlocks}
          where (${userBlocks.blockerId} = ${viewerId} and ${userBlocks.blockedId} = ${users.id})
             or (${userBlocks.blockerId} = ${users.id} and ${userBlocks.blockedId} = ${viewerId})
        )`,
      );
    }
    if (cursor) {
      conditions.push(
        or(
          sql`${memberPriority} > ${cursor.priority}`,
          and(
            eq(memberPriority, cursor.priority),
            or(
              lt(communityMemberships.createdAt, cursor.createdAt),
              and(
                eq(communityMemberships.createdAt, cursor.createdAt),
                lt(communityMemberships.userId, cursor.id),
              ),
            ),
          ),
        )!,
      );
    }
    const rows = await database
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        bio: profiles.bio,
        avatarUrl: profiles.avatarUrl,
        avatarVersion: profiles.avatarVersion,
        initials: profiles.initials,
        avatarColor: profiles.avatarColor,
        ember: profiles.ember,
        activityStreak: sql<number>`case
          when ${users.lastActivityDate} >= ((now() at time zone 'utc')::date - 1)
            then ${users.activityStreak}
          else 0
        end`.mapWith(Number),
        bestActivityStreak: users.bestActivityStreak,
        verified: profiles.isVerified,
        createdAt: communityMemberships.createdAt,
        role: communityMemberships.role,
        isMuted:
          community.viewerRole === "owner" ||
          community.viewerRole === "moderator"
            ? sql<boolean>`exists (
                select 1 from ${communityMemberMutes}
                where ${communityMemberMutes.communityId} = ${community.id}
                  and ${communityMemberMutes.userId} = ${users.id}
              )`
            : sql<boolean>`false`,
      })
      .from(communityMemberships)
      .innerJoin(users, eq(users.id, communityMemberships.userId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(and(...conditions))
      .orderBy(
        asc(memberPriority),
        desc(communityMemberships.createdAt),
        desc(communityMemberships.userId),
      )
      .limit(parsedQuery.data.limit + 1);

    const hasMore = rows.length > parsedQuery.data.limit;
    const items = hasMore ? rows.slice(0, parsedQuery.data.limit) : rows;
    const lastItem = items.at(-1);
    const lastItemPriority = lastItem
      ? lastItem.id === community.creatorId || lastItem.role === "owner"
        ? 0
        : lastItem.role === "moderator"
          ? 1
          : 2
      : null;
    reply.header(
      "cache-control",
      viewerId
        ? "private, no-store"
        : "public, max-age=0, s-maxage=5, stale-while-revalidate=15",
    );
    return {
      items,
      nextCursor: hasMore && lastItem && lastItemPriority !== null
        ? encodeCommunityMemberCursor({
            createdAt: lastItem.createdAt,
            id: lastItem.id,
            priority: lastItemPriority,
          })
        : null,
    };
  });

  app.get("/api/v1/profiles/:username", async (request, reply) => {
    const parsedParams = usernameParamsSchema.safeParse(request.params);
    if (!parsedParams.success) return invalidRequest(reply);

    const [profile] = await database
      .select({
        userId: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        bio: profiles.bio,
        avatarUrl: profiles.avatarUrl,
        avatarVersion: profiles.avatarVersion,
        bannerUrl: profiles.bannerUrl,
        initials: profiles.initials,
        avatarColor: profiles.avatarColor,
        ember: profiles.ember,
        activityStreak: sql<number>`case
          when ${users.lastActivityDate} >= ((now() at time zone 'utc')::date - 1)
            then ${users.activityStreak}
          else 0
        end`.mapWith(Number),
        bestActivityStreak: users.bestActivityStreak,
        verified: profiles.isVerified,
        createdAt: profiles.createdAt,
        indexingOptedIn: profiles.isIndexingOptedIn,
      })
      .from(profiles)
      .innerJoin(users, eq(profiles.userId, users.id))
      .where(
        and(
          eq(profiles.username, parsedParams.data.username),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);

    if (!profile) {
      return reply.code(404).send({
        error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
      });
    }

    const indexable = await isProfileIndexable(
      profile.userId,
      profile.indexingOptedIn,
      profile.bio,
    );
    const grantedBadges = await database
      .select({ badgeKey: profileBadges.badgeKey })
      .from(profileBadges)
      .where(eq(profileBadges.userId, profile.userId));
    const badges = new Set(
      grantedBadges
        .map(({ badgeKey }) => badgeKey)
        .filter((badgeKey) => badgeKey !== "staff"),
    );
    if (profile.verified) badges.add("verified");
    if (environment.CORE_ADMIN_USER_IDS.includes(profile.userId)) {
      badges.add("staff");
    }
    const [createdCommunity] = await database
      .select({ id: communities.id })
      .from(communities)
      .where(
        and(
          eq(communities.creatorId, profile.userId),
          eq(communities.status, "active"),
        ),
      )
      .limit(1);
    if (createdCommunity) badges.add("community_creator");
    const memberships = await database
      .select({
        slug: communities.slug,
        name: communities.name,
        avatarUrl: communities.avatarUrl,
      })
      .from(communityMemberships)
      .innerJoin(
        communities,
        eq(communities.id, communityMemberships.communityId),
      )
      .where(
        and(
          eq(communityMemberships.userId, profile.userId),
          eq(communities.isPublic, true),
          eq(communities.status, "active"),
        ),
      );

    const viewerId = await currentViewerId(request);
    const [followerCount] = await database
      .select({ value: count() })
      .from(userFollows)
      .innerJoin(users, eq(users.id, userFollows.followerId))
      .where(
        and(
          eq(userFollows.followedId, profile.userId),
          isNull(users.deletedAt),
          ...(viewerId
            ? [
                sql`not exists (
                  select 1 from ${userBlocks}
                  where (${userBlocks.blockerId} = ${viewerId} and ${userBlocks.blockedId} = ${users.id})
                     or (${userBlocks.blockerId} = ${users.id} and ${userBlocks.blockedId} = ${viewerId})
                )`,
              ]
            : []),
        ),
      );
    const [followingCount] = await database
      .select({ value: count() })
      .from(userFollows)
      .innerJoin(users, eq(users.id, userFollows.followedId))
      .where(
        and(
          eq(userFollows.followerId, profile.userId),
          isNull(users.deletedAt),
          ...(viewerId
            ? [
                sql`not exists (
                  select 1 from ${userBlocks}
                  where (${userBlocks.blockerId} = ${viewerId} and ${userBlocks.blockedId} = ${users.id})
                     or (${userBlocks.blockerId} = ${users.id} and ${userBlocks.blockedId} = ${viewerId})
                )`,
              ]
            : []),
        ),
      );
    let isFollowing = false;
    let isBlocked = false;
    let isBlockedBy = false;
    let isMuted = false;
    if (viewerId && viewerId !== profile.userId) {
      const [follow] = await database
        .select({ followerId: userFollows.followerId })
        .from(userFollows)
        .where(
          and(
            eq(userFollows.followerId, viewerId),
            eq(userFollows.followedId, profile.userId),
          ),
        )
        .limit(1);
      const [block] = await database
        .select({ blockerId: userBlocks.blockerId })
        .from(userBlocks)
        .where(
          and(
            eq(userBlocks.blockerId, viewerId),
            eq(userBlocks.blockedId, profile.userId),
          ),
        )
        .limit(1);
      const [blockedBy] = await database
        .select({ blockerId: userBlocks.blockerId })
        .from(userBlocks)
        .where(
          and(
            eq(userBlocks.blockerId, profile.userId),
            eq(userBlocks.blockedId, viewerId),
          ),
        )
        .limit(1);
      const [mute] = await database
        .select({ muterId: userMutes.muterId })
        .from(userMutes)
        .where(
          and(
            eq(userMutes.muterId, viewerId),
            eq(userMutes.mutedId, profile.userId),
          ),
        )
        .limit(1);
      isFollowing = Boolean(follow);
      isBlocked = Boolean(block);
      isBlockedBy = Boolean(blockedBy);
      isMuted = Boolean(mute);
    }

    reply.header("cache-control", "private, no-store");
    const { userId, indexingOptedIn, ...profileData } = profile;
    return {
      profile: {
        ...profileData,
        ...(viewerId === profile.userId ? { indexingOptedIn } : {}),
        indexable,
        communities: memberships,
        followerCount: followerCount?.value ?? 0,
        followingCount: followingCount?.value ?? 0,
        isFollowing,
        isBlocked,
        isBlockedBy,
        isMuted,
        badges: [...badges],
      },
    };
  });

  const listProfileConnections = async (
    request: FastifyRequest,
    reply: FastifyReply,
    direction: "followers" | "following",
  ) => {
    const parsedParams = usernameParamsSchema.safeParse(request.params);
    const parsedQuery = profileConnectionsQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success)
      return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const [profile] = await database
      .select({ userId: profiles.userId })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(
        and(
          eq(profiles.username, parsedParams.data.username),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!profile) {
      return reply.code(404).send({
        error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
      });
    }

    const targetColumn =
      direction === "followers"
        ? userFollows.followedId
        : userFollows.followerId;
    const connectionColumn =
      direction === "followers"
        ? userFollows.followerId
        : userFollows.followedId;
    const conditions = [
      eq(targetColumn, profile.userId),
      isNull(users.deletedAt),
    ];
    const viewerId = await currentViewerId(request);
    if (viewerId && viewerId !== profile.userId) {
      conditions.push(
        sql`not exists (
          select 1 from ${userBlocks}
          where (${userBlocks.blockerId} = ${viewerId} and ${userBlocks.blockedId} = ${connectionColumn})
             or (${userBlocks.blockerId} = ${connectionColumn} and ${userBlocks.blockedId} = ${viewerId})
        )`,
      );
    }
    if (cursor) {
      conditions.push(
        or(
          lt(userFollows.createdAt, cursor.createdAt),
          and(
            eq(userFollows.createdAt, cursor.createdAt),
            lt(connectionColumn, cursor.id),
          ),
        )!,
      );
    }

    const rows = await database
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        bio: profiles.bio,
        avatarUrl: profiles.avatarUrl,
        avatarVersion: profiles.avatarVersion,
        initials: profiles.initials,
        avatarColor: profiles.avatarColor,
        verified: profiles.isVerified,
        createdAt: userFollows.createdAt,
      })
      .from(userFollows)
      .innerJoin(users, eq(users.id, connectionColumn))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(userFollows.createdAt), desc(connectionColumn))
      .limit(parsedQuery.data.limit + 1);

    const hasMore = rows.length > parsedQuery.data.limit;
    const items = hasMore ? rows.slice(0, parsedQuery.data.limit) : rows;
    const lastItem = items.at(-1);
    reply.header(
      "cache-control",
      "public, max-age=0, s-maxage=5, stale-while-revalidate=15",
    );
    return {
      items,
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
    };
  };

  app.get("/api/v1/profiles/:username/followers", (request, reply) =>
    listProfileConnections(request, reply, "followers"),
  );
  app.get("/api/v1/profiles/:username/following", (request, reply) =>
    listProfileConnections(request, reply, "following"),
  );

  app.get("/api/v1/profiles/:username/activity", async (request, reply) => {
    const parsedParams = usernameParamsSchema.safeParse(request.params);
    const parsedQuery = profileActivityQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success)
      return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const [profile] = await database
      .select({ userId: profiles.userId })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(
        and(
          eq(profiles.username, parsedParams.data.username),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!profile) {
      return reply.code(404).send({
        error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
      });
    }

    const viewerId = await currentViewerId(request);
    if (viewerId && viewerId !== profile.userId) {
      const [block] = await database
        .select({ blockerId: userBlocks.blockerId })
        .from(userBlocks)
        .where(
          or(
            and(
              eq(userBlocks.blockerId, viewerId),
              eq(userBlocks.blockedId, profile.userId),
            ),
            and(
              eq(userBlocks.blockerId, profile.userId),
              eq(userBlocks.blockedId, viewerId),
            ),
          ),
        )
        .limit(1);
      if (block) {
        reply.header("cache-control", "private, no-store");
        return { items: [], nextCursor: null };
      }
    }

    if (parsedQuery.data.type === "posts") {
      const conditions = [
        eq(posts.authorId, profile.userId),
        or(isNull(posts.deletedAt), eq(posts.deletedByModerator, true))!,
        isNull(users.deletedAt),
        eq(communities.isPublic, true),
        eq(communities.postsPrivate, false),
        eq(communities.status, "active"),
      ];
      if (cursor) {
        conditions.push(
          or(
            lt(posts.createdAt, cursor.createdAt),
            and(eq(posts.createdAt, cursor.createdAt), lt(posts.id, cursor.id)),
          )!,
        );
      }
      const results = await database
        .select({
          id: posts.id,
          ...moderatorSafePostFields,
          voteCount: posts.voteCount,
          downvoteCount: posts.downvoteCount,
          replyCount: sql<number>`case when ${posts.deletedByModerator} then 0 else (
            select count(*)::int
            from ${replies}
            inner join ${users} as reply_author on reply_author.id = ${replies.authorId}
            where ${replies.postId} = ${posts.id}
              and ${replies.deletedAt} is null
              and reply_author.deleted_at is null
              ${
                viewerId
                  ? sql`and not exists (
                    select 1 from ${userBlocks} as reply_block
                    where (reply_block.blocker_id = ${viewerId} and reply_block.blocked_id = reply_author.id)
                       or (reply_block.blocker_id = reply_author.id and reply_block.blocked_id = ${viewerId})
                  )`
                  : sql``
              }
          ) end`,
          isReacted: viewerId
            ? sql<boolean>`exists (
                select 1 from ${postReactions}
                where ${postReactions.postId} = ${posts.id}
                  and ${postReactions.userId} = ${viewerId}
                  and ${postReactions.type} = 'like'
              )`
            : sql<boolean>`false`,
          isDownvoted: viewerId
            ? sql<boolean>`exists (
                select 1 from ${postReactions}
                where ${postReactions.postId} = ${posts.id}
                  and ${postReactions.userId} = ${viewerId}
                  and ${postReactions.type} = 'downvote'
              )`
            : sql<boolean>`false`,
          isBookmarked: viewerId
            ? sql<boolean>`exists (
                select 1 from ${bookmarks}
                where ${bookmarks.postId} = ${posts.id}
                  and ${bookmarks.userId} = ${viewerId}
              )`
            : sql<boolean>`false`,
          isProfilePinned: sql<boolean>`${posts.profilePinnedAt} is not null`,
          isCommunityPinned: sql<boolean>`${posts.communityPinnedAt} is not null`,
          canManage: viewerId
            ? sql<boolean>`${posts.deletedAt} is null and (
                ${posts.authorId} = ${viewerId}
                or exists (
                  select 1 from ${communityMemberships} as post_manager
                  where post_manager.community_id = ${posts.communityId}
                    and post_manager.user_id = ${viewerId}
                    and post_manager.role in ('owner', 'moderator')
                )
              )`
            : sql<boolean>`false`,
          createdAt: posts.createdAt,
          community: {
            id: communities.id,
            slug: communities.slug,
            name: communities.name,
            avatarUrl: communities.avatarUrl,
          },
          author: {
            id: users.id,
            username: profiles.username,
            displayName: profiles.displayName,
            avatarUrl: profiles.avatarUrl,
            avatarVersion: profiles.avatarVersion,
            initials: profiles.initials,
            avatarColor: profiles.avatarColor,
            verified: profiles.isVerified,
            isFollowing: viewerId
              ? sql<boolean>`exists (select 1 from ${userFollows} where ${userFollows.followerId} = ${viewerId} and ${userFollows.followedId} = ${users.id})`
              : sql<boolean>`false`,
          },
        })
        .from(posts)
        .innerJoin(communities, eq(posts.communityId, communities.id))
        .innerJoin(users, eq(posts.authorId, users.id))
        .innerJoin(profiles, eq(users.id, profiles.userId))
        .where(and(...conditions))
        .orderBy(
          asc(sql`case when ${posts.profilePinnedAt} is null then 1 else 0 end`),
          desc(posts.createdAt),
          desc(posts.id),
        )
        .limit(parsedQuery.data.limit + 1);
      const hasMore = results.length > parsedQuery.data.limit;
      const items = hasMore
        ? results.slice(0, parsedQuery.data.limit)
        : results;
      const lastItem = items.at(-1);
      reply.header(
        "cache-control",
        viewerId
          ? "private, no-store"
          : "public, max-age=0, s-maxage=5, stale-while-revalidate=15",
      );
      return {
        items,
        nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
      };
    }

    const conditions = [
      eq(replies.authorId, profile.userId),
      isNull(replies.deletedAt),
      isNull(posts.deletedAt),
      isNull(users.deletedAt),
      eq(communities.isPublic, true),
      eq(communities.postsPrivate, false),
      eq(communities.status, "active"),
    ];
    if (cursor) {
      conditions.push(
        or(
          lt(replies.createdAt, cursor.createdAt),
          and(
            eq(replies.createdAt, cursor.createdAt),
            lt(replies.id, cursor.id),
          ),
        )!,
      );
    }
    const results = await database
      .select({
        id: replies.id,
        body: replies.body,
        mediaUrl: replies.mediaUrl,
        mediaKind: replies.mediaKind,
        createdAt: replies.createdAt,
        post: {
          id: posts.id,
          body: posts.body,
          kind: posts.kind,
          url: posts.url,
          communitySlug: communities.slug,
          communityName: communities.name,
        },
      })
      .from(replies)
      .innerJoin(posts, eq(replies.postId, posts.id))
      .innerJoin(communities, eq(posts.communityId, communities.id))
      .innerJoin(users, eq(replies.authorId, users.id))
      .where(and(...conditions))
      .orderBy(desc(replies.createdAt), desc(replies.id))
      .limit(parsedQuery.data.limit + 1);
    const hasMore = results.length > parsedQuery.data.limit;
    const items = hasMore ? results.slice(0, parsedQuery.data.limit) : results;
    const lastItem = items.at(-1);
    reply.header(
      "cache-control",
      "public, max-age=0, s-maxage=5, stale-while-revalidate=15",
    );
    return {
      items,
      nextCursor:
        hasMore && lastItem
          ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
          : null,
    };
  });

  app.get("/api/v1/profiles", async (request, reply) => {
    const parsedQuery = pageQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const conditions = [isNull(users.deletedAt)];
    if (cursor) {
      conditions.push(
        or(
          lt(profiles.createdAt, cursor.createdAt),
          and(
            eq(profiles.createdAt, cursor.createdAt),
            lt(profiles.userId, cursor.id),
          ),
        )!,
      );
    }

    const rows = await database
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        bio: profiles.bio,
        avatarUrl: profiles.avatarUrl,
        avatarVersion: profiles.avatarVersion,
        initials: profiles.initials,
        avatarColor: profiles.avatarColor,
        verified: profiles.isVerified,
        createdAt: profiles.createdAt,
      })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(and(...conditions))
      .orderBy(desc(profiles.createdAt), desc(profiles.userId))
      .limit(parsedQuery.data.limit + 1);

    const hasMore = rows.length > parsedQuery.data.limit;
    const items = hasMore ? rows.slice(0, parsedQuery.data.limit) : rows;
    const lastItem = items.at(-1);
    reply.header(
      "cache-control",
      "public, max-age=0, s-maxage=10, stale-while-revalidate=30",
    );
    return {
      items,
      nextCursor:
        hasMore && lastItem
          ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
          : null,
    };
  });

  app.get("/api/v1/notifications", async (request, reply) => {
    const viewerId = await currentViewerId(request);
    if (!viewerId) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });
    }
    const parsedQuery = notificationsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const conditions = [
      eq(notifications.recipientId, viewerId),
      notificationPrivatePostsVisibleTo(viewerId),
    ];
    if (parsedQuery.data.unread === "true") {
      conditions.push(isNull(notifications.readAt));
    }
    if (parsedQuery.data.messages === "true") {
      conditions.push(
        sql`(${notifications.payload}->>'action' = 'chat_message'
          or ${notifications.payload}->>'targetKind' = 'chat_reply')`,
      );
    }
    if (cursor) {
      conditions.push(
        or(
          lt(notifications.createdAt, cursor.createdAt),
          and(
            eq(notifications.createdAt, cursor.createdAt),
            lt(notifications.id, cursor.id),
          ),
        )!,
      );
    }
    const [unreadRow] = await database
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, viewerId),
          notificationPrivatePostsVisibleTo(viewerId),
          isNull(notifications.readAt),
        ),
      );
    const rows = await database
      .select({
        id: notifications.id,
        type: notifications.type,
        entityId: notifications.entityId,
        payload: sql<Record<string, unknown>>`
          ${notifications.payload} || jsonb_strip_nulls(jsonb_build_object(
            'viewerFollowsActor', (
              select exists (
                select 1
                from ${userFollows} notification_follow
                inner join ${profiles} notification_follow_actor
                  on notification_follow_actor.user_id = notification_follow.followed_id
                where notification_follow.follower_id = ${viewerId}
                  and notification_follow_actor.username =
                    ${notifications.payload}->>'actorUsername'
              )
            ),
            'viewerPostVote', (
              select case
                when notification_vote.type = 'like' then 'up'
                when notification_vote.type = 'downvote' then 'down'
                else null
              end
              from ${postReactions} notification_vote
              where notification_vote.user_id = ${viewerId}
                and notification_vote.post_id = ${notifications.entityId}
                and notification_vote.type in ('like', 'downvote')
              limit 1
            ),
            'actorAvatarUrl', (
              select notification_actor.avatar_url
              from profiles notification_actor
              where notification_actor.username =
                ${notifications.payload}->>'actorUsername'
              limit 1
            ),
            'postPreview', (
              select left(notification_post.body, 180)
              from posts notification_post
              where notification_post.id = ${notifications.entityId}
                and notification_post.deleted_at is null
              limit 1
            ),
            'postAuthorName', (
              select notification_post_author.display_name
              from posts notification_post
              inner join profiles notification_post_author
                on notification_post_author.user_id = notification_post.author_id
              inner join users notification_post_user
                on notification_post_user.id = notification_post.author_id
                and notification_post_user.deleted_at is null
              where notification_post.id = ${notifications.entityId}
                and notification_post.deleted_at is null
              limit 1
            ),
            'postAuthorUsername', (
              select notification_post_author.username
              from posts notification_post
              inner join profiles notification_post_author
                on notification_post_author.user_id = notification_post.author_id
              inner join users notification_post_user
                on notification_post_user.id = notification_post.author_id
                and notification_post_user.deleted_at is null
              where notification_post.id = ${notifications.entityId}
                and notification_post.deleted_at is null
              limit 1
            ),
            'mediaUrl', (
              select case
                when notification_post.kind in ('image_url', 'video_url')
                  then notification_post.url
                else null
              end
              from posts notification_post
              where notification_post.id = ${notifications.entityId}
                and notification_post.deleted_at is null
              limit 1
            ),
            'mediaKind', (
              select notification_post.kind
              from posts notification_post
              where notification_post.id = ${notifications.entityId}
                and notification_post.deleted_at is null
              limit 1
            ),
            'postUrl', (
              select notification_post.url
              from posts notification_post
              where notification_post.id = ${notifications.entityId}
                and notification_post.kind = 'link'
                and notification_post.deleted_at is null
              limit 1
            ),
            'communityName', (
              select notification_community.name
              from posts notification_post
              inner join communities notification_community
                on notification_community.id = notification_post.community_id
              where notification_post.id = ${notifications.entityId}
                and notification_post.deleted_at is null
              limit 1
            ),
            'communitySlug', (
              select notification_community.slug
              from posts notification_post
              inner join communities notification_community
                on notification_community.id = notification_post.community_id
              where notification_post.id = ${notifications.entityId}
                and notification_post.deleted_at is null
              limit 1
            )
          ))
        `,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(parsedQuery.data.limit + 1);
    const hasMore = rows.length > parsedQuery.data.limit;
    const items = hasMore ? rows.slice(0, parsedQuery.data.limit) : rows;
    const lastItem = items.at(-1);
    reply.header("cache-control", "private, no-store");
    return {
      items,
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
      unreadCount: unreadRow?.value ?? 0,
    };
  });

  app.get("/api/v1/me/bookmarks", async (request, reply) => {
    const viewerId = await currentViewerId(request);
    if (!viewerId) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });
    }
    const parsedQuery = pageQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const conditions = [
      eq(bookmarks.userId, viewerId),
      or(isNull(posts.deletedAt), eq(posts.deletedByModerator, true))!,
      isNull(users.deletedAt),
      eq(communities.isPublic, true),
      privateCommunityPostsVisibleTo(viewerId),
      eq(communities.status, "active"),
      sql`not exists (
        select 1 from ${userBlocks}
        where (${userBlocks.blockerId} = ${viewerId} and ${userBlocks.blockedId} = ${users.id})
           or (${userBlocks.blockerId} = ${users.id} and ${userBlocks.blockedId} = ${viewerId})
      )`,
    ];
    if (cursor) {
      conditions.push(
        or(
          lt(bookmarks.createdAt, cursor.createdAt),
          and(
            eq(bookmarks.createdAt, cursor.createdAt),
            lt(posts.id, cursor.id),
          ),
        )!,
      );
    }

    const rows = await database
      .select({
        id: posts.id,
        ...moderatorSafePostFields,
        voteCount: posts.voteCount,
        downvoteCount: posts.downvoteCount,
        replyCount: sql<number>`case when ${posts.deletedByModerator} then 0 else (
          select count(*)::int
          from ${replies}
          inner join ${users} as reply_author on reply_author.id = ${replies.authorId}
          where ${replies.postId} = ${posts.id}
            and ${replies.deletedAt} is null
            and reply_author.deleted_at is null
            ${
              viewerId
                ? sql`and not exists (
              select 1 from ${userBlocks} as reply_block
              where (reply_block.blocker_id = ${viewerId} and reply_block.blocked_id = reply_author.id)
                 or (reply_block.blocker_id = reply_author.id and reply_block.blocked_id = ${viewerId})
            )`
                : sql``
            }
        ) end`,
        isReacted: sql<boolean>`exists (
          select 1 from ${postReactions}
          where ${postReactions.postId} = ${posts.id}
            and ${postReactions.userId} = ${viewerId}
            and ${postReactions.type} = 'like'
        )`,
        isDownvoted: sql<boolean>`exists (
          select 1 from ${postReactions}
          where ${postReactions.postId} = ${posts.id}
            and ${postReactions.userId} = ${viewerId}
            and ${postReactions.type} = 'downvote'
        )`,
        isBookmarked: sql<boolean>`true`,
        canManage: sql<boolean>`${posts.deletedAt} is null and (
          ${posts.authorId} = ${viewerId}
          or exists (
            select 1 from ${communityMemberships} as post_manager
            where post_manager.community_id = ${posts.communityId}
              and post_manager.user_id = ${viewerId}
              and post_manager.role in ('owner', 'moderator')
          )
        )`,
        createdAt: posts.createdAt,
        bookmarkCreatedAt: bookmarks.createdAt,
        community: {
          id: communities.id,
          slug: communities.slug,
          name: communities.name,
          avatarUrl: communities.avatarUrl,
        },
        author: {
          id: users.id,
          username: profiles.username,
          displayName: profiles.displayName,
          avatarUrl: profiles.avatarUrl,
          avatarVersion: profiles.avatarVersion,
          initials: profiles.initials,
          avatarColor: profiles.avatarColor,
          verified: profiles.isVerified,
          isFollowing: sql<boolean>`exists (
            select 1 from ${userFollows}
            where ${userFollows.followerId} = ${viewerId}
              and ${userFollows.followedId} = ${users.id}
          )`,
        },
      })
      .from(bookmarks)
      .innerJoin(posts, eq(posts.id, bookmarks.postId))
      .innerJoin(communities, eq(communities.id, posts.communityId))
      .innerJoin(users, eq(users.id, posts.authorId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(bookmarks.createdAt), desc(posts.id))
      .limit(parsedQuery.data.limit + 1);
    const hasMore = rows.length > parsedQuery.data.limit;
    const items = hasMore ? rows.slice(0, parsedQuery.data.limit) : rows;
    const lastItem = items.at(-1);
    reply.header("cache-control", "private, no-store");
    return {
      items: items.map(
        ({ bookmarkCreatedAt: _bookmarkCreatedAt, ...post }) => post,
      ),
      nextCursor:
        hasMore && lastItem
          ? encodeCursor({
              createdAt: lastItem.bookmarkCreatedAt,
              id: lastItem.id,
            })
          : null,
    };
  });

  app.get("/api/v1/feed", async (request, reply) => {
    const parsedQuery = feedQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const viewerId = await currentViewerId(request);

    const conditions = [
      eq(communities.isPublic, true),
      privateCommunityPostsVisibleTo(viewerId),
      eq(communities.status, "active"),
      or(isNull(posts.deletedAt), eq(posts.deletedByModerator, true))!,
      isNull(users.deletedAt),
    ];
    if (parsedQuery.data.community) {
      conditions.push(
        or(
          eq(communities.slug, parsedQuery.data.community),
          inArray(
            communities.id,
            database
              .select({ communityId: communitySlugAliases.communityId })
              .from(communitySlugAliases)
              .where(eq(communitySlugAliases.slug, parsedQuery.data.community)),
          ),
        )!,
      );
    }
    if (parsedQuery.data.news === "only") {
      conditions.push(eq(posts.isNews, true));
    } else if (parsedQuery.data.news === "exclude") {
      conditions.push(eq(posts.isNews, false));
    }
    if (parsedQuery.data.scope === "profile" && parsedQuery.data.username) {
      conditions.push(eq(profiles.username, parsedQuery.data.username));
    }
    if (parsedQuery.data.media === "video") {
      conditions.push(
        or(
          eq(posts.kind, "video_url"),
          and(
            eq(posts.kind, "link"),
            or(
              ilike(posts.url, "%youtube.com/watch%"),
              ilike(posts.url, "%youtube.com/shorts/%"),
              ilike(posts.url, "%youtube.com/live/%"),
              ilike(posts.url, "%youtu.be/%"),
              ilike(posts.url, "%youtube-nocookie.com/embed/%"),
              ilike(posts.url, "%youtube-nocookie.com/shorts/%"),
            )!,
          ),
        )!,
      );
    } else if (parsedQuery.data.media === "audio") {
      conditions.push(eq(posts.kind, "audio_url"));
    }
    if (parsedQuery.data.members === "only") {
      conditions.push(
        exists(
          database
            .select({ userId: communityMemberships.userId })
            .from(communityMemberships)
            .where(
              and(
                eq(communityMemberships.communityId, posts.communityId),
                eq(communityMemberships.userId, posts.authorId),
              ),
            ),
        ),
      );
    }
    let personalized = false;
    const replyCountExpression = sql<number>`case when ${posts.deletedByModerator} then 0 else (
      select count(*)::int
      from ${replies}
      inner join ${users} as reply_author on reply_author.id = ${replies.authorId}
      where ${replies.postId} = ${posts.id}
        and ${replies.deletedAt} is null
        and reply_author.deleted_at is null
        ${
          viewerId
            ? sql`and not exists (
          select 1 from ${userBlocks} as reply_block
          where (reply_block.blocker_id = ${viewerId} and reply_block.blocked_id = reply_author.id)
             or (reply_block.blocker_id = reply_author.id and reply_block.blocked_id = ${viewerId})
        )`
            : sql``
        }
    ) end`;
    if (viewerId) {
      conditions.push(
        sql`not exists (
          select 1 from ${userBlocks}
          where (${userBlocks.blockerId} = ${viewerId} and ${userBlocks.blockedId} = ${users.id})
             or (${userBlocks.blockerId} = ${users.id} and ${userBlocks.blockedId} = ${viewerId})
        )`,
      );
      conditions.push(
        sql`not exists (
          select 1 from ${userMutes}
          where ${userMutes.muterId} = ${viewerId} and ${userMutes.mutedId} = ${users.id}
        )`,
      );
    }
    if (parsedQuery.data.scope === "following" && viewerId) {
      conditions.push(
        sql`exists (
            select 1 from ${communityMemberships}
            where ${communityMemberships.communityId} = ${posts.communityId}
              and ${communityMemberships.userId} = ${viewerId}
          )`,
      );
      personalized = true;
    }
    const cursor =
      parsedQuery.data.sort === "hot"
        ? decodeHotFeedCursor(parsedQuery.data.cursor)
        : decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);
    if (cursor) {
      if (parsedQuery.data.sort === "hot") {
        const hotCursor = cursor as HotFeedCursor;
        conditions.push(
          or(
            lt(posts.voteCount, hotCursor.voteCount),
            and(
              eq(posts.voteCount, hotCursor.voteCount),
              lt(replyCountExpression, hotCursor.replyCount),
            ),
            and(
              eq(posts.voteCount, hotCursor.voteCount),
              eq(replyCountExpression, hotCursor.replyCount),
              lt(posts.createdAt, hotCursor.createdAt),
            ),
            and(
              eq(posts.voteCount, hotCursor.voteCount),
              eq(replyCountExpression, hotCursor.replyCount),
              eq(posts.createdAt, hotCursor.createdAt),
              lt(posts.id, hotCursor.id),
            ),
          )!,
        );
      } else {
        conditions.push(
          or(
            lt(posts.createdAt, cursor.createdAt),
            and(
              eq(posts.createdAt, cursor.createdAt),
              lt(posts.id, cursor.id),
            ),
          )!,
        );
      }
    }

    const results = await database
      .select({
        id: posts.id,
        ...moderatorSafePostFields,
        voteCount: posts.voteCount,
        downvoteCount: posts.downvoteCount,
        replyCount: replyCountExpression,
        isReacted: viewerId
          ? sql<boolean>`exists (select 1 from ${postReactions} where ${postReactions.postId} = ${posts.id} and ${postReactions.userId} = ${viewerId} and ${postReactions.type} = 'like')`
          : sql<boolean>`false`,
        isDownvoted: viewerId
          ? sql<boolean>`exists (select 1 from ${postReactions} where ${postReactions.postId} = ${posts.id} and ${postReactions.userId} = ${viewerId} and ${postReactions.type} = 'downvote')`
          : sql<boolean>`false`,
        isBookmarked: viewerId
          ? sql<boolean>`exists (select 1 from ${bookmarks} where ${bookmarks.postId} = ${posts.id} and ${bookmarks.userId} = ${viewerId})`
          : sql<boolean>`false`,
        isProfilePinned: sql<boolean>`${posts.profilePinnedAt} is not null`,
        isCommunityPinned: sql<boolean>`${posts.communityPinnedAt} is not null`,
        canManage: viewerId
          ? sql<boolean>`${posts.deletedAt} is null and (
              ${posts.authorId} = ${viewerId}
              or exists (
                select 1 from ${communityMemberships} as post_manager
                where post_manager.community_id = ${posts.communityId}
                  and post_manager.user_id = ${viewerId}
                  and post_manager.role in ('owner', 'moderator')
              )
            )`
          : sql<boolean>`false`,
        createdAt: posts.createdAt,
        community: {
          id: communities.id,
          slug: communities.slug,
          name: communities.name,
          avatarUrl: communities.avatarUrl,
        },
        author: {
          id: users.id,
          username: profiles.username,
          displayName: profiles.displayName,
          avatarUrl: profiles.avatarUrl,
          avatarVersion: profiles.avatarVersion,
          initials: profiles.initials,
          avatarColor: profiles.avatarColor,
          verified: profiles.isVerified,
          isFollowing: viewerId
            ? sql<boolean>`exists (select 1 from ${userFollows} where ${userFollows.followerId} = ${viewerId} and ${userFollows.followedId} = ${users.id})`
            : sql<boolean>`false`,
        },
      })
      .from(posts)
      .innerJoin(communities, eq(posts.communityId, communities.id))
      .innerJoin(users, eq(posts.authorId, users.id))
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(and(...conditions))
      .orderBy(
        ...(parsedQuery.data.scope === "community"
          ? [
              asc(
                sql`case when ${posts.communityPinnedAt} is null then 1 else 0 end`,
              ),
            ]
          : parsedQuery.data.scope === "profile"
            ? [
                asc(
                  sql`case when ${posts.profilePinnedAt} is null then 1 else 0 end`,
                ),
              ]
            : []),
        ...(parsedQuery.data.sort === "hot"
          ? [
              desc(posts.voteCount),
              desc(replyCountExpression),
              desc(posts.createdAt),
              desc(posts.id),
            ]
          : [desc(posts.createdAt), desc(posts.id)]),
      )
      .limit(parsedQuery.data.limit + 1);

    const hasMore = results.length > parsedQuery.data.limit;
    const items = hasMore ? results.slice(0, parsedQuery.data.limit) : results;
    const lastItem = items.at(-1);
    reply.header(
      "cache-control",
      viewerId
        ? "private, no-store"
        : "public, max-age=0, s-maxage=5, stale-while-revalidate=15",
    );
    return {
      items,
      personalized,
      nextCursor:
        hasMore && lastItem
          ? parsedQuery.data.sort === "hot"
            ? encodeHotFeedCursor({
                createdAt: lastItem.createdAt,
                id: lastItem.id,
                voteCount: lastItem.voteCount,
                replyCount: Number(lastItem.replyCount),
              })
            : encodeCursor(lastItem)
          : null,
    };
  });

  app.get("/api/v1/posts/:id/replies", async (request, reply) => {
    const parsedParams = idParamsSchema.safeParse(request.params);
    const parsedQuery = pageQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success)
      return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);
    const viewerId = await currentViewerId(request);

    const postConditions = [
      eq(posts.id, parsedParams.data.id),
      eq(communities.isPublic, true),
      privateCommunityPostsVisibleTo(viewerId),
      eq(communities.status, "active"),
      or(isNull(posts.deletedAt), eq(posts.deletedByModerator, true))!,
      isNull(users.deletedAt),
    ];
    if (viewerId) {
      postConditions.push(
        sql`not exists (
          select 1 from ${userBlocks}
          where (${userBlocks.blockerId} = ${viewerId} and ${userBlocks.blockedId} = ${users.id})
             or (${userBlocks.blockerId} = ${users.id} and ${userBlocks.blockedId} = ${viewerId})
        )`,
      );
    }
    const [post] = await database
      .select({
        id: posts.id,
        isModeratorRemoved: posts.deletedByModerator,
      })
      .from(posts)
      .innerJoin(communities, eq(communities.id, posts.communityId))
      .innerJoin(users, eq(users.id, posts.authorId))
      .where(and(...postConditions))
      .limit(1);
    if (!post) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    if (post.isModeratorRemoved) return { items: [], nextCursor: null };

    const conditions = [
      eq(replies.postId, post.id),
      isNull(replies.deletedAt),
      isNull(users.deletedAt),
    ];
    if (viewerId) {
      conditions.push(
        sql`not exists (
          select 1 from ${userBlocks}
          where (${userBlocks.blockerId} = ${viewerId} and ${userBlocks.blockedId} = ${users.id})
             or (${userBlocks.blockerId} = ${users.id} and ${userBlocks.blockedId} = ${viewerId})
        )`,
      );
    }
    if (cursor) {
      conditions.push(
        or(
          lt(replies.createdAt, cursor.createdAt),
          and(
            eq(replies.createdAt, cursor.createdAt),
            lt(replies.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await database
      .select({
        id: replies.id,
        parentReplyId: replies.parentReplyId,
        reactionCount: replies.voteCount,
        reacted: viewerId
          ? sql<boolean>`exists (
              select 1 from ${replyReactions}
              where ${replyReactions.replyId} = ${replies.id}
                and ${replyReactions.userId} = ${viewerId}
                and ${replyReactions.type} = 'like'
            )`
          : sql<boolean>`false`,
        body: sql<string>`case when ${replies.deletedAt} is null then ${replies.body} else '' end`,
        mediaUrl: sql<
          string | null
        >`case when ${replies.deletedAt} is null then ${replies.mediaUrl} else null end`,
        mediaKind: sql<
          string | null
        >`case when ${replies.deletedAt} is null then ${replies.mediaKind} else null end`,
        removed: sql<boolean>`${replies.deletedAt} is not null`,
        isRemovedByModerator: replies.deletedByModerator,
        isEditedByModerator: replies.moderatorEdited,
        isPostAuthor: sql<boolean>`${replies.deletedAt} is null and ${replies.authorId} = ${posts.authorId}`,
        isCommunityOwner: sql<boolean>`exists (
          select 1 from ${communityMemberships} as reply_owner
          where reply_owner.community_id = ${posts.communityId}
            and reply_owner.user_id = ${replies.authorId}
            and reply_owner.role = 'owner'
        )`,
        isCommunityModerator: sql<boolean>`exists (
          select 1 from ${communityMemberships} as reply_moderator
          where reply_moderator.community_id = ${posts.communityId}
            and reply_moderator.user_id = ${replies.authorId}
            and reply_moderator.role = 'moderator'
        )`,
        createdAt: replies.createdAt,
        author: {
          id: sql<string>`case when ${replies.deletedAt} is null then ${users.id} else '00000000-0000-4000-8000-000000000000'::uuid end`,
          username: sql<string>`case when ${replies.deletedAt} is null then ${profiles.username} else '' end`,
          displayName: sql<string>`case when ${replies.deletedAt} is null then ${profiles.displayName} else 'Removed reply' end`,
          avatarUrl: sql<
            string | null
          >`case when ${replies.deletedAt} is null then ${profiles.avatarUrl} else null end`,
          avatarVersion: sql<
            string | null
          >`case when ${replies.deletedAt} is null then ${profiles.avatarVersion} else null end`,
          initials: sql<
            string | null
          >`case when ${replies.deletedAt} is null then ${profiles.initials} else null end`,
          avatarColor: sql<
            string | null
          >`case when ${replies.deletedAt} is null then ${profiles.avatarColor} else null end`,
          verified: sql<boolean>`case when ${replies.deletedAt} is null then ${profiles.isVerified} else false end`,
        },
        canManage: viewerId
          ? sql<boolean>`${replies.deletedAt} is null and (
              ${replies.authorId} = ${viewerId}
              or exists (
                select 1 from ${communityMemberships} as reply_manager
                where reply_manager.community_id = ${posts.communityId}
                  and reply_manager.user_id = ${viewerId}
                  and reply_manager.role in ('owner', 'moderator')
              )
            )`
          : sql<boolean>`false`,
      })
      .from(replies)
      .innerJoin(users, eq(users.id, replies.authorId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .innerJoin(posts, eq(posts.id, replies.postId))
      .where(and(...conditions))
      .orderBy(desc(replies.createdAt), desc(replies.id))
      .limit(parsedQuery.data.limit + 1);
    const hasMore = rows.length > parsedQuery.data.limit;
    const items = hasMore ? rows.slice(0, parsedQuery.data.limit) : rows;
    const lastItem = items.at(-1);
    reply.header(
      "cache-control",
      viewerId
        ? "private, no-store"
        : "public, max-age=0, s-maxage=5, stale-while-revalidate=15",
    );
    return {
      items,
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
    };
  });

  app.get("/api/v1/posts/:id", async (request, reply) => {
    const parsedParams = idParamsSchema.safeParse(request.params);
    if (!parsedParams.success) return invalidRequest(reply);
    const viewerId = await currentViewerId(request);
    const conditions = [
      eq(posts.id, parsedParams.data.id),
      eq(communities.isPublic, true),
      privateCommunityPostsVisibleTo(viewerId),
      eq(communities.status, "active"),
      or(isNull(posts.deletedAt), eq(posts.deletedByModerator, true))!,
      isNull(users.deletedAt),
    ];
    if (viewerId) {
      conditions.push(
        sql`not exists (
          select 1 from ${userBlocks}
          where (${userBlocks.blockerId} = ${viewerId} and ${userBlocks.blockedId} = ${users.id})
             or (${userBlocks.blockerId} = ${users.id} and ${userBlocks.blockedId} = ${viewerId})
        )`,
      );
    }

    const [post] = await database
      .select({
        id: posts.id,
        ...moderatorSafePostFields,
        voteCount: posts.voteCount,
        downvoteCount: posts.downvoteCount,
        replyCount: sql<number>`case when ${posts.deletedByModerator} then 0 else (
          select count(*)::int
          from ${replies}
          inner join ${users} as reply_author on reply_author.id = ${replies.authorId}
          where ${replies.postId} = ${posts.id}
            and ${replies.deletedAt} is null
            and reply_author.deleted_at is null
            ${
              viewerId
                ? sql`and not exists (
              select 1 from ${userBlocks} as reply_block
              where (reply_block.blocker_id = ${viewerId} and reply_block.blocked_id = reply_author.id)
                 or (reply_block.blocker_id = reply_author.id and reply_block.blocked_id = ${viewerId})
            )`
                : sql``
            }
        ) end`,
        isReacted: viewerId
          ? sql<boolean>`exists (select 1 from ${postReactions} where ${postReactions.postId} = ${posts.id} and ${postReactions.userId} = ${viewerId} and ${postReactions.type} = 'like')`
          : sql<boolean>`false`,
        isDownvoted: viewerId
          ? sql<boolean>`exists (select 1 from ${postReactions} where ${postReactions.postId} = ${posts.id} and ${postReactions.userId} = ${viewerId} and ${postReactions.type} = 'downvote')`
          : sql<boolean>`false`,
        isBookmarked: viewerId
          ? sql<boolean>`exists (select 1 from ${bookmarks} where ${bookmarks.postId} = ${posts.id} and ${bookmarks.userId} = ${viewerId})`
          : sql<boolean>`false`,
        isProfilePinned: sql<boolean>`${posts.profilePinnedAt} is not null`,
        isCommunityPinned: sql<boolean>`${posts.communityPinnedAt} is not null`,
        canManage: viewerId
          ? sql<boolean>`${posts.deletedAt} is null and (
              ${posts.authorId} = ${viewerId}
              or exists (
                select 1 from ${communityMemberships} as post_manager
                where post_manager.community_id = ${posts.communityId}
                  and post_manager.user_id = ${viewerId}
                  and post_manager.role in ('owner', 'moderator')
              )
            )`
          : sql<boolean>`false`,
        createdAt: posts.createdAt,
        community: {
          id: communities.id,
          slug: communities.slug,
          name: communities.name,
          avatarUrl: communities.avatarUrl,
        },
        author: {
          id: users.id,
          username: profiles.username,
          displayName: profiles.displayName,
          avatarUrl: profiles.avatarUrl,
          avatarVersion: profiles.avatarVersion,
          initials: profiles.initials,
          avatarColor: profiles.avatarColor,
          verified: profiles.isVerified,
          isFollowing: viewerId
            ? sql<boolean>`exists (select 1 from ${userFollows} where ${userFollows.followerId} = ${viewerId} and ${userFollows.followedId} = ${users.id})`
            : sql<boolean>`false`,
        },
        authorIsActive: sql<boolean>`${users.deletedAt} is null and ${users.suspendedAt} is null`,
      })
      .from(posts)
      .innerJoin(communities, eq(posts.communityId, communities.id))
      .innerJoin(users, eq(posts.authorId, users.id))
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(and(...conditions))
      .limit(1);

    if (!post) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }
    const { authorIsActive, ...postData } = post;
    const indexable =
      authorIsActive && (await isCommunityIndexable(post.community.id));

    const replyRows = post.isModeratorRemoved
      ? []
      : await database
          .select({
        id: replies.id,
        parentReplyId: replies.parentReplyId,
        reactionCount: replies.voteCount,
        reacted: viewerId
          ? sql<boolean>`exists (
              select 1 from ${replyReactions}
              where ${replyReactions.replyId} = ${replies.id}
                and ${replyReactions.userId} = ${viewerId}
                and ${replyReactions.type} = 'like'
            )`
          : sql<boolean>`false`,
        body: sql<string>`case when ${replies.deletedAt} is null then ${replies.body} else '' end`,
        mediaUrl: sql<
          string | null
        >`case when ${replies.deletedAt} is null then ${replies.mediaUrl} else null end`,
        mediaKind: sql<
          string | null
        >`case when ${replies.deletedAt} is null then ${replies.mediaKind} else null end`,
        removed: sql<boolean>`${replies.deletedAt} is not null`,
        isRemovedByModerator: replies.deletedByModerator,
        isEditedByModerator: replies.moderatorEdited,
        isPostAuthor: sql<boolean>`${replies.deletedAt} is null and ${replies.authorId} = ${posts.authorId}`,
        isCommunityOwner: sql<boolean>`exists (
          select 1 from ${communityMemberships} as reply_owner
          where reply_owner.community_id = ${posts.communityId}
            and reply_owner.user_id = ${replies.authorId}
            and reply_owner.role = 'owner'
        )`,
        isCommunityModerator: sql<boolean>`exists (
          select 1 from ${communityMemberships} as reply_moderator
          where reply_moderator.community_id = ${posts.communityId}
            and reply_moderator.user_id = ${replies.authorId}
            and reply_moderator.role = 'moderator'
        )`,
        createdAt: replies.createdAt,
        author: {
          id: sql<string>`case when ${replies.deletedAt} is null then ${users.id} else '00000000-0000-4000-8000-000000000000'::uuid end`,
          username: sql<string>`case when ${replies.deletedAt} is null then ${profiles.username} else '' end`,
          displayName: sql<string>`case when ${replies.deletedAt} is null then ${profiles.displayName} else 'Removed reply' end`,
          avatarUrl: sql<
            string | null
          >`case when ${replies.deletedAt} is null then ${profiles.avatarUrl} else null end`,
          avatarVersion: sql<
            string | null
          >`case when ${replies.deletedAt} is null then ${profiles.avatarVersion} else null end`,
          initials: sql<
            string | null
          >`case when ${replies.deletedAt} is null then ${profiles.initials} else null end`,
          avatarColor: sql<
            string | null
          >`case when ${replies.deletedAt} is null then ${profiles.avatarColor} else null end`,
          verified: sql<boolean>`case when ${replies.deletedAt} is null then ${profiles.isVerified} else false end`,
        },
        canManage: viewerId
          ? sql<boolean>`${replies.deletedAt} is null and (
              ${replies.authorId} = ${viewerId}
              or exists (
                select 1 from ${communityMemberships} as reply_manager
                where reply_manager.community_id = ${posts.communityId}
                  and reply_manager.user_id = ${viewerId}
                  and reply_manager.role in ('owner', 'moderator')
              )
            )`
          : sql<boolean>`false`,
          })
          .from(replies)
          .innerJoin(users, eq(replies.authorId, users.id))
          .innerJoin(profiles, eq(users.id, profiles.userId))
          .innerJoin(posts, eq(posts.id, replies.postId))
          .where(
            and(
              eq(replies.postId, post.id),
              isNull(replies.deletedAt),
              isNull(users.deletedAt),
              ...(viewerId
                ? [
                    sql`not exists (
                  select 1 from ${userBlocks}
                  where (${userBlocks.blockerId} = ${viewerId} and ${userBlocks.blockedId} = ${users.id})
                     or (${userBlocks.blockerId} = ${users.id} and ${userBlocks.blockedId} = ${viewerId})
                )`,
                  ]
                : []),
            ),
          )
          .orderBy(desc(replies.createdAt), desc(replies.id))
          .limit(51);
    const hasMoreReplies = replyRows.length > 50;
    const postReplies = hasMoreReplies ? replyRows.slice(0, 50) : replyRows;
    const oldestReply = postReplies.at(-1);
    const repliesCursor =
      hasMoreReplies && oldestReply ? encodeCursor(oldestReply) : null;

    reply.header(
      "cache-control",
      viewerId
        ? "private, no-store"
        : "public, max-age=0, s-maxage=5, stale-while-revalidate=15",
    );
    return {
      post: { ...postData, indexable },
      replies: postReplies.reverse(),
      nextRepliesCursor: repliesCursor,
    };
  });
}
