# Sanctyria Community API

The backend is a standalone Fastify service that powers the Sanctyria community application and `/core` administration workspace. It uses PostgreSQL for application data and Drizzle ORM for schema management and migrations.

## Features

- Account signup/login, HTTP-only sessions, and profile management, including HTTPS avatar and banner image URLs.
- Public communities, membership, posts, nested replies, reactions, votes, bookmarks, and notifications.
- Community chat with owner-only `@everyone`, reply and mention notifications, per-community notification preferences, and unread counts.
- Profile and community post pinning, plus profile achievement badges.
- Community-owner moderation and global Core administration with audited actions.
- Journal CMS, community announcement banners, and aggregated analytics.
- Audited search-index approvals for communities and explicit profile indexing opt-in.
- Cursor-paginated APIs and server-sent community events.
- Optional Firebase Cloud Messaging delivery for registered Android and iOS devices.
- HTTPS link metadata previews with guarded public-host fetching.
- Signed Cloudinary uploads for profile, community, post, reply, and chat media.
- Cloudflare Turnstile verification and shared PostgreSQL auth-attempt limits.
- One-time Stripe and PayPal checkout, with verified, idempotent payment webhooks.

## Requirements

- Node.js 22 or newer
- npm
- PostgreSQL 17 (Docker Compose is provided for local development)

## Local development

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a private environment file:

   ```sh
   cp .env.example .env
   ```

   Set `DATABASE_URL` to your local PostgreSQL connection. The `.env` file is ignored by Git.

3. Start the local database from this directory:

   ```sh
   docker compose up -d postgres
   ```

   The Compose service publishes PostgreSQL on port `54329` and uses development-only credentials. Do not reuse these credentials outside local development.

4. Apply migrations:

   ```sh
   npm run db:migrate
   ```

5. Optionally populate and verify the demo dataset:

   ```sh
   npm run db:seed
   npm run db:verify-seed
   ```

   Seeding creates a local `accounts.md` file containing generated demo credentials. It is ignored by Git; keep it private and never publish it.

6. Start the API:

   ```sh
   npm run dev
   ```

7. Start the frontend separately from `../Web-Svelte/`. Its same-origin proxy defaults to `http://127.0.0.1:3000`; set `COMMUNITY_BACKEND_URL` in the frontend environment to override it.

The API listens on `http://127.0.0.1:3000` by default. `GET /api/v1/health` is a liveness check; `GET /api/v1/ready` also checks PostgreSQL connectivity.

## Configuration

Configuration is loaded from environment variables and validated at startup.

