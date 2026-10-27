CREATE TABLE "community_slug_aliases" (
	"slug" text PRIMARY KEY NOT NULL,
	"community_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community_slug_aliases" ADD CONSTRAINT "community_slug_aliases_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_slug_aliases_community_idx" ON "community_slug_aliases" USING btree ("community_id");