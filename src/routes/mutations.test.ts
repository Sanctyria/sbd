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

  it("accepts audio upload purposes only with a community", () => {
    expect(
      uploadSignatureSchema.safeParse({
        purpose: "post-audio",
        communitySlug: "worldbuilding",
        fileName: "My Song.m4a",
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
