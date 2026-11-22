ALTER TABLE "communities" ADD COLUMN "posts_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "audio_cover_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "activity_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "best_activity_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_activity_date" date;