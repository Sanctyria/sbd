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
      notification: { title: "A reply", body: "New activity" },
      data: {
        notificationId: "notification-id",
        deepLink: "https://sanctyria.com/p/post-id",
      },
    });
    expect(message).not.toHaveProperty("token");
  });
});