| Variable                    | Required | Default                 | Description                                                                           |
| --------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `NODE_ENV`                  | No       | `development`           | `development`, `test`, or `production`.                                               |
| `HOST`                      | No       | `127.0.0.1`             | Address on which Fastify listens.                                                     |
| `PORT`                      | No       | `3000`                  | Fastify listen port.                                                                  |
| `WEB_ORIGIN`                | No       | `http://localhost:5173` | Allowed web origin for CORS and mutation origin checks.                               |
| `TRUST_PROXY`               | No       | `127.0.0.1,::1`         | Comma-separated immediate proxy IPs/CIDRs trusted for forwarded client IPs.            |
| `DATABASE_URL`              | Yes      | —                       | PostgreSQL connection URL.                                                            |
| `SESSION_COOKIE_NAME`       | No       | `sanctyria_session`     | Name of the HTTP-only session cookie.                                                 |
| `SESSION_COOKIE_SECURE`     | No       | Environment-dependent   | Set `true` behind HTTPS; use `false` only for local HTTP development.                 |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | No   | Empty                   | Firebase Admin service-account JSON; enables the push-delivery worker. Keep it in a deployment secret manager. |
| `GOOGLE_APPLICATION_CREDENTIALS` | No  | Empty                   | Path to a mounted service-account JSON file; enables the worker via Application Default Credentials. |
| `CLOUDINARY_CLOUD_NAME`     | No       | —                       | Cloudinary cloud name for signed uploads. Configure together with the API key and secret. |
| `CLOUDINARY_API_KEY`        | No       | —                       | Cloudinary API key; returned only as a public upload parameter. |
| `CLOUDINARY_API_SECRET`     | No       | —                       | Cloudinary API secret used for server-side signatures and asset cleanup. Never expose it to the app. |
| `TURNSTILE_SITE_KEY`        | Production | —                     | Public Cloudflare Turnstile site key, returned to the login/signup form.               |
| `TURNSTILE_SECRET_KEY`      | Production | —                     | Cloudflare Turnstile server secret; required in production.                           |
| `STRIPE_SECRET_KEY`         | No       | —                       | Stripe API secret; requires the webhook secret to enable donations.                   |
| `STRIPE_WEBHOOK_SECRET`     | No       | —                       | Signing secret for the Stripe webhook endpoint.                                       |
| `PAYPAL_CLIENT_ID`          | No       | —                       | PayPal REST application client ID.                                                     |
| `PAYPAL_CLIENT_SECRET`      | No       | —                       | PayPal REST application secret.                                                       |
| `PAYPAL_WEBHOOK_ID`         | No       | —                       | PayPal webhook ID used by PayPal's signature verification API.                        |
| `PAYPAL_ENVIRONMENT`        | No       | `sandbox`               | `sandbox` or `live`; use sandbox while testing.                                        |
| `CRYPTO_WALLET_ADDRESS`     | No       | —                       | Public donation wallet address; shown publicly when all crypto settings are set.       |
| `CRYPTO_WALLET_ASSET`       | No       | —                       | Exact asset accepted at the configured address.                                       |
| `CRYPTO_WALLET_NETWORK`     | No       | —                       | Exact chain/network accepted at the configured address.                               |
| `CASH_APP_TAG`              | No       | —                       | Public Cash App Cashtag without `$`.                                                   |
| `SENTRY_DSN`                | No       | Empty                   | Optional Sentry backend project DSN. Captures scrubbed server errors when configured. |
| `CORE_ADMIN_USER_IDS`       | No       | Empty                   | Comma-separated UUIDs authorized for global Core administration.                      |
| `CORE_SUPER_ADMIN_USER_IDS` | No       | Empty                   | Comma-separated subset of Core admins authorized for permanent account anonymization. |

Keep all production credentials in a secret manager. Do not commit `.env`, database URLs, session secrets, or generated demo account files.
When `SENTRY_DSN` is configured, the backend sends server errors to Sentry with request data, user data, breadcrumbs, and exception messages removed. Review the Sentry project’s data-retention and access settings before enabling it in production.

### VPS security and payments

