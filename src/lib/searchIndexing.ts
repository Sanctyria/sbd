import { and, eq, isNull, sql } from "drizzle-orm";
import { database } from "../db/client.js";
import { communities, posts, profiles, users } from "../db/schema.js";

export const COMMUNITY_INDEX_MIN_DESCRIPTION_LENGTH = 80;
export const COMMUNITY_INDEX_MIN_POSTS = 10;
export const COMMUNITY_INDEX_MIN_AUTHORS = 3;
export const COMMUNITY_INDEX_ACTIVITY_DAYS = 90;
export const PROFILE_INDEX_MIN_BIO_LENGTH = 20;

export function communityQualityConditions() {
  return [
    eq(communities.isPublic, true),
    eq(communities.status, "active"),
    sql`length(btrim(${communities.description})) >= ${COMMUNITY_INDEX_MIN_DESCRIPTION_LENGTH}`,
    sql`(
      select count(*)::int
      from ${posts}
      inner join ${users} as seo_post_author on seo_post_author.id = ${posts.authorId}
      where ${posts.communityId} = ${communities.id}
        and ${posts.deletedAt} is null
        and seo_post_author.deleted_at is null
        and seo_post_author.suspended_at is null
        and ${posts.createdAt} >= now() - (${COMMUNITY_INDEX_ACTIVITY_DAYS} * interval '1 day')
    ) >= ${COMMUNITY_INDEX_MIN_POSTS}`,
    sql`(
      select count(distinct ${posts.authorId})::int
      from ${posts}
      inner join ${users} as seo_post_author on seo_post_author.id = ${posts.authorId}
      where ${posts.communityId} = ${communities.id}
        and ${posts.deletedAt} is null
        and seo_post_author.deleted_at is null
        and seo_post_author.suspended_at is null
        and ${posts.createdAt} >= now() - (${COMMUNITY_INDEX_ACTIVITY_DAYS} * interval '1 day')
    ) >= ${COMMUNITY_INDEX_MIN_AUTHORS}`,
  ];
}

export function communityIndexingConditions() {
  return [
    eq(communities.indexingApproved, true),
    ...communityQualityConditions(),
  ];
}

export async function isCommunityQualityEligible(
  communityId: string,
): Promise<boolean> {
  const [community] = await database
    .select({ id: communities.id })
    .from(communities)
    .where(
      and(eq(communities.id, communityId), ...communityQualityConditions()),
    )
    .limit(1);
  return Boolean(community);
}

export async function isCommunityIndexable(
  communityId: string,
): Promise<boolean> {
  const [community] = await database
    .select({ id: communities.id })
    .from(communities)
    .where(
      and(eq(communities.id, communityId), ...communityIndexingConditions()),
    )
    .limit(1);
  return Boolean(community);
}

export async function getIndexableCommunitySlug(
  communityId: string,
): Promise<string | null> {
  const [community] = await database
    .select({ slug: communities.slug })
    .from(communities)
    .where(
      and(eq(communities.id, communityId), ...communityIndexingConditions()),
    )
    .limit(1);
  return community?.slug ?? null;
}

export async function isProfileIndexable(
  userId: string,
  optedIn: boolean,
  bio: string,
): Promise<boolean> {
  if (!optedIn || bio.trim().length < PROFILE_INDEX_MIN_BIO_LENGTH) {
    return false;
  }

  const [post] = await database
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(communities, eq(communities.id, posts.communityId))
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(
      and(
        eq(posts.authorId, userId),
        isNull(posts.deletedAt),
        isNull(users.deletedAt),
        isNull(users.suspendedAt),
        ...communityIndexingConditions(),
      ),
    )
    .limit(1);
  return Boolean(post);
}
