ALTER TABLE "posts" ADD COLUMN "moderator_edited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "deleted_by_moderator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "moderator_edited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "deleted_by_moderator" boolean DEFAULT false NOT NULL;