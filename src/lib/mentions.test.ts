import { describe, expect, it } from "vitest";
import { extractMentionUsernames } from "./mentions.js";

describe("mention usernames", () => {
  it("normalizes usernames and removes duplicate mentions", () => {
    expect(extractMentionUsernames("Thanks @MiraVoss, and @miravoss for the map.")).toEqual([
      "miravoss",
    ]);
  });

  it("matches mention tokens rather than email addresses or embedded handles", () => {
    expect(extractMentionUsernames("mail@miravoss.example path/@tarinhale @eli-rowan")).toEqual([
      "eli-rowan",
    ]);
  });

  it("accepts mentions at the start of content and after opening punctuation", () => {
    expect(extractMentionUsernames("@MiraVoss (cc @EliRowan) also @a")).toEqual([
      "miravoss",
      "elirowan",
    ]);
  });
});