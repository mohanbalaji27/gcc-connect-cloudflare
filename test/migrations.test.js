import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrationFileNames, renderMigrationsModule } from '../scripts/gen-migrations.mjs';

test('every server/migrations/*.sql file is numbered in order and registered for the Worker', () => {
  const names = migrationFileNames();
  assert.ok(names.length > 0);
  names.forEach((name, index) => assert.equal(Number(name.slice(0, 3)), index + 1, `migration numbers must be 001, 002, ... with no gaps (found ${name})`));
  const committed = readFileSync(new URL('../worker/migrations.generated.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, renderMigrationsModule(names), 'worker/migrations.generated.js is out of date. Run: npm run migrations:gen');
});

test('migrations only add things (no destructive statements)', () => {
  for (const name of migrationFileNames().filter((file) => Number(file.slice(0, 3)) > 3)) {
    const sql = readFileSync(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(sql, /\b(DROP\s+(TABLE|COLUMN|INDEX|SCHEMA)|TRUNCATE|DELETE\s+FROM)\b/i, `${name} must be additive`);
  }
});

test('migration 005 keeps existing menu rows and likes, maps them to sections, and can be re-run safely', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate, readMigrationFiles } = await import('../server/setup.js');
  const lite = new PGlite('memory://');
  await lite.waitReady;
  const db = { query: (sql, params) => lite.query(sql, params), exec: (sql) => lite.exec(sql), tx: (fn) => lite.transaction((client) => fn({ query: (sql, params) => client.query(sql, params), exec: (sql) => client.exec(sql) })) };
  try {
    const all = readMigrationFiles();
    await migrate(db, all.filter((migration) => migration.version < 5));
    await db.query("INSERT INTO employees (id, email, name, role, password_hash) VALUES ('e1', 'e1@x.gcc', 'E One', 'user', 'x')");
    const legacy = [['Masala dosa', 'breakfast'], ['Filter coffee', 'breakfast'], ['Gulab jamun', 'lunch'], ['Samosa and chai', 'snacks'], ['Fresh lime juice', 'snacks'], ['Veg pulao', 'dinner']];
    for (const [index, [name, meal]] of legacy.entries()) await db.query("INSERT INTO menu_items (id, menu_date, meal, name, description, diet, emoji) VALUES ($1, '2026-01-05', $2, $3, 'old note', 'egg', '🍛')", [`old-${index}`, meal, name]);
    await db.query("INSERT INTO menu_reactions (item_id, employee_id) VALUES ('old-2', 'e1')");
    await migrate(db, all);
    await migrate(db, all);
    const rows = (await db.query('SELECT name, meal, course, description, diet, emoji, special, sort_order FROM menu_items ORDER BY id')).rows;
    assert.deepEqual(rows.map((row) => [row.name, row.course]), [['Masala dosa', 'mains'], ['Filter coffee', 'drinks'], ['Gulab jamun', 'desserts'], ['Samosa and chai', 'mains'], ['Fresh lime juice', 'drinks'], ['Veg pulao', 'mains']]);
    assert.ok(rows.every((row) => row.description === 'old note' && row.diet === 'egg' && row.emoji === '🍛' && row.special === false && row.sort_order === 0));
    assert.equal(rows[3].meal, 'snacks', 'snacks stays the stored id for "Evening snacks"');
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM menu_reactions WHERE item_id = 'old-2'")).rows[0].n, 1);
    await db.query("INSERT INTO menu_reviews (id, menu_date, meal, employee_id, rating) VALUES ('r1', '2026-01-05', 'snacks', 'e1', 5)");
    await assert.rejects(() => db.query("INSERT INTO menu_reviews (id, menu_date, meal, employee_id, rating) VALUES ('r2', '2026-01-05', 'snacks', 'e1', 4)"), /duplicate key|unique/i);
  } finally {
    await lite.close();
  }
});