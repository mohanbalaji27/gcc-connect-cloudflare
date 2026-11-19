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