- Create a Cloudflare Turnstile widget for the production hostname. Set its **site key** as backend `TURNSTILE_SITE_KEY` and the matching **secret key** as backend `TURNSTILE_SECRET_KEY`. Production backend startup fails unless both are set. The site key is served to login/signup as public configuration; the secret remains server-only. Signup and login verify the single-use token with Cloudflare, action, and hostname before proceeding.
- The backend applies per-IP route limits, PostgreSQL-backed daily signup limits per IP, and 15-minute login limits per IP and username. Signup limits are not keyed by requested username, so an attacker cannot reserve somebody else's desired username by exhausting a username bucket. Apply migration `0018_auth_abuse_and_payment_events.sql` before deploying this version. The stored rate-limit identifiers are SHA-256 hashes. Expired buckets are cleaned hourly.
- Keep the API private behind the VPS reverse proxy/firewall. Set `TRUST_PROXY` only to the backend's immediate trusted proxy addresses. Configure that proxy to replace, not blindly pass through, client-supplied forwarded-IP headers; allow Cloudflare source ranges at the edge and preserve the verified client IP. Incorrect proxy trust can let clients spoof their rate-limit IP.
- Configure Stripe `STRIPE_SECRET_KEY` and the endpoint signing secret `STRIPE_WEBHOOK_SECRET`; point Stripe at the public same-origin proxy `https://sanctyria.com/api/community/webhooks/stripe` and subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. The proxy forwards the raw request body and signature header to the private API endpoint, which verifies the timestamped HMAC and deduplicates successful events.
- Configure a PayPal REST app and webhook, then set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, and `PAYPAL_ENVIRONMENT=live`. Point PayPal at `https://sanctyria.com/api/community/webhooks/paypal`; signatures are checked through PayPal's verification API. Test with sandbox credentials first.
- Checkout amounts are one-time USD payments from $1 through $5,000. Cash App and self-hosted crypto wallet transfers are direct payments, not webhook-backed confirmations; configure `CASH_APP_TAG` or all three `CRYPTO_WALLET_*` values only after confirming the destination, asset, and network. Never accept funds on an address whose network/asset has not been verified.
- `/donate` presents the refund policy and only enables methods configured on the backend. Donations are generally non-refundable, subject to applicable law and payment-provider rules; accidental/unauthorized payment queries should be handled through the support channel.
- Native push is opt-in in the mobile app's Notifications screen. The Android app initializes Firebase by default; iOS remains disabled until its Firebase options and APNs capability are configured. Configure a Firebase service account in the backend deployment secret manager as `FIREBASE_SERVICE_ACCOUNT_JSON`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a mounted key-file path; either enables the in-process worker to consume committed `notification.created` outbox events and retry transient FCM failures. Apply all pending migrations, including `0019_silly_stryfe.sql`, `0020_fair_lady_mastermind.sql`, `0021_cold_stranger.sql`, and `0030_mixed_wild_pack.sql`, before deploying this version. Device registrations are bound to a session and are removed when that session is deleted. Do not put Firebase service-account credentials in the mobile app or repository.
- Mobile uploads use signed Cloudinary requests. Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in the backend environment/secret manager. The API secret must never be added to Flutter build defines or client configuration. The app enforces 10 MB images and 50 MB videos (up to 3 minutes); also set appropriate upload limits in the Cloudinary account.
- Post audio and chat audio use upload purposes `post-audio` and `chat-audio`; they are signed as Cloudinary `video` resources, restricted to MP3, WAV, AAC, M4A, OGG, and FLAC, with a 20 MB limit. Chat authors include their `role` (`owner`, `moderator`, or `member`); `/api/v1/me/chats` includes `viewerRole`, `chatNotificationsEnabled`, and `unreadCount`. Reading a chat message page records its read time. Update per-community notification settings with `PATCH /api/v1/communities/:slug/chat/notifications` and `{ "chatNotificationsEnabled": false }`. Only a community creator or `owner` role can send `@everyone`; moderators cannot.

## Commands

| Command                  | Description                                       |
| ------------------------ | ------------------------------------------------- |
| `npm run dev`            | Run the API with `tsx watch`.                     |
| `npm run check`          | Type-check the TypeScript service.                |
| `npm test`               | Run the Vitest suite.                             |
| `npm run build`          | Compile the backend to `dist/`.                   |
| `npm start`              | Run the compiled server.                          |
| `npm run db:generate`    | Generate a Drizzle migration from the schema.     |
| `npm run db:migrate`     | Apply pending migrations.                         |
| `npm run db:seed`        | Upsert local demo accounts and community content. |
| `npm run db:verify-seed` | Verify demo data and local password hashes.       |

## API overview

All API routes are under `/api/v1`.

| Area                     | Representative routes                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Health                   | `GET /health`, `GET /ready`                                                                                                     |
| Authentication           | `POST /auth/signup`, `POST /auth/login`, `GET /me`, `DELETE /auth/session`                                                      |
| Profiles                 | `GET /profiles/:username`, profile activity and connections, `PATCH /me/profile` (including avatar and banner URLs), follow/unfollow |
| Communities              | `GET /communities`, `GET /communities/:slug`, membership, members, and community creation/update                                      |
| Community chat           | `GET /communities/:slug/chat/messages?search=...`, message send/edit/delete, and channel preferences                                |
| Feed and content         | `GET /feed`, `GET /posts/:id`, replies, reactions, votes, bookmarks, and reports                                                |
| Notifications and events | `GET /notifications`, notification reads, `GET /events` (SSE), and authenticated `POST`/`DELETE /me/push-device`                |
| Search and previews      | `GET /search`, `GET /link-preview?url=...`                                                                                      |
| SEO                      | `GET /seo/sitemap` returns eligible public communities, posts, and opted-in profiles                                            |
| Marketing                | Published journal reads and `/community/banners`                                                                                |
| Core administration      | `/core/overview`, `/core/users`, `/core/communities`, `/core/moderation`, `/core/marketing`, `/core/banners`, `/core/analytics` |

