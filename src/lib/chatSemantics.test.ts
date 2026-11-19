import { describe, expect, it } from "vitest";
import {
  canUseEveryoneMention,
  chatAuthorRole,
  containsEveryoneMention,
} from "./chatSemantics.js";

describe("chat mention semantics", () => {
  it("recognizes @everyone as a standalone mention token", () => {
    expect(containsEveryoneMention("Hello @everyone!")).toBe(true);
    expect(containsEveryoneMention("email@everyone")).toBe(false);
    expect(containsEveryoneMention("@everyone_else")).toBe(false);
  });

  it("allows @everyone only for community creators and owners", () => {
    expect(
      canUseEveryoneMention({
        userId: "creator",
        creatorId: "creator",
        role: "member",
      }),
    ).toBe(true);
    expect(
      canUseEveryoneMention({
        userId: "owner",
        creatorId: "creator",
        role: "owner",
      }),
    ).toBe(true);
    expect(
      canUseEveryoneMention({
        userId: "moderator",
        creatorId: "creator",
        role: "moderator",
      }),
    ).toBe(false);
  });

  it("reports creator, owner, moderator, and member roles correctly", () => {
    expect(
      chatAuthorRole({ userId: "creator", creatorId: "creator", role: "member" }),
    ).toBe("owner");
    expect(
      chatAuthorRole({ userId: "owner", creatorId: "creator", role: "owner" }),
    ).toBe("owner");
    expect(
      chatAuthorRole({
        userId: "moderator",
        creatorId: "creator",
        role: "moderator",
      }),
    ).toBe("moderator");
    expect(
      chatAuthorRole({ userId: "member", creatorId: "creator", role: "member" }),
    ).toBe("member");
  });
});
