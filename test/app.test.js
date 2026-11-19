import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';

let db;
let server;
let baseUrl;
let tempDirectory;

before(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'gcc-connect-test-'));
  db = await openDatabase({ memory: true, inventoryPath: null });
  const planPath = join(tempDirectory, 'floor-plan.pdf');
  writeFileSync(planPath, Buffer.from('%PDF-1.4\n% fixture only'));
  server = createApp(db, { floorPlanPath: planPath, bookingRateLimit: 1000 }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { hashPassword } = await import('../server/security.js');
  await db.query("INSERT INTO employees (id, email, name, team, role, password_hash) VALUES ('emp-sam','sam@demo.gcc','Sam Rivera','Design','user',$1)", [hashPassword('gccdemo')]);
});

beforeEach(async () => {
  await db.exec('DELETE FROM token_redemptions; DELETE FROM idempotency; DELETE FROM bookings; DELETE FROM booking_tokens; DELETE FROM event_rsvps;');
});

after(async () => {
  server.close();
  await db.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function signIn(email = 'ava@demo.gcc', password = 'gccdemo') {
  const response = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrfToken, user: body.user };
}

const call = (session, method, path, body, extra = {}) => fetch(`${baseUrl}/api${path}`, {
  method,
  headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json', ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function futureWindow(offsetHours = 24) {
  const start = new Date(Date.now() + offsetHours * 3_600_000);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString() };
}

const book = (session, resourceId, offsetHours = 24, token) => call(session, 'POST', '/bookings', { resourceId, ...futureWindow(offsetHours), ...(token ? { token } : {}) }, { 'Idempotency-Key': randomUUID() });

test('resource lookup requires an authenticated session', async () => {
  const response = await fetch(`${baseUrl}/api/resources`);
  assert.equal(response.status, 401);
});

test('the source plan is private, session-protected, and not cacheable', async () => {
  assert.equal((await fetch(`${baseUrl}/api/floor-plan`)).status, 401);
  const session = await signIn();
  const response = await fetch(`${baseUrl}/api/floor-plan`, { headers: { Cookie: session.cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/pdf/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
});

test('login exposes only the employee and effective permissions', async () => {
  const user = await signIn();
  assert.equal(user.user.role, 'user');
  assert.deepEqual(user.user.permissions, []);
  assert.equal(user.user.password_hash, undefined);
  const admin = await signIn('noah@demo.gcc');
  assert.ok(admin.user.permissions.includes('events.manage'));
  assert.ok(!admin.user.permissions.includes('users.manage'));
  const root = await signIn('root@demo.gcc');
  assert.ok(root.user.permissions.includes('users.manage'));
  const wrong = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ava@demo.gcc', password: 'nope' }) });
  assert.equal(wrong.status, 401);
});

test('state-changing requests need the CSRF token', async () => {
  const session = await signIn();
  const response = await fetch(`${baseUrl}/api/bookings`, { method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ resourceId: 'room-meeting-a', ...futureWindow() }) });
  assert.equal(response.status, 403);
});

test('concurrent bookings cannot reserve the same space twice', async () => {
  const [ava, sam] = await Promise.all([signIn(), signIn('sam@demo.gcc')]);
  const results = await Promise.all([book(ava, 'room-meeting-a'), book(sam, 'room-meeting-a'), book(ava, 'room-meeting-a'), book(sam, 'room-meeting-a')]);
  const statuses = results.map((response) => response.status).sort();
  assert.equal(statuses.filter((status) => status === 201).length, 1, statuses.join(','));
  const { rows } = await db.query("SELECT COUNT(*)::int AS count FROM bookings WHERE resource_id = 'room-meeting-a' AND status = 'confirmed'");
  assert.equal(rows[0].count, 1);
});

test('one employee cannot hold two desks at the same time', async () => {
  const ava = await signIn();
  const { rows } = await db.query("SELECT id FROM resources WHERE type = 'desk' AND active = TRUE ORDER BY label LIMIT 2");
  assert.equal((await book(ava, rows[0].id)).status, 201);
  const second = await book(ava, rows[1].id);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, 'ALREADY_BOOKED');
});

test('employees cannot cancel others bookings but managers with permission can', async () => {
  const [ava, sam, noah, root] = await Promise.all([signIn(), signIn('sam@demo.gcc'), signIn('noah@demo.gcc'), signIn('root@demo.gcc')]);
  const made = await (await book(ava, 'room-cabin-1', 30)).json();
  assert.equal((await call(sam, 'DELETE', `/bookings/${made.booking.id}`)).status, 403);
  assert.equal((await call(noah, 'DELETE', `/bookings/${made.booking.id}`)).status, 204);
  const again = await (await book(ava, 'room-cabin-1', 30)).json();
  assert.equal((await call(root, 'DELETE', `/bookings/${again.booking.id}`)).status, 204);
});

test('QR codes can be created with no expiry, are reusable, and can be revoked', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  const sam = await signIn('sam@demo.gcc');
  assert.equal((await call(ava, 'POST', '/admin/tokens', { resourceId: 'room-meeting-a', noExpiry: true })).status, 403);
  const created = await call(noah, 'POST', '/admin/tokens', { resourceId: 'room-meeting-b', noExpiry: true, maxRedemptions: null });
  assert.equal(created.status, 201);
  const { token, id } = await created.json();
  const stored = (await db.query('SELECT expires_at, max_redemptions FROM booking_tokens WHERE id = $1', [id])).rows[0];
  assert.equal(stored.expires_at, null);
  assert.equal(stored.max_redemptions, null);
  assert.equal((await book(ava, 'room-meeting-b', 24, token)).status, 201);
  assert.equal((await book(sam, 'room-meeting-b', 30, token)).status, 201);
  assert.equal((await call(noah, 'DELETE', `/admin/tokens/${id}`)).status, 204);
  assert.equal((await book(sam, 'room-meeting-b', 40, token)).status, 403);
});

test('single-use QR codes are consumed only by a successful booking', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  const { token } = await (await call(noah, 'POST', '/admin/tokens', { resourceId: 'room-meeting-c', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxRedemptions: 1 })).json();
  assert.equal((await book(ava, 'room-meeting-a', 24, token)).status, 403);
  assert.equal((await book(ava, 'room-meeting-c', 24, token)).status, 201);
  assert.equal((await book(ava, 'room-meeting-c', 48, token)).status, 403);
});

