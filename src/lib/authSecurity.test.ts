import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:54329/sanctyria";

const { verifyStripeSignature } = await import("./authSecurity.js");

describe("Stripe webhook signature verification", () => {
  const secret = "whsec_test_secret";
  const timestamp = 1_800_000_000;
  const payload = Buffer.from(
    '{"id":"evt_test","type":"checkout.session.completed"}',
  );
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest("hex");
  const signature = `t=${timestamp},v1=${digest}`;

  it("accepts a matching signature within the timestamp tolerance", () => {
    expect(
      verifyStripeSignature(payload, signature, secret, timestamp + 10),
    ).toBe(true);
  });

  it("rejects a changed payload", () => {
    expect(
      verifyStripeSignature(
        Buffer.from(`${payload.toString()} `),
        signature,
        secret,
        timestamp + 10,
      ),
    ).toBe(false);
  });

  it("rejects missing, malformed, and stale signatures", () => {
    expect(verifyStripeSignature(payload, undefined, secret, timestamp)).toBe(
      false,
    );
    expect(verifyStripeSignature(payload, "t=not-a-time,v1=bad", secret)).toBe(
      false,
    );
    expect(
      verifyStripeSignature(payload, signature, secret, timestamp + 301),
    ).toBe(false);
  });
});
