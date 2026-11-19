import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword, ADMIN_DEFAULT_PERMISSIONS } from './security.js';
import { importInventory } from './inventory.js';

const officeDay = (offset) => {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(Date.now() + offset * 86_400_000));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};


export function readMigrationFiles() {
  // Resolved lazily: import.meta.url is not a file URL inside a Worker.
  const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{3}-.+\.sql$/.test(name))
    .sort()
    .map((file) => ({ version: Number(file.slice(0, 3)), sql: readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8') }));
}

export async function migrate(db, migrations = readMigrationFiles()) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.query('SELECT version FROM schema_migrations')).rows.map((row) => row.version));
  for (const { version, sql } of migrations) {
    if (done.has(version)) continue;
    await db.tx(async (tx) => {
      // Two Worker instances starting together must not both apply the same migration.
      await tx.query('SELECT pg_advisory_xact_lock(727310)');
      if ((await tx.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version])).rows.length) return;
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    });
  }
}

async function seedAccounts(db, options) {
  const count = (await db.query('SELECT COUNT(*)::int AS count FROM employees')).rows[0].count;
  if (count > 0) return;
  const insert = (id, email, name, team, role, password, permissions = [], mustChange = false) => db.query(
    'INSERT INTO employees (id, email, name, team, role, permissions, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, email, name, team, role, permissions, hashPassword(password), mustChange],
  );
  const bootstrapEmail = options.bootstrapEmail ?? process.env.BOOTSTRAP_ADMIN_EMAIL;
  const bootstrapPassword = options.bootstrapPassword ?? process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (bootstrapEmail && bootstrapPassword) {
    if (bootstrapPassword.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
    await insert(randomUUID(), bootstrapEmail.trim().toLowerCase(), 'Super Admin', 'Platform', 'super_admin', bootstrapPassword, [], true);
  }
  if (options.seedDemo) {
    await insert('emp-ava', 'ava@demo.gcc', 'Ava Chen', 'Product design', 'user', 'gccdemo');
    await insert('emp-noah', 'noah@demo.gcc', 'Noah Patel', 'Workplace operations', 'admin', 'gccdemo', ADMIN_DEFAULT_PERMISSIONS);
    await insert('emp-root', 'root@demo.gcc', 'Riley Morgan', 'Platform operations', 'super_admin', 'gccdemo');
  }
}

const ROOMS = [
  ['room-meeting-a', 'Meeting Room A', 'Meeting room · 6 pax', 6, ['Display', 'Video conferencing']],
  ['room-meeting-b', 'Meeting Room B', 'Meeting room · 8 pax', 8, ['Display', 'Video conferencing', 'Whiteboard']],
  ['room-meeting-c', 'Meeting Room C', 'Meeting room · 8 pax', 8, ['Display', 'Video conferencing']],
  ['room-cabin-1', 'Cabin 1', 'Private cabin for calls and focus', 3, ['Door', 'Display']],
  ['room-cabin-2', 'Cabin 2', 'Private cabin for calls and focus', 3, ['Door', 'Display']],
  ['room-collab-1', 'Collab Zone', 'Open collaboration zone', 8, ['Whiteboard', 'Display']],
  ['room-collab-2', 'Collab Corner', 'Open collaboration zone', 6, ['Whiteboard']],
  ['room-collab-3', 'Collab Lounge', 'Open collaboration zone', 8, ['Display', 'Whiteboard']],
];

async function seedSpaces(db, options) {
  const existing = (await db.query('SELECT COUNT(*)::int AS count FROM resources')).rows[0].count;
  if (existing > 0) return;
  const inventoryPath = options.inventoryPath === null ? null : resolve(options.inventoryPath ?? process.env.LOCAL_SEAT_INVENTORY ?? './local-data/seat-inventory.json');
  const hasInventory = Boolean(inventoryPath && existsSync(inventoryPath));
  if (!hasInventory && !options.seedDemo) return;

  await db.tx(async (tx) => {
    let roomPositions = new Map();
    if (hasInventory) {
      const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
      await importInventory(tx, inventory, { replace: false });
      // Optional room coordinates (percent of the plan) from the same private file; otherwise rooms get neutral default spots.
      roomPositions = new Map((Array.isArray(inventory.rooms) ? inventory.rooms : []).map((room) => [String(room.label).toLowerCase(), room]));
    } else {
      const groups = ['Design', 'Engineering', 'Operations'];
      const seats = Array.from({ length: 24 }, (_, index) => ({
        label: `D-${String(index + 1).padStart(3, '0')}`, team: groups[Math.floor(index / 8)], row: Math.floor(index / 8) * 3 + 1, column: (index % 8) + 1,
      }));
      await importInventory(tx, { seats });
    }
    for (const [index, [id, label, description, capacity, amenities]] of ROOMS.entries()) {
      // A seat file that already brought a room with the same name (with its own position) wins over the default.
      if ((await tx.query("SELECT 1 FROM resources WHERE type = 'room' AND lower(label) = lower($1)", [label])).rows[0]) continue;
      const known = roomPositions.get(label.toLowerCase());
      const x = Number.isFinite(known?.x) ? known.x : 10 + (index % 4) * 25;
      const y = Number.isFinite(known?.y) ? known.y : 92 - Math.floor(index / 4) * 6;
      await tx.query(
        `INSERT INTO resources (id, type, label, building, floor, zone, description, amenities, capacity, x_pct, y_pct, placed_manually)
         VALUES ($1,'room',$2,'GCC Office','Main floor','Rooms',$3,$4,$5,$6,$7,TRUE)`,
        [id, label, description, JSON.stringify(amenities), capacity, x, y],
      );
    }
  });
}
async function seedEvents(db, options) {
  if (!options.seedDemo) return;
  const count = (await db.query('SELECT COUNT(*)::int AS count FROM events')).rows[0].count;
  if (count > 0) return;
  const rows = [
    ['event-design', 'Designing for focus', 'A short, friendly session on making deep-work time stick.', 0, '10:30', '11:15', 'Meeting Room B', 'Learning'],
    ['event-lunch', 'Community lunch', 'Bring a friend from another team. First round of coffee is on us.', 0, '12:30', '13:30', 'Cafeteria', 'Community'],
    ['event-townhall', 'Monthly town hall', 'Wins, shout-outs and what is coming next.', 2, '16:00', '17:00', 'Collab Lounge', 'Company'],
  ];
  for (const [id, title, description, offset, start, end, venue, category] of rows) {
    await db.query(
      'INSERT INTO events (id, title, description, starts_at, ends_at, venue, category) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, title, description, `${officeDay(offset)}T${start}:00+05:30`, `${officeDay(offset)}T${end}:00+05:30`, venue, category],
    );
  }
}

async function seedContent(db, options) {
  if (!options.seedDemo) return;
  if ((await db.query('SELECT COUNT(*)::int AS count FROM links')).rows[0].count > 0) return;
  const q = (sql, params) => db.query(sql, params);
  const links = [
    ['Employee handbook', 'https://example.com/handbook', 'Policies, leave and everything in between', 'Guides', '📘'],
    ['How to book a desk', 'https://example.com/guide/booking', 'A two-minute walkthrough', 'Guides', '🎬'],
    ['Payroll portal', 'https://example.com/payroll', 'Payslips and tax documents', 'Payments', '💳'],
    ['Reimbursements', 'https://example.com/expenses', 'Submit travel and food claims', 'Payments', '🧾'],
    ['Health insurance portal', 'https://example.com/insurance', 'Cards, claims and hospital list', 'Insurance', '🩺'],
  ];
  for (const [index, [title, url, description, category, emoji]] of links.entries()) {
    await q('INSERT INTO links (id, title, url, description, category, emoji, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [`link-demo-${index}`, title, url, description, category, emoji, index]);
  }
  const contacts = [
    ['Reception', 'Front desk', 'Emergency', '+91 80 0000 0001', 'reception@example.com', '24 x 7', '', '🛎️'],
    ['Security control room', 'Gate and lifts', 'Emergency', '+91 80 0000 0002', '', '24 x 7', 'For lost badges and anything urgent', '🛡️'],
    ['First-aid room', 'Nurse on duty', 'Health', '+91 80 0000 0003', '', 'Mon-Fri 9am to 6pm', '', '🩹'],
    ['Insurance helpdesk', 'Claims support', 'Insurance', '+91 1800 000 000', 'claims@example.com', 'Mon-Sat 9am to 7pm', 'Keep your member ID handy', '📋'],
    ['IT help', 'Laptops, access, Wi-Fi', 'Support', '', 'ithelp@example.com', 'Mon-Fri 9am to 6pm', '', '💻'],
  ];
  for (const [index, [name, roleTitle, category, phone, email, hours, notes, emoji]] of contacts.entries()) {
    await q('INSERT INTO contacts (id, name, role_title, category, phone, email, hours, notes, emoji, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [`contact-demo-${index}`, name, roleTitle, category, phone, email, hours, notes, emoji, index]);
  }
  const menu = [
    ['breakfast', 'Masala dosa', 'With sambar and two chutneys', 'veg', '🥞'], ['breakfast', 'Egg bhurji toast', '', 'egg', '🍳'],
    ['lunch', 'Paneer butter masala', 'Jeera rice, roti, salad', 'veg', '🍛'], ['lunch', 'Chicken biryani', 'With raita', 'non-veg', '🍗'], ['lunch', 'Dal tadka', 'Comfort in a bowl', 'vegan', '🥘'],
    ['snacks', 'Samosa and chai', '', 'veg', '🫖'], ['dinner', 'Veg pulao', '', 'veg', '🍚'],
  ];
  for (let day = 0; day < 5; day += 1) {
    const date = officeDay(day);
    for (const [index, [meal, name, description, diet, emoji]] of menu.entries()) {
      await q('INSERT INTO menu_items (id, menu_date, meal, name, description, diet, emoji) VALUES ($1,$2,$3,$4,$5,$6,$7)', [`dish-demo-${day}-${index}`, date, meal, name, description, diet, emoji]);
    }
  }
  await q("INSERT INTO announcements (id, title, body, emoji, pinned) VALUES ('news-demo-1', 'Welcome to the new office app', 'Book desks, grab lunch, say thanks. Tell us what else you want to see in the idea box.', '🎉', TRUE)");
  await q("INSERT INTO polls (id, question, options) VALUES ('poll-demo-1', 'Team lunch on Friday?', $1)", [JSON.stringify(['Pizza', 'Biryani', 'Sushi', 'Surprise us'])]);
  await q("INSERT INTO kudos (id, from_id, to_id, badge, message) VALUES ('kudos-demo-1', 'emp-noah', 'emp-ava', 'star', 'Ava stayed late to get the launch over the line. Thank you!')");
  await q("UPDATE employees SET joined_on = (CURRENT_DATE - interval '2 years' + interval '2 days')::date WHERE id = 'emp-noah'");
}


// Applies migrations and seeds an empty database. Shared by the Node server and the Cloudflare Worker.
export async function prepareDatabase(db, input = {}, migrations) {
  const env = input.env ?? process.env;
  const options = { ...input, seedDemo: input.seedDemo ?? (env.SEED_DEMO ?? (env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true' };
  await migrate(db, migrations);
  await seedAccounts(db, options);
  await seedSpaces(db, options);
  await seedEvents(db, options);
  await seedContent(db, options);
  return db;
}
