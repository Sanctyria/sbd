import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Environment } from "../../config/env.js";
import { database } from "../../db/client.js";
import { coreAdminActions, marketingArticles } from "../../db/schema.js";
import { hasAllowedOrigin, invalidRequest, requireAdmin } from "./shared.js";

const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });
const articleSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  title: z.string().trim().min(1).max(160),
  dek: z.string().trim().min(1).max(500),
  category: z.string().trim().min(1).max(80),
  date: z.string().trim().min(1).max(40),
  readTime: z.string().trim().min(1).max(40),
  image: httpsUrlSchema,
  imageAlt: z.string().trim().max(300),
  imageNote: z.string().trim().max(200),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().max(160).optional(),
        paragraphs: z
          .array(z.string().trim().min(1).max(10_000))
          .min(1)
          .max(20),
      }),
    )
    .min(1)
    .max(30),
  pullQuote: z.string().trim().min(1).max(500),
  isPublished: z.boolean(),
});
const publicListQuerySchema = z.object({
  known: z
    .string()
    .max(2_000)
    .optional()
    .transform((value) => value?.split(",").filter(Boolean) ?? [])
    .pipe(
      z
        .array(
          z
            .string()
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
            .max(100),
        )
        .max(20),
    ),
});
const bundledJournalSlugs = new Set([
  "the-flame-that-remembers",
  "eight-nations-one-sky",
  "finding-the-sound-of-sanctyria",
]);

