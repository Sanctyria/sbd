INSERT INTO "community_memberships" ("user_id", "community_id", "role")
SELECT "creator_id", "id", 'owner'::"community_role"
FROM "communities"
WHERE "creator_id" IS NOT NULL
ON CONFLICT ("user_id", "community_id") DO UPDATE
SET "role" = 'owner'::"community_role"
WHERE "community_memberships"."role" = 'member'::"community_role";