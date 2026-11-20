import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { OFFICE_TIPS, getDailyTip, getRandomTip, getLoginTip } from '../server/tips.js';

let db;
let server;
let baseUrl;
let tempDirectory;

async function signIn(email = 'ava@demo.gcc', password = 'gccdemo') {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { cookie: response.headers.get('set-cookie')?.split(';')[0], csrf: body.csrfToken };
}

before(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'gcc-sec-test-'));
  db = await openDatabase({ memory: true, inventoryPath: null });
  const planPath = join(tempDirectory, 'floor-plan.pdf');
  writeFileSync(planPath, Buffer.from('%PDF-1.4\n% fixture only'));
  server = createApp(db, { floorPlanPath: planPath, bookingRateLimit: 1000 }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await db?.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

test('tips: library has over 100 office tips and functions return strings', () => {
  assert.ok(OFFICE_TIPS.length >= 100, `Expected >= 100 tips, got ${OFFICE_TIPS.length}`);
  const daily = getDailyTip();
  assert.ok(daily && typeof daily === 'string');
  const random = getRandomTip();
  assert.ok(random && typeof random === 'string');
  const login = getLoginTip();
  assert.ok(login && typeof login === 'string');
});

test('cache-control: /api routes return private, no-store headers by default', async () => {
  const ava = await signIn('ava@demo.gcc');
  const res = await fetch(`${baseUrl}/api/contacts?manage=1`, {
    headers: { Cookie: ava.cookie, 'X-CSRF-Token': ava.csrf },
  });
  assert.equal(res.status, 200);
  const cacheControl = res.headers.get('cache-control');
  assert.ok(cacheControl?.includes('no-store'), `Expected no-store in Cache-Control, got ${cacheControl}`);
});

test('manifest: /manifest.webmanifest serves valid JSON with app metadata', async () => {
  const res = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('application/manifest+json'));
  const manifest = await res.json();
  assert.ok(manifest.name);
  assert.ok(manifest.theme_color);
  assert.ok(manifest.icons?.length > 0);
});

test('security: password length enforcement honors security.passwordMinLength', async () => {
  const ava = await signIn('ava@demo.gcc');
  // Attempt to set a 6-character password when minLength is 10
  const shortPass = await fetch(`${baseUrl}/api/me/password`, {
    method: 'POST',
    headers: {
      Cookie: ava.cookie,
      'X-CSRF-Token': ava.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ currentPassword: 'gccdemo', newPassword: 'short' }),
  });
  assert.equal(shortPass.status, 400);
  const err = await shortPass.json();
  assert.equal(err.error?.code, 'WEAK_PASSWORD');
});
