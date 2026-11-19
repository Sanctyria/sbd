CREATE TABLE "community_chat_preferences" (
	"user_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_chat_preferences_user_id_community_id_pk" PRIMARY KEY("user_id","community_id")
);
--> statement-breakpoint
ALTER TABLE "community_chat_preferences" ADD CONSTRAINT "community_chat_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_chat_preferences" ADD CONSTRAINT "community_chat_preferences_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_chat_preferences_community_idx" ON "community_chat_preferences" USING btree ("community_id");