test('idempotency keys return the original booking and reject changed payloads', async () => {
  const ava = await signIn();
  const key = randomUUID();
  const body = { resourceId: 'room-meeting-a', ...futureWindow() };
  const first = await call(ava, 'POST', '/bookings', body, { 'Idempotency-Key': key });
  const second = await call(ava, 'POST', '/bookings', body, { 'Idempotency-Key': key });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal((await call(ava, 'POST', '/bookings', { ...body, resourceId: 'room-meeting-b' }, { 'Idempotency-Key': key })).status, 409);
});

test('super admin creates users with chosen permissions; users must change the temporary password', async () => {
  const root = await signIn('root@demo.gcc');
  const noah = await signIn('noah@demo.gcc');
  assert.equal((await call(noah, 'POST', '/admin/users', { email: 'x@demo.gcc', name: 'X' })).status, 403);
  const created = await call(root, 'POST', '/admin/users', { email: 'Events.Lead@Demo.gcc', name: 'Events Lead', team: 'HR', role: 'user', permissions: ['events.manage'] });
  assert.equal(created.status, 201);
  const { temporaryPassword } = await created.json();
  assert.equal((await call(root, 'POST', '/admin/users', { email: 'events.lead@demo.gcc', name: 'Dup' })).status, 409);
  const lead = await signIn('events.lead@demo.gcc', temporaryPassword);
  assert.deepEqual(lead.user.permissions, ['events.manage']);
  assert.equal(lead.user.mustChangePassword, true);
  assert.equal((await call(lead, 'GET', '/events')).status, 403);
  const changed = await call(lead, 'POST', '/me/password', { currentPassword: temporaryPassword, newPassword: 'a-much-better-pass' });
  assert.equal(changed.status, 204);
  assert.equal((await call(lead, 'GET', '/events')).status, 200);
  const event = await call(lead, 'POST', '/events', { title: 'Lunch & learn', venue: 'Cafeteria', category: 'Learning', ...futureWindow(48) });
  assert.equal(event.status, 201);
  assert.equal((await call(lead, 'POST', '/admin/tokens', { resourceId: 'room-meeting-a', noExpiry: true })).status, 403);
});

test('only users.manage can change roles, and the final super admin is protected', async () => {
  const root = await signIn('root@demo.gcc');
  const roster = await (await call(root, 'GET', '/admin/users')).json();
  const rootId = roster.users.find((user) => user.email === 'root@demo.gcc').id;
  assert.equal((await call(root, 'PATCH', `/admin/users/${rootId}`, { role: 'admin' })).status, 409);
  assert.equal((await call(root, 'PATCH', `/admin/users/${rootId}`, { active: false })).status, 400);
  const sam = roster.users.find((user) => user.email === 'sam@demo.gcc');
  assert.equal((await call(root, 'PATCH', `/admin/users/${sam.id}`, { role: 'admin' })).status, 204);
  const promoted = await signIn('sam@demo.gcc');
  assert.ok(promoted.user.permissions.includes('events.manage'));
  assert.equal((await call(root, 'PATCH', `/admin/users/${sam.id}`, { role: 'user' })).status, 204);
});

test('events: managers create, edit, and delete; everyone can RSVP', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  assert.equal((await call(ava, 'POST', '/events', { title: 'No', venue: 'X', category: 'Social', ...futureWindow() })).status, 403);
  assert.equal((await call(noah, 'POST', '/events', { title: 'Bad', venue: 'X', category: 'Nope', ...futureWindow() })).status, 400);
  const created = await (await call(noah, 'POST', '/events', { title: 'Game day', venue: 'Cafeteria', category: 'Social', ...futureWindow(72) })).json();
  assert.equal((await call(ava, 'PUT', `/events/${created.id}/rsvp`)).status, 204);
  const listed = await (await call(ava, 'GET', '/events')).json();
  const mine = listed.events.find((event) => event.id === created.id);
  assert.equal(mine.going, true);
  assert.equal(mine.going_count, 1);
  assert.equal((await call(noah, 'PATCH', `/events/${created.id}`, { title: 'Game day!' })).status, 204);
  assert.equal((await call(noah, 'DELETE', `/events/${created.id}`)).status, 204);
});

test('teams are configurable and seats can be assigned to them in bulk', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  assert.equal((await call(ava, 'POST', '/admin/teams', { name: 'Nope', color: '#112233' })).status, 403);
  const made = await call(noah, 'POST', '/admin/teams', { name: 'Platform', color: '#2F9E6F' });
  assert.equal(made.status, 201);
  const { id } = await made.json();
  assert.equal((await call(noah, 'POST', '/admin/teams', { name: 'platform', color: '#2f9e6f' })).status, 409);
  const resources = await (await call(noah, 'GET', '/resources?type=desk')).json();
  const ids = resources.resources.slice(0, 3).map((resource) => resource.id);
  const assigned = await (await call(noah, 'POST', '/admin/teams/assign', { teamId: id, resourceIds: ids })).json();
  assert.equal(assigned.updated, 3);
  const teams = await (await call(ava, 'GET', '/teams')).json();
  assert.equal(teams.teams.find((team) => team.id === id).seatCount, 3);
  assert.equal((await call(noah, 'PATCH', `/admin/teams/${id}`, { name: 'Platform team', color: '#e8772e' })).status, 204);
  assert.equal((await call(noah, 'DELETE', `/admin/teams/${id}`)).status, 204);
});

test('spaces can be created, repositioned, and retired by managers', async () => {
  const noah = await signIn('noah@demo.gcc');
  const created = await call(noah, 'POST', '/admin/resources', { type: 'desk', label: 'Z999', zone: 'Pop-up' });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await call(noah, 'POST', '/admin/resources', { type: 'desk', label: 'z999' })).status, 409);
  assert.equal((await call(noah, 'PATCH', `/admin/resources/${id}`, { x: 12.5, y: 80 })).status, 204);
  assert.equal((await call(noah, 'PATCH', `/admin/resources/${id}`, { x: 120, y: 80 })).status, 400);
  const fetched = await (await call(noah, 'GET', `/resources/${id}`)).json();
  assert.equal(fetched.resource.x, 12.5);
  assert.equal((await call(noah, 'DELETE', `/admin/resources/${id}`)).status, 204);
  assert.equal((await call(noah, 'GET', `/resources/${id}`)).status, 404);
});

