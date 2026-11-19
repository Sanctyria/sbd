import { afterAll, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??=
  "postgres://sanctyria:sanctyria_dev_only@localhost:54329/sanctyria";

const [{ buildApp }, { environment }] = await Promise.all([
  import("./app.js"),
  import("./config/env.js"),
]);
const app = await buildApp(environment);
app.get("/test/internal-error", async () => {
  throw new Error("sensitive database details");
});

afterAll(async () => {
  await app.close();
});

describe("community API", () => {
  it("returns liveness without requiring a database query", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects malformed cursors before querying the database", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/communities?cursor=invalid",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_CURSOR");
  });

  it("rejects malformed global search queries before querying the database", async () => {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/search?query=a" }),
      app.inject({ method: "GET", url: "/api/v1/search?query=" }),
      app.inject({
        method: "GET",
        url: `/api/v1/search?query=${"a".repeat(101)}`,
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      400, 400, 400,
    ]);
    expect(responses.map((response) => response.json().error.code)).toEqual([
      "INVALID_REQUEST",
      "INVALID_REQUEST",
      "INVALID_REQUEST",
    ]);
  });

  it("only accepts HTTPS links for link previews", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/link-preview?url=http%3A%2F%2Fexample.com",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("rejects malformed community member cursors before querying the database", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/communities/worldbuilding/members?cursor=invalid",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_CURSOR");
  });

  it("validates community member mention searches before querying the database", async () => {
    const [invalidPrefix, invalidCursor] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/communities/worldbuilding/members?usernamePrefix=bad%20name",
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/communities/worldbuilding/members?usernamePrefix=mira&cursor=invalid",
      }),
    ]);

    expect(invalidPrefix.statusCode).toBe(400);
    expect(invalidPrefix.json().error.code).toBe("INVALID_REQUEST");
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json().error.code).toBe("INVALID_CURSOR");
  });

  it("validates community-only feed filters and hot-sort cursors", async () => {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/feed?sort=hot" }),
      app.inject({ method: "GET", url: "/api/v1/feed?members=only" }),
      app.inject({
        method: "GET",
        url: "/api/v1/feed?scope=community&community=worldbuilding&sort=hot&cursor=invalid",
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      400, 400, 400,
    ]);
    expect(responses.map((response) => response.json().error.code)).toEqual([
      "INVALID_REQUEST",
      "INVALID_REQUEST",
      "INVALID_CURSOR",
    ]);
  });

  it("rejects malformed post IDs before querying the database", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/posts/not-a-uuid",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("protects chat lists and messages and validates chat cursors", async () => {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/me/chats" }),
      app.inject({
        method: "GET",
        url: "/api/v1/communities/worldbuilding/chat/messages",
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/communities/worldbuilding/chat/messages?cursor=invalid",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/communities/worldbuilding/chat/messages",
        payload: { body: "Hello" },
      }),
      app.inject({
        method: "PATCH",
        url: "/api/v1/communities/worldbuilding/chat/notifications",
        payload: { chatNotificationsEnabled: false },
      }),
      app.inject({
        method: "DELETE",
        url: "/api/v1/communities/worldbuilding/chat/messages/00000000-0000-4000-8000-000000000000",
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      401, 401, 400, 401, 401, 401,
    ]);
    expect(responses[2].json().error.code).toBe("INVALID_CURSOR");
  });

  it("rejects malformed reply cursors before querying the database", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/posts/00000000-0000-4000-8000-000000000000/replies?cursor=invalid",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_CURSOR");
  });

  it("rejects invalid profile activity filters before querying the database", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/miravoss/activity?type=unknown",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("does not expose internal error messages", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/internal-error",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).toBe("An unexpected error occurred.");
    expect(response.body).not.toContain("sensitive database details");
  });

  it("rejects incomplete login requests before accessing the database", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "guest" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("returns only public donation configuration", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/donations/options",
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual([
      "cashAppTag",
      "cryptoWallet",
      "paypal",
      "stripe",
    ]);
  });

  it("serves only the public Turnstile site key to auth forms", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/security-options",
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json())).toEqual(["turnstileSiteKey"]);
    expect(response.body).not.toContain("TURNSTILE_SECRET_KEY");
  });

  it("rejects invalid donation amounts before contacting payment providers", async () => {
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/donations/stripe/checkout",
        payload: { amount: 0 },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/donations/paypal/order",
        payload: { amount: 5_001 },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/donations/paypal/capture",
        payload: { orderId: "../../other-order" },
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      400, 400, 400,
    ]);
    expect(responses.map((response) => response.json().error.code)).toEqual([
      "INVALID_REQUEST",
      "INVALID_REQUEST",
      "INVALID_REQUEST",
    ]);
  });

  it("rejects authentication mutations from untrusted origins", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/session",
      headers: { origin: "https://untrusted.example" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("validates and authenticates push-device registration", async () => {
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/me/push-device",
        payload: { token: "", platform: "windows" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/me/push-device",
        payload: { token: "device-token", platform: "android" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/uploads/signature",
        payload: {
          purpose: "chat-audio",
          communitySlug: "worldbuilding",
        },
      }),
      app.inject({ method: "DELETE", url: "/api/v1/me/push-device" }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      400, 401, 401, 401,
    ]);
    expect(responses.map((response) => response.json().error.code)).toEqual([
      "INVALID_REQUEST",
      "UNAUTHENTICATED",
      "UNAUTHENTICATED",
      "UNAUTHENTICATED",
    ]);
  });

  it("requires a session for the current-user endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/me" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("requires a session for every global Core administration surface", async () => {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/core/overview" }),
      app.inject({ method: "GET", url: "/api/v1/core/users" }),
      app.inject({ method: "GET", url: "/api/v1/core/communities" }),
      app.inject({ method: "GET", url: "/api/v1/core/moderation/reports" }),
      app.inject({ method: "GET", url: "/api/v1/core/marketing/articles" }),
      app.inject({ method: "GET", url: "/api/v1/core/banners" }),
      app.inject({ method: "GET", url: "/api/v1/core/analytics" }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      401, 401, 401, 401, 401, 401, 401,
    ]);
    expect(responses[0]?.headers["cache-control"]).toBe("no-store");
  });

  it("requires a session for Core banner mutations", async () => {
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/core/banners", payload: {} }),
      app.inject({
        method: "PATCH",
        url: "/api/v1/core/banners/order",
        payload: { ids: [] },
      }),
      app.inject({
        method: "DELETE",
        url: "/api/v1/core/banners/00000000-0000-4000-8000-000000000000",
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      401, 401, 401,
    ]);
  });

  it("validates anonymous analytics events before writing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/analytics/pageview",
      payload: { path: "/u/example", campaign: "campaign" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("rejects anonymous analytics events from untrusted origins", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/analytics/pageview",
      headers: { origin: "https://untrusted.example" },
      payload: { path: "/", source: "newsletter", medium: "email" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("rejects participation writes without a session", async () => {
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/posts", payload: {} }),
      app.inject({
        method: "PATCH",
        url: "/api/v1/posts/00000000-0000-4000-8000-000000000000",
        payload: { body: "Updated post" },
      }),
      app.inject({
        method: "DELETE",
        url: "/api/v1/posts/00000000-0000-4000-8000-000000000000",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/posts/00000000-0000-4000-8000-000000000000/replies",
        payload: { body: "A reply" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/posts/00000000-0000-4000-8000-000000000000/replies",
        payload: {
          body: "A nested reply",
          parentReplyId: "00000000-0000-4000-8000-000000000001",
        },
      }),
      app.inject({
        method: "PATCH",
        url: "/api/v1/replies/00000000-0000-4000-8000-000000000000",
        payload: { body: "Updated reply" },
      }),
      app.inject({
        method: "DELETE",
        url: "/api/v1/replies/00000000-0000-4000-8000-000000000000",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/posts/00000000-0000-4000-8000-000000000000/reaction",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/posts/00000000-0000-4000-8000-000000000000/vote",
        payload: { direction: "down" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/replies/00000000-0000-4000-8000-000000000000/reaction",
      }),
      app.inject({
        method: "DELETE",
        url: "/api/v1/replies/00000000-0000-4000-8000-000000000000/reaction",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/posts/00000000-0000-4000-8000-000000000000/bookmark",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/communities/worldbuilding/membership",
      }),
      app.inject({
        method: "PATCH",
        url: "/api/v1/communities/worldbuilding/members/miravoss/role",
        payload: { role: "moderator" },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("validates weekly Ember leaderboard limits before database access", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ember/weekly?limit=11",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("applies the stricter report-submission rate limit before database access", async () => {
    const responses = [];
    for (let requestIndex = 0; requestIndex < 6; requestIndex += 1) {
      responses.push(
        await app.inject({
          method: "POST",
          url: "/api/v1/reports",
          payload: {},
          remoteAddress: "192.0.2.55",
        }),
      );
    }

    expect(
      responses.filter((response) => response.statusCode === 429),
    ).toHaveLength(1);
  });

  it("requires a session for profile and community writes", async () => {
    const responses = await Promise.all([
      app.inject({
        method: "PATCH",
        url: "/api/v1/me/profile",
        payload: { displayName: "Changed Name" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/profiles/miravoss/follow",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/communities",
        payload: { name: "New Circle", description: "A new community." },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/reports",
        payload: {
          targetType: "post",
          targetId: "00000000-0000-4000-8000-000000000000",
          reason: "This looks like spam content.",
        },
      }),
      app.inject({ method: "GET", url: "/api/v1/notifications" }),
      app.inject({ method: "GET", url: "/api/v1/moderation/reports" }),
      app.inject({ method: "GET", url: "/api/v1/moderation/actions" }),
      app.inject({
        method: "PATCH",
        url: "/api/v1/moderation/reports/00000000-0000-4000-8000-000000000000",
        payload: { status: "resolved", reason: "Reviewed and resolved." },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/notifications/read-all",
      }),
      app.inject({ method: "GET", url: "/api/v1/me/bookmarks" }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("rejects participation writes from an untrusted origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/posts/00000000-0000-4000-8000-000000000000/reaction",
      headers: { origin: "https://untrusted.example" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("allows session logout when already signed out", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/session",
    });

    expect(response.statusCode).toBe(204);
  });
});
