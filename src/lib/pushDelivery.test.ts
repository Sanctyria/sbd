import { describe, expect, it } from "vitest";
import {
  isExpiredPushRegistration,
  makeMessage,
} from "./pushDelivery.js";

describe("push delivery message", () => {
  it("recognizes unregistered Firebase installation IDs", () => {
    expect(
      isExpiredPushRegistration({
        code: "messaging/installation-id-not-registered",
      }),
    ).toBe(true);
    expect(
      isExpiredPushRegistration({
        code: "messaging/invalid-argument",
      }),
    ).toBe(false);
  });

  it("targets a Firebase Installation ID", () => {
    const message = makeMessage({
      event_id: "event-id",
      device_id: "device-id",
      fid: "firebase-installation-id",
      notification_id: "notification-id",
      notification_type: "reply",
      entity_id: "post-id",
      payload: { title: "A reply", detail: "New activity" },
      attempts: 0,
    });

    expect(message).toMatchObject({
      fid: "firebase-installation-id",
      data: {
        title: "A reply",
        body: "New activity",
        notificationId: "notification-id",
        deepLink: "https://sanctyria.com/p/post-id",
      },
      apns: {
        payload: {
          aps: {
            alert: { title: "A reply", body: "New activity" },
            category: "community_actions",
          },
        },
      },
    });
    expect(message).not.toHaveProperty("token");
    expect(message).not.toHaveProperty("notification");
    expect(message.android.priority).toBe("high");
  });

  it("identifies replies to a user's reply without claiming the post", () => {
    const message = makeMessage({
      event_id: "event-id",
      device_id: "device-id",
      fid: "firebase-installation-id",
      notification_id: "notification-id",
      notification_type: "reply",
      entity_id: "post-id",
      payload: {
        actorName: "Mira Voss",
        targetKind: "reply",
        preview: "A nested reply",
      },
      attempts: 0,
      post_preview: "Original post context",
      post_author_name: "Tess Ember",
      post_author_username: "tess",
    });

    expect(message.data).toMatchObject({
      title: "Mira Voss replied to your reply",
      body: "A nested reply · In Tess Ember's post: Original post context",
      targetKind: "reply",
      postAuthorName: "Tess Ember",
    });
  });

  it("formats follows as new-follower notifications with profile actions", () => {
    const message = makeMessage({
      event_id: "event-id",
      device_id: "device-id",
      fid: "firebase-installation-id",
      notification_id: "notification-id",
      notification_type: "system",
      entity_id: "follower-id",
      payload: {
        action: "follow",
        actorName: "Mira Voss",
        actorUsername: "mira",
      },
      attempts: 0,
    });

    expect(message.data).toMatchObject({
      title: "Mira Voss started following you",
      body: "@mira followed you.",
      deepLink: "https://sanctyria.com/u/mira",
    });
    expect(message.apns.payload.aps.category).toBeUndefined();
  });

  it("includes media and avatar metadata for rich Android notifications", () => {
    const message = makeMessage({
      event_id: "event-id",
      device_id: "device-id",
      fid: "firebase-installation-id",
      notification_id: "notification-id",
      notification_type: "mention",
      entity_id: "post-id",
      payload: { actorName: "Mira Voss", actorUsername: "mira" },
      attempts: 0,
      actor_avatar_url: "https://cdn.example.test/avatar.png",
      media_url: "https://cdn.example.test/post.png",
      media_kind: "image_url",
      post_preview: "An illustrated community post.",
    });

    expect(message.data).toMatchObject({
      actorAvatarUrl: "https://cdn.example.test/avatar.png",
      mediaUrl: "https://cdn.example.test/post.png",
      postPreview: "An illustrated community post.",
    });
    expect(message.apns.fcmOptions).toEqual({
      imageUrl: "https://cdn.example.test/post.png",
    });
  });
});
