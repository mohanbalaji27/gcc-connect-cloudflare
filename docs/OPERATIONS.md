# Operations

## Environments and variables

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string. When set, the `pg` driver is used. | unset → local PGlite in `PGLITE_DIR` |
| `PGLITE_DIR` | Local PGlite data directory | `./data/pglite` |
| `DATABASE_SSL` | `true` to require TLS and verify the certificate; `no-verify` to encrypt without verifying | off |
| `DATABASE_POOL_MAX` | Connection pool size | 10 |
| `NODE_ENV` | `production` → secure cookies, trust proxy, bind `0.0.0.0`, no demo seed | development |
| `PORT`, `HOST` | Listen address | 3000, `127.0.0.1` (dev) / `0.0.0.0` (prod) |
| `SEED_DEMO` | Create demo accounts/rooms/events on an empty database | `true` in dev, `false` in prod |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | Create the first super admin on an empty database (password ≥ 12 chars, must be changed at first sign-in) | unset |
| `LOCAL_SEAT_INVENTORY` | Seat list loaded on first start | `./local-data/seat-inventory.json` |

## Migrations

SQL files in `server/migrations/NNN-name.sql` run once, in order, inside a transaction, recorded in `schema_migrations`. Add new files; never edit one that has shipped.

## Backups (PostgreSQL)

A hosted database's built-in storage is not a substitute for backups. Take a logical backup regularly and keep copies somewhere else:

```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --file gcc-$(date +%F).dump
```

Restore into an empty database with `pg_restore --no-owner --dbname "$TARGET_URL" gcc-YYYY-MM-DD.dump`, start the app against it, and check sign-in, the map, and a booking. Test a restore before you rely on it. The floor-plan PDF is inside the database (`app_files`), so it is included. Encrypt backups at rest and limit who can read them — they contain names, emails and booking history.

Local development: `npm run db:reset` deletes `data/pglite`.

## Roles in practice

- Keep one or two **super admins**; give everyone else only the permissions they need (Manage → People). The last active super admin cannot be demoted or suspended.
- Suspending someone or changing their role ends all their sessions immediately.
- Password reset gives a one-time temporary password and forces a change at next sign-in.
- Manage → Activity shows who changed what (bookings, events, teams, spaces, users, roles, settings, menu, content, issues, categories and routing, repeated failed sign-ins) and, as the *Sign-ins* area, who signed in. It can be filtered by person, date, area and text, and exported with the same filters (up to 5,000 rows).
- Built-in role templates (Employee, Facility staff, Facility manager, ...) are seeded by migration 006. Edit them freely; they cannot be deleted. People without a work email sign in with a **username / employee ID** set under Manage → People.
- **Issue box:** set the categories and who is told under Manage → Issue box. Facility managers (the *Facility manager* template) are always notified and escalated to; give the template to the right people. Photos can be switched off in Settings → Options. Issues, their timeline and photos are kept until a retention policy is agreed.
- **Notifications** older than 30 days are deleted opportunistically (at most once a day, guarded by the `notifications_cleanup` row in `app_settings`).

## Time and retention

Office dates use `Asia/Kolkata`; instants are stored as `timestamptz`. Sessions last 8 hours and expired rows are purged at sign-in. Food menus and their reviews are kept for the number of days set in Settings (default 7; the first menu request of the day purges older ones, guarded by the `menu_cleanup` row in `app_settings`). Bookings and the activity log are kept indefinitely until a retention policy is agreed and a purge job is added.

**Usage analytics** (`usage_daily`, `usage_hourly`) and **sign-in history** (`login_events`) are kept for `usageRetentionDays` (Settings → Usage analytics and privacy; 30 to 1095, default 400). Rows older than that are deleted at most once a day per server: the first usage request, sign-in or dashboard read of the day does it, guarded by the `usage_cleanup` row in `app_settings` (its value is `<day>:<retention days>`, so changing the retention triggers one more cleanup). To turn collection off set the *Count which screens people open* option off: the browser stops sending and the server refuses to store; existing rows stay until they age out (delete them by hand with `DELETE FROM usage_daily; DELETE FROM usage_hourly;` if you want them gone now). Only counts per person, feature and day are stored: no IP address, device, page content or click log. The free plan budget is small: usage writes are one statement per batch (at most every couple of minutes per open tab) and the dashboard reads are about nine small aggregate queries with a one-minute browser cache.

**Cancellation times:** `bookings.cancelled_at` is stamped on every cancellation (by the person, a manager, or when a space is retired). Cancellations from before it existed were back-filled by migration 008 from the activity log where possible; the rest stay empty and reports use the booking time for them.
