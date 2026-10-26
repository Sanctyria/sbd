# Sanctyria Community Backend

Standalone Fastify API for the Sanctyria community platform. This service lives beside `Web-Svelte/`; it does not use or modify `Patron/`.

## Requirements

- Node.js 22 or newer
- Docker Compose for local PostgreSQL

## Local Development

1. Install packages with `npm install`.
2. Copy `.env.example` to `.env` and enter your rotated Neon connection URL locally. Keep `.env` private.
3. Apply migrations with `npm run db:migrate` and insert demo data with `npm run db:seed`.
4. Run `npm run db:verify-seed` to check imported rows and local demo password hashes.
5. Start the API with `npm run dev`.
6. Start `Web-Svelte/` separately. Its same-origin API proxy defaults to `http://127.0.0.1:3000`; set `COMMUNITY_BACKEND_URL` on the web host when deploying.
7. Check `http://127.0.0.1:3000/api/v1/health` and `http://127.0.0.1:3000/api/v1/ready`.

The liveness endpoint does not query PostgreSQL; `/api/v1/ready` checks the database connection. For local PostgreSQL, run `docker compose up -d postgres` and set `DATABASE_URL=postgres://sanctyria:sanctyria_dev_only@localhost:54329/sanctyria` in your private `.env`. The Compose credentials are local-only. Never reuse a database URL that has been shared in chat; rotate its password first.

Set `CORE_ADMIN_USER_IDS` to a comma-separated list of trusted user UUIDs to grant access to the global `/core` admin workspace. Set `CORE_SUPER_ADMIN_USER_IDS` to a comma-separated subset of those IDs to allow permanent account deletion. Both default to empty. Community owner/moderator roles do not grant global admin access, and the backend enforces each permission server-side.

## Commands

- `npm run dev`: watch and run the API.
- `npm run check`: typecheck the service.
- `npm test`: run API tests.
- `npm run build`: compile to `dist/`.
- `npm run db:generate`: generate a migration from the Drizzle schema.
- `npm run db:migrate`: apply generated migrations.
- `npm run db:seed`: upsert demo accounts, communities, posts, replies, and guest memberships. Passwords are Argon2id-hashed in PostgreSQL; generated plaintext credentials are written to the ignored `accounts.md` file. Keep that file private. Reruns reuse its passwords.
- `npm run db:verify-seed`: verify aggregate seed counts and each local password against its stored hash without printing credentials.

## Initial API