test('map calibration re-lays out seats that were not manually placed', async () => {
  const noah = await signIn('noah@demo.gcc');
  const res = await call(noah, 'PUT', '/admin/map/calibration', { calibration: { x0: 10, y0: 10, x1: 60, y1: 60 } });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).updated > 0);
  assert.equal((await call(noah, 'PUT', '/admin/map/calibration', { calibration: { x0: 10, y0: 10, x1: 12, y1: 60 } })).status, 400);
});

test('availability search reflects bookings', async () => {
  const ava = await signIn();
  const window = futureWindow(26);
  await call(ava, 'POST', '/bookings', { resourceId: 'room-meeting-a', ...window }, { 'Idempotency-Key': randomUUID() });
  const sam = await signIn('sam@demo.gcc');
  const listed = await (await call(sam, 'GET', `/resources?type=room&startsAt=${encodeURIComponent(window.startsAt)}&endsAt=${encodeURIComponent(window.endsAt)}`)).json();
  assert.equal(listed.resources.find((resource) => resource.id === 'room-meeting-a').available, false);
  assert.equal(listed.resources.find((resource) => resource.id === 'room-meeting-b').available, true);
});

test('a user manager who is not a super admin cannot escalate to super admin', async () => {
  const root = await signIn('root@demo.gcc');
  const created = await (await call(root, 'POST', '/admin/users', { email: 'hr.lead@demo.gcc', name: 'HR Lead', role: 'user', permissions: ['users.manage', 'events.manage'] })).json();
  const lead = await signIn('hr.lead@demo.gcc', created.temporaryPassword);
  await call(lead, 'POST', '/me/password', { currentPassword: created.temporaryPassword, newPassword: 'a-much-better-pass' });
  const roster = await (await call(root, 'GET', '/admin/users')).json();
  const rootId = roster.users.find((user) => user.email === 'root@demo.gcc').id;
  const leadId = roster.users.find((user) => user.email === 'hr.lead@demo.gcc').id;
  assert.equal((await call(lead, 'POST', '/admin/users', { email: 'x1@demo.gcc', name: 'X1', role: 'super_admin' })).status, 403);
  assert.equal((await call(lead, 'POST', '/admin/users', { email: 'x2@demo.gcc', name: 'X2', role: 'user', permissions: ['users.manage'] })).status, 403);
  assert.equal((await call(lead, 'POST', '/admin/users', { email: 'x3@demo.gcc', name: 'X3', role: 'user', permissions: ['qr.manage'] })).status, 403);
  assert.equal((await call(lead, 'POST', `/admin/users/${rootId}/reset-password`)).status, 403);
  assert.equal((await call(lead, 'PATCH', `/admin/users/${rootId}`, { active: false })).status, 403);
  assert.equal((await call(lead, 'PATCH', `/admin/users/${leadId}`, { role: 'super_admin' })).status, 403);
  assert.equal((await call(lead, 'PATCH', `/admin/users/${leadId}`, { permissions: ['users.manage', 'events.manage', 'qr.manage'] })).status, 403);
  assert.equal((await call(lead, 'PATCH', `/admin/users/${leadId}`, { active: false })).status, 400);
  assert.equal((await call(lead, 'POST', '/admin/users', { email: 'x4@demo.gcc', name: 'X4', role: 'user', permissions: ['events.manage'] })).status, 201);
});

test('one person cannot exceed the booking quota with parallel requests', async () => {
  const ava = await signIn();
  const { rows } = await db.query("SELECT id FROM resources WHERE type = 'room' AND active = TRUE ORDER BY label LIMIT 6");
  const results = await Promise.all(rows.map((row, index) => book(ava, row.id, 24 + index * 3)));
  assert.equal(results.filter((response) => response.status === 201).length, 3);
});

test('retiring a space through PATCH also cancels its upcoming bookings', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  const created = await (await call(noah, 'POST', '/admin/resources', { type: 'room', label: 'Pop-up room', capacity: 4 })).json();
  assert.equal((await book(ava, created.id)).status, 201);
  assert.equal((await call(noah, 'PATCH', `/admin/resources/${created.id}`, { active: false })).status, 204);
  const mine = await (await call(ava, 'GET', '/bookings')).json();
  assert.equal(mine.bookings.filter((booking) => booking.resource_id === created.id).length, 0);
});

test('floor plan can be uploaded by managers and is then served from the database', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 65)]);
  const send = (session) => fetch(`${baseUrl}/api/admin/floor-plan`, { method: 'PUT', headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/pdf' }, body: pdf });
  assert.equal((await send(ava)).status, 403);
  const bad = await fetch(`${baseUrl}/api/admin/floor-plan`, { method: 'PUT', headers: { Cookie: noah.cookie, 'X-CSRF-Token': noah.csrf, 'Content-Type': 'application/pdf' }, body: Buffer.alloc(300, 1) });
  assert.equal(bad.status, 400);
  assert.equal((await send(noah)).status, 204);
  const served = await fetch(`${baseUrl}/api/floor-plan`, { headers: { Cookie: ava.cookie } });
  assert.equal(served.status, 200);
  assert.equal((await served.arrayBuffer()).byteLength, pdf.length);
  await db.query("DELETE FROM app_files WHERE key = 'floor-plan'");
});

