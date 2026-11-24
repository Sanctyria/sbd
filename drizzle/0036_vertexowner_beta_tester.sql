INSERT INTO "profile_badges" ("user_id", "badge_key")
SELECT profiles."user_id", requested_badges.badge_key
FROM "profiles"
JOIN (
  VALUES
    ('vertexowner', 'beta_tester')
) AS requested_badges(username, badge_key)
  ON lower(profiles."username") = requested_badges.username
ON CONFLICT DO NOTHING;
