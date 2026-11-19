ALTER TYPE "public"."post_kind" ADD VALUE 'audio_url';--> statement-breakpoint
ALTER TABLE "community_chat_messages" ADD COLUMN "media_kind" text;