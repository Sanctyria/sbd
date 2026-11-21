import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { database } from "../db/client.js";
import { authRateLimits } from "../db/schema.js";

const authRateLimitWindowMs = 24 * 60 * 60 * 1_000;

export async function consumeAuthRateLimit(
  action: "signup" | "login" | "password_reset" | "email_verify",
  buckets: string[],
  limits: number[],
  windowMs: number,
): Promise<boolean> {
  const now = new Date();
  const expiredBefore = new Date(now.getTime() - windowMs);
  const rows = buckets.map((bucket) => ({
    action,
    bucketHash: createHash("sha256").update(bucket).digest("hex"),
    attemptCount: 1,
    windowStartedAt: now,
  }));
  const counts = await database.transaction(async (transaction) =>
    Promise.all(
      rows.map(async (row) => {
        const [result] = await transaction
          .insert(authRateLimits)
          .values(row)
          .onConflictDoUpdate({
            target: [authRateLimits.action, authRateLimits.bucketHash],
            set: {
              attemptCount: sql`case when ${authRateLimits.windowStartedAt} <= ${expiredBefore} then 1 else ${authRateLimits.attemptCount} + 1 end`,
              windowStartedAt: sql`case when ${authRateLimits.windowStartedAt} <= ${expiredBefore} then ${now} else ${authRateLimits.windowStartedAt} end`,
            },
          })
          .returning({ attemptCount: authRateLimits.attemptCount });
        return result?.attemptCount ?? Number.POSITIVE_INFINITY;
      }),
    ),
  );
  return counts.every((count, index) => count <= (limits[index] ?? 0));
}

export async function verifyTurnstile(
  token: string | undefined,
  request: FastifyRequest,
  secretKey: string | undefined,
  expectedAction: "signup" | "login",
  expectedHostname: string,
): Promise<"valid" | "missing" | "invalid" | "unavailable"> {
  if (!secretKey) return "valid";
  if (!token) return "missing";

  let response: Response;
  try {
    response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: secretKey,
          response: token,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch (error) {
    request.log.error({ err: error }, "Turnstile verification request failed");
    return "unavailable";
  }
  if (!response.ok) {
    request.log.error(
      { statusCode: response.status },
      "Turnstile verification returned an unsuccessful response",
    );
    return "unavailable";
  }

  const result = (await response.json().catch((error: unknown) => {
    request.log.error({ err: error }, "Turnstile response was not valid JSON");
    return null;
  })) as {
    success?: boolean;
    action?: string;
    hostname?: string;
  } | null;
  if (!result?.success) return "invalid";
  if (
    result.action !== expectedAction ||
    result.hostname !== expectedHostname
  ) {
    return "invalid";
  }
  return "valid";
}

export function verifyStripeSignature(
  payload: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  if (!signatureHeader) return false;
  const entries = signatureHeader.split(",").map((part) => part.split("=", 2));
  const timestamp = entries.find(([key]) => key === "t")?.[1];
  const signatures = entries
    .filter(([key, value]) => key === "v1" && value)
    .map(([, value]) => value as string);
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > 300
  ) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest();
  return signatures.some((signature) => {
    if (!/^[\da-f]{64}$/i.test(signature)) return false;
    const candidate = Buffer.from(signature, "hex");
    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    );
  });
}

export async function pruneAuthRateLimits(): Promise<void> {
  const cutoff = new Date(Date.now() - authRateLimitWindowMs);
  await database
    .delete(authRateLimits)
    .where(lt(authRateLimits.windowStartedAt, cutoff));
}
