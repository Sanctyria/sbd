CREATE TABLE "core_admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_analytics" (
	"day" date NOT NULL,
	"path" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"medium" text DEFAULT '' NOT NULL,
	"campaign" text DEFAULT '' NOT NULL,
	"page_views" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_analytics_day_path_source_medium_campaign_pk" PRIMARY KEY("day","path","source","medium","campaign")
);
--> statement-breakpoint
CREATE TABLE "marketing_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"dek" text NOT NULL,
	"category" text NOT NULL,
	"date" text NOT NULL,
	"read_time" text NOT NULL,
	"image" text NOT NULL,
	"image_alt" text NOT NULL,
	"image_note" text NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pull_quote" text NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core_admin_actions" ADD CONSTRAINT "core_admin_actions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_admin_actions_created_idx" ON "core_admin_actions" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "core_admin_actions_target_idx" ON "core_admin_actions" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "daily_analytics_day_idx" ON "daily_analytics" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_articles_slug_uidx" ON "marketing_articles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "marketing_articles_published_idx" ON "marketing_articles" USING btree ("is_published","published_at");