import { describe, expect, it } from "vitest";
import {
  demoAccounts,
  demoCommunities,
  demoPosts,
  guestMembershipSlugs,
} from "./demoData.js";

describe("community demo fixtures", () => {
  it("includes each demo author and reply author exactly once", () => {
    const usernames = demoAccounts.map((account) => account.username);
    const referencedUsernames = new Set(
      demoPosts.flatMap((post) => [
        post.author,
        ...post.replies.map((reply) => reply.author),
      ]),
    );

    expect(usernames).toHaveLength(9);
    expect(new Set(usernames).size).toBe(usernames.length);
    expect(
      [...referencedUsernames].every((username) =>
        usernames.includes(username),
      ),
    ).toBe(true);
    expect(usernames).toContain("sanctyria-guest");
  });

  it("contains every public community and each demo post", () => {
    const slugs = demoCommunities.map((community) => community.slug);
    expect(slugs).toEqual([
      "worldbuilding",
      "the-archive",
      "writing-room",
      "visual-studies",
      "studio-notes",
    ]);
    expect(demoPosts).toHaveLength(6);
    expect(demoPosts.every((post) => slugs.includes(post.community))).toBe(
      true,
    );
    expect(
      demoPosts.reduce((total, post) => total + post.replies.length, 0),
    ).toBe(2);
    expect(guestMembershipSlugs).toEqual(["worldbuilding", "visual-studies"]);
  });
});
