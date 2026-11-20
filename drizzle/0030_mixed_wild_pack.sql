CREATE TABLE "profile_badges" (
	"user_id" uuid NOT NULL,
	"badge_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_badges_user_id_badge_key_pk" PRIMARY KEY("user_id","badge_key")
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "profile_pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "community_pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_badges" ADD CONSTRAINT "profile_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_badges_user_idx" ON "profile_badges" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_author_profile_pin_unique" ON "posts" USING btree ("author_id") WHERE "posts"."profile_pinned_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_community_pin_unique" ON "posts" USING btree ("community_id") WHERE "posts"."community_pinned_at" is not null;--> statement-breakpoint
INSERT INTO "profile_badges" ("user_id", "badge_key")
SELECT profiles."user_id", badge.badge_key
FROM "profiles"
CROSS JOIN (VALUES ('early_supporter'), ('beta_tester')) AS badge(badge_key)
WHERE profiles."username" = 'sanctyria'
ON CONFLICT DO NOTHING;