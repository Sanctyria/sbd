import { describe, expect, it } from "vitest";

import {
  communityChatNotificationSchema,
  createChatMessageSchema,
  postBodySchema,
  uploadSignatureSchema,
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
    if (result.success) {
      expect(result.data.isNews).toBe(false);
    }
    expect(
      postBodySchema.safeParse({
        community: "worldbuilding",
        kind: "text",
        body: "A community announcement",
        isNews: true,
      }).success,
    ).toBe(true);
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
      {
        community: "worldbuilding",
        kind: "audio_url",
        body: "A community audio clip",
        url: "https://res.cloudinary.com/demo/video/upload/audio.m4a",
      },
      {
        community: "worldbuilding",
        kind: "audio_url",
        body: "An original song",
        url: "https://res.cloudinary.com/demo/video/upload/song.m4a",
        isMusic: true,
      },
      {
        community: "worldbuilding",
        kind: "book_url",
        body: "A short book title",
        url: "https://res.cloudinary.com/demo/raw/upload/book.pdf",
      },
    ]) {
      expect(postBodySchema.safeParse(post).success).toBe(true);
    }
  });

  it("limits music and book titles and only allows music on audio posts", () => {
    const base = {
      community: "worldbuilding",
      kind: "audio_url",
      body: "A song",
      url: "https://res.cloudinary.com/demo/video/upload/song.m4a",
      isMusic: true,
    };
    expect(postBodySchema.safeParse(base).success).toBe(true);
    expect(
      postBodySchema.safeParse({ ...base, body: "x".repeat(81) }).success,
    ).toBe(false);
    expect(
      postBodySchema.safeParse({ ...base, kind: "text" }).success,
    ).toBe(false);
    expect(
      postBodySchema.safeParse({
        ...base,
        kind: "book_url",
        body: "x".repeat(121),
        isMusic: false,
      }).success,
    ).toBe(false);
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

  it("requires a media URL for explicitly typed chat audio", () => {
    expect(
      createChatMessageSchema.safeParse({
        body: "",
        mediaKind: "audio_url",
      }).success,
    ).toBe(false);
    expect(
      createChatMessageSchema.safeParse({
        body: "",
        mediaKind: "audio_url",
        mediaUrl: "https://res.cloudinary.com/demo/video/upload/audio.m4a",
      }).success,
    ).toBe(true);
  });

  it("accepts replies and rich item shares as valid chat messages", () => {
    expect(
      createChatMessageSchema.safeParse({
        body: "Following up",
        replyToId: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(true);
    for (const [sharedItemType, sharedItemId] of [
      ["post", "00000000-0000-4000-8000-000000000002"],
      ["community", "worldbuilding"],
      ["chat", "worldbuilding"],
      ["profile", "mira"],
    ]) {
      expect(
        createChatMessageSchema.safeParse({
          body: "",
          sharedItemType,
          sharedItemId,
        }).success,
      ).toBe(true);
    }
    expect(
      createChatMessageSchema.safeParse({
        body: "extra text",
        sharedItemType: "profile",
        sharedItemId: "mira",
      }).success,
    ).toBe(false);
  });

  it("accepts audio upload purposes only with a community", () => {
    expect(
      uploadSignatureSchema.safeParse({
        purpose: "post-audio",
        communitySlug: "worldbuilding",
        fileName: "My Song.m4a",
      }).success,
    ).toBe(true);
    expect(
      uploadSignatureSchema.safeParse({
        purpose: "post-book",
        communitySlug: "worldbuilding",
      }).success,
    ).toBe(true);
    expect(
      uploadSignatureSchema.safeParse({ purpose: "chat-audio" }).success,
    ).toBe(false);
    expect(
      uploadSignatureSchema.safeParse({
        purpose: "chat-audio",
        communitySlug: "worldbuilding",
      }).success,
    ).toBe(true);
    expect(
      uploadSignatureSchema.safeParse({
        purpose: "post-image",
        communitySlug: "worldbuilding",
        fileName: "not-an-audio-file.jpg",
      }).success,
    ).toBe(false);
  });

  it("validates per-community chat notification settings", () => {
    expect(
      communityChatNotificationSchema.safeParse({
        chatNotificationsEnabled: false,
      }).success,
    ).toBe(true);
    expect(
      communityChatNotificationSchema.safeParse({ enabled: false }).success,
    ).toBe(false);
  });
});
