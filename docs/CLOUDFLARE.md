# Deploying to Cloudflare

How it fits together:

| Piece | Where it runs | Cost |
|---|---|---|
| React app (`dist/`) | Cloudflare Workers static assets, served from the edge. Only `/api/*` wakes the Worker. | Free, unlimited static requests |
| Express API (`server/`) | One Cloudflare Worker (`worker/index.js`, Node compatibility) | Free: 100,000 requests/day |
| Database | Any PostgreSQL, reached through **Hyperdrive** (connection pooling) | Neon / Supabase free tiers, or any Postgres you already have |

The API code and SQL are the same as the Node/Railway edition, so you can move between hosts without touching data.

## 1. Create a free PostgreSQL

Neon (neon.tech) or Supabase both have free tiers. Create a project and copy the connection string (`postgres://user:pass@host/db?sslmode=require`).

## 2. Create the Hyperdrive config

```bash
npm install
npx wrangler login
npx wrangler hyperdrive create gcc-connect --connection-string "postgres://user:pass@host/db?sslmode=require"
```

Paste the printed `id` into the `hyperdrive` block of `wrangler.jsonc`.

> No Hyperdrive? Delete that block and run `npx wrangler secret put DATABASE_URL` instead. The Worker then connects straight to the database; it works but opens a fresh TLS connection per request.

## 3. Deploy

```bash
npm run cf:deploy
npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL
npx wrangler secret put BOOTSTRAP_ADMIN_PASSWORD   # at least 12 characters
```

The first request creates the tables (`AUTO_MIGRATE=true`) and the first super admin. Sign in, change the password, then load your floor plan under **Manage → Map & teams → Plan & seats** (PDF, then seat JSON). Your site is at `https://gcc-connect.<your-subdomain>.workers.dev`; add a custom domain under Workers → Settings → Domains.

Once the tables exist you can set `AUTO_MIGRATE` to `"false"` in `wrangler.jsonc` to skip the check on cold starts. New migrations then need one deploy with it set back to `"true"`.

## Try it on your laptop first

```bash
npm run cf:db      # terminal 1: local PostgreSQL (PGlite over a socket), port 5544
npm run cf:dev     # terminal 2: builds the UI and runs the Worker in Cloudflare's local runtime
```

Open http://localhost:8787. Put `SEED_DEMO=true` (demo people and sample data) and `BOOTSTRAP_ADMIN_*` in a `.dev.vars` file (git-ignored) to sign in. `localConnectionString` in `wrangler.jsonc` points Hyperdrive at that local database.

## Settings

| Name | Where | Meaning |
|---|---|---|
| `HYPERDRIVE` | binding | Pooled PostgreSQL connection |
| `DATABASE_URL` | secret | Direct connection if you skip Hyperdrive |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | secrets | First super admin on an empty database |
| `SEED_DEMO` | var | `true` adds demo users and sample content (never in production) |
| `AUTO_MIGRATE` | var | `true` (default) applies migrations on cold start |
| `PASSWORD_SCRYPT_N` | var | Password hashing cost. `8192` fits the free plan's 10 ms CPU budget; use `16384` or more on the paid plan. Existing hashes keep working because the cost is stored with each hash. |

## Free-plan limits to know

- **CPU time is 10 ms per request.** Everything is fast except password hashing, which is why `PASSWORD_SCRYPT_N` is lowered. If logins ever fail with Cloudflare error 1102, lower it to `4096` or move to the Workers Paid plan ($5/month), which allows far more CPU and lets you raise the cost.
- **100,000 API requests/day** (a few hundred people booking desks is far below this).
- **Rate limits are per Worker instance, not global**, so they slow abuse but do not strictly cap it. For strict limits use Cloudflare's rate limiting rules in front of `/api/login`.
- **Uploaded floor plan** is stored in the database (25 MB request cap in the API; Workers allow 100 MB bodies). Keep it small on a free database.
- Hyperdrive on the free plan has a daily query quota; the Worker reuses one connection per request to stay well below it.

## What changed versus the Node edition

- `worker/index.js` hosts the same Express app through `httpServerHandler` and applies the migrations bundled as text.
- `worker/pg-edge-adapter.js` opens one PostgreSQL connection per request (transactions run on it, with other queries of that request held back until commit).
- `server/db.js` was split: `server/setup.js` holds migrations and seeding and is shared by both editions.
- Password hashes now carry their scrypt cost (`salt:hash:N`); old `salt:hash` values still verify.
- Railway files were removed. Node (`npm start`) still works with any PostgreSQL via `DATABASE_URL`.
