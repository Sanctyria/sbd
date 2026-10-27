import { createHash } from "node:crypto";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { environment, type Environment } from "./config/env.js";
import { pool } from "./db/client.js";
import { authRoutes } from "./routes/auth.js";
import { mutationRoutes } from "./routes/mutations.js";
import { publicRoutes } from "./routes/public.js";
import { coreRoutes } from "./routes/core.js";

const SESSION_CLEANUP_BATCH_SIZE = 1_000;
const SESSION_CLEANUP_MAX_BATCHES = 10;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

export async function buildApp(
  config: Environment = environment,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV !== "test",
    bodyLimit: 1_048_576,
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    const errorStatusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const statusCode =
      errorStatusCode >= 400 && errorStatusCode < 500 ? errorStatusCode : 500;
    const code =
      statusCode === 404
        ? "NOT_FOUND"
        : statusCode === 500
          ? "INTERNAL_ERROR"
          : "REQUEST_FAILED";
    const message =
      statusCode === 404
        ? "Route not found."
        : statusCode === 500
          ? "An unexpected error occurred."
          : "The request could not be processed.";

    return reply.code(statusCode).send({ error: { code, message } });
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      const sessionToken = request.cookies[config.SESSION_COOKIE_NAME];
      return sessionToken
        ? createHash("sha256").update(sessionToken).digest("hex")
        : request.ip;
    },
  });
  let cleanupTask: Promise<void> | undefined;
  const cleanupExpiredSessions = async () => {
    let totalDeleted = 0;
    for (let batch = 0; batch < SESSION_CLEANUP_MAX_BATCHES; batch += 1) {
      const result = await pool.query(
        `with expired_sessions as (
          select token_hash
          from user_sessions
          where expires_at <= now()
          limit $1
        )
        delete from user_sessions
        using expired_sessions
        where user_sessions.token_hash = expired_sessions.token_hash`,
        [SESSION_CLEANUP_BATCH_SIZE],
      );
      totalDeleted += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < SESSION_CLEANUP_BATCH_SIZE) break;
    }
    if (totalDeleted > 0) {
      app.log.info({ deletedSessions: totalDeleted }, "Expired sessions removed");
    }
  };
  const runSessionCleanup = () => {
    if (config.NODE_ENV === "test" || cleanupTask) return;
    cleanupTask = cleanupExpiredSessions()
      .catch((error: unknown) => {
        app.log.error({ err: error }, "Expired session cleanup failed");
      })
      .finally(() => {
        cleanupTask = undefined;
      });
  };
  const sessionCleanupTimer =
    config.NODE_ENV === "test"
      ? undefined
      : setInterval(runSessionCleanup, SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer?.unref();
  runSessionCleanup();
  app.addHook("onClose", async () => {
    if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
    await cleanupTask;
    await pool.end();
  });

  app.get("/api/v1/health", async () => ({ status: "ok" }));
  app.get("/api/v1/ready", async (_request, reply) => {
    try {
      await pool.query("select 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Database is not ready.",
        },
      });
    }
  });
  await app.register(async (instance) => authRoutes(instance, config));
  await app.register(mutationRoutes);
  await app.register(publicRoutes);
  await app.register(async (instance) => coreRoutes(instance, config));

  return app;
}
