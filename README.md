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
  | `menu.manage` | post and edit the food menu (quick day editor, copies, templates) and read meal reviews |
  | `menu.reviews.view` | read meal reviews, comments and the ratings trend without being able to edit the menu |
  | `community.manage` | run polls, moderate kudos, read the idea box |
  | `insights.view` | see the insights dashboard |

  New accounts get a temporary password and must choose their own at first sign-in.
- **Custom roles:** a super admin builds role templates (for example "HR partner", "Facilities", "Culture crew") from any mix of permissions, then gives them to people. Four starters are included.
- **Everything is switchable:** Manage → Settings lets a super admin turn each feature on or off (links, contacts, menu, announcements, kudos, polls, celebrations, idea box, who's in, points) and set the app name, tagline, welcome note and default colour theme. A few extra options sit under Options: **Show who booked** (names in availability details, off by default) and **“I’m going” on events** (turn off to hide the button and the going counts; the server also refuses RSVPs). Changes reach other people within a few minutes.
- **Useful stuff:** links to user guides and portals (payments, insurance, anything), an important-contacts directory with tap-to-call and email, announcements on the home page, and links on events.
- **Food menu:** a "grand hotel" menu card for everyone, and a fast editor for the food team. See [Food menu](#food-menu) below.
- **Community:** kudos wall with badges and cheers, polls, birthdays and work anniversaries (birthdays are opt-in), and an anonymous idea box for HR and leaders.
- **Who's in today**, a visit streak, points, levels and badges, "Sit with my team" and "Surprise me" seat pickers, dark mode, colour themes and emoji avatars.
- **Insights dashboard** for leaders: desk and room use, booking trends, busiest days, team seat use, most booked spaces, engagement, and plain-English highlights.
- **Teams are fully configurable** (Manage â†’ Map & teams): create/rename/recolour teams, box-select seats on the map or type a range like `Z001-Z020`, then assign. The seat list from the Excel workbook is only the starting point.
- **Map gestures:** scroll wheel zooms toward the cursor, drag to pan, pinch with two fingers on a phone.
- **Stay options:** besides 1 to 8 hours you can book until 5 pm, 8 pm or midnight. The seat panel lets you change date, arrival and stay and shows live availability. Admins can set a suggested stay on a QR, and each person's last choice is remembered.
- **Availability before you click:** pick a date, arrival time and stay and the map instantly colours every seat and room (free, booked at your time, yours, not available). Hover (desktop) or tap (phone) for details such as "Booked 9:00 am – 1:00 pm, free from 1:00 pm" or "Free until 3:00 pm"; rooms also show a small day timeline. Changing the time or stay never calls the server: one compact `GET /api/availability?date=` per date is cached in the browser. Your own booking or cancellation updates the map at once; the day is re-checked when the tab comes back to the front, and a 409 conflict explains when the space is free again. Who booked is hidden unless a super admin turns on **Show who booked** (managers with `bookings.manage` always see names).
- **Seat numbers placed smartly:** each seat number goes on the side with the most free space (top, bottom, left or right), shrinks or hides where it would collide and appears as you zoom in. Override a seat in **Manage → Map & teams** (Selection → "Seat number goes on the…").
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

## Food menu

**For everyone** (Food menu): a menu card that opens on today and on the meal that fits the time of day (breakfast until 10:30, lunch until 15:00, evening snacks until 18:00, then dinner). Switch meal with the tabs, change day with the arrows, a swipe or the 7-day strip (the past week, today and what is coming), and filter by veg, non-veg, egg or vegan. Specials are highlighted, every dish has the usual Indian green / red / amber square-dot mark (a leaf for vegan), and the whole day downloads as a one-page PDF (**PDF**, created in the browser; emoji and non-Latin text are left out of the PDF) or prints cleanly (**Print**). Moving between days and meals makes no server calls: `GET /api/menu` returns the whole window (history + upcoming) in one call with an ETag, and likes and reviews update the screen from their own replies.

**Reviews:** anyone signed in can rate a meal for a day (1 to 5 stars, an optional comment of up to 280 characters, optionally anonymous) and optionally rate single dishes. There is one review per person per meal per day; it can be edited or removed, and it is rate limited. **Who can read them is a super-admin setting (Manage -> Settings -> Food menu), enforced by the server:**

| Setting | Employees see | Food team (`menu.manage` or `menu.reviews.view`) sees |
|---|---|---|
| `everyone` | average, count, comments and names (not for anonymous reviews) | everything |
| `summary` (default) | average and count, plus their own review | everything, including comments |
| `managers` | only their own review | everything |

An anonymous review never exposes its author to anyone, the food team included. Managers also get **Manage -> Food menu -> Reviews**: averages by day and meal, a daily trend, best and weakest dishes, the comments, filters by period, meal and dish, and a CSV export.

**History:** menus and their reviews older than the **days of menu history** setting (1 to 90, default 7) are removed. The cleanup is opportunistic: the first menu request or save of the day (or saving a shorter history in Settings) runs it once, guarded by a row in `app_settings`, so there is no cost on other requests.

**For the food team** (Manage -> Food menu -> Edit menu, `menu.manage`): one screen per day, with a week strip to jump between days.

- **Type or paste** the whole day. A live preview shows exactly what will be saved, with line-by-line notes. The syntax is forgiving:

  ```
  Lunch                          meal: Breakfast, Lunch, Dinner, Evening snacks (also "== Lunch ==", "Lunch (12:30-2pm)")
  Starters:                      section: Starters, Mains, Breads & rice, Sides, Desserts, Drinks, Others (no section = Mains)
  Paneer tikka (v) ★, Fish fry (nv)    dishes on one line separated by commas, or one per line; bullets are optional
  nv: Chicken curry, Mutton keema      "v:", "nv:", "egg:", "vegan:" mark every dish on the line
  Gulab jamun (v) - served hot         text after " - " is a note; use (brackets) for a note that contains commas
  Idli v                               a trailing v / nv, or (v) (nv) (egg) (vegan), or the dots 🟢 🔴 🟡 🌱
  🍛 Biryani (nv) (special)            a leading emoji is kept; ★ or (special) highlights today's special
  ```

  Names with chicken, fish and so on are marked non-veg for you when you give no mark, and repeats within a meal are skipped. The parser is a pure function (`src/lib/menuText.ts`) with its own tests.
- **Grid** editor in sync with the text: tap the dot to cycle veg / non-veg / egg / vegan, rename inline (marks typed in a name are understood), mark a special, move with the arrows, drag or Alt + arrow keys, Enter for a new row, Backspace on an empty row to remove it, and the **...** button for section, meal, note and emoji.
- **One Save** writes the whole day with a single `PUT /api/admin/menu/day/:date` in one transaction (audit-logged, size limited). Dishes that stay keep their ids, so likes and dish ratings survive edits and renames. **Undo last save** puts the previous version back (dishes that were removed return as new dishes, so their likes are not restored).
- **Copy from** yesterday, the same weekday last week or any date; **copy to other dates** (up to 14 at once, replace or add); **templates** (save a day, load it into the editor or apply it to chosen dates, e.g. "Monday" on the same weekday for 4 weeks); **clear day**.
- **Unsaved changes** are flagged, the browser warns before you leave, and a draft is autosaved on the device (restore it from the banner next time).

To add a section, add it to `COURSE_IDS`/`COURSES` in `src/lib/menuCatalog.ts` and `COURSES` in `server/menu-catalog.js` (a test keeps the two files identical). Existing menu rows keep working: the meal id `snacks` is shown as "Evening snacks", and migration 005 puts older dishes under Mains, Drinks or Desserts by name.

## How the app keeps server calls low

- **One call after sign-in:** `GET /api/bootstrap` returns the settings (feature switches, branding, options), teams, map info, floor-plan version and your summary, with an ETag. The old endpoints (`/config`, `/teams`, `/map`, `/me/summary`) still work.
- **A tiny heartbeat:** `GET /api/pulse` returns `{ configVersion, serverTime }`. The browser calls it when a tab comes back to the front and then every 3 minutes, only while the tab is visible. Anything an admin changes in Settings, branding, teams, spaces or the map bumps `configVersion` (it is also sent in an `X-Config-Version` header on every response), and a browser that sees a new number reloads bootstrap. So switching the Kudos wall off or on reaches other people within a few minutes, without a manual refresh, and the admin's own screen updates immediately. To add something to the heartbeat later (notification counts, usage beacons), register it on the server with `app.locals.pulse.add('name', async (req) => value)`; keep it to one cheap query. Clients read the extra fields from the same reply (`startPulse` in `src/lib/pulse.ts`).
- **Spaces are cached by version:** the list of desks and rooms is fetched once and re-fetched only when `configVersion` changes; availability is fetched per date as described above.
- **Migrations:** `server/migrations/NNN-name.sql` must be additive. The Worker's bundled list is generated (`npm run migrations:gen`, run by `cf:dev`/`cf:deploy`) and a test fails if it is stale.

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