The Core API checks configured administrator UUIDs server-side. Community-owner or moderator status does not grant global administrator access. The super-admin list must be a subset of the admin list. Administrative changes and moderation decisions are audited. Demo seeding is disabled when `NODE_ENV=production`.

Profile badges are returned by `GET /profiles/:username`: early-supporter and beta-tester grants are stored in `profile_badges`, verified and community-creator badges are derived from account state, and the staff badge is derived only from `CORE_ADMIN_USER_IDS`. The demo `@sanctyria` account receives early-supporter and beta-tester grants when seeded; migration `0031` grants beta-tester to `@watcher` and `@dimacods`, and early-supporter plus beta-tester to `@chipcheese`.

Use the route implementations and schemas as the source of truth for request and response shapes. Public listing endpoints use bounded cursor pagination where applicable.

## Database and migrations

The Drizzle schema is in `src/db/schema.ts`; ordered PostgreSQL SQL migrations are in `drizzle/`. When changing the schema:

1. Update the Drizzle schema.
2. Generate a migration with `npm run db:generate`.
3. Review the generated SQL and commit it with the schema change.
4. Apply migrations with `npm run db:migrate` in each target environment.

Do not edit applied migrations to change an existing deployment's schema; add a new migration instead. Take a database backup before production migrations.

Search indexing is disabled by default for all communities and profiles. Core staff can approve an eligible community only when it is public/active, has an 80-character description, and has at least 10 non-deleted posts from at least 3 active authors in the trailing 90 days. Posts are indexable only within such communities and while the post and author remain eligible. Profiles require explicit member opt-in, an active account, a 20-character bio, and at least one eligible public post. Apply the migration before using the Core approval controls.

### IndexNow

Set `INDEXNOW_KEY` in the production backend environment to the same key served by the frontend at `https://sanctyria.com/<key>.txt`. The verification file is public and must be deployed before sending notifications. Production content changes submit only eligible community, post, and profile URLs; removal or de-indexing changes notify search engines to recrawl affected URLs. IndexNow shares notifications with participating search engines and does not guarantee indexing.

After both the frontend verification file and backend key are deployed, submit the current sitemap once from `Backend/`:

```powershell
npm run seo:indexnow:submit
```

The command verifies the live key file, reads the canonical sitemap, and submits its URLs in batches. It reads `INDEXNOW_KEY` from the backend process environment (or local `.env`); use the production key and a production database/runtime environment when running it. Search engines may initially return HTTP 202 while key verification is pending.

### Moving the production database to another Neon account

To preserve the data currently in production, **clone/migrate the PostgreSQL database; do not run `npm run db:seed`**. The seed command is for local demo data and is intentionally disabled in production. A database dump preserves account/profile records, password hashes, communities, posts, moderation history, analytics, and the Drizzle migration ledger.

1. **Check the source and target.** In the current Neon account, note the source PostgreSQL version, database size, database name, role, and region. Create a target Neon project close to the backend VPS, with the same PostgreSQL major version. Confirm the target plan has enough storage and network transfer for the dump and application.
2. **Prepare the target project.** Use its default database and role, or create a target database/role first. Keep both projects available until the new backend has been verified. Use the source's **direct/unpooled** connection endpoint for `pg_dump`; Neon documents that pooled endpoints should not be used for `pg_dump`.
3. **Take a protected backup.** Use the PostgreSQL client tools matching the source major version or newer. From a trusted machine with network access to both Neon projects, set `PGSSLMODE=require` and run the commands below, substituting the host, role, database, and dump-file placeholders. `--password` prompts interactively; do not put passwords or complete connection URLs in shell commands, tickets, logs, or this repository.

   ```powershell
   $env:PGSSLMODE = "require"

   pg_dump `
     --host="<SOURCE_UNPOOLED_HOST>" `
     --username="<SOURCE_ROLE>" `
     --dbname="<SOURCE_DATABASE>" `
     --format=custom `
     --no-owner `
     --no-acl `
     --password `
     --file="sanctyria-production.dump"
   ```

