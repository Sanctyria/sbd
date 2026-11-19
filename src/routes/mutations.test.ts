import { describe, expect, it } from "vitest";

import {
  createChatMessageSchema,
  postBodySchema,
} from "./mutations.js";

describe("community mutation request schemas", () => {
  it("accepts the Flutter text-post payload with a nullable URL", () => {
    const result = postBodySchema.safeParse({
      community: "worldbuilding",
      kind: "text",
      body: "A text post",
      url: null,
    });

    expect(result.success).toBe(true);
  });

  it("accepts links and uploaded media post URLs", () => {
    for (const post of [
      {
        community: "worldbuilding",
        kind: "link",
        body: "A useful link",
        url: "https://example.test/article",
      },
      {
        community: "worldbuilding",
        kind: "image_url",
        body: "A community photo",
        url: "https://cdn.example.test/photo.jpg",
      },
      {
        community: "worldbuilding",
        kind: "video_url",
        body: "A community video",
        url: "https://cdn.example.test/video.mp4",
      },
    ]) {
      expect(postBodySchema.safeParse(post).success).toBe(true);
    }
  });

  it("accepts text-only and image-only channel messages", () => {
    expect(
      createChatMessageSchema.safeParse({ body: "Hello!" }).success,
    ).toBe(true);
    expect(
      createChatMessageSchema.safeParse({
        body: "",
        mediaUrl: "https://cdn.example.test/photo.jpg",
      }).success,
    ).toBe(true);
  });
});
