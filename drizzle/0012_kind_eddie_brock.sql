CREATE TABLE "ember_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"actor_id" uuid,
	"community_id" uuid,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reply_reactions" (
	"user_id" uuid NOT NULL,
	"reply_id" uuid NOT NULL,
	"type" text DEFAULT 'like' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_reactions_user_id_reply_id_type_pk" PRIMARY KEY("user_id","reply_id","type")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "ember" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "vote_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ember_events" ADD CONSTRAINT "ember_events_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ember_events" ADD CONSTRAINT "ember_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ember_events" ADD CONSTRAINT "ember_events_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_reactions" ADD CONSTRAINT "reply_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_reactions" ADD CONSTRAINT "reply_reactions_reply_id_replies_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."replies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "profiles" AS profile
SET "ember" =
	COALESCE((
		SELECT sum(floor(10 * ln(1 + post."vote_count"))::integer)
		FROM "posts" AS post
		INNER JOIN "communities" AS community ON community."id" = post."community_id"
		WHERE post."author_id" = profile."user_id"
			AND post."deleted_at" IS NULL
			AND community."is_public" = true
			AND community."status" = 'active'
	), 0)
	+ COALESCE((
		SELECT sum(floor(10 * ln(1 + reply."vote_count"))::integer)
		FROM "replies" AS reply
		INNER JOIN "posts" AS post ON post."id" = reply."post_id"
		INNER JOIN "communities" AS community ON community."id" = post."community_id"
		WHERE reply."author_id" = profile."user_id"
			AND reply."deleted_at" IS NULL
			AND post."deleted_at" IS NULL
			AND community."is_public" = true
			AND community."status" = 'active'
	), 0);--> statement-breakpoint
CREATE INDEX "ember_events_recipient_created_idx" ON "ember_events" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "ember_events_community_created_idx" ON "ember_events" USING btree ("community_id","created_at");--> statement-breakpoint
CREATE INDEX "ember_events_source_idx" ON "ember_events" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "reply_reactions_reply_idx" ON "reply_reactions" USING btree ("reply_id");