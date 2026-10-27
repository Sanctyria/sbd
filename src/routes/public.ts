import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
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
  communities,
  communitySlugAliases,
  communityMemberships,
  communityMemberMutes,
  emberEvents,
  notifications,
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

const pageLimit = 30;
const maxPageLimit = 50;

const pageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(maxPageLimit).default(pageLimit),
});

const communitiesQuerySchema = pageQuerySchema.extend({
  query: z.string().trim().max(100).optional(),
});

const profileActivityQuerySchema = pageQuerySchema.extend({
  type: z.enum(["posts", "replies"]).default("posts"),
});

const profileConnectionsQuerySchema = pageQuerySchema;

const notificationsQuerySchema = pageQuerySchema.extend({
  unread: z.enum(["true", "false"]).optional(),
});
const linkPreviewQuerySchema = z.object({
  url: z.string().trim().min(1).max(2048).url(),
});

const feedQuerySchema = pageQuerySchema
  .extend({
    scope: z.enum(["following", "community", "public"]).default("public"),
    community: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
  })
  .superRefine((query, context) => {
    if (query.scope === "community" && !query.community) {
      context.addIssue({
        code: "custom",
        path: ["community"],
        message: "A community slug is required for the community feed.",
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
        createdAt: communities.createdAt,
        memberCount: viewerId
          ? sql<number>`count(${communityMemberships.userId}) filter (where not exists (
              select 1 from ${userBlocks} as membership_block
              where (membership_block.blocker_id = ${viewerId} and membership_block.blocked_id = ${communityMemberships.userId})
                 or (membership_block.blocker_id = ${communityMemberships.userId} and membership_block.blocked_id = ${viewerId})
            ))`
          : count(communityMemberships.userId),
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
        communities.createdAt,
      )
      .limit(1);

    if (!community) {
      return reply.code(404).send({
        error: { code: "COMMUNITY_NOT_FOUND", message: "Community not found." },
      });
    }

    reply.header(
      "cache-control",
      viewerId
        ? "private, no-store"
        : "public, max-age=0, s-maxage=10, stale-while-revalidate=30",
    );
    return { community };
  });

  app.get("/api/v1/communities/:slug/members", async (request, reply) => {
    const parsedParams = slugParamsSchema.safeParse(request.params);
    const parsedQuery = pageQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success)
      return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);
    const viewerId = await currentViewerId(request);

    const [community] = await database
      .select({
        id: communities.id,
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
          lt(communityMemberships.createdAt, cursor.createdAt),
          and(
            eq(communityMemberships.createdAt, cursor.createdAt),
            lt(communityMemberships.userId, cursor.id),
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
        verified: profiles.isVerified,
        createdAt: communityMemberships.createdAt,
        role:
          community.viewerRole === "owner" ||
          community.viewerRole === "moderator"
            ? communityMemberships.role
            : sql<string | null>`null`,
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
        desc(communityMemberships.createdAt),
        desc(communityMemberships.userId),
      )
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
        initials: profiles.initials,
        avatarColor: profiles.avatarColor,
        ember: profiles.ember,
        verified: profiles.isVerified,
        createdAt: profiles.createdAt,
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
    const { userId, ...profileData } = profile;
    return {
      profile: {
        ...profileData,
        communities: memberships,
        followerCount: followerCount?.value ?? 0,
        followingCount: followingCount?.value ?? 0,
        isFollowing,
        isBlocked,
        isBlockedBy,
        isMuted,
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
        isNull(posts.deletedAt),
        isNull(users.deletedAt),
        eq(communities.isPublic, true),
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
          kind: posts.kind,
          body: posts.body,
          url: posts.url,
          linkTitle: posts.linkTitle,
          linkDescription: posts.linkDescription,
          linkDomain: posts.linkDomain,
          voteCount: posts.voteCount,
          downvoteCount: posts.downvoteCount,
          replyCount: sql<number>`(
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
          )`,
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
          canManage: viewerId
            ? sql<boolean>`(
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
        .orderBy(desc(posts.createdAt), desc(posts.id))
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

    const conditions = [eq(notifications.recipientId, viewerId)];
    if (parsedQuery.data.unread === "true") {
      conditions.push(isNull(notifications.readAt));
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
          isNull(notifications.readAt),
        ),
      );
    const rows = await database
      .select({
        id: notifications.id,
        type: notifications.type,
        entityId: notifications.entityId,
        payload: notifications.payload,
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
      isNull(posts.deletedAt),
      isNull(users.deletedAt),
      eq(communities.isPublic, true),
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
        kind: posts.kind,
        body: posts.body,
        url: posts.url,
        linkTitle: posts.linkTitle,
        linkDescription: posts.linkDescription,
        linkDomain: posts.linkDomain,
        voteCount: posts.voteCount,
        downvoteCount: posts.downvoteCount,
        replyCount: sql<number>`(
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
        )`,
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
        canManage: sql<boolean>`(
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

    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const conditions = [
      eq(communities.isPublic, true),
      eq(communities.status, "active"),
      isNull(posts.deletedAt),
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
    let personalized = false;
    const viewerId = await currentViewerId(request);
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
        kind: posts.kind,
        body: posts.body,
        url: posts.url,
        linkTitle: posts.linkTitle,
        linkDescription: posts.linkDescription,
        linkDomain: posts.linkDomain,
        voteCount: posts.voteCount,
        downvoteCount: posts.downvoteCount,
        replyCount: sql<number>`(
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
        )`,
        isReacted: viewerId
          ? sql<boolean>`exists (select 1 from ${postReactions} where ${postReactions.postId} = ${posts.id} and ${postReactions.userId} = ${viewerId} and ${postReactions.type} = 'like')`
          : sql<boolean>`false`,
        isDownvoted: viewerId
          ? sql<boolean>`exists (select 1 from ${postReactions} where ${postReactions.postId} = ${posts.id} and ${postReactions.userId} = ${viewerId} and ${postReactions.type} = 'downvote')`
          : sql<boolean>`false`,
        isBookmarked: viewerId
          ? sql<boolean>`exists (select 1 from ${bookmarks} where ${bookmarks.postId} = ${posts.id} and ${bookmarks.userId} = ${viewerId})`
          : sql<boolean>`false`,
        canManage: viewerId
          ? sql<boolean>`(
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
      .orderBy(desc(posts.createdAt), desc(posts.id))
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
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
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
      eq(communities.status, "active"),
      isNull(posts.deletedAt),
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
      .select({ id: posts.id })
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

    const conditions = [eq(replies.postId, post.id), isNull(users.deletedAt)];
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
        removed: sql<boolean>`${replies.deletedAt} is not null`,
        isCommunityOwner: sql<boolean>`exists (
          select 1 from ${communityMemberships} as reply_owner
          where reply_owner.community_id = ${posts.communityId}
            and reply_owner.user_id = ${replies.authorId}
            and reply_owner.role = 'owner'
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
      eq(communities.status, "active"),
      isNull(posts.deletedAt),
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
        kind: posts.kind,
        body: posts.body,
        url: posts.url,
        linkTitle: posts.linkTitle,
        linkDescription: posts.linkDescription,
        linkDomain: posts.linkDomain,
        voteCount: posts.voteCount,
        downvoteCount: posts.downvoteCount,
        replyCount: sql<number>`(
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
        )`,
        isReacted: viewerId
          ? sql<boolean>`exists (select 1 from ${postReactions} where ${postReactions.postId} = ${posts.id} and ${postReactions.userId} = ${viewerId} and ${postReactions.type} = 'like')`
          : sql<boolean>`false`,
        isDownvoted: viewerId
          ? sql<boolean>`exists (select 1 from ${postReactions} where ${postReactions.postId} = ${posts.id} and ${postReactions.userId} = ${viewerId} and ${postReactions.type} = 'downvote')`
          : sql<boolean>`false`,
        isBookmarked: viewerId
          ? sql<boolean>`exists (select 1 from ${bookmarks} where ${bookmarks.postId} = ${posts.id} and ${bookmarks.userId} = ${viewerId})`
          : sql<boolean>`false`,
        canManage: viewerId
          ? sql<boolean>`(
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
      .limit(1);

    if (!post) {
      return reply.code(404).send({
        error: { code: "POST_NOT_FOUND", message: "Post not found." },
      });
    }

    const replyRows = await database
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
        removed: sql<boolean>`${replies.deletedAt} is not null`,
        isCommunityOwner: sql<boolean>`exists (
          select 1 from ${communityMemberships} as reply_owner
          where reply_owner.community_id = ${posts.communityId}
            and reply_owner.user_id = ${replies.authorId}
            and reply_owner.role = 'owner'
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
      post,
      replies: postReplies.reverse(),
      nextRepliesCursor: repliesCursor,
    };
  });
}
