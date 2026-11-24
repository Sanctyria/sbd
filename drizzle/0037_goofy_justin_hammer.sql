ALTER TYPE "public"."post_kind" ADD VALUE 'book_url';--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "is_music" boolean DEFAULT false NOT NULL;