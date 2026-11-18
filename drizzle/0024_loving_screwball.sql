CREATE TABLE "community_content_cooldowns" (
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"last_action_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_content_cooldowns_user_id_action_pk" PRIMARY KEY("user_id","action")
);
--> statement-breakpoint
ALTER TABLE "community_content_cooldowns" ADD CONSTRAINT "community_content_cooldowns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;