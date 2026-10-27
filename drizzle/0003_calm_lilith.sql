CREATE TABLE "user_follows" (
	"follower_id" uuid NOT NULL,
	"followed_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_follows_follower_id_followed_id_pk" PRIMARY KEY("follower_id","followed_id")
);
--> statement-breakpoint
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_followed_id_users_id_fk" FOREIGN KEY ("followed_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_follows_follower_idx" ON "user_follows" USING btree ("follower_id","created_at");--> statement-breakpoint
CREATE INDEX "user_follows_followed_idx" ON "user_follows" USING btree ("followed_id","created_at");