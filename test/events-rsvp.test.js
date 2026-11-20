import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';

let db;
let server;
let baseUrl;
let tempDirectory;

function futureWindow(hoursAhead = 24, durationHours = 2) {
  const start = new Date(Date.now() + hoursAhead * 3600 * 1000);
  const end = new Date(start.getTime() + durationHours * 3600 * 1000);
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

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

const call = (session, method, path, body) =>
  fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

before(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'gcc-events-test-'));
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

test('per-event RSVP: creation with rsvp_enabled=false prevents RSVPing, editing restores it', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn('ava@demo.gcc');

  // Create an event with RSVP explicitly disabled
  const res = await call(noah, 'POST', '/events', {
    title: 'Executive Broadcast',
    venue: 'Auditorium',
    category: 'Company',
    rsvp_enabled: false,
    ...futureWindow(48),
  });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  assert.ok(id);

  // Attempting to RSVP returns 403 Forbidden
  const rsvpBlocked = await call(ava, 'PUT', `/events/${id}/rsvp`);
  assert.equal(rsvpBlocked.status, 403);
  const errBody = await rsvpBlocked.json();
  assert.equal(errBody.error?.code, 'RSVP_DISABLED');

  // Verify event list reflects rsvp_enabled: false and going: false
  const list1 = await (await call(ava, 'GET', '/events')).json();
  const event1 = list1.events.find((e) => e.id === id);
  assert.ok(event1);
  assert.equal(event1.rsvp_enabled, false);
  assert.equal(event1.going, false);
  assert.equal(event1.going_count, 0);

  // Manager edits event to enable RSVPs
  const editRes = await call(noah, 'PATCH', `/events/${id}`, { rsvp_enabled: true });
  assert.equal(editRes.status, 204);

  // Ava can now successfully RSVP
  const rsvpSuccess = await call(ava, 'PUT', `/events/${id}/rsvp`);
  assert.equal(rsvpSuccess.status, 204);

  // Verify list reflects that Ava is going
  const list2 = await (await call(ava, 'GET', '/events')).json();
  const event2 = list2.events.find((e) => e.id === id);
  assert.equal(event2.rsvp_enabled, true);
  assert.equal(event2.going, true);
  assert.equal(event2.going_count, 1);

  // Clean up
  await call(noah, 'DELETE', `/events/${id}`);
});