test('seat inventory import creates teams, positions seats, and can retire the rest', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  const payload = { seats: [
    { label: 'Q001', team: 'Alpha', row: 1, column: 1, x: 10, y: 20 },
    { label: 'Q002', team: 'Alpha', row: 1, column: 2 },
    { label: 'Q003', team: 'Beta', row: 4, column: 1 },
  ] };
  assert.equal((await call(ava, 'POST', '/admin/inventory/import', payload)).status, 403);
  assert.equal((await call(noah, 'POST', '/admin/inventory/import', { seats: [{ label: '<script>' }] })).status, 400);
  const first = await (await call(noah, 'POST', '/admin/inventory/import', payload)).json();
  assert.equal(first.created, 3);
  assert.equal(first.teamsCreated, 2);
  const again = await (await call(noah, 'POST', '/admin/inventory/import', payload)).json();
  assert.equal(again.updated, 3);
  const listed = await (await call(noah, 'GET', '/resources?q=Q00')).json();
  const q1 = listed.resources.find((resource) => resource.label === 'Q001');
  assert.equal(q1.x, 10);
  assert.equal(q1.team.name, 'Alpha');
  const replaced = await (await call(noah, 'POST', '/admin/inventory/import', { seats: [payload.seats[0]], replace: true })).json();
  assert.ok(replaced.retired >= 3);
  const left = await (await call(noah, 'GET', '/resources?type=desk')).json();
  assert.equal(left.resources.length, 1);
});

test('seat import also brings in rooms with positions', async () => {
  const noah = await signIn('noah@demo.gcc');
  const payload = { seats: [{ label: 'R001', team: 'Gamma', row: 1, column: 1 }], rooms: [{ label: 'Imported Room', x: 20, y: 30, capacity: 5 }] };
  const result = await (await call(noah, 'POST', '/admin/inventory/import', payload)).json();
  assert.equal(result.roomsImported, 1);
  const listed = await (await call(noah, 'GET', '/resources?type=room&q=Imported')).json();
  assert.equal(listed.resources[0].x, 20);
  assert.equal(listed.resources[0].capacity, 5);
});

test('super admin can switch features off and rebrand; others cannot', async () => {
  const root = await signIn('root@demo.gcc');
  const ava = await signIn();
  const noah = await signIn('noah@demo.gcc');
  assert.equal((await call(noah, 'PUT', '/admin/settings', { features: { menu: false } })).status, 403);
  assert.equal((await call(root, 'PUT', '/admin/settings', { features: { nope: true } })).status, 400);
  assert.equal((await call(root, 'PUT', '/admin/settings', { features: { menu: false }, branding: { appName: 'Our Place', accent: 'ocean' } })).status, 200);
  assert.equal((await call(ava, 'GET', '/menu')).status, 404);
  const cfg = await (await call(ava, 'GET', '/config')).json();
  assert.equal(cfg.features.menu, false);
  assert.equal(cfg.branding.appName, 'Our Place');
  assert.equal((await (await fetch(`${baseUrl}/api/public-config`)).json()).branding.appName, 'Our Place');
  assert.equal((await call(root, 'PUT', '/admin/settings', { features: { menu: true }, branding: { appName: 'GCC Connect', accent: 'green' } })).status, 200);
  assert.equal((await call(ava, 'GET', '/menu')).status, 200);
});

test('links and contacts are managed by content managers and reject unsafe addresses', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  assert.equal((await call(ava, 'POST', '/admin/links', { title: 'Guide', url: 'https://example.com' })).status, 403);
  assert.equal((await call(noah, 'POST', '/admin/links', { title: 'Bad', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call(noah, 'POST', '/admin/links', { title: 'Bad', url: 'example.com' })).status, 400);
  const made = await call(noah, 'POST', '/admin/links', { title: 'User guide', url: 'https://example.com/guide', category: 'Guides', emoji: '??' });
  assert.equal(made.status, 201);
  const listed = await (await call(ava, 'GET', '/links')).json();
  assert.equal(listed.links.some((link) => link.title === 'User guide'), true);
  assert.equal((await call(noah, 'POST', '/admin/contacts', { name: 'Reception' })).status, 400);
  assert.equal((await call(noah, 'POST', '/admin/contacts', { name: 'Insurance desk', category: 'Insurance', phone: '+91 80 1234 5678', email: 'help@example.com' })).status, 201);
  assert.equal((await (await call(ava, 'GET', '/contacts')).json()).contacts.some((contact) => contact.name === 'Insurance desk'), true);
});

test('events can carry links', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  const bad = await call(noah, 'POST', '/events', { title: 'Hack day', venue: 'Cafe', category: 'Team', ...futureWindow(60), links: [{ label: 'Agenda', url: 'ftp://x' }] });
  assert.equal(bad.status, 400);
  const ok = await call(noah, 'POST', '/events', { title: 'Hack day', venue: 'Cafe', category: 'Team', ...futureWindow(60), links: [{ label: 'Agenda', url: 'https://example.com/agenda' }] });
  assert.equal(ok.status, 201);
  const events = await (await call(ava, 'GET', '/events')).json();
  assert.equal(events.events.find((event) => event.title === 'Hack day').links[0].label, 'Agenda');
});

test('food menu: managers add dishes for several days, everyone can like', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await call(ava, 'POST', '/admin/menu', { date: today, meal: 'lunch', name: 'Dal' })).status, 403);
  assert.equal((await call(noah, 'POST', '/admin/menu', { dates: [today], meal: 'brunch', name: 'Dal' })).status, 400);
  const added = await (await call(noah, 'POST', '/admin/menu', { dates: [today], meal: 'lunch', name: 'Paneer wrap', diet: 'veg', emoji: '??' })).json();
  assert.equal(added.added, 1);
  const menu = await (await call(ava, 'GET', `/menu?from=${today}&days=2`)).json();
  const item = menu.items.find((entry) => entry.name === 'Paneer wrap');
  assert.ok(item);
  assert.equal((await (await call(ava, 'POST', `/menu/${item.id}/like`)).json()).liked, true);
  assert.equal((await (await call(ava, 'POST', `/menu/${item.id}/like`)).json()).liked, false);
});

