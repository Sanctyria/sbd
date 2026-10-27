CREATE TABLE "community_member_mutes" (
	"community_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"moderator_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_member_mutes_community_id_user_id_pk" PRIMARY KEY("community_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "community_member_mutes" ADD CONSTRAINT "community_member_mutes_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_member_mutes" ADD CONSTRAINT "community_member_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_member_mutes" ADD CONSTRAINT "community_member_mutes_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_member_mutes_user_idx" ON "community_member_mutes" USING btree ("user_id","created_at");