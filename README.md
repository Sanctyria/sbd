# Sanctyria Community API

The backend is a standalone Fastify service that powers the Sanctyria community application and `/core` administration workspace. It uses PostgreSQL for application data and Drizzle ORM for schema management and migrations.

## Features

- Account signup/login, HTTP-only sessions, and profile management.
- Public communities, membership, posts, nested replies, reactions, votes, bookmarks, and notifications.
- Community-owner moderation and global Core administration with audited actions.
- Journal CMS, community announcement banners, and aggregated analytics.
- Cursor-paginated APIs and server-sent community events.
- HTTPS link metadata previews with guarded public-host fetching.

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
| `DATABASE_URL`              | Yes      | —                       | PostgreSQL connection URL.                                                            |
| `SESSION_COOKIE_NAME`       | No       | `sanctyria_session`     | Name of the HTTP-only session cookie.                                                 |
| `SESSION_COOKIE_SECURE`     | No       | Environment-dependent   | Set `true` behind HTTPS; use `false` only for local HTTP development.                 |
| `CORE_ADMIN_USER_IDS`       | No       | Empty                   | Comma-separated UUIDs authorized for global Core administration.                      |
| `CORE_SUPER_ADMIN_USER_IDS` | No       | Empty                   | Comma-separated subset of Core admins authorized for permanent account anonymization. |

Keep all production credentials in a secret manager. Do not commit `.env`, database URLs, session secrets, or generated demo account files.

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
| Profiles                 | `GET /profiles/:username`, profile activity and connections, `PATCH /me/profile`, follow/unfollow                               |
| Communities              | `GET /communities`, `GET /communities/:slug`, membership, members, and community creation/update                                |
| Feed and content         | `GET /feed`, `GET /posts/:id`, replies, reactions, votes, bookmarks, and reports                                                |
| Notifications and events | `GET /notifications`, notification reads, and `GET /events` (SSE)                                                               |
| Search and previews      | `GET /search`, `GET /link-preview?url=...`                                                                                      |
| Marketing                | Published journal reads and `/community/banners`                                                                                |
| Core administration      | `/core/overview`, `/core/users`, `/core/communities`, `/core/moderation`, `/core/marketing`, `/core/banners`, `/core/analytics` |

The Core API checks configured administrator UUIDs server-side. Community-owner or moderator status does not grant global administrator access. The super-admin list must be a subset of the admin list. Administrative changes and moderation decisions are audited. Demo seeding is disabled when `NODE_ENV=production`.

Use the route implementations and schemas as the source of truth for request and response shapes. Public listing endpoints use bounded cursor pagination where applicable.

## Database and migrations

The Drizzle schema is in `src/db/schema.ts`; ordered PostgreSQL SQL migrations are in `drizzle/`. When changing the schema:

1. Update the Drizzle schema.
2. Generate a migration with `npm run db:generate`.
3. Review the generated SQL and commit it with the schema change.
4. Apply migrations with `npm run db:migrate` in each target environment.

Do not edit applied migrations to change an existing deployment's schema; add a new migration instead. Take a database backup before production migrations.

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
