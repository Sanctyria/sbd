import { describe, expect, it } from "vitest";
import { communitySlugFromName } from "./communitySlug.js";

describe("communitySlugFromName", () => {
  it("normalizes names into stable URL slugs", () => {
    expect(communitySlugFromName(" The World Builders! ")).toBe("the-world-builders");
    expect(communitySlugFromName("Café & Co.")).toBe("cafe-co");
  });

  it("rejects names with no usable URL characters", () => {
    expect(communitySlugFromName("世界")).toBeNull();
    expect(communitySlugFromName("a".repeat(81))).toBeNull();
  });
});
