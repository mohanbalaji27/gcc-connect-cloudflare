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
- Manage → Activity shows who changed what (bookings, events, teams, spaces, users, QR codes).

## Time and retention

Office dates use `Asia/Kolkata`; instants are stored as `timestamptz`. Sessions last 8 hours and expired rows are purged at sign-in. Food menus and their reviews are kept for the number of days set in Settings (default 7; the first menu request of the day purges older ones, guarded by the `menu_cleanup` row in `app_settings`). Bookings and the activity log are kept indefinitely until a retention policy is agreed and a purge job is added.