test('kudos, polls and feedback work and respect permissions', async () => {
  const ava = await signIn();
  const sam = await signIn('sam@demo.gcc');
  const noah = await signIn('noah@demo.gcc');
  assert.equal((await call(ava, 'POST', '/kudos', { toId: ava.user.id, message: 'me' })).status, 400);
  const sent = await call(ava, 'POST', '/kudos', { toId: sam.user.id, badge: 'helper', message: 'Thanks for the help!' });
  assert.equal(sent.status, 201);
  const { id } = await sent.json();
  assert.equal((await (await call(sam, 'POST', `/kudos/${id}/cheer`)).json()).cheered, true);
  const wall = await (await call(sam, 'GET', '/kudos')).json();
  assert.equal(wall.kudos[0].cheers, 1);
  assert.equal((await call(sam, 'DELETE', `/kudos/${id}`)).status, 403);

  assert.equal((await call(ava, 'POST', '/admin/polls', { question: 'Pizza?', options: ['Yes', 'No'] })).status, 403);
  assert.equal((await call(noah, 'POST', '/admin/polls', { question: 'Pizza?', options: ['Yes'] })).status, 400);
  const poll = await (await call(noah, 'POST', '/admin/polls', { question: 'Pizza Friday?', options: ['Yes', 'No'] })).json();
  assert.equal((await call(ava, 'POST', `/polls/${poll.id}/vote`, { option: 5 })).status, 400);
  assert.equal((await call(ava, 'POST', `/polls/${poll.id}/vote`, { option: 0 })).status, 204);
  assert.equal((await call(ava, 'POST', `/polls/${poll.id}/vote`, { option: 1 })).status, 204);
  const polls = await (await call(sam, 'GET', '/polls')).json();
  const mine = polls.polls.find((entry) => entry.id === poll.id);
  assert.deepEqual(mine.counts, [0, 1]);
  assert.equal((await call(noah, 'POST', `/admin/polls/${poll.id}/close`)).status, 204);
  assert.equal((await call(sam, 'POST', `/polls/${poll.id}/vote`, { option: 0 })).status, 409);

  assert.equal((await call(ava, 'POST', '/feedback', { message: 'More plants please', category: 'Idea' })).status, 201);
  assert.equal((await call(ava, 'GET', '/admin/feedback')).status, 403);
  const inbox = await (await call(noah, 'GET', '/admin/feedback')).json();
  assert.equal(inbox.feedback[0].from_name, null);
});

test('celebrations, who is in, vibes and profile', async () => {
  const ava = await signIn();
  const soon = new Date(Date.now() + 3 * 86_400_000);
  const profile = await call(ava, 'PATCH', '/me/profile', { avatar: '??', birthMonth: soon.getUTCMonth() + 1, birthDay: soon.getUTCDate() });
  assert.equal(profile.status, 200);
  assert.equal((await call(ava, 'PATCH', '/me/profile', { birthMonth: 2, birthDay: 31 })).status, 400);
  const celebrations = await (await call(ava, 'GET', '/celebrations')).json();
  assert.ok(celebrations.celebrations.some((entry) => entry.kind === 'birthday' && entry.name === 'Ava Chen'));
  await book(ava, 'room-meeting-a', 1);
  const vibes = await (await call(ava, 'GET', '/me/vibes')).json();
  assert.ok(vibes.badges.find((badge) => badge.id === 'first').earned);
  assert.equal(vibes.level.name, 'Newcomer');
  const { rows } = await db.query("SELECT id FROM resources WHERE type = 'desk' AND active = TRUE LIMIT 1");
  const soonStart = new Date(Date.now() + 5 * 60_000).toISOString();
  const deskBooking = await call(ava, 'POST', '/bookings', { resourceId: rows[0].id, startsAt: soonStart, endsAt: new Date(Date.now() + 3_600_000).toISOString() }, { 'Idempotency-Key': randomUUID() });
  assert.equal(deskBooking.status, 201);
  const sam = await signIn('sam@demo.gcc');
  const here = await (await call(sam, 'GET', '/whosin')).json();
  assert.ok(here.people.some((person) => person.name === 'Ava Chen' && person.avatar === '??'));
  await call(ava, 'PATCH', '/me/profile', { showInWhosin: false });
  const hidden = await (await call(sam, 'GET', '/whosin')).json();
  assert.equal(hidden.people.some((person) => person.name === 'Ava Chen'), false);
  assert.ok(hidden.hidden >= 1);
});

test('insights dashboard needs the insights permission', async () => {
  const ava = await signIn();
  const root = await signIn('root@demo.gcc');
  assert.equal((await call(ava, 'GET', '/admin/insights')).status, 403);
  const res = await call(root, 'GET', '/admin/insights');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.trend.length, 21);
  assert.ok(data.totals.desks >= 1);
  assert.equal(data.weekdays.length, 7);
});

test('custom roles grant permissions through a template, and only super admin manages them', async () => {
  const root = await signIn('root@demo.gcc');
  const noah = await signIn('noah@demo.gcc');
  assert.equal((await call(noah, 'GET', '/admin/roles')).status, 403);
  const created = await call(root, 'POST', '/admin/roles', { name: 'Canteen crew', emoji: '??', permissions: ['menu.manage'] });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await call(root, 'POST', '/admin/roles', { name: 'canteen crew', permissions: [] })).status, 409);
  assert.equal((await call(root, 'POST', '/admin/roles', { name: 'Weird', permissions: ['root.everything'] })).status, 400);
  const person = await (await call(root, 'POST', '/admin/users', { email: 'chef@demo.gcc', name: 'Chef', role: 'user', customRoleId: id })).json();
  const chef = await signIn('chef@demo.gcc', person.temporaryPassword);
  assert.ok(chef.user.permissions.includes('menu.manage'));
  assert.equal(chef.user.permissions.includes('events.manage'), false);
  await call(chef, 'POST', '/me/password', { currentPassword: person.temporaryPassword, newPassword: 'a-much-better-pass' });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await call(chef, 'POST', '/admin/menu', { date: today, meal: 'snacks', name: 'Samosa' })).status, 201);
  await call(root, 'PATCH', `/admin/roles/${id}`, { permissions: [] });
  assert.equal((await call(chef, 'POST', '/admin/menu', { date: today, meal: 'snacks', name: 'Vada' })).status, 403);
  assert.equal((await call(noah, 'PATCH', `/admin/users/${person.id}`, { customRoleId: 'role-hr' })).status, 403);
  assert.equal((await call(root, 'DELETE', `/admin/roles/${id}`)).status, 204);
});

test('impossible dates and header-injecting emails are rejected', async () => {
  const noah = await signIn('noah@demo.gcc');
  const root = await signIn('root@demo.gcc');
  assert.equal((await call(noah, 'POST', '/admin/menu', { date: '2026-02-31', meal: 'lunch', name: 'Ghost dish' })).status, 400);
  assert.equal((await call(root, 'POST', '/admin/users', { email: 'dated@demo.gcc', name: 'Dated', joinedOn: '2026-02-31' })).status, 400);
  assert.equal((await call(noah, 'POST', '/admin/contacts', { name: 'Sneaky', email: 'a@b.co?bcc=evil@example.com' })).status, 400);
});

