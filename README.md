# GCC Connect

A friendly, hobby-grade office companion: book desks and rooms on the real floor plan, scan QR codes, join events, see the food menu, send kudos, vote in polls, and keep the important links and phone numbers in one place. It is independent of any company system. React + Vite front end, Express API, PostgreSQL database.

> **Status:** works end to end on a laptop and is built to deploy to Cloudflare Workers. Before real employee data goes in, read [Production checklist](#production-checklist) â€” sign-in is still email + password (no company SSO yet).

## What you get

- **Employees:** sign in, see a live map of the office with team-coloured seats, book a desk or room, get a calendar file, track a visit streak, RSVP to events, scan a QR to jump straight to a space.
- **Floor plan:** the PDF is drawn as the map background; seats sit exactly on the desks drawn in it. Zoom, pan, search, or switch to a list.
- **Roles and permissions:** `user`, `admin`, `super_admin`. A super admin can do everything and creates people with exactly the permissions they need:

  | Permission | Lets someoneâ€¦ |
  |---|---|
  | `bookings.manage` | see and cancel anyone's bookings |
  | `events.manage` | create, edit and delete events |
  | `spaces.manage` | add, move and retire desks/rooms, upload the floor plan, import seats |
  | `teams.manage` | create teams, set colours, assign seats |
  | `qr.manage` | create booking QR codes (expiring or **no expiry**, limited or unlimited uses) |
  | `users.manage` | create people, change roles and permissions, reset passwords, see the activity log |
  | `content.manage` | manage useful links, important contacts and announcements |
  | `menu.manage` | post the food menu |
  | `community.manage` | run polls, moderate kudos, read the idea box |
  | `insights.view` | see the insights dashboard |

  New accounts get a temporary password and must choose their own at first sign-in.
- **Custom roles:** a super admin builds role templates (for example "HR partner", "Facilities", "Culture crew") from any mix of permissions, then gives them to people. Four starters are included.
- **Everything is switchable:** Manage â†’ Settings lets a super admin turn each feature on or off (links, contacts, menu, announcements, kudos, polls, celebrations, idea box, who's in, points) and set the app name, tagline, welcome note and default colour theme.
- **Useful stuff:** links to user guides and portals (payments, insurance, anything), an important-contacts directory with tap-to-call and email, announcements on the home page, and links on events.
- **Food menu:** daily breakfast, lunch, snacks and dinner with diet markers and likes. Menu managers can repeat a dish across days.
- **Community:** kudos wall with badges and cheers, polls, birthdays and work anniversaries (birthdays are opt-in), and an anonymous idea box for HR and leaders.
- **Who's in today**, a visit streak, points, levels and badges, "Sit with my team" and "Surprise me" seat pickers, dark mode, colour themes and emoji avatars.
- **Insights dashboard** for leaders: desk and room use, booking trends, busiest days, team seat use, most booked spaces, engagement, and plain-English highlights.
- **Teams are fully configurable** (Manage â†’ Map & teams): create/rename/recolour teams, box-select seats on the map or type a range like `Z001-Z020`, then assign. The seat list from the Excel workbook is only the starting point.
- **Map gestures:** scroll wheel zooms toward the cursor, drag to pan, pinch with two fingers on a phone.
- **Stay options:** besides 1 to 8 hours you can book until 5 pm, 8 pm or midnight. The seat panel lets you change date, arrival and stay and shows live availability. Admins can set a suggested stay on a QR, and each person's last choice is remembered.
- **QR stickers** show the seat or room name under the code.
- **Save button for the map:** moving seats and changing teams is staged until you press **Save changes** (or **Discard**). A save is written to the activity log.
- **Exports:** the activity log and the bookings list export as CSV (Manage â†’ Activity and Bookings), with optional date ranges for the log.
- **Export PDF:** one click produces an A3 PDF of the office plan with every seat coloured by team, a legend, and a second page listing seat numbers per team.

## Run it locally

Requirements: Node.js 20.19+ or 22.12+.

```powershell
npm.cmd install
npm.cmd run dev
```

Open <http://localhost:5173>. Demo accounts (local development only; the password for all three is `gccdemo`):

| Role | Email |
|---|---|
| Employee | `ava@demo.gcc` |
| Admin | `noah@demo.gcc` |
| Super admin | `root@demo.gcc` |

### Database: PostgreSQL everywhere

Hosted databases (Neon, Supabase, Railway ...) are PostgreSQL, so that is what runs locally â€” no SQLite. With no `DATABASE_URL`, the app runs [PGlite](https://pglite.dev) (a real PostgreSQL compiled to WebAssembly, no install needed) and keeps its files in `data/pglite/`. Set `DATABASE_URL` and the same code talks to any PostgreSQL server through the standard `pg` driver, so nothing changes when you move.

```powershell
npm.cmd run db:reset        # wipe the local database; the next start reseeds it
npm.cmd test                # API tests on PGlite
npm.cmd run test:pg         # the same tests through the real pg driver over a socket
```

To run against a real local PostgreSQL instead, set `DATABASE_URL=postgres://user:pass@localhost:5432/gcc` before `npm run dev`. Schema changes live in `server/migrations/*.sql` and apply automatically on start.

### Your floor plan and seat workbook

Both files are private and are **never committed** (`local-data/` and `data/` are Git-ignored).

1. Copy the PDF to `local-data/floor-plan.pdf`.
2. Turn the workbook into a seat list, then place every seat on its desk in the PDF:

   ```powershell
   python scripts\import-seat-workbook.py "C:\path\to\Floor Seat Numbers GCC.xlsx"
   npm.cmd run map:seats
   ```

   The first command writes `local-data/seat-inventory.json` (seat numbers, team ranges, grid cells). The second finds the 12 Ã— 24 pt desk rectangles drawn in the PDF (184 in this plan) and matches them to the workbook seats, adding `x`/`y` positions. If a seat lands on the wrong desk, drag it in **Manage â†’ Map & teams**; it saves instantly.
3. `npm.cmd run db:reset` then `npm.cmd run dev` to load them.

The same two files can be loaded into a running (or deployed) app from **Manage â†’ Map & teams â†’ Plan & seats**: upload the PDF and the seat JSON. The PDF is stored privately in the database and only served after sign-in.

## Deploy

This is the **Cloudflare edition**: the React app is served from Cloudflare's edge and the Express API runs in a Worker, talking to any PostgreSQL (Neon, Supabase, ...) through Hyperdrive. See [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md) for the step-by-step guide. Short version: `npm run cf:deploy`, then set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` as secrets.

Try the Worker on your laptop first (no Cloudflare account needed): `npm run cf:db` in one terminal, `npm run cf:dev` in another, open http://localhost:8787.

## Production checklist

- [ ] Company SSO (Microsoft Entra ID / OIDC) instead of passwords, plus MFA â€” **not implemented**.
- [ ] Privacy, security and accessibility review; retention policy for bookings and the activity log.
- [ ] Backups and a tested restore ([`docs/OPERATIONS.md`](docs/OPERATIONS.md)).
- [ ] Remove demo data (`SEED_DEMO=false` is the production default) and change the bootstrap password after first sign-in.
- [ ] Persistent/distributed rate limiting if you run more than one replica (limits are per process today).

More: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) Â· [`docs/OPERATIONS.md`](docs/OPERATIONS.md) Â· [`docs/openapi.yaml`](docs/openapi.yaml)

## Project layout

```
server/        Express API, PostgreSQL access (pg / PGlite), migrations, seat import
worker/        Cloudflare Worker entry + per-request PostgreSQL adapter (wrangler.jsonc configures it)
src/           React UI (screens, floor map, PDF export)
scripts/       workbook importer, desk detector, db reset, pg driver check
test/          API tests (permissions, booking races, QR, import â€¦)
```
