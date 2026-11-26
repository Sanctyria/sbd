import { randomBytes, createHash, randomUUID } from "node:crypto";
import argon2 from "argon2";
import { normalizeIP } from "@fastify/rate-limit";
import { and, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  environment,
  getAllowedWebHostnames,
  isAllowedWebOrigin,
  type Environment,
} from "../config/env.js";
import { database } from "../db/client.js";
import {
  communities,
  communityMemberships,
  profiles,
  pushDevices,
  authEmailTokens,
  userEmails,
  userCredentials,
  userSessions,
  users,
} from "../db/schema.js";
import { consumeAuthRateLimit, verifyTurnstile } from "../lib/authSecurity.js";
import { deleteUserAccount } from "../lib/accountDeletion.js";
import {
  AccountEmailDeliveryError,
  AccountEmailUnavailableError,
  sendAccountEmail,
} from "../lib/accountEmail.js";

const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;
const dummyPasswordHash = argon2.hash(randomBytes(32).toString("base64url"), {
  type: argon2.argon2id,
});
const loginSchema = z.object({
  username: z.string().trim().min(3).max(30),
  password: z.string().min(1).max(256),
  turnstileToken: z.string().min(1).max(2048).optional(),
});
const signupSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_-]{2,29}$/),
  displayName: z.string().trim().min(1).max(60),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(256),
  turnstileToken: z.string().min(1).max(2048).optional(),
});
const emailTokenSchema = z.object({ code: z.string().trim().min(32).max(128) });
const passwordResetRequestSchema = z.object({
  email: z.string().trim().email().max(254),
});
const passwordResetSchema = z.object({
  code: z.string().trim().min(32).max(128),
  password: z.string().min(12).max(256),
});
const emailSchema = z.object({ email: z.string().trim().email().max(254) });
const emailTokenLifetimeMs = 20 * 60 * 1000;
const pushDeviceSchema = z.object({
  token: z.string().trim().min(1).max(4096),
  platform: z.enum(["android", "ios"]),
});

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashEmailToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function createEmailToken(
  userId: string,
  purpose: "verify" | "password_reset",
): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await database.transaction(async (transaction) => {
    await transaction
      .delete(authEmailTokens)
      .where(
        and(
          eq(authEmailTokens.userId, userId),
          eq(authEmailTokens.purpose, purpose),
        ),
      );
    await transaction.insert(authEmailTokens).values({
      tokenHash: hashEmailToken(code),
      userId,
      purpose,
      expiresAt: new Date(Date.now() + emailTokenLifetimeMs),
    });
  });
  return code;
}

function emailServiceUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: {
      code: "EMAIL_DELIVERY_UNAVAILABLE",
      message: "Email delivery is temporarily unavailable. Try again later.",
    },
  });
}

function invalidAuthRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_REQUEST", message: "The request is invalid." },
  });
}

