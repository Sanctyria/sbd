import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

describe("pagination cursor", () => {
  it("round-trips a timestamp and UUID", () => {
    const cursor = {
      createdAt: new Date("2026-01-15T12:30:00.000Z"),
      id: "44444444-4444-4444-8444-444444444444",
    };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects invalid cursors", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor()).toBeUndefined();
  });
});
