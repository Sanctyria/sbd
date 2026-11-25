import {
  and,
  asc,
  desc,
  eq,
  ilike,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Environment } from "../../config/env.js";
import { database } from "../../db/client.js";
import {
  communities,
  communityMemberships,
  coreAdminActions,
  profiles,
  userSessions,
  users,
} from "../../db/schema.js";
import { deleteUserAccount } from "../../lib/accountDeletion.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import {
  hasAllowedOrigin,
  invalidCursor,
  invalidRequest,
  listQuerySchema,
  requireAdmin,
} from "./shared.js";

const userParamsSchema = z.object({ id: z.string().uuid() });
const userActionSchema = z.object({
  action: z.enum(["suspend", "reactivate", "delete"]),
  reason: z.string().trim().min(10).max(500),
});

export async function coreUserRoutes(
  app: FastifyInstance,
  config: Environment,
): Promise<void> {
  app.get("/api/v1/core/users", async (request, reply) => {
    if (!(await requireAdmin(request, reply, config))) return;
    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const cursor = decodeCursor(parsedQuery.data.cursor);
    if (cursor === null) return invalidCursor(reply);

    const filters = [];
    if (parsedQuery.data.query) {
      const match = `%${parsedQuery.data.query}%`;
      filters.push(
        or(
          ilike(profiles.username, match),
          ilike(profiles.displayName, match),
        )!,
      );
    }
    if (cursor) {
      filters.push(
        or(
          lt(users.createdAt, cursor.createdAt),
          and(eq(users.createdAt, cursor.createdAt), lt(users.id, cursor.id)),
        )!,
      );
    }

    const rows = await database
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        createdAt: users.createdAt,
        deletedAt: users.deletedAt,
        suspendedAt: users.suspendedAt,
        ember: profiles.ember,
        communityCount: sql<number>`count(distinct ${communityMemberships.communityId})`,
      })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .leftJoin(communityMemberships, eq(communityMemberships.userId, users.id))
      .where(filters.length ? and(...filters) : undefined)
      .groupBy(
        users.id,
        profiles.username,
        profiles.displayName,
        profiles.ember,
      )
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(parsedQuery.data.limit + 1);

    const hasMore = rows.length > parsedQuery.data.limit;
    const items = rows.slice(0, parsedQuery.data.limit);
    const lastItem = items.at(-1);
    return {
      items: items.map((user) => ({
        ...user,
        communityCount: Number(user.communityCount),
        status: user.deletedAt
          ? "deleted"
          : user.suspendedAt
            ? "suspended"
            : "active",
      })),
      nextCursor:
        hasMore && lastItem
          ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
          : null,
    };
  });

  app.patch("/api/v1/core/users/:id", async (request, reply) => {
    const actorId = await requireAdmin(request, reply, config);
    if (!actorId) return;
    if (!hasAllowedOrigin(request, reply, config)) return;
    const parsedParams = userParamsSchema.safeParse(request.params);
    const parsedBody = userActionSchema.safeParse(request.body);
    if (!parsedParams.success || !parsedBody.success)
      return invalidRequest(reply);
    if (
      parsedBody.data.action === "delete" &&
      !config.CORE_SUPER_ADMIN_USER_IDS.includes(actorId)
    ) {
      return reply.code(403).send({
        error: {
          code: "SUPER_ADMIN_REQUIRED",
          message:
            "Only a super administrator can permanently delete accounts.",
        },
      });
    }
    if (parsedParams.data.id === actorId) {
      return reply.code(409).send({
        error: {
          code: "SELF_ACTION_NOT_ALLOWED",
          message:
            "You cannot change or delete your own administrator account.",
        },
      });
    }

    const targetId = parsedParams.data.id;
    const { action, reason } = parsedBody.data;
    if (action === "delete") {
      const result = await deleteUserAccount({
        targetId,
        actorId,
        source: "admin",
        reason,
      });
      if (result === "not-found") {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "The user could not be found." },
        });
      }
      if (result === "invalid-state") {
        return reply.code(409).send({
          error: {
            code: "INVALID_ACCOUNT_STATE",
            message: "The account is not in a valid state for this action.",
          },
        });
      }
      return { success: true, action };
    }

    const mutationResult = await database.transaction(async (transaction) => {
      const [lockedTarget] = await transaction
        .select({
          deletedAt: users.deletedAt,
          suspendedAt: users.suspendedAt,
        })
        .from(users)
        .where(eq(users.id, targetId))
        .for("update")
        .limit(1);
      if (!lockedTarget) return "not-found" as const;
      if (
        lockedTarget.deletedAt ||
        (action === "suspend" && lockedTarget.suspendedAt) ||
        (action === "reactivate" && !lockedTarget.suspendedAt)
      ) {
        return "invalid-state" as const;
      }

      await transaction
        .update(users)
        .set({
          suspendedAt: action === "suspend" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, targetId));
      if (action === "suspend") {
        await transaction
          .delete(userSessions)
          .where(eq(userSessions.userId, targetId));
      }
      await transaction.insert(coreAdminActions).values({
        actorId,
        targetType: "user",
        targetId,
        action,
        details: { reason },
      });
      return "updated" as const;
    });
    if (mutationResult === "not-found") {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "The user could not be found." },
      });
    }
    if (mutationResult === "invalid-state") {
      return reply.code(409).send({
        error: {
          code: "INVALID_ACCOUNT_STATE",
          message: "The account is not in a valid state for this action.",
        },
      });
    }
    return { success: true, action };
  });
}
