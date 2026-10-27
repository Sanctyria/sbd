CREATE TABLE "community_banners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eyebrow" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"action" text NOT NULL,
	"href" text NOT NULL,
	"image" text NOT NULL,
	"image_alt" text DEFAULT '' NOT NULL,
	"accent" text DEFAULT '#f4a261' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "community_banners_sort_order_idx" ON "community_banners" USING btree ("sort_order");
--> statement-breakpoint
INSERT INTO "community_banners" (
	"id", "eyebrow", "title", "description", "action", "href", "image", "image_alt", "accent", "sort_order"
) VALUES
	('11111111-1111-4111-8111-111111111101', 'JOURNAL DISPATCH', 'The Flame That Remembers', 'A new field note from a world learning how to keep its stories.', 'Read the dispatch', '/journal', '/assets/worldview/ezgif-frame-001.jpg', 'A floating city among waterfalls and cliffs', '#f4a261', 0),
	('11111111-1111-4111-8111-111111111102', 'COMMUNITY SPOTLIGHT', 'Make room for strange worlds', 'Meet the makers trading maps, histories, and unfinished ideas.', 'Visit Worldbuilding', '/r/worldbuilding', '/assets/characters/ember.png', 'Ember, a horned character in ceremonial clothing', '#85c7be', 1),
	('11111111-1111-4111-8111-111111111103', 'FROM THE STUDIO', 'A quieter place to create', 'Step into the studio and explore the work taking shape there.', 'Explore the studio', '/studio', '/assets/characters/kai.png', 'Kai, a hooded character in dark armor', '#d88e9b', 2);