export async function coreMarketingRoutes(
  app: FastifyInstance,
  config: Environment,
): Promise<void> {
  app.get("/api/v1/marketing/articles", async (request, reply) => {
    const parsedQuery = publicListQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply);
    const knownBundledSlugs = parsedQuery.data.known.filter((slug) =>
      bundledJournalSlugs.has(slug),
    );
    const [items, hiddenArticles] = await Promise.all([
      database
        .select({
          slug: marketingArticles.slug,
          title: marketingArticles.title,
          dek: marketingArticles.dek,
          category: marketingArticles.category,
          date: marketingArticles.date,
          readTime: marketingArticles.readTime,
          image: marketingArticles.image,
          imageAlt: marketingArticles.imageAlt,
          imageNote: marketingArticles.imageNote,
          sections: marketingArticles.sections,
          pullQuote: marketingArticles.pullQuote,
          publishedAt: marketingArticles.publishedAt,
        })
        .from(marketingArticles)
        .where(eq(marketingArticles.isPublished, true))
        .orderBy(desc(marketingArticles.publishedAt)),
      database
        .select({ slug: marketingArticles.slug })
        .from(marketingArticles)
        .where(
          and(
            eq(marketingArticles.isPublished, false),
            knownBundledSlugs.length
              ? inArray(marketingArticles.slug, knownBundledSlugs)
              : sql`false`,
          ),
        ),
    ]);
    return {
      items,
      hiddenSlugs: hiddenArticles.map((article) => article.slug),
    };
  });

  app.get("/api/v1/marketing/articles/:slug", async (request, reply) => {
    const parsedParams = z
      .object({
        slug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(100),
      })
      .safeParse(request.params);
    if (!parsedParams.success) return invalidRequest(reply);
    const [article] = await database
      .select({
        slug: marketingArticles.slug,
        title: marketingArticles.title,
        dek: marketingArticles.dek,
        category: marketingArticles.category,
        date: marketingArticles.date,
        readTime: marketingArticles.readTime,
        image: marketingArticles.image,
        imageAlt: marketingArticles.imageAlt,
        imageNote: marketingArticles.imageNote,
        sections: marketingArticles.sections,
        pullQuote: marketingArticles.pullQuote,
        isPublished: marketingArticles.isPublished,
      })
      .from(marketingArticles)
      .where(eq(marketingArticles.slug, parsedParams.data.slug))
      .limit(1);
    if (!article) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "Article not found." },
      });
    }
    if (!article.isPublished) {
      return reply.code(410).send({
        error: { code: "NOT_FOUND", message: "Article not found." },
      });
    }
    const { isPublished: _isPublished, ...publishedArticle } = article;
    return publishedArticle;
  });

  app.get("/api/v1/core/marketing/articles", async (request, reply) => {
    if (!(await requireAdmin(request, reply, config))) return;
    return database
      .select()
      .from(marketingArticles)
      .orderBy(desc(marketingArticles.updatedAt), desc(marketingArticles.id))
      .limit(200);
  });

  app.put("/api/v1/core/marketing/articles", async (request, reply) => {
    const actorId = await requireAdmin(request, reply, config);
    if (!actorId) return;
    if (!hasAllowedOrigin(request, reply, config)) return;
    const parsedBody = articleSchema.safeParse(request.body);
    if (!parsedBody.success) return invalidRequest(reply);
    const article = parsedBody.data;

    const now = new Date();
    const result = await database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ id: marketingArticles.id })
        .from(marketingArticles)
        .where(eq(marketingArticles.slug, article.slug))
        .limit(1);
      const [saved] = await transaction
        .insert(marketingArticles)
        .values({
          slug: article.slug,
          title: article.title,
          dek: article.dek,
          category: article.category,
          date: article.date,
          readTime: article.readTime,
          image: article.image,
          imageAlt: article.imageAlt,
          imageNote: article.imageNote,
          sections: article.sections.map((section) => ({
            ...(section.heading ? { heading: section.heading } : {}),
            paragraphs: section.paragraphs,
          })),
          pullQuote: article.pullQuote,
          isPublished: article.isPublished,
          publishedAt: article.isPublished ? now : null,
        })
        .onConflictDoUpdate({
          target: marketingArticles.slug,
          set: {
            title: article.title,
            dek: article.dek,
            category: article.category,
            date: article.date,
            readTime: article.readTime,
            image: article.image,
            imageAlt: article.imageAlt,
            imageNote: article.imageNote,
            sections: article.sections.map((section) => ({
              ...(section.heading ? { heading: section.heading } : {}),
              paragraphs: section.paragraphs,
            })),
            pullQuote: article.pullQuote,
            isPublished: article.isPublished,
            publishedAt: article.isPublished
              ? sql`coalesce(${marketingArticles.publishedAt}, ${now})`
              : null,
            updatedAt: now,
          },
        })
        .returning({ id: marketingArticles.id, slug: marketingArticles.slug });
      if (!saved) return null;

      await transaction.insert(coreAdminActions).values({
        actorId,
        targetType: "marketing_article",
        targetId: saved.id,
        action: existing ? "update" : "create",
        details: { slug: saved.slug, isPublished: article.isPublished },
      });
      return saved;
    });
    if (!result) {
      return reply.code(500).send({
        error: {
          code: "SAVE_FAILED",
          message: "The article could not be saved.",
        },
      });
    }
    return { article: result };
  });

  app.delete(
    "/api/v1/core/marketing/articles/:slug",
    async (request, reply) => {
      const actorId = await requireAdmin(request, reply, config);
      if (!actorId) return;
      if (!hasAllowedOrigin(request, reply, config)) return;
      const parsedParams = z
        .object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) })
        .safeParse(request.params);
      if (!parsedParams.success) return invalidRequest(reply);
      const [article] = await database.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(marketingArticles)
          .set({
            isPublished: false,
            publishedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(marketingArticles.slug, parsedParams.data.slug),
              eq(marketingArticles.isPublished, true),
            ),
          )
          .returning({
            id: marketingArticles.id,
            slug: marketingArticles.slug,
          });
        if (!updated) return [undefined];
        await transaction.insert(coreAdminActions).values({
          actorId,
          targetType: "marketing_article",
          targetId: updated.id,
          action: "unpublish",
          details: { slug: updated.slug },
        });
        return [updated];
      });
      if (!article) {
        return reply.code(404).send({
          error: {
            code: "NOT_FOUND",
            message: "The published article could not be found.",
          },
        });
      }
      return reply.code(204).send();
    },
  );
}
