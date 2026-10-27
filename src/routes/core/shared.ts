import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Environment } from "../../config/env.js";
import { database } from "../../db/client.js";
import { userSessions, users } from "../../db/schema.js";

export const listQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  query: z.string().trim().max(100).default(""),
});

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Environment,
): Promise<string | null> {
  reply.header("cache-control", "no-store");
  const token = request.cookies[config.SESSION_COOKIE_NAME];
  if (!token) {
    reply.code(401).send({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
    return null;
  }

  const [session] = await database
    .select({ userId: userSessions.userId })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(
      and(
        eq(userSessions.tokenHash, hashSessionToken(token)),
        gt(userSessions.expiresAt, new Date()),
        isNull(users.deletedAt),
        isNull(users.suspendedAt),
      ),
    )
    .limit(1);

  if (!session) {
    reply.code(401).send({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
    return null;
  }
  if (!config.CORE_ADMIN_USER_IDS.includes(session.userId)) {
    reply.code(403).send({
      error: {
        code: "FORBIDDEN",
        message: "Global administrator access is required.",
      },
    });
    return null;
  }
  return session.userId;
}

export function hasAllowedOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Environment,
): boolean {
  const origin = request.headers.origin;
  if (!origin || origin === config.WEB_ORIGIN) return true;
  reply.code(403).send({
    error: {
      code: "ORIGIN_NOT_ALLOWED",
      message: "Request origin is not allowed.",
    },
  });
  return false;
}

export function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_REQUEST", message: "The request is invalid." },
  });
}

export function invalidCursor(reply: FastifyReply) {
  return reply.code(400).send({
    error: {
      code: "INVALID_CURSOR",
      message: "The pagination cursor is invalid.",
    },
  });
}
