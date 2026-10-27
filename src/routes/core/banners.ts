import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Environment } from "../../config/env.js";
import { database } from "../../db/client.js";
import { communityBanners, coreAdminActions } from "../../db/schema.js";
import { hasAllowedOrigin, invalidRequest, requireAdmin } from "./shared.js";

const imageSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => {
    if (value.startsWith("/") && !value.startsWith("//")) return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });

const bannerSchema = z.object({
  eyebrow: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(500),
  action: z.string().trim().min(1).max(80),
  href: z
    .string()
    .trim()
    .min(2)
    .max(500)
    .regex(/^\/(?!\/)[^\s\\]*$/),
  image: imageSchema,
  imageAlt: z.string().trim().max(300),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

const idParamsSchema = z.object({ id: z.string().uuid() });
const orderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export async function coreBannerRoutes(
  app: FastifyInstance,
  config: Environment,
): Promise<void> {
  app.get("/api/v1/core/banners", async (request, reply) => {
    if (!(await requireAdmin(request, reply, config))) return;
    return database
      .select()
      .from(communityBanners)
      .orderBy(
        asc(communityBanners.sortOrder),
        asc(communityBanners.createdAt),
      );
  });

  app.post("/api/v1/core/banners", async (request, reply) => {
    const actorId = await requireAdmin(request, reply, config);
    if (!actorId) return;
    if (!hasAllowedOrigin(request, reply, config)) return;
    const parsedBody = bannerSchema.safeParse(request.body);
    if (!parsedBody.success) return invalidRequest(reply);

    const created = await database.transaction(async (transaction) => {
      const [orderRow] = await transaction
        .select({
          nextOrder: sql<number>`coalesce(max(${communityBanners.sortOrder}) + 1, 0)`,
        })
        .from(communityBanners);
      const [banner] = await transaction
        .insert(communityBanners)
        .values({ ...parsedBody.data, sortOrder: orderRow?.nextOrder ?? 0 })
        .returning();
      if (!banner) return null;
      await transaction.insert(coreAdminActions).values({
        actorId,
        targetType: "community_banner",
        targetId: banner.id,
        action: "create",
        details: { title: banner.title, sortOrder: banner.sortOrder },
      });
      return banner;
    });
    if (!created) {
      return reply.code(500).send({
        error: {
          code: "SAVE_FAILED",
          message: "The banner could not be created.",
        },
      });
    }
    return reply.code(201).send({ banner: created });
  });

  app.put("/api/v1/core/banners/:id", async (request, reply) => {
    const actorId = await requireAdmin(request, reply, config);
    if (!actorId) return;
    if (!hasAllowedOrigin(request, reply, config)) return;
    const parsedParams = idParamsSchema.safeParse(request.params);
    const parsedBody = bannerSchema.safeParse(request.body);
    if (!parsedParams.success || !parsedBody.success)
      return invalidRequest(reply);

    const updated = await database.transaction(async (transaction) => {
      const [banner] = await transaction
        .update(communityBanners)
        .set({ ...parsedBody.data, updatedAt: new Date() })
        .where(eq(communityBanners.id, parsedParams.data.id))
        .returning();
      if (!banner) return null;
      await transaction.insert(coreAdminActions).values({
        actorId,
        targetType: "community_banner",
        targetId: banner.id,
        action: "update",
        details: { title: banner.title, sortOrder: banner.sortOrder },
      });
      return banner;
    });
    if (!updated) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "The banner could not be found." },
      });
    }
    return { banner: updated };
  });

  app.patch("/api/v1/core/banners/order", async (request, reply) => {
    const actorId = await requireAdmin(request, reply, config);
    if (!actorId) return;
    if (!hasAllowedOrigin(request, reply, config)) return;
    const parsedBody = orderSchema.safeParse(request.body);
    if (
      !parsedBody.success ||
      new Set(parsedBody.data.ids).size !== parsedBody.data.ids.length
    ) {
      return invalidRequest(reply);
    }

    const updated = await database.transaction(async (transaction) => {
      const current = await transaction
        .select({ id: communityBanners.id })
        .from(communityBanners)
        .orderBy(
          asc(communityBanners.sortOrder),
          asc(communityBanners.createdAt),
        );
      if (
        current.length !== parsedBody.data.ids.length ||
        current.some((banner) => !parsedBody.data.ids.includes(banner.id))
      ) {
        return false;
      }
      for (const [sortOrder, id] of parsedBody.data.ids.entries()) {
        await transaction
          .update(communityBanners)
          .set({ sortOrder, updatedAt: new Date() })
          .where(eq(communityBanners.id, id));
      }
      await transaction.insert(coreAdminActions).values({
        actorId,
        targetType: "community_banner",
        targetId: parsedBody.data.ids[0]!,
        action: "reorder",
        details: { count: parsedBody.data.ids.length },
      });
      return true;
    });
    if (!updated) {
      return reply.code(409).send({
        error: {
          code: "ORDER_CHANGED",
          message: "The banner list changed. Refresh and try again.",
        },
      });
    }
    return reply.code(204).send();
  });

  app.delete("/api/v1/core/banners/:id", async (request, reply) => {
    const actorId = await requireAdmin(request, reply, config);
    if (!actorId) return;
    if (!hasAllowedOrigin(request, reply, config)) return;
    const parsedParams = idParamsSchema.safeParse(request.params);
    if (!parsedParams.success) return invalidRequest(reply);

    const deleted = await database.transaction(async (transaction) => {
      const [banner] = await transaction
        .delete(communityBanners)
        .where(eq(communityBanners.id, parsedParams.data.id))
        .returning({ id: communityBanners.id, title: communityBanners.title });
      if (!banner) return null;
      await transaction.insert(coreAdminActions).values({
        actorId,
        targetType: "community_banner",
        targetId: banner.id,
        action: "delete",
        details: { title: banner.title },
      });
      return banner;
    });
    if (!deleted) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "The banner could not be found." },
      });
    }
    return reply.code(204).send();
  });
}