- `GET /api/v1/health`: liveness check.
- `GET /api/v1/ready`: PostgreSQL readiness check.
- `GET /api/v1/communities?query=...&cursor=...`: public community directory.
- `GET /api/v1/communities/:slug`: public community details.
- `PATCH /api/v1/communities/:slug`: update community name, description, HTTPS avatar/banner image URLs, and external website URL as its owner.
- `GET /api/v1/communities/:slug/members?cursor=...`: public cursor-paginated member profiles; deleted accounts are omitted and roles are not exposed.
- `GET /api/v1/profiles/:username`: public profile.
- `GET /api/v1/profiles/:username/activity?type=posts|replies&cursor=...`: cursor-paginated public authored posts or replies; removed content and nonpublic communities are excluded.
- `GET /api/v1/profiles/:username/followers|following?cursor=...`: public cursor-paginated profile connections.
- `PATCH /api/v1/me/profile`: update the signed-in user's display name, bio, or HTTPS avatar URL.
- `POST /api/v1/profiles/:username/follow` and `DELETE /api/v1/profiles/:username/follow`: follow/unfollow another active user.
- `GET /api/v1/profiles?cursor=...`: public profile list for suggestions.
- `GET /api/v1/ember/weekly?limit=3`: weekly community contributors, ranked by Ember earned over the previous seven days.
- `GET /api/v1/feed?scope=public|following|community&community=...&cursor=...`: public cursor-paginated posts with viewer reaction/bookmark flags. `following` uses the session's community memberships when signed in and falls back to the public feed for guests.
- `GET /api/v1/posts/:id`: public post and its first 50 replies.
- `GET /api/v1/posts/:id/replies?cursor=...`: cursor-paginated public replies for an active public post.
- `POST /api/v1/auth/signup`: create a password account and start a session.
- `POST /api/v1/auth/login`: exchange a seeded username/password for an HTTP-only session cookie.
- `GET /api/v1/me`: return the current session's profile, community roles, and whether its user UUID is configured as a global or super administrator.
- `DELETE /api/v1/auth/session`: revoke the current session.
- `POST /api/v1/communities/:slug/membership`: join a public community; requires a session.
- `DELETE /api/v1/communities/:slug/membership`: leave a community; requires a session.
- `POST /api/v1/communities`: create a public community; the creator is made its owner and first member.
- `PATCH /api/v1/communities/:slug/members/:username/role`: assign or remove moderator status as the community owner; role changes are audited and notify the affected member.
- `POST /api/v1/posts`: create a text, link, image-URL, or video-URL post in a community the member joined. URLs must use HTTPS; the API does not fetch external URLs.
- `PATCH /api/v1/posts/:id`: edit post text and/or its HTTPS URL as the author or a community owner/moderator.
- `DELETE /api/v1/posts/:id`: soft-delete a post as the author or a community owner/moderator.
- `POST /api/v1/posts/:id/replies`: add a reply to a public post; optionally include a `parentReplyId` belonging to that post for a nested reply.
- `PATCH /api/v1/replies/:id` and `DELETE /api/v1/replies/:id`: edit or soft-delete a reply as its author or a community owner/moderator.
- `POST /api/v1/reports`: report a currently public post or reply for moderation review; requires a session.
- `GET /api/v1/moderation/reports?status=open&cursor=...`: list reports only for communities where the signed-in user is an owner/moderator.
- `GET /api/v1/moderation/actions?cursor=...`: list audit actions scoped to communities where the signed-in user is an owner/moderator.
- `PATCH /api/v1/moderation/reports/:id`: change report status with a required reason; can explicitly soft-delete reported content and records append-only moderation actions.
- `GET /api/v1/notifications?unread=true&cursor=...`: list only the signed-in user's notifications and unread count.
- `GET /api/v1/search?query=...`: bounded global search across active public communities, active member profiles, and visible posts; each result group is capped and excludes deleted or suspended accounts.
- `GET /api/v1/me/bookmarks?cursor=...`: cursor-paginated saved posts belonging to the signed-in user.
- `PATCH /api/v1/notifications/:id`: mark one of the signed-in user's notifications read.
- `POST /api/v1/notifications/read-all`: mark all of the signed-in user's notifications read.
- `POST /api/v1/posts/:id/reaction`: toggle the member's `like` reaction. `DELETE` removes it.
- `POST /api/v1/posts/:id/vote`: set or toggle an upvote (`direction: "up"`) or post-only downvote (`direction: "down"`); votes update Ember.
- `POST /api/v1/replies/:id/reaction` and `DELETE /api/v1/replies/:id/reaction`: add or remove a reply like.
- `POST /api/v1/posts/:id/bookmark`: toggle a bookmark. `DELETE` removes it.
- `GET /api/v1/events`: SSE invalidation stream for public post, reply, reaction, and lifecycle changes, plus recipient-scoped notifications when signed in. It polls the PostgreSQL outbox every 1.5 seconds; clients should refetch canonical data after an event.
- `GET /api/v1/core/overview`: global workspace totals and recent communities/editorial updates.
- `GET /api/v1/core/users?query=...&cursor=...`: searchable, cursor-paginated user directory; excludes credential and session fields.
- `PATCH /api/v1/core/users/:id`: audited suspend/reactivate or irreversible account anonymization; permanent deletion is restricted to configured super administrators. Suspension/deletion revokes sessions; deletion erases credentials, profile identity, and personal relationships while preserving audit/moderation references. Owned communities transfer to an active member or are archived if no successor exists.
- `GET /api/v1/core/communities?query=...&cursor=...`: global community directory and activity counts.
- `PATCH /api/v1/core/communities/:id`: audited archive/restore.
- `GET /api/v1/core/moderation/reports?status=...&cursor=...` and `PATCH /api/v1/core/moderation/reports/:id`: global report review and audited resolution/content removal.
- `GET /api/v1/core/moderation/actions?cursor=...`: paginated global administrative audit actions.
- `GET /api/v1/core/marketing/articles`: journal CMS records for administrators; `PUT /api/v1/core/marketing/articles` validates and saves a draft or published article, and `DELETE /api/v1/core/marketing/articles/:slug` unpublishes it. The public `GET /api/v1/marketing/articles` and `GET /api/v1/marketing/articles/:slug` endpoints expose published journal content only.
- `GET /api/v1/core/banners`, `POST /api/v1/core/banners`, `PUT /api/v1/core/banners/:id`, `PATCH /api/v1/core/banners/order`, and `DELETE /api/v1/core/banners/:id`: audited banner management. Public `GET /api/v1/community/banners` returns the ordered community-home announcements.
- `POST /api/v1/analytics/pageview`: rate-limited anonymous public marketing page-view ingestion, aggregated by UTC day, route, and allowlisted UTM dimensions. It does not persist IP addresses, user agents, user IDs, sessions, referrers, or raw events.
- `GET /api/v1/core/analytics?days=7|30|90`: global community and aggregated first-party marketing analytics.

## Ember

Each active public post and reply scores `floor(10 × ln(1 + likes))`, with one unique like per member per item. This logarithmic formula gives diminishing returns as an item earns more reactions. A member's lifetime Ember is the sum across their active content; unlikes and deleted or moderated content reverse the associated score. Weekly voices and active circles use net Ember changes during the previous seven days. Popular circles are ranked by membership.

Notification listing and read APIs are implemented; creation covers follows, post-author replies, post reactions, post/reply mentions, community join/leave events, and role changes. Avatar storage, blocking, and production hosting configuration remain unimplemented. The demo write endpoints enforce session, origin, membership, visibility, payload, and URL checks, but need additional operational safeguards before public production launch.

Rate limits use a hashed session key for signed-in users and the client IP for guests. Auth and high-risk mutations have stricter route-specific caps. The in-memory counters are per process; configure a shared store before running multiple API instances.

Apply the new Core tables and user suspension column with `npm run db:migrate`. Core account deletion intentionally retains a scrubbed user tombstone because existing authored content and append-only moderation records use restrictive foreign keys; it is irreversible and removes the account's usable identity and credentials rather than physically deleting referenced history.
#   s b d  
 