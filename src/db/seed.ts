import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import argon2 from "argon2";
import { inArray, sql } from "drizzle-orm";
import { database, pool } from "./client.js";
import {
  communities,
  communityMemberships,
  posts,
  profiles,
  replies,
  userCredentials,
  users,
} from "./schema.js";
import {
  demoAccounts,
  demoCommunities,
  demoPosts,
  guestMembershipSlugs,
} from "./demoData.js";

const accountFile = resolve(process.cwd(), "accounts.md");
const guestAccount = demoAccounts.find(
  (account) => account.username === "sanctyria-guest",
)!;
const officialAccount = demoAccounts.find(
  (account) => account.username === "sanctyria",
)!;
const accountIds = new Map(
  demoAccounts.map((account) => [account.username, account.id]),
);
const communityIds = new Map(
  demoCommunities.map((community) => [community.slug, community.id]),
);

async function loadPasswords(): Promise<Map<string, string>> {
  let accountText: string;
  try {
    accountText = await readFile(accountFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    const existingCredentials = await database
      .select({ userId: userCredentials.userId })
      .from(userCredentials)
      .where(
        inArray(
          userCredentials.userId,
          demoAccounts.map((account) => account.id),
        ),
      );
    if (existingCredentials.length) {
      throw new Error(
        "accounts.md is missing but demo credentials already exist. Restore that file before reseeding to avoid resetting passwords.",
      );
    }
    accountText = "";
  }

  const passwords = new Map<string, string>();
  const rowPattern = /^\| `([^`]+)` \| `([^`]+)` \|$/gm;
  for (const match of accountText.matchAll(rowPattern)) {
    if (match[1] && match[2]) passwords.set(match[1], match[2]);
  }

  for (const account of demoAccounts) {
    if (!passwords.has(account.username)) {
      passwords.set(account.username, randomBytes(24).toString("base64url"));
    }
  }

  const rows = demoAccounts.map(
    (account) =>
      `| \`${account.username}\` | \`${passwords.get(account.username)}\` |`,
  );
  const content = [
    "# Local Demo Accounts",
    "",
    "Development-only credentials for the seeded demo accounts. This file is ignored by Git; never share or commit it.",
    "",
    "| Username | Password |",
    "| --- | --- |",
    ...rows,
    "",
  ].join("\n");
  await writeFile(accountFile, content, { encoding: "utf8", mode: 0o600 });
  return passwords;
}

async function seedDemoData(): Promise<void> {
  const passwords = await loadPasswords();
  const passwordHashes = new Map<string, string>();
  for (const account of demoAccounts) {
    passwordHashes.set(
      account.username,
      await argon2.hash(passwords.get(account.username)!, {
        type: argon2.argon2id,
      }),
    );
  }

  const now = Date.now();
  const communitySeed = demoCommunities.map((community) => ({
    ...community,
    creatorId: officialAccount.id,
    isPublic: true,
    status: "active" as const,
  }));
  const postSeed = demoPosts.map((post) => {
    const authorId = accountIds.get(post.author);
    const communityId = communityIds.get(post.community);
    if (!authorId || !communityId) {
      throw new Error(`Demo post ${post.id} references an unknown fixture.`);
    }
    const {
      author,
      community,
      minutesAgo,
      votes,
      replies: _replies,
      ...content
    } = post;
    return {
      ...content,
      authorId,
      communityId,
      voteCount: votes,
      createdAt: new Date(now - minutesAgo * 60_000),
      updatedAt: new Date(now - minutesAgo * 60_000),
    };
  });
  const replySeed = demoPosts.flatMap((post) => {
    const postCommunityId = communityIds.get(post.community);
    if (!postCommunityId)
      throw new Error(`Unknown community ${post.community}.`);
    return post.replies.map((demoReply, index) => {
      const authorId = accountIds.get(demoReply.author);
      if (!authorId)
        throw new Error(`Unknown reply author ${demoReply.author}.`);
      return {
        ...demoReply,
        postId: post.id,
        authorId,
        createdAt: new Date(
          now - Math.max(post.minutesAgo - index - 1, 0) * 60_000,
        ),
        updatedAt: new Date(
          now - Math.max(post.minutesAgo - index - 1, 0) * 60_000,
        ),
      };
    });
  });

  await database.transaction(async (transaction) => {
    await transaction
      .insert(users)
      .values(demoAccounts.map(({ id }) => ({ id, authSubject: null })))
      .onConflictDoNothing();

    await transaction
      .insert(profiles)
      .values(
        demoAccounts.map((account) => ({
          userId: account.id,
          username: account.username,
          displayName: account.displayName,
          bio: account.bio,
          initials: account.initials,
          avatarColor: account.avatarColor,
          isVerified: account.verified ?? false,
        })),
      )
      .onConflictDoUpdate({
        target: profiles.userId,
        set: {
          username: sql`excluded.username`,
          displayName: sql`excluded.display_name`,
          bio: sql`excluded.bio`,
          initials: sql`excluded.initials`,
          avatarColor: sql`excluded.avatar_color`,
          isVerified: sql`excluded.is_verified`,
          updatedAt: new Date(),
        },
      });

    await transaction
      .insert(userCredentials)
      .values(
        demoAccounts.map((account) => ({
          userId: account.id,
          passwordHash: passwordHashes.get(account.username)!,
        })),
      )
      .onConflictDoUpdate({
        target: userCredentials.userId,
        set: {
          passwordHash: sql`excluded.password_hash`,
          updatedAt: new Date(),
        },
      });

    await transaction
      .insert(communities)
      .values(communitySeed)
      .onConflictDoUpdate({
        target: communities.id,
        set: {
          slug: sql`excluded.slug`,
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          creatorId: sql`excluded.creator_id`,
          isPublic: sql`excluded.is_public`,
          status: sql`excluded.status`,
          updatedAt: new Date(),
        },
      });

    await transaction
      .insert(communityMemberships)
      .values(
        demoCommunities.map((community) => ({
          userId: officialAccount.id,
          communityId: community.id,
          role: "owner" as const,
        })),
      )
      .onConflictDoNothing();

    await transaction
      .insert(communityMemberships)
      .values(
        guestMembershipSlugs.map((slug) => {
          const communityId = communityIds.get(slug);
          if (!communityId) throw new Error(`Unknown guest community ${slug}.`);
          return {
            userId: guestAccount.id,
            communityId,
            role: "member" as const,
          };
        }),
      )
      .onConflictDoNothing();

    await transaction
      .insert(posts)
      .values(postSeed)
      .onConflictDoUpdate({
        target: posts.id,
        set: {
          communityId: sql`excluded.community_id`,
          authorId: sql`excluded.author_id`,
          kind: sql`excluded.kind`,
          body: sql`excluded.body`,
          url: sql`excluded.url`,
          linkTitle: sql`excluded.link_title`,
          linkDescription: sql`excluded.link_description`,
          linkDomain: sql`excluded.link_domain`,
          voteCount: sql`excluded.vote_count`,
          createdAt: sql`excluded.created_at`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
      });

    if (replySeed.length) {
      await transaction
        .insert(replies)
        .values(replySeed)
        .onConflictDoUpdate({
          target: replies.id,
          set: {
            postId: sql`excluded.post_id`,
            parentReplyId: sql`excluded.parent_reply_id`,
            authorId: sql`excluded.author_id`,
            body: sql`excluded.body`,
            createdAt: sql`excluded.created_at`,
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
        });
    }
  });

  console.info(
    `Seeded ${demoAccounts.length} accounts, ${demoCommunities.length} communities, ${demoPosts.length} posts, and ${replySeed.length} replies. Credentials are in the ignored accounts.md file.`,
  );
}

try {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Demo seeding is disabled in production.");
  }
  await seedDemoData();
} finally {
  await pool.end();
}