test('the manage bypass only covers GET reads of the area a manager runs', async () => {
  const root = await signIn('root@demo.gcc');
  const ava = await signIn();
  const chef = await (await call(root, 'POST', '/admin/users', { email: 'menu.only@demo.gcc', name: 'Menu Only', permissions: ['menu.manage'] })).json();
  const menuOnly = await signIn('menu.only@demo.gcc', chef.temporaryPassword);
  await call(menuOnly, 'POST', '/me/password', { currentPassword: chef.temporaryPassword, newPassword: 'a-much-better-pass' });
  await call(root, 'PUT', '/admin/settings', { features: { kudos: false, menu: false } });
  try {
    assert.equal((await call(ava, 'GET', '/menu')).status, 404);
    assert.equal((await call(menuOnly, 'GET', '/menu?manage=1')).status, 200);
    assert.equal((await call(ava, 'GET', '/menu?manage=1')).status, 404);
    assert.equal((await call(menuOnly, 'GET', '/kudos?manage=1')).status, 404);
    assert.equal((await call(menuOnly, 'POST', '/kudos?manage=1', { toId: ava.user.id, message: 'hi' })).status, 404);
  } finally {
    await call(root, 'PUT', '/admin/settings', { features: { kudos: true, menu: true } });
  }
});

test('map layout saves moves and team changes in one batch, and logs it', async () => {
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  const desks = (await (await call(noah, 'GET', '/resources?type=desk')).json()).resources.slice(0, 2);
  const team = await (await call(noah, 'POST', '/admin/teams', { name: 'Batch team', color: '#112233' })).json();
  const body = { moves: [{ id: desks[0].id, x: 11.5, y: 22.5 }], assignments: [{ teamId: team.id, resourceIds: [desks[0].id, desks[1].id] }] };
  assert.equal((await call(ava, 'PUT', '/admin/map/layout', body)).status, 403);
  assert.equal((await call(noah, 'PUT', '/admin/map/layout', { moves: [{ id: desks[0].id, x: 500, y: 1 }] })).status, 400);
  const saved = await (await call(noah, 'PUT', '/admin/map/layout', body)).json();
  assert.deepEqual(saved, { moved: 1, assigned: 2, relabelled: 0 });
  const after = (await (await call(noah, 'GET', `/resources/${desks[0].id}`)).json()).resource;
  assert.equal(after.x, 11.5);
  assert.equal(after.team.id, team.id);
  const log = await db.query("SELECT detail FROM audit_log WHERE action = 'map.saved' ORDER BY created_at DESC LIMIT 1");
  assert.match(log.rows[0].detail, /1 seats moved/);
});

test('activity log and bookings export as safe CSV for the right people', async () => {
  const root = await signIn('root@demo.gcc');
  const noah = await signIn('noah@demo.gcc');
  const ava = await signIn();
  assert.equal((await call(ava, 'GET', '/admin/audit/export')).status, 403);
  assert.equal((await call(noah, 'GET', '/admin/audit/export')).status, 403);
  await call(root, 'POST', '/admin/teams', { name: '=HYPERLINK("x")', color: '#445566' });
  const res = await call(root, 'GET', '/admin/audit/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const text = await res.text();
  assert.ok(text.includes('Time (UTC)'));
  assert.ok(text.includes('"\'=HYPERLINK'));
  assert.equal((await call(noah, 'GET', '/admin/bookings/export')).status, 200);
  assert.equal((await call(ava, 'GET', '/admin/bookings/export')).status, 403);
});

// ---------- Bootstrap, pulse and config version ----------
const getRaw = (session, path, headers = {}) => {
  // node:http, not fetch: fetch adds "Cache-Control: no-cache" to conditional requests, which (correctly) defeats a 304.
  if (!headers['If-None-Match']) return fetch(`${baseUrl}/api${path}`, { headers: { Cookie: session.cookie, ...headers } });
  return new Promise((resolve, reject) => {
    httpGet(`${baseUrl}/api${path}`, { headers: { Cookie: session.cookie, ...headers } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); }).on('error', reject);
  });
};
const officeDay = (offsetDays) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offsetDays * 86_400_000));

test('bootstrap returns everything the app needs after sign-in in one call, with an ETag', async () => {
  assert.equal((await fetch(`${baseUrl}/api/bootstrap`)).status, 401);
  const ava = await signIn();
  const response = await getRaw(ava, '/bootstrap');
  assert.equal(response.status, 200);
  const boot = await response.json();
  assert.equal(boot.user.email, 'ava@demo.gcc');
  assert.equal(typeof boot.configVersion, 'number');
  assert.equal(boot.config.features.kudos, true);
  assert.equal(boot.config.options.eventsRsvpEnabled, true);
  assert.equal(boot.config.options.showBookerNames, false);
  assert.ok(Array.isArray(boot.teams));
  assert.equal(typeof boot.unassignedSeats, 'number');
  assert.equal(boot.map.floorPlanAvailable, true);
  assert.equal(typeof boot.summary.desksTotal, 'number');
  const etag = response.headers.get('etag');
  assert.ok(etag);
  assert.match(response.headers.get('cache-control'), /private/);
  assert.equal((await getRaw(ava, '/bootstrap', { 'If-None-Match': etag })).status, 304);
});

