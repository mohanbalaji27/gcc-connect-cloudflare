# GCC Connect

A friendly, hobby-grade office companion: book desks and rooms on the real floor plan, scan QR codes, join events, see the food menu, send kudos, vote in polls, and keep the important links and phone numbers in one place. It is independent of any company system. React + Vite front end, Express API, PostgreSQL database.

> **Status:** works end to end on a laptop and is built to deploy to Cloudflare Workers. Before real employee data goes in, read [Production checklist](#production-checklist) — sign-in is still email + password (no company SSO yet).

## What you get

- **Employees:** sign in, see a live map of the office with team-coloured seats, book a desk or room, get a calendar file, track a visit streak, RSVP to events, scan a QR to jump straight to a space.
- **Floor plan:** the PDF is drawn as the map background; seats sit exactly on the desks drawn in it. Zoom, pan, search, or switch to a list.
- **Roles and permissions (checkboxes):** three built-in roles (`user`, `admin`, `super_admin`) plus **role templates** that bundle permissions, default notifications and a home screen. A super admin ticks exactly what each person or role may do, in grouped checkboxes with descriptions, a search box, "all / none" per group, a live "what can this person do" summary and a before-you-save diff. The catalogue lives in one file, [`server/permissions.js`](server/permissions.js); the browser receives it through `/api/bootstrap` (`config.permissionCatalog`) and keeps no list of its own, and a test fails if any permission string used in the code is missing from it.

  | Group | Permissions |
  |---|---|
  | Bookings | `bookings.view_all`, `bookings.cancel_others` |
  | Events | `events.create`, `events.edit`, `events.delete` |
  | Spaces, teams, QR | `spaces.manage`, `teams.manage`, `qr.manage` |
  | Content | `content.links`, `content.contacts`, `content.announcements` |
  | Food menu | `menu.edit` (includes reading reviews), `menu.reviews.view` |
  | Community | `community.polls`, `community.ideas`, `community.moderation` |
  | Facility issues | `issues.view_all`, `issues.assign`, `issues.update`, `issues.manage_categories`, `issues.export` (everyone can report a problem and follow their own reports) |
  | Notifications | `notifications.route` |
  | Insights | `insights.view` |
  | People and access | `users.view`, `users.create`, `users.edit`, `users.reset_password`, `users.change_roles`, `users.audit` (only a super admin can give these out) |
  | System | `settings.manage`, `roles.manage` (only the super admin role; never granted to others) |

  **Older permissions keep working.** The previous strings (`bookings.manage`, `events.manage`, `content.manage`, `menu.manage`, `community.manage`, `users.manage`) expand to the finer ones they used to cover whenever they are read, and migration 006 also adds the finer permissions next to them on every person and role (nothing is removed; existing admins additionally get the issue tools). Rules are unchanged: a non-super admin can only hand out permissions they hold, the super-admin-only ones can never be handed out by others, and you cannot edit yourself into more power. Creating people needs `users.create`; picking their role or permissions also needs `users.change_roles`.

  New accounts get a temporary password and must choose their own at first sign-in.
- **Role templates:** built in and editable (they cannot be deleted, and no role can be deleted while people hold it): *Employee* (the default for everybody), *Facility staff* (simple big-button home), *Facility manager*, *Cafeteria / food manager*, *HR / People team*, *Receptionist / front desk*, *Floor warden*, *Admin*, and *Super admin* (shown for reference; give it with the Role field). Four older starters (HR partner, Facilities, Leader, Culture crew) stay. A role is **what you can do + default notifications + landing experience**; clone one to start a new one.
- **Facility issue box:** a separate feature (switch: *Issue box*) from the idea box. See [Issue box](#issue-box) and [Notifications](#notifications) below.
- **Facility staff and employee IDs:** a role can switch on a **simple big-button home** (`simple_ui`): *My tasks*, the unassigned queue (if the role may see it), big **Start / Done / Need help** buttons, scan QR, contacts and the menu; the rest of the navigation is hidden. It is a simpler screen, not a security boundary: what people may do is decided by their permissions on the server. People **without a work email** can sign in with a **username / employee ID** (3 to 32 letters, numbers, dots, dashes or underscores; unique, case-insensitive): a user manager sets it under Manage → People, the same password rules and forced first-time password change apply, and the sign-in box accepts either. A wrong name and a wrong password get the same answer, and attempts are rate limited.
- **Everything is switchable:** Manage → Settings lets a super admin turn each feature on or off (links, contacts, menu, announcements, **issue box**, kudos, polls, celebrations, **idea box**, who's in, points) and set the app name, tagline, welcome note and default colour theme. A few extra options sit under Options: **Show who booked** (names in availability details, off by default) and **“I’m going” on events** (turn off to hide the button and the going counts; the server also refuses RSVPs), **Issue photos** (on by default), **Home contacts** (on by default; with how many contacts to show) and **Usage analytics** (on by default; with how long to keep the data). Kudos is optional: it is **off for brand-new installs only**, and installs that already exist keep exactly the setting they have (migration 006 writes it down). Changes reach other people within a few minutes.
- **Useful stuff:** links to user guides and portals (payments, insurance, anything), an important-contacts directory with tap-to-call and email, announcements on the home page, and links on events.
- **Food menu:** a "grand hotel" menu card for everyone, and a fast editor for the food team. See [Food menu](#food-menu) below.
- **Community:** an optional kudos wall with badges and cheers, polls, birthdays and work anniversaries (birthdays are opt-in), and an anonymous **idea box** (ideas and suggestions only) for HR and leaders.
- **Who's in today**, a visit streak, points, levels and badges, "Sit with my team" and "Surprise me" seat pickers, dark mode, colour themes and emoji avatars.
- **Insights dashboard** for leaders (Manage → Dashboard): *Bookings and office* (desk and room use, booking trends, busiest days, team seat use, most booked spaces, with an **i** button next to every number saying exactly what it counts) and *Usage* (logins per day, daily / weekly / monthly active people, which features are used and which are not, peak hours, new vs returning people). See [Analytics](#analytics).
- **Recent activity with filters** (Manage → Activity): by person, by date (today, 7 or 30 days, custom), by area (bookings, events, spaces, map, teams, people, roles, settings, food menu, content, issue box, community, security, sign-ins) and by text, with a total count, "Show older entries" paging and a CSV export that follows the filters. Every entry is a plain sentence ("Zed Admin edited Yan Manager (permissions changed)"). Sign-ins are merged in from their own table, so they never flood the log.
- **Important contacts on Home:** a card with tap-to-call and email buttons. Admins tick **Show on Home** on the contacts to feature (if none are ticked, the first *Emergency* contacts are shown); a super admin switches the card on or off and chooses how many (1 to 6) under Settings → Options.
- **Teams are fully configurable** (Manage → Map & teams): create/rename/recolour teams, box-select seats on the map or type a range like `Z001-Z020`, then assign. The seat list from the Excel workbook is only the starting point.
- **Map gestures:** scroll wheel zooms toward the cursor, drag to pan, pinch with two fingers on a phone.
- **Stay options:** besides 1 to 8 hours you can book until 5 pm, 8 pm or midnight. The seat panel lets you change date, arrival and stay and shows live availability. Admins can set a suggested stay on a QR, and each person's last choice is remembered.
- **Availability before you click:** pick a date, arrival time and stay and the map instantly colours every seat and room (free, booked at your time, yours, not available). Hover (desktop) or tap (phone) for details such as "Booked 9:00 am – 1:00 pm, free from 1:00 pm" or "Free until 3:00 pm"; rooms also show a small day timeline. Changing the time or stay never calls the server: one compact `GET /api/availability?date=` per date is cached in the browser. Your own booking or cancellation updates the map at once; the day is re-checked when the tab comes back to the front, and a 409 conflict explains when the space is free again. Who booked is hidden unless a super admin turns on **Show who booked** (managers with `bookings.view_all` always see names).
- **Seat numbers placed smartly:** each seat number goes on the side with the most free space (top, bottom, left or right), shrinks or hides where it would collide and appears as you zoom in. Override a seat in **Manage → Map & teams** (Selection → "Seat number goes on the…").
- **QR stickers** show the seat or room name under the code.
- **Save button for the map:** moving seats and changing teams is staged until you press **Save changes** (or **Discard**). A save is written to the activity log.
- **Exports:** the activity log (with the filters you chose, up to 5,000 rows) and the bookings list export as CSV (Manage → Activity and Bookings), with optional date ranges.
- **Export PDF:** one click produces an A3 PDF of the office plan with every seat coloured by team, a legend, and a second page listing seat numbers per team.

## Run it locally

Requirements: Node.js 20.19+ or 22.12+.

```powershell
npm.cmd install
npm.cmd run dev
```

Open <http://localhost:5173>. Demo accounts (local development only; the password for all of them is `gccdemo`):

| Role | Sign in with |
|---|---|
| Employee | `ava@demo.gcc` |
| Admin | `noah@demo.gcc` |
| Super admin | `root@demo.gcc` |
| Facility manager | `meera@demo.gcc` |
| Facility staff (simple home) | `ravi@demo.gcc` |
| Facility staff without an email | username `emp-1001` |

The demo database also has a few issues and notifications. `npm run db:reset` recreates it.

### Database: PostgreSQL everywhere

Hosted databases (Neon, Supabase, Railway ...) are PostgreSQL, so that is what runs locally — no SQLite. With no `DATABASE_URL`, the app runs [PGlite](https://pglite.dev) (a real PostgreSQL compiled to WebAssembly, no install needed) and keeps its files in `data/pglite/`. Set `DATABASE_URL` and the same code talks to any PostgreSQL server through the standard `pg` driver, so nothing changes when you move.

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

   The first command writes `local-data/seat-inventory.json` (seat numbers, team ranges, grid cells). The second finds the 12 × 24 pt desk rectangles drawn in the PDF (184 in this plan) and matches them to the workbook seats, adding `x`/`y` positions. If a seat lands on the wrong desk, drag it in **Manage → Map & teams**; it saves instantly.
3. `npm.cmd run db:reset` then `npm.cmd run dev` to load them.

The same two files can be loaded into a running (or deployed) app from **Manage → Map & teams → Plan & seats**: upload the PDF and the seat JSON. The PDF is stored privately in the database and only served after sign-in.

## Food menu

**For everyone** (Food menu): a menu card that opens on today and on the meal that fits the time of day (breakfast until 10:30, lunch until 15:00, evening snacks until 18:00, then dinner). Switch meal with the tabs, change day with the arrows, a swipe or the 7-day strip (the past week, today and what is coming), and filter by veg, non-veg, egg or vegan. Specials are highlighted, every dish has the usual Indian green / red / amber square-dot mark (a leaf for vegan), and the whole day downloads as a one-page PDF (**PDF**, created in the browser; emoji and non-Latin text are left out of the PDF) or prints cleanly (**Print**). Moving between days and meals makes no server calls: `GET /api/menu` returns the whole window (history + upcoming) in one call with an ETag, and likes and reviews update the screen from their own replies.

**Reviews:** anyone signed in can rate a meal for a day (1 to 5 stars, an optional comment of up to 280 characters, optionally anonymous) and optionally rate single dishes. There is one review per person per meal per day; it can be edited or removed, and it is rate limited. **Who can read them is a super-admin setting (Manage -> Settings -> Food menu), enforced by the server:**

| Setting | Employees see | Food team (`menu.edit` or `menu.reviews.view`) sees |
|---|---|---|
| `everyone` | average, count, comments and names (not for anonymous reviews) | everything |
| `summary` (default) | average and count, plus their own review | everything, including comments |
| `managers` | only their own review | everything |

An anonymous review never exposes its author to anyone, the food team included. Managers also get **Manage -> Food menu -> Reviews**: averages by day and meal, a daily trend, best and weakest dishes, the comments, filters by period, meal and dish, and a CSV export.

**History:** menus and their reviews older than the **days of menu history** setting (1 to 90, default 7) are removed. The cleanup is opportunistic: the first menu request or save of the day (or saving a shorter history in Settings) runs it once, guarded by a row in `app_settings`, so there is no cost on other requests.

**For the food team** (Manage -> Food menu -> Edit menu, `menu.edit`): one screen per day, with a week strip to jump between days.

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

## Issue box

Report a problem in under 20 seconds: tap a big emoji tile (cafeteria and pantry, washrooms, electrical, AC, cleaning, IT and Wi-Fi, furniture, security, lifts, other), optionally say where (pick a seat or room from a search or the map, scan its QR, or type a place), type a few words (quick phrases fill it in), choose how urgent it is, add one photo if you like and send. You get an issue number (#123). *My reports* shows the status timeline; you can comment, and tap **Still not fixed** within 7 days of a fix. If others already reported the same thing at the same place, you see "3 people already reported this" and can add a **+1** instead of a duplicate (you only ever see counts, never someone else's text). Submitting is rate limited and uses an idempotency key, so a double tap never creates two issues.

- **Seat and room stickers:** Manage -> QR codes -> *Report-a-problem sticker* makes a QR for `/?report=<seatOrRoomId>`; scanning it (signed in) opens the form already pointing at that place. It carries no secret, it only pre-fills the form.
- **Photos:** one per issue, shrunk in the browser to about 200 KB, then validated by the server (JPEG, PNG or WebP bytes that match the declared type, 400 KB at most, only the reporter can add it) and served privately. Super admins can switch photos off (Settings -> Options).
- **Staff:** *Queue* (`issues.view_all`) with counts, filters by status, category, priority, assignee, age and overdue, search and **Export CSV** (`issues.export`); *My tasks* (`issues.update`); on an issue: Start, Waiting, Fixed, Close, priority, assign to someone (`issues.assign`) or take it, **Need help** (alerts managers), a note for the reporter and **staff-only internal notes**. Categories can carry a target time, and open issues past it get an *Overdue* badge.
- **Privacy:** an issue is visible to its reporter, its assignee and people with `issues.view_all`; everyone else gets 404. Followers who added a +1 only hear the outcome.
- **Categories and routing** (Manage -> Issue box): add, edit, reorder and switch off categories (`issues.manage_categories`), and for each one choose who is notified, who gets urgent issues and who is the default assignee (`notifications.route`); people or whole roles. New issues go to the default assignee with the fewest open issues. Facility managers are always told and always escalated to.
- **Idea box:** stays separate and is for ideas and suggestions only (existing notes remain ideas).

## Notifications

The bell (top bar, and the sidebar on desktop) opens a notification centre with *mark read / mark all read* and deep links (an issue notification opens that issue). Notifications are kept for 30 days (old ones are removed opportunistically, at most once a day). Events that notify: a new issue (category recipients and facility managers), an assignment, a status change or comment (reporter and assignee), an urgent issue or *Need help* (escalation recipients), a new idea (idea handlers who opted in), and an announcement when its author ticks *Also send a notification*. A fan-out is one batched `INSERT` however many people it reaches. Event reminders are not included yet.

**Preferences** (Me and settings -> Notifications) are a checkbox matrix of type by channel, plus, for people who can see the issue queue, the issue categories they follow. What someone receives is *their own choice, else their role's default, else the type's default*, and only for things their permissions let them open. Roles carry default notification subscriptions (Manage -> Roles). **Browser push is not delivered yet:** the data model stores a `push` choice per type, the channel is marked *coming soon* in the catalogue (`available: false`) and the UI hides it. Doing it properly needs VAPID web push from the Worker (payload encryption and a push-service call per recipient), which does not fit comfortably inside the free plan's 10 ms CPU per request; the plan is to send pushes from a Cron Trigger or a queue consumer.

## Analytics

Two parts, both behind `insights.view` (Manage → Dashboard). Windows are **office days in India time**; "last 30 days" means the 30 days ending today, today included. Every figure in the app has an **i** button that shows the definition below.

**Bookings and office** (`GET /api/admin/insights`; the ETag changes exactly when a number changes, and every query includes `now()` so a Hyperdrive cache never serves stale numbers):

| Number | What it counts |
|---|---|
| Desk use / Room use today | booked time ÷ available time during office hours (9:00 to 18:00) across all *active* desks / rooms: seat-time, not "how many seats were touched". Also shown: how many seats have any booking today |
| People who booked (30 days) | active accounts with at least one confirmed booking starting in the window (suspended people excluded) |
| Bookings (30 days) | confirmed bookings starting in the window, desk and room shown separately; history on later-retired spaces still counts |
| Cancellations (30 days) | bookings cancelled in the window, by **cancel time** (`bookings.cancelled_at`, stamped on every cancellation; older ones are back-filled from the activity log, else they fall back to the booking time) |
| Desk coverage | share of active desks used at least once in the window |
| Trend | bookings per start day: 14 past days (today included) and the next 7 days |
| Busiest weekdays | average desk bookings per weekday over 60 days (an average, because weekdays occur 8 or 9 times) |
| Team seat use / Most booked spaces | desk bookings per assigned desk / top active spaces, 30 days |
| Kudos, poll votes, new ideas, RSVPs | hidden (not zero) when that feature or option is off; poll votes are counted by when they were cast (`poll_votes.voted_at`) |

All ratios guard against dividing by zero, and a test seeds bookings across IST midnight, retired spaces and suspended people and checks every number.

**Usage** (`GET /api/admin/usage?days=30` or `?from=&to=`; 7, 30, 90 days or custom, CSV download in the browser): sign-ins per day with active people, daily / weekly / monthly active people and stickiness (average daily ÷ monthly), most used features by people and by opens with a ▲/▼ trend against the previous period, features nobody opened ("try promoting these"), peak hours, new vs returning people and how many of the last period came back, and adoption by team (teams under three people are merged so nobody can be singled out).

### Usage analytics and privacy

- **Collected:** how many times each person opened each screen (or tab) per office day (`usage_daily`, a whitelist of about 20 features such as Home, Book, Map, Events, Menu, Links, Contacts, Polls, Issues), one total per hour of the day with nobody attached (`usage_hourly`), and who signed in when (`login_events`, shown as *Sign-ins* in the activity log). **Never collected:** clicks, what anyone typed, read, booked or searched, IP addresses, devices or locations. The dashboard only shows totals.
- **How it is sent:** the browser counts in memory (one count per screen view, repeats within 10 seconds ignored) and attaches the counts to the heartbeat it already makes every few minutes (`POST /api/pulse`, only when there is something to send and at most every 2 minutes), plus one `navigator.sendBeacon` to `POST /api/usage` when the page is hidden. Never one call per click. The server whitelists feature names (unknown ones are dropped), caps counts and batch size, rate limits per person and upserts one row per person, feature and day.
- **Switch:** Settings → Options → *Count which screens people open*. When off the browser sends nothing and the server stores nothing even if asked. Sign-ins are part of the security log and are always recorded.
- **Retention:** usage rows and sign-ins older than *Days to keep usage data* (30 to 1095, default 400) are deleted automatically once a day (see [`docs/OPERATIONS.md`](docs/OPERATIONS.md)). The same text is shown to the super admin in Settings.

## Activity log

Manage → Activity (`users.audit`) merges two sources into one filterable feed: `audit_log` (one row per important change) and `login_events` (sign-ins). Filters: person, date range, area, text; paging uses a cursor (`before`) so entries are never repeated or skipped, and the total comes with the first page. Areas come from the action prefix (`booking.*` → Bookings, `menu.*` → Food menu, and so on; see `server/activity.js`, where each known action also has its friendly sentence; unknown actions still show up under *Other*). Logged writes include bookings, events, spaces and the map, teams, people and role changes, roles, settings (naming what changed), menu saves and deletes, links, contacts, announcements, polls, ideas, issue changes and routing, password changes, and a **burst of failed sign-ins** (once per burst, not once per try). The CSV export takes the same filters and is capped at 5,000 rows.

## How the app keeps server calls low

- **One call after sign-in:** `GET /api/bootstrap` returns the settings (feature switches, branding, options), teams, map info, floor-plan version, your summary and the few **Home contacts**, with an ETag. The Home card therefore costs no request of its own; editing a contact bumps the settings version so open apps refresh. The old endpoints (`/config`, `/teams`, `/map`, `/me/summary`) still work.
- **A tiny heartbeat:** `GET /api/pulse` returns `{ configVersion, serverTime, notifications: { unread } }`. The browser calls it when a tab comes back to the front and then every 3 minutes, only while the tab is visible. When screen-open counts are waiting (usage analytics) the call is a `POST /api/pulse` carrying them, with the same reply, so analytics add no request. Anything an admin changes in Settings, branding, teams, spaces or the map bumps `configVersion` (it is also sent in an `X-Config-Version` header on every response), and a browser that sees a new number reloads bootstrap. So switching the Kudos wall off or on reaches other people within a few minutes, without a manual refresh, and the admin's own screen updates immediately. The **notification bell's unread count rides on it** (and on `/api/bootstrap` at sign-in), so the bell costs no extra request; the list is fetched only when the bell is opened. To add something else to the heartbeat, register it on the server with `app.locals.pulse.add('name', async (req) => value)`; keep it to one cheap query. Clients read the extra fields from the same reply (`startPulse` in `src/lib/pulse.ts`).
- **Spaces are cached by version:** the list of desks and rooms is fetched once and re-fetched only when `configVersion` changes; availability is fetched per date as described above.
- **Migrations:** `server/migrations/NNN-name.sql` must be additive. The Worker's bundled list is generated (`npm run migrations:gen`, run by `cf:dev`/`cf:deploy`) and a test fails if it is stale.

## Deploy

This is the **Cloudflare edition**: the React app is served from Cloudflare's edge and the Express API runs in a Worker, talking to any PostgreSQL (Neon, Supabase, ...) through Hyperdrive. See [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md) for the step-by-step guide. Short version: `npm run cf:deploy`, then set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` as secrets.

Try the Worker on your laptop first (no Cloudflare account needed): `npm run cf:db` in one terminal, `npm run cf:dev` in another, open http://localhost:8787.

## Production checklist

- [ ] Company SSO (Microsoft Entra ID / OIDC) instead of passwords, plus MFA — **not implemented**.
- [ ] Privacy, security and accessibility review; retention policy for bookings and the activity log (usage data already has one, see Analytics).
- [ ] Backups and a tested restore ([`docs/OPERATIONS.md`](docs/OPERATIONS.md)).
- [ ] Remove demo data (`SEED_DEMO=false` is the production default) and change the bootstrap password after first sign-in.
- [ ] Persistent/distributed rate limiting if you run more than one replica (limits are per process today).

More: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) · [`docs/OPERATIONS.md`](docs/OPERATIONS.md) · [`docs/openapi.yaml`](docs/openapi.yaml)

## Project layout

```
server/        Express API, PostgreSQL access (pg / PGlite), migrations, seat import
worker/        Cloudflare Worker entry + per-request PostgreSQL adapter (wrangler.jsonc configures it)
src/           React UI (screens, floor map, PDF export)
scripts/       workbook importer, desk detector, db reset, pg driver check
test/          API tests (permissions, issues, notifications, analytics, activity filters, booking races, QR, import …)
```
