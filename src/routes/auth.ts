import { randomBytes, createHash, randomUUID } from "node:crypto";
import argon2 from "argon2";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { environment, type Environment } from "../config/env.js";
import { database } from "../db/client.js";
import {
  communities,
  communityMemberships,
  profiles,
  userCredentials,
  userSessions,
  users,
} from "../db/schema.js";

const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;
const dummyPasswordHash = argon2.hash(randomBytes(32).toString("base64url"), {
  type: argon2.argon2id,
});
const loginSchema = z.object({
  username: z.string().trim().min(3).max(30),
  password: z.string().min(1).max(256),
});
const signupSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_-]{2,29}$/),
  displayName: z.string().trim().min(1).max(60),
  password: z.string().min(12).max(256),
});

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookieOptions(config: Environment) {
  return {
    httpOnly: true,
    secure:
      config.SESSION_COOKIE_SECURE === "true" ||
      (config.SESSION_COOKIE_SECURE !== "false" &&
        config.NODE_ENV === "production"),
    sameSite: "lax" as const,
    path: "/",
  };
}

function hasAllowedOrigin(
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

export async function authRoutes(
  app: FastifyInstance,
  config: Environment = environment,
): Promise<void> {
  app.post(
    "/api/v1/auth/signup",
    {
      config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!hasAllowedOrigin(request, reply, config)) return;

      const parsedBody = signupSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message:
              "Choose a 3-30 character username, display name, and password with at least 12 characters.",
          },
        });
      }

      const userId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + sessionDurationMs);
      const passwordHash = await argon2.hash(parsedBody.data.password, {
        type: argon2.argon2id,
      });
      const initials = parsedBody.data.displayName
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("");

      try {
        const createdUser = await database.transaction(async (transaction) => {
          const [user] = await transaction
            .insert(users)
            .values({ id: userId })
            .returning({ id: users.id });
          await transaction.insert(profiles).values({
            userId,
            username: parsedBody.data.username,
            displayName: parsedBody.data.displayName,
            initials,
            avatarColor: "#cf6f65",
          });
          await transaction.insert(userCredentials).values({
            userId,
            passwordHash,
          });
          await transaction.insert(userSessions).values({
            tokenHash: hashSessionToken(token),
            userId,
            expiresAt,
          });
          return user;
        });

        reply.setCookie(config.SESSION_COOKIE_NAME, token, {
          ...cookieOptions(config),
          expires: expiresAt,
        });
        return reply.code(201).send({
          user: {
            id: createdUser?.id ?? userId,
            username: parsedBody.data.username,
            displayName: parsedBody.data.displayName,
            initials,
            avatarColor: "#cf6f65",
          },
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505"
        ) {
          return reply.code(409).send({
            error: {
              code: "USERNAME_TAKEN",
              message: "That username is already in use.",
            },
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/auth/login",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!hasAllowedOrigin(request, reply, config)) return;
      const parsedBody = loginSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "Enter a username and password.",
          },
        });
      }

      const [account] = await database
        .select({
          id: users.id,
          passwordHash: userCredentials.passwordHash,
          username: profiles.username,
          displayName: profiles.displayName,
          avatarUrl: profiles.avatarUrl,
          avatarVersion: profiles.avatarVersion,
        })
        .from(profiles)
        .innerJoin(users, eq(users.id, profiles.userId))
        .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
        .where(
          and(
            eq(profiles.username, parsedBody.data.username.toLowerCase()),
            isNull(users.deletedAt),
            isNull(users.suspendedAt),
          ),
        )
        .limit(1);

      const passwordHash = account?.passwordHash ?? (await dummyPasswordHash);
      const passwordValid = await argon2.verify(
        passwordHash,
        parsedBody.data.password,
      );
      if (!account || !passwordValid) {
        return reply.code(401).send({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Username or password is incorrect.",
          },
        });
      }

      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + sessionDurationMs);
      await database.insert(userSessions).values({
        tokenHash: hashSessionToken(token),
        userId: account.id,
        expiresAt,
      });

      reply.setCookie(config.SESSION_COOKIE_NAME, token, {
        ...cookieOptions(config),
        expires: expiresAt,
      });
      return {
        user: {
          id: account.id,
          username: account.username,
          displayName: account.displayName,
          avatarUrl: account.avatarUrl,
          avatarVersion: account.avatarVersion,
        },
      };
    },
  );

  app.get("/api/v1/me", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    if (!token) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });
    }

    const [account] = await database
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        bio: profiles.bio,
        avatarUrl: profiles.avatarUrl,
        avatarVersion: profiles.avatarVersion,
        initials: profiles.initials,
        avatarColor: profiles.avatarColor,
        ember: profiles.ember,
      })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(
        and(
          eq(userSessions.tokenHash, hashSessionToken(token)),
          gt(userSessions.expiresAt, new Date()),
          isNull(users.deletedAt),
          isNull(users.suspendedAt),
        ),
      )
      .limit(1);

    if (!account) {
      reply.clearCookie(config.SESSION_COOKIE_NAME, cookieOptions(config));
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });
    }

    const joinedCommunities = await database
      .select({
        slug: communities.slug,
        name: communities.name,
        role: communityMemberships.role,
      })
      .from(communityMemberships)
      .innerJoin(
        communities,
        eq(communities.id, communityMemberships.communityId),
      )
      .where(
        and(
          eq(communityMemberships.userId, account.id),
          eq(communities.isPublic, true),
          eq(communities.status, "active"),
        ),
      );

    return {
      user: {
        ...account,
        isAdmin: config.CORE_ADMIN_USER_IDS.includes(account.id),
        isSuperAdmin: config.CORE_SUPER_ADMIN_USER_IDS.includes(account.id),
        communities: joinedCommunities,
      },
    };
  });

  app.delete("/api/v1/auth/session", async (request, reply) => {
    if (!hasAllowedOrigin(request, reply, config)) return;
    reply.header("cache-control", "no-store");
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    if (token) {
      await database
        .delete(userSessions)
        .where(eq(userSessions.tokenHash, hashSessionToken(token)));
    }
    reply.clearCookie(config.SESSION_COOKIE_NAME, cookieOptions(config));
    return reply.code(204).send();
  });
}