test('pulse is cheap, needs a session, and the config version moves when settings change (kudos wall off and on)', async () => {
  assert.equal((await fetch(`${baseUrl}/api/pulse`)).status, 401);
  const [ava, root] = await Promise.all([signIn(), signIn('root@demo.gcc')]);
  const before = await (await getRaw(ava, '/pulse')).json();
  assert.equal(typeof before.configVersion, 'number');
  assert.equal((await (await getRaw(ava, '/bootstrap')).json()).config.features.kudos, true);
  assert.equal((await getRaw(ava, '/kudos')).status, 200);

  const off = await call(root, 'PUT', '/admin/settings', { features: { kudos: false } });
  assert.equal(off.status, 200);
  const offBody = await off.json();
  assert.ok(offBody.configVersion > before.configVersion);
  assert.equal(off.headers.get('x-config-version'), String(offBody.configVersion));

  // Another person sees the new version on their very next pulse, and the new flags after reloading bootstrap.
  const during = await getRaw(ava, '/pulse');
  assert.equal((await during.json()).configVersion, offBody.configVersion);
  assert.equal(during.headers.get('x-config-version'), String(offBody.configVersion));
  assert.equal((await (await getRaw(ava, '/bootstrap')).json()).config.features.kudos, false);
  assert.equal((await getRaw(ava, '/kudos')).status, 404);

  const on = await (await call(root, 'PUT', '/admin/settings', { features: { kudos: true } })).json();
  assert.ok(on.configVersion > offBody.configVersion);
  assert.equal((await (await getRaw(ava, '/pulse')).json()).configVersion, on.configVersion);
  assert.equal((await (await getRaw(ava, '/bootstrap')).json()).config.features.kudos, true);
  assert.equal((await getRaw(ava, '/kudos')).status, 200);
});

test('teams, spaces and the map also bump the config version; plain bookings do not', async () => {
  const [ava, noah] = await Promise.all([signIn(), signIn('noah@demo.gcc')]);
  const version = async () => (await (await getRaw(ava, '/pulse')).json()).configVersion;
  const start = await version();
  await book(ava, 'room-cabin-2', 50);
  assert.equal(await version(), start);
  await call(noah, 'POST', '/admin/teams', { name: 'Version bump team', color: '#abcdef' });
  assert.ok(await version() > start);
});

test('super admin options: RSVP can be switched off for events and booker names switched on for availability', async () => {
  const [ava, sam, noah, root] = await Promise.all([signIn(), signIn('sam@demo.gcc'), signIn('noah@demo.gcc'), signIn('root@demo.gcc')]);
  assert.equal((await call(noah, 'PUT', '/admin/settings', { options: { eventsRsvpEnabled: false } })).status, 403);
  assert.equal((await call(root, 'PUT', '/admin/settings', { options: { nope: true } })).status, 400);
  const created = await (await call(noah, 'POST', '/events', { title: 'RSVP test', venue: 'Cafe', category: 'Social', ...futureWindow(80) })).json();
  assert.equal((await call(ava, 'PUT', `/events/${created.id}/rsvp`)).status, 204);
  try {
    assert.equal((await call(root, 'PUT', '/admin/settings', { options: { eventsRsvpEnabled: false } })).status, 200);
    assert.equal((await call(sam, 'PUT', `/events/${created.id}/rsvp`)).status, 403);
    assert.equal((await call(ava, 'DELETE', `/events/${created.id}/rsvp`)).status, 403);
    const listed = await (await call(ava, 'GET', '/events')).json();
    const mine = listed.events.find((event) => event.id === created.id);
    assert.equal(listed.rsvpEnabled, false);
    assert.equal(mine.going, false);
    assert.equal(mine.going_count, 0);
  } finally {
    await call(root, 'PUT', '/admin/settings', { options: { eventsRsvpEnabled: true } });
  }
  assert.equal((await call(sam, 'PUT', `/events/${created.id}/rsvp`)).status, 204);
  assert.equal((await (await call(sam, 'GET', '/events')).json()).events.find((event) => event.id === created.id).going_count, 2);
});

