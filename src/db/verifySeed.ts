import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import argon2 from "argon2";
import { inArray } from "drizzle-orm";
import { database, pool } from "./client.js";
import { demoAccounts, demoCommunities, demoPosts } from "./demoData.js";
import {
  communities,
  communityMemberships,
  posts,
  profiles,
  replies,
  userCredentials,
} from "./schema.js";

async function verifySeed(): Promise<void> {
  const accountFile = await readFile(resolve(process.cwd(), "accounts.md"), "utf8");
  const passwords = new Map<string, string>();
  for (const match of accountFile.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gm)) {
    if (match[1] && match[2]) passwords.set(match[1], match[2]);
  }

  const profileRows = await database
    .select({ userId: profiles.userId, username: profiles.username })
    .from(profiles)
    .where(inArray(profiles.userId, demoAccounts.map((account) => account.id)));
  const credentialRows = await database
    .select({ userId: userCredentials.userId, passwordHash: userCredentials.passwordHash })
    .from(userCredentials)
    .where(inArray(userCredentials.userId, demoAccounts.map((account) => account.id)));
  const communityRows = await database
    .select({ slug: communities.slug })
    .from(communities)
    .where(inArray(communities.id, demoCommunities.map((community) => community.id)));
  const postRows = await database
    .select({ id: posts.id })
    .from(posts)
    .where(inArray(posts.id, demoPosts.map((post) => post.id)));
  const replyIds = demoPosts.flatMap((post) => post.replies.map((reply) => reply.id));
  const replyRows = replyIds.length
    ? await database.select({ id: replies.id }).from(replies).where(inArray(replies.id, replyIds))
    : [];
  const membershipRows = await database
    .select({ communityId: communityMemberships.communityId })
    .from(communityMemberships)
    .where(inArray(communityMemberships.userId, demoAccounts.map((account) => account.id)));

  const credentialByUserId = new Map(
    credentialRows.map((credential) => [credential.userId, credential.passwordHash]),
  );
  for (const account of demoAccounts) {
    const password = passwords.get(account.username);
    const passwordHash = credentialByUserId.get(account.id);
    if (!password || !passwordHash || !(await argon2.verify(passwordHash, password))) {
      throw new Error(`Seed credential verification failed for ${account.username}.`);
    }
  }

  const expectedReplyCount = replyIds.length;
  const counts = {
    accounts: profileRows.length,
    communities: communityRows.length,
    posts: postRows.length,
    replies: replyRows.length,
    memberships: membershipRows.length,
  };
  if (
    counts.accounts !== demoAccounts.length ||
    counts.communities !== demoCommunities.length ||
    counts.posts !== demoPosts.length ||
    counts.replies !== expectedReplyCount
  ) {
    throw new Error(`Seed count verification failed: ${JSON.stringify(counts)}`);
  }

  console.info("Seed verified:", JSON.stringify(counts));
  console.info("All generated demo passwords match their stored Argon2id hashes.");
}

try {
  await verifySeed();
} finally {
  await pool.end();
}