async function currentSessionUserId(
  request: FastifyRequest,
  config: Environment,
): Promise<string | null> {
  const sessionToken = request.cookies[config.SESSION_COOKIE_NAME];
  if (!sessionToken) return null;
  const [session] = await database
    .select({ userId: userSessions.userId })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(
      and(
        eq(userSessions.tokenHash, hashSessionToken(sessionToken)),
        gt(userSessions.expiresAt, new Date()),
        isNull(users.deletedAt),
        isNull(users.suspendedAt),
      ),
    )
    .limit(1);
  return session?.userId ?? null;
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
  if (isAllowedWebOrigin(config, origin)) return true;
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
  app.get("/api/v1/auth/security-options", async () => ({
    turnstileSiteKey: config.TURNSTILE_SITE_KEY ?? null,
  }));

  app.post(
    "/api/v1/auth/signup",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 hour",
          keyGenerator: (request) => normalizeIP(request.ip),
        },
      },
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

      if (!config.RESEND_API_KEY || !config.AUTH_EMAIL_FROM) {
        return emailServiceUnavailable(reply);
      }
      const username = parsedBody.data.username;
      if (
        !(await consumeAuthRateLimit(
          "signup",
          [`ip:${normalizeIP(request.ip)}`],
          [10],
          24 * 60 * 60 * 1_000,
        ))
      ) {
        return reply.code(429).send({
          error: {
            code: "RATE_LIMITED",
            message: "Too many account creation attempts. Try again later.",
          },
        });
      }

      const turnstileResult = await verifyTurnstile(
        parsedBody.data.turnstileToken,
        request,
        config.TURNSTILE_SECRET_KEY,
        "signup",
        getAllowedWebHostnames(config),
      );
      if (turnstileResult !== "valid") {
        const unavailable = turnstileResult === "unavailable";
        return reply.code(unavailable ? 503 : 403).send({
          error: {
            code: unavailable
              ? "SECURITY_CHECK_UNAVAILABLE"
              : "SECURITY_CHECK_FAILED",
            message: unavailable
              ? "Security verification is temporarily unavailable."
              : "Complete the security check and try again.",
          },
        });
      }

      const userId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const emailCode = randomBytes(32).toString("base64url");
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
            username,
            displayName: parsedBody.data.displayName,
            initials,
            avatarColor: "#cf6f65",
          });
          await transaction.insert(userCredentials).values({
            userId,
            passwordHash,
          });
          await transaction.insert(userEmails).values({
            userId,
            email: parsedBody.data.email.trim().toLowerCase(),
          });
          await transaction.insert(authEmailTokens).values({
            tokenHash: hashEmailToken(emailCode),
            userId,
            purpose: "verify",
            expiresAt: new Date(Date.now() + emailTokenLifetimeMs),
          });
          await transaction.insert(userSessions).values({
            tokenHash: hashSessionToken(token),
            userId,
            expiresAt,
          });
          return user;
        });

        try {
          await sendAccountEmail(
            config,
            parsedBody.data.email.trim().toLowerCase(),
            "verify",
            emailCode,
          );
        } catch (error) {
          if (
            error instanceof AccountEmailUnavailableError ||
            error instanceof AccountEmailDeliveryError
          ) {
            await database.delete(users).where(eq(users.id, userId));
            return emailServiceUnavailable(reply);
          }
          throw error;
        }

        reply.setCookie(config.SESSION_COOKIE_NAME, token, {
          ...cookieOptions(config),
          expires: expiresAt,
        });
        return reply.code(201).send({
          user: {
            id: createdUser?.id ?? userId,
            username,
            displayName: parsedBody.data.displayName,
            initials,
            avatarColor: "#cf6f65",
            emailVerificationRequired: true,
          },
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505"
        ) {
          if ("constraint" in error && error.constraint === "user_emails_email_uidx") {
            return reply.code(409).send({
              error: {
                code: "EMAIL_ALREADY_IN_USE",
                message: "That email address is already associated with an account.",
              },
            });
          }
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
    "/api/v1/auth/email/verify",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!hasAllowedOrigin(request, reply, config)) return;
      const body = emailTokenSchema.safeParse(request.body);
      if (!body.success) return invalidAuthRequest(reply);
      const [token] = await database
        .select({ userId: authEmailTokens.userId })
        .from(authEmailTokens)
        .where(
          and(
            eq(authEmailTokens.tokenHash, hashEmailToken(body.data.code)),
            eq(authEmailTokens.purpose, "verify"),
            gt(authEmailTokens.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!token) {
        return reply.code(400).send({
          error: {
            code: "EMAIL_CODE_INVALID",
            message: "That verification code is invalid or expired.",
          },
        });
      }
      const verified = await database.transaction(async (transaction) => {
        const [consumed] = await transaction
          .delete(authEmailTokens)
          .where(
            and(
              eq(
                authEmailTokens.tokenHash,
                hashEmailToken(body.data.code),
              ),
              eq(authEmailTokens.purpose, "verify"),
              gt(authEmailTokens.expiresAt, new Date()),
            ),
          )
          .returning({ userId: authEmailTokens.userId });
        if (!consumed) return false;
        await transaction
          .update(userEmails)
          .set({ verifiedAt: new Date(), updatedAt: new Date() })
          .where(eq(userEmails.userId, consumed.userId));
        return true;
      });
      if (!verified) {
        return reply.code(400).send({
          error: {
            code: "EMAIL_CODE_INVALID",
            message: "That verification code is invalid or expired.",
          },
        });
      }
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/auth/password-reset/request",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!hasAllowedOrigin(request, reply, config)) return;
      const body = passwordResetRequestSchema.safeParse(request.body);
      if (!body.success) return invalidAuthRequest(reply);
      const normalizedEmail = body.data.email.trim().toLowerCase();
      if (
        !(await consumeAuthRateLimit(
          "password_reset",
          [
            `ip:${normalizeIP(request.ip)}`,
            `email:${normalizedEmail}`,
          ],
          [5, 3],
          15 * 60 * 1_000,
        ))
      ) {
        return reply.code(429).send({
          error: {
            code: "RATE_LIMITED",
            message: "Too many recovery requests. Try again later.",
          },
        });
      }
      const [account] = await database
        .select({ userId: userEmails.userId })
        .from(userEmails)
        .innerJoin(users, eq(users.id, userEmails.userId))
        .where(
          and(
            sql`lower(${userEmails.email}) = ${normalizedEmail}`,
            isNotNull(userEmails.verifiedAt),
            isNull(users.deletedAt),
            isNull(users.suspendedAt),
          ),
        )
        .limit(1);
      if (account) {
        const code = await createEmailToken(account.userId, "password_reset");
        try {
          await sendAccountEmail(
            config,
            normalizedEmail,
            "password_reset",
            code,
          );
        } catch (error) {
          if (
            error instanceof AccountEmailUnavailableError ||
            error instanceof AccountEmailDeliveryError
          ) {
            return emailServiceUnavailable(reply);
          }
          throw error;
        }
      }
      return reply.code(202).send({
        message:
          "If an account has a verified email with us, a recovery code has been sent.",
      });
    },
  );

  app.post(
    "/api/v1/auth/password-reset/confirm",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!hasAllowedOrigin(request, reply, config)) return;
      const body = passwordResetSchema.safeParse(request.body);
      if (!body.success) return invalidAuthRequest(reply);
      const tokenHash = hashEmailToken(body.data.code);
      const [token] = await database
        .select({ userId: authEmailTokens.userId })
        .from(authEmailTokens)
        .where(
          and(
            eq(authEmailTokens.tokenHash, tokenHash),
            eq(authEmailTokens.purpose, "password_reset"),
            gt(authEmailTokens.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!token) {
        return reply.code(400).send({
          error: {
            code: "PASSWORD_RESET_CODE_INVALID",
            message: "That recovery code is invalid or expired.",
          },
        });
      }
      const passwordHash = await argon2.hash(body.data.password, {
        type: argon2.argon2id,
      });
      const reset = await database.transaction(async (transaction) => {
        const [consumed] = await transaction
          .delete(authEmailTokens)
          .where(
            and(
              eq(authEmailTokens.tokenHash, tokenHash),
              gt(authEmailTokens.expiresAt, new Date()),
            ),
          )
          .returning({ userId: authEmailTokens.userId });
        if (!consumed) return false;
        await transaction
          .update(userCredentials)
          .set({ passwordHash, updatedAt: new Date() })
          .where(eq(userCredentials.userId, consumed.userId));
        await transaction
          .delete(userSessions)
          .where(eq(userSessions.userId, consumed.userId));
        await transaction
          .delete(authEmailTokens)
          .where(eq(authEmailTokens.userId, consumed.userId));
        return true;
      });
      if (!reset) {
        return reply.code(400).send({
          error: {
            code: "PASSWORD_RESET_CODE_INVALID",
            message: "That recovery code is invalid or expired.",
          },
        });
      }
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/auth/login",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "15 minutes",
          keyGenerator: (request) => normalizeIP(request.ip),
        },
      },
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

      const username = parsedBody.data.username.toLowerCase();
      if (
        !(await consumeAuthRateLimit(
          "login",
          [`ip:${normalizeIP(request.ip)}`, `username:${username}`],
          [30, 10],
          15 * 60 * 1_000,
        ))
      ) {
        return reply.code(429).send({
          error: {
            code: "RATE_LIMITED",
            message: "Too many sign-in attempts. Try again later.",
          },
        });
      }

      const turnstileResult = await verifyTurnstile(
        parsedBody.data.turnstileToken,
        request,
        config.TURNSTILE_SECRET_KEY,
        "login",
        getAllowedWebHostnames(config),
      );
      if (turnstileResult !== "valid") {
        const unavailable = turnstileResult === "unavailable";
        return reply.code(unavailable ? 503 : 403).send({
          error: {
            code: unavailable
              ? "SECURITY_CHECK_UNAVAILABLE"
              : "SECURITY_CHECK_FAILED",
            message: unavailable
              ? "Security verification is temporarily unavailable."
              : "Complete the security check and try again.",
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
            eq(profiles.username, username),
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

  app.get("/api/v1/me/email", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const userId = await currentSessionUserId(request, config);
    if (!userId) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });
    }
    const [email] = await database
      .select({
        email: userEmails.email,
        verifiedAt: userEmails.verifiedAt,
      })
      .from(userEmails)
      .where(eq(userEmails.userId, userId))
      .limit(1);
    return {
      email: email?.email ?? null,
      verified: email?.verifiedAt != null,
    };
  });

  app.put(
    "/api/v1/me/email",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!hasAllowedOrigin(request, reply, config)) return;
      const userId = await currentSessionUserId(request, config);
      if (!userId) {
        return reply.code(401).send({
          error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
        });
      }
      if (!config.RESEND_API_KEY || !config.AUTH_EMAIL_FROM) {
        return emailServiceUnavailable(reply);
      }
      const body = emailSchema.safeParse(request.body);
      if (!body.success) return invalidAuthRequest(reply);
      const email = body.data.email.trim().toLowerCase();
      const code = randomBytes(32).toString("base64url");
      try {
        await database.transaction(async (transaction) => {
          await transaction
            .insert(userEmails)
            .values({ userId, email })
            .onConflictDoUpdate({
              target: userEmails.userId,
              set: { email, verifiedAt: null, updatedAt: new Date() },
            });
          await transaction
            .delete(authEmailTokens)
            .where(
              and(
                eq(authEmailTokens.userId, userId),
                eq(authEmailTokens.purpose, "verify"),
              ),
            );
          await transaction.insert(authEmailTokens).values({
            tokenHash: hashEmailToken(code),
            userId,
            purpose: "verify",
            expiresAt: new Date(Date.now() + emailTokenLifetimeMs),
          });
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
              code: "EMAIL_ALREADY_IN_USE",
              message: "That email address is already associated with an account.",
            },
          });
        }
        throw error;
      }
      try {
        await sendAccountEmail(config, email, "verify", code);
      } catch (error) {
        if (
          error instanceof AccountEmailUnavailableError ||
          error instanceof AccountEmailDeliveryError
        ) {
          return emailServiceUnavailable(reply);
        }
        throw error;
      }
      return reply.code(202).send({ message: "Verification code sent." });
    },
  );

  app.post(
    "/api/v1/me/email/verify/resend",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!hasAllowedOrigin(request, reply, config)) return;
      const userId = await currentSessionUserId(request, config);
      if (!userId) {
        return reply.code(401).send({
          error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
        });
      }
      if (!config.RESEND_API_KEY || !config.AUTH_EMAIL_FROM) {
        return emailServiceUnavailable(reply);
      }
      const [email] = await database
        .select({ email: userEmails.email, verifiedAt: userEmails.verifiedAt })
        .from(userEmails)
        .where(eq(userEmails.userId, userId))
        .limit(1);
      if (!email || email.verifiedAt) {
        return reply.code(409).send({
          error: {
            code: "EMAIL_VERIFICATION_NOT_AVAILABLE",
            message: "There is no unverified email address to verify.",
          },
        });
      }
      const code = await createEmailToken(userId, "verify");
      try {
        await sendAccountEmail(config, email.email, "verify", code);
      } catch (error) {
        if (
          error instanceof AccountEmailUnavailableError ||
          error instanceof AccountEmailDeliveryError
        ) {
          return emailServiceUnavailable(reply);
        }
        throw error;
      }
      return reply.code(202).send({ message: "Verification code sent." });
    },
  );

  app.delete("/api/v1/me/account", async (request, reply) => {
    if (!hasAllowedOrigin(request, reply, config)) return;
    reply.header("cache-control", "no-store");
    const userId = await currentSessionUserId(request, config);
    if (!userId) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });
    }

    const result = await deleteUserAccount({
      targetId: userId,
      actorId: userId,
      source: "self",
    });
    if (result === "not-found") {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "The account could not be found." },
      });
    }
    if (result === "invalid-state") {
      return reply.code(409).send({
        error: {
          code: "INVALID_ACCOUNT_STATE",
          message: "The account has already been deleted.",
        },
      });
    }

    reply.clearCookie(config.SESSION_COOKIE_NAME, cookieOptions(config));
    return reply.code(204).send();
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

  app.post("/api/v1/me/push-device", async (request, reply) => {
    if (!hasAllowedOrigin(request, reply, config)) return;
    const body = pushDeviceSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "The request is invalid." },
      });
    }

    const sessionToken = request.cookies[config.SESSION_COOKIE_NAME];
    if (!sessionToken) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });
    }
    const sessionTokenHash = hashSessionToken(sessionToken);
    const [session] = await database
      .select({ userId: userSessions.userId })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(
        and(
          eq(userSessions.tokenHash, sessionTokenHash),
          gt(userSessions.expiresAt, new Date()),
          isNull(users.deletedAt),
          isNull(users.suspendedAt),
        ),
      )
      .limit(1);
    if (!session) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });
    }

    await database.transaction(async (transaction) => {
      await transaction
        .delete(pushDevices)
        .where(
          or(
            eq(pushDevices.sessionTokenHash, sessionTokenHash),
            eq(pushDevices.token, body.data.token),
          ),
        );
      await transaction
        .insert(pushDevices)
        .values({
          userId: session.userId,
          sessionTokenHash,
          token: body.data.token,
          platform: body.data.platform,
        });
    });

    return { registered: true };
  });

  app.delete("/api/v1/me/push-device", async (request, reply) => {
    if (!hasAllowedOrigin(request, reply, config)) return;
    const sessionToken = request.cookies[config.SESSION_COOKIE_NAME];
    if (!sessionToken) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      });
    }
    await database
      .delete(pushDevices)
      .where(
        eq(pushDevices.sessionTokenHash, hashSessionToken(sessionToken)),
      );
    return reply.code(204).send();
  });
}