// ---------- Availability ----------
test('availability returns compact busy intervals per space, with a private ETag and no names by default', async () => {
  const [ava, sam, noah, root] = await Promise.all([signIn(), signIn('sam@demo.gcc'), signIn('noah@demo.gcc'), signIn('root@demo.gcc')]);
  const day = officeDay(2);
  assert.equal((await fetch(`${baseUrl}/api/availability?date=${day}`)).status, 401);
  for (const bad of ['', '?date=nope', '?date=2020-01-01', '?date=2099-01-01', '?date=2026-02-30']) assert.equal((await getRaw(ava, `/availability${bad}`)).status, 400, bad);

  const make = (session, resourceId, from, to) => call(session, 'POST', '/bookings', { resourceId, startsAt: `${day}T${from}:00+05:30`, endsAt: `${day}T${to}:00+05:30` }, { 'Idempotency-Key': randomUUID() });
  assert.equal((await make(ava, 'room-cabin-1', '09:00', '10:30')).status, 201);
  assert.equal((await make(sam, 'room-cabin-1', '14:00', '15:00')).status, 201);

  const response = await getRaw(sam, `/availability?date=${day}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /private/);
  const body = await response.json();
  assert.equal(body.date, day);
  assert.equal(body.showNames, false);
  assert.deepEqual(body.busy['room-cabin-1'], [[540, 630, 0], [840, 900, 1]]);
  assert.equal(body.busy['room-cabin-2'], undefined);
  assert.equal((await getRaw(sam, `/availability?date=${day}`, { 'If-None-Match': response.headers.get('etag') })).status, 304);

  // Managers always see names; everyone does when a super admin allows it.
  assert.equal((await (await getRaw(noah, `/availability?date=${day}`)).json()).busy['room-cabin-1'][0][3], 'Ava Chen');
  try {
    await call(root, 'PUT', '/admin/settings', { options: { showBookerNames: true } });
    const named = await (await getRaw(sam, `/availability?date=${day}`)).json();
    assert.equal(named.showNames, true);
    assert.equal(named.busy['room-cabin-1'][0][3], 'Ava Chen');
  } finally {
    await call(root, 'PUT', '/admin/settings', { options: { showBookerNames: false } });
  }

  await call(ava, 'DELETE', `/bookings/${(await (await call(ava, 'GET', '/bookings')).json()).bookings[0].id}`);
  assert.deepEqual((await (await getRaw(sam, `/availability?date=${day}`)).json()).busy['room-cabin-1'], [[840, 900, 1]]);
});

test('a booking that runs past midnight shows up on both days, clipped to each', async () => {
  const ava = await signIn();
  const day = officeDay(3);
  const next = officeDay(4);
  const made = await call(ava, 'POST', '/bookings', { resourceId: 'room-collab-2', startsAt: `${day}T22:00:00+05:30`, endsAt: `${next}T02:00:00+05:30` }, { 'Idempotency-Key': randomUUID() });
  assert.equal(made.status, 201);
  assert.deepEqual((await (await getRaw(ava, `/availability?date=${day}`)).json()).busy['room-collab-2'], [[1320, 1440, 1]]);
  assert.deepEqual((await (await getRaw(ava, `/availability?date=${next}`)).json()).busy['room-collab-2'], [[0, 120, 1]]);
});

// ---------- Booking logic audit ----------
test('bookings that already ended cannot be cancelled, and cancelling twice is a clean 404', async () => {
  const [ava, noah] = await Promise.all([signIn(), signIn('noah@demo.gcc')]);
  await db.query("INSERT INTO bookings (id, employee_id, resource_id, starts_at, ends_at) VALUES ('old-booking', $1, 'room-meeting-a', now() - interval '3 hours', now() - interval '2 hours')", [ava.user.id]);
  const ended = await call(ava, 'DELETE', '/bookings/old-booking');
  assert.equal(ended.status, 409);
  assert.equal((await ended.json()).error.code, 'BOOKING_ENDED');
  assert.equal((await call(noah, 'DELETE', '/bookings/old-booking')).status, 409);
  const made = await (await book(ava, 'room-meeting-b', 26)).json();
  const [one, two] = await Promise.all([call(ava, 'DELETE', `/bookings/${made.booking.id}`), call(noah, 'DELETE', `/bookings/${made.booking.id}`)]);
  assert.deepEqual([one.status, two.status].sort(), [204, 404]);
  const logged = await db.query("SELECT COUNT(*)::int AS count FROM audit_log WHERE action = 'booking.cancelled' AND entity_id = $1", [made.booking.id]);
  assert.equal(logged.rows[0].count, 1);
});

test('replaying an idempotency key after the booking was cancelled does not pretend it is still booked', async () => {
  const ava = await signIn();
  const key = randomUUID();
  const body = { resourceId: 'room-meeting-c', ...futureWindow(28) };
  const first = await (await call(ava, 'POST', '/bookings', body, { 'Idempotency-Key': key })).json();
  assert.equal((await call(ava, 'DELETE', `/bookings/${first.booking.id}`)).status, 204);
  const replay = await call(ava, 'POST', '/bookings', body, { 'Idempotency-Key': key });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, 'BOOKING_CANCELLED');
  assert.equal((await call(ava, 'POST', '/bookings', body, { 'Idempotency-Key': randomUUID() })).status, 201);
});

test('the booking quota also counts a booking that is in progress right now', async () => {
  const ava = await signIn();
  for (const [index, room] of ['room-meeting-a', 'room-meeting-b', 'room-meeting-c'].entries()) {
    await db.query("INSERT INTO bookings (id, employee_id, resource_id, starts_at, ends_at) VALUES ($1, $2, $3, now() - interval '10 minutes', now() + interval '50 minutes')", [`live-${index}`, ava.user.id, room]);
  }
  const blocked = await book(ava, 'room-cabin-1', 24);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'BOOKING_QUOTA');
});

test('a single-use QR can only be redeemed once even when two people scan it at the same moment', async () => {
  const [noah, ava, sam] = await Promise.all([signIn('noah@demo.gcc'), signIn(), signIn('sam@demo.gcc')]);
  const { token } = await (await call(noah, 'POST', '/admin/tokens', { resourceId: 'room-collab-3', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxRedemptions: 1 })).json();
  const results = await Promise.all([book(ava, 'room-collab-3', 24, token), book(sam, 'room-collab-3', 30, token)]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 403]);
  const row = (await db.query("SELECT redemption_count FROM booking_tokens WHERE max_redemptions = 1 AND resource_id = 'room-collab-3' ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.equal(row.redemption_count, 1);
});

test('retiring a space cancels its bookings, and the space disappears from availability and cannot be booked', async () => {
  const [noah, ava] = await Promise.all([signIn('noah@demo.gcc'), signIn()]);
  const created = await (await call(noah, 'POST', '/admin/resources', { type: 'room', label: 'Retire me room', capacity: 4 })).json();
  const made = await (await book(ava, created.id, 24)).json();
  assert.ok(made.booking.id);
  assert.equal((await call(noah, 'DELETE', `/admin/resources/${created.id}`)).status, 204);
  assert.equal((await book(ava, created.id, 48)).status, 404);
  const day = officeDay(1);
  assert.equal((await (await getRaw(ava, `/availability?date=${day}`)).json()).busy[created.id], undefined);
  assert.equal((await (await call(ava, 'GET', '/bookings')).json()).bookings.some((row) => row.resource_id === created.id), false);
});

test('seat label placement can be set per seat or in a batch, and only from the allowed sides', async () => {
  const [noah, ava] = await Promise.all([signIn('noah@demo.gcc'), signIn()]);
  const desks = (await (await call(noah, 'GET', '/resources?type=desk')).json()).resources.slice(0, 2);
  assert.equal(desks[0].labelSide, null);
  assert.equal((await call(noah, 'PATCH', `/admin/resources/${desks[0].id}`, { labelSide: 'diagonal' })).status, 400);
  assert.equal((await call(noah, 'PATCH', `/admin/resources/${desks[0].id}`, { labelSide: 'left' })).status, 204);
  assert.equal((await (await call(ava, 'GET', `/resources/${desks[0].id}`)).json()).resource.labelSide, 'left');
  assert.equal((await call(ava, 'PUT', '/admin/map/layout', { labels: [{ id: desks[1].id, side: 'top' }] })).status, 403);
  assert.equal((await call(noah, 'PUT', '/admin/map/layout', { labels: [{ id: desks[1].id, side: 'sideways' }] })).status, 400);
  const saved = await (await call(noah, 'PUT', '/admin/map/layout', { labels: [{ id: desks[0].id, side: null }, { id: desks[1].id, side: 'top' }] })).json();
  assert.equal(saved.relabelled, 2);
  const after = (await (await call(noah, 'GET', '/resources?type=desk')).json()).resources;
  assert.equal(after.find((r) => r.id === desks[0].id).labelSide, null);
  assert.equal(after.find((r) => r.id === desks[1].id).labelSide, 'top');
});
