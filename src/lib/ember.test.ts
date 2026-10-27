import { describe, expect, it } from "vitest";
import { emberFromReactions } from "./ember.js";

describe("Ember scoring", () => {
  it("uses logarithmic diminishing returns for reactions", () => {
    expect(emberFromReactions(0)).toBe(0);
    expect(emberFromReactions(1)).toBe(6);
    expect(emberFromReactions(10)).toBe(23);
    expect(emberFromReactions(100)).toBe(46);
  });

  it("never awards less for a higher reaction count", () => {
    for (let reactions = 0; reactions < 1_000; reactions += 1) {
      expect(emberFromReactions(reactions + 1)).toBeGreaterThanOrEqual(
        emberFromReactions(reactions),
      );
    }
  });

  it("makes the marginal reward decrease as a post becomes more popular", () => {
    const earlyGain = emberFromReactions(2) - emberFromReactions(1);
    const laterGain = emberFromReactions(100) - emberFromReactions(99);
    expect(earlyGain).toBeGreaterThan(laterGain);
  });

  it("scores posts from net upvotes and downvotes without going below zero", () => {
    expect(emberFromReactions(10, 3)).toBe(20);
    expect(emberFromReactions(3, 10)).toBe(0);
    expect(emberFromReactions(10, 2)).toBeLessThan(emberFromReactions(10));
  });
});
