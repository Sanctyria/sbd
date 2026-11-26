import { createHmac } from "node:crypto";
import Fastify from "fastify";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:54329/sanctyria";

const { verifyStripeSignature, verifyTurnstile } = await import(
  "./authSecurity.js"
);
const app = Fastify({ logger: false });

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("Turnstile hostname verification", () => {
  it("accepts a hostname from the allowed web origins", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            action: "signup",
            hostname: "sanctity.sanctyria.com",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      verifyTurnstile(
        "test-token",
        { log: app.log },
        "test-secret",
        "signup",
        ["sanctyria.com", "sanctity.sanctyria.com"],
      ),
    ).resolves.toBe("valid");
  });

  it("rejects a hostname outside the allowed web origins", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            action: "signup",
            hostname: "unrelated.example",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      verifyTurnstile(
        "test-token",
        { log: app.log },
        "test-secret",
        "signup",
        ["sanctyria.com", "sanctity.sanctyria.com"],
      ),
    ).resolves.toBe("invalid");
  });
});
