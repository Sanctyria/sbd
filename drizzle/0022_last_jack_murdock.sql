ALTER TYPE "public"."notification_type" ADD VALUE 'post' BEFORE 'community';--> statement-breakpoint
CREATE TABLE "community_notification_mutes" (
	"user_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_notification_mutes_user_id_community_id_pk" PRIMARY KEY("user_id","community_id")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"community_posts" boolean DEFAULT true NOT NULL,
	"following_posts" boolean DEFAULT true NOT NULL,
	"replies" boolean DEFAULT true NOT NULL,
	"mentions" boolean DEFAULT true NOT NULL,
	"likes" boolean DEFAULT true NOT NULL,
	"follows" boolean DEFAULT true NOT NULL,
	"community_updates" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community_notification_mutes" ADD CONSTRAINT "community_notification_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_notification_mutes" ADD CONSTRAINT "community_notification_mutes_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_notification_mutes_community_idx" ON "community_notification_mutes" USING btree ("community_id");