4. **Pause writes for the final copy.** For the final cutover, enable maintenance mode or temporarily stop the Render backend and any other writers. This avoids missing writes made after the dump. For a small beta database, a short maintenance window and one final dump/restore is simpler and safer than setting up replication.
5. **Restore into the target database.** The target database should be empty. `pg_restore` will prompt for the target role password. Do not use `--clean` against a database containing anything you want to keep.

   ```powershell
   pg_restore `
     --host="<TARGET_HOST>" `
     --username="<TARGET_ROLE>" `
     --dbname="<TARGET_DATABASE>" `
     --no-owner `
     --no-acl `
     --exit-on-error `
     --verbose `
     --password `
     "sanctyria-production.dump"
   ```

6. **Verify before switching traffic.** Check the restore completed without errors and compare representative row counts between source and target, including `users`, `profiles`, `communities`, `community_memberships`, `posts`, `replies`, `reports`, `marketing_articles`, and `daily_analytics`. Confirm the Drizzle migration ledger was restored. Test login, existing sessions, signup, writes, Core administration, and `/api/v1/ready` with a temporary backend configured to use the target database.
7. **Cut over.** Update the VPS backend's secret `DATABASE_URL` to the target project's connection string, then restart/deploy the backend. Point the frontend proxy's `COMMUNITY_BACKEND_URL` to the VPS API as a separate cutover setting. Confirm health/readiness and production flows before disabling maintenance mode.
8. **Keep rollback safe.** Retain the old Neon project and the protected dump until the new setup is stable. Do not allow both old and new backends to accept writes against separate database copies after cutover; they will diverge. If rollback is needed after target writes begin, stop writes and plan how to reconcile those writes before switching back.
9. **Protect and dispose of the dump.** It contains sensitive production data, including password hashes. Restrict its file permissions, keep it off public/shared storage, encrypt it if it must be transferred or retained, verify a usable backup exists, then securely remove temporary copies.

After a **full database restore**, do not run `npm run db:migrate` just to reproduce the schema: the migration ledger is part of the restored database. Run migrations only if the application has additional migrations that were not applied to the source before the dump. A fresh, empty database is a different setup; for that case, apply the repository migrations rather than importing a production dump.

## Ember

Ember is derived from reactions to active posts and replies. The score uses `floor(10 × ln(1 + likes))` with diminishing returns; removing reactions or content reverses the score. Weekly Ember ranks net changes over the preceding seven days. Popular communities are ranked separately by membership.

## Operational notes

- Fastify applies security headers, CORS checks, request validation, and rate limits. Current rate-limit counters are in memory and therefore per process; use shared gateway limits or a shared store when running multiple replicas.
- SSE connections are capped at 100 per backend process and end after 15 minutes. These per-process bounds should be complemented by deployment-level connection limits.
- Link previews only fetch HTTPS pages on publicly routable hosts and limit redirects, response size, and request time. Preview failures are returned explicitly rather than treated as valid metadata.
- Passwords are stored as Argon2id hashes. Session tokens are stored hashed and sent using HTTP-only cookies.
- Community and Core routes enforce their authorization rules in the API, independent of frontend visibility.
- Permanent account deletion is implemented as irreversible anonymization to preserve referenced content and audit history. It is restricted to configured super administrators.
- Expired sessions are purged in batches of up to 10,000 rows at startup and hourly. Each deletion batch is capped at 1,000 rows to avoid long-running cleanup statements.
- The `/ready` endpoint depends on PostgreSQL; `/health` does not.

## Related application

The SvelteKit frontend, route groups, same-origin API proxy, and web setup are documented in [`../Web-Svelte/README.md`](../Web-Svelte/README.md).
