import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/security.js';
import { ACTIONS, AREAS, EXPORT_CAP, areaOf, describe } from '../server/activity.js';

let db;
let server;
let baseUrl;

const RANGE = 'from=2026-03-01T00:00:00Z&to=2026-03-10T00:00:00Z';
const log = (id, actor, action, entity, detail, at) => db.query('INSERT INTO audit_log (id, actor_id, action, entity_id, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, actor, action, entity, detail, new Date(at)]);

before(async () => {
  db = await openDatabase({ memory: true, inventoryPath: null });
  server = createApp(db, { bookingRateLimit: 1000 }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const password = hashPassword('gccdemo');
  for (const [id, name, active] of [['ta-x', 'Zed Admin', true], ['ta-y', 'Yan Manager', true], ['ta-gone', 'Zed Gone', false], ['ta-burst', 'Burst Target', true]]) {
    await db.query("INSERT INTO employees (id, email, name, role, password_hash, active) VALUES ($1,$2,$3,'user',$4,$5)", [id, `${id}@t.gcc`, name, password, active]);
  }
  await db.exec("DELETE FROM audit_log; DELETE FROM login_events;");
  await log('al-01', 'ta-x', 'booking.created', 'b1', 'Desk A-12', '2026-03-01T05:00:00Z');
  await log('al-02', 'ta-x', 'booking.cancelled', 'b1', 'own booking', '2026-03-01T06:00:00Z');
  await log('al-03', 'ta-y', 'event.created', 'e1', 'Town hall', '2026-03-02T05:00:00Z');
  await log('al-04', 'ta-y', 'settings.updated', null, 'kudos on', '2026-03-03T05:00:00Z');
  await log('al-05', 'ta-x', 'user.updated', 'ta-y', 'admin, permissions changed', '2026-03-04T05:00:00Z');
  await log('al-06', 'ta-y', 'menu.day-saved', '2026-03-05', '12 dishes (+12 -0 ~0)', '2026-03-05T10:00:00Z');
  await log('al-07', null, 'security.login-burst', 'ta-x', 'sign-in paused for 15 minutes', '2026-03-06T05:00:00Z');
  await log('al-08', 'ta-x', 'contact.created', 'c1', 'Reception', '2026-03-07T05:00:00Z');
  await log('al-09', 'ta-x', 'weird.unknown', null, 'x', '2026-03-08T05:00:00Z');
  await log('al-10', 'ta-x', 'user.created', 'u1', '=HYPERLINK("http://evil")', '2026-03-09T05:00:00Z');
  await log('al-11', 'ta-x', 'link.created', 'l1', 'Wiki', '2026-03-09T12:00:00Z');
  await log('al-12', 'ta-y', 'link.deleted', 'l2', 'Old page', '2026-03-09T12:00:00Z'); // same instant as al-11
  for (const [who, at] of [['ta-x', '2026-03-01T04:00:00Z'], ['ta-y', '2026-03-02T04:00:00Z'], ['ta-x', '2026-03-05T04:00:00Z']]) await db.query('INSERT INTO login_events (employee_id, at) VALUES ($1,$2)', [who, new Date(at)]);
});

after(async () => {
  server.close();
  await db.close();
});

async function signIn(login = 'ava@demo.gcc') {
  const response = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: 'gccdemo' }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrfToken };
}
const call = (session, method, path, body) => fetch(`${baseUrl}/api${path}`, {
  method, headers: { ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), 'Content-Type': 'application/json', ...(method === 'POST' && path === '/bookings' ? { 'Idempotency-Key': randomUUID() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
});
const getJson = async (session, path) => { const response = await call(session, 'GET', path); assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`); return response.json(); };
const feed = (root, query) => getJson(root, `/admin/audit?${RANGE}${query ? `&${query}` : ''}`);
const ids = (page) => page.entries.map((entry) => entry.id);
const auditCount = async (action) => (await db.query('SELECT COUNT(*)::int AS n FROM audit_log WHERE action = $1', [action])).rows[0].n;

test('the activity feed needs users.audit', async () => {
  const [ava, noah] = [await signIn(), await signIn('noah@demo.gcc')];
  assert.equal((await call(null, 'GET', '/admin/audit')).status, 401);
  for (const session of [ava, noah]) for (const path of ['/admin/audit', '/admin/audit/export', '/admin/audit/people?q=zed']) assert.equal((await call(session, 'GET', path)).status, 403, path);
});

test('activity feed: friendly sentences, areas, newest first, sign-ins merged from login_events', async () => {
  const root = await signIn('root@demo.gcc');
  const page = await feed(root, 'limit=100');
  assert.equal(page.total, 15, '12 log rows plus 3 sign-ins');
  assert.equal(page.entries.length, 15);
  assert.deepEqual(ids(page).slice(0, 7), ['al-12', 'al-11', 'al-10', 'al-09', 'al-08', 'al-07', 'al-06'], 'newest first, ties broken by id');
  const times = page.entries.map((entry) => Date.parse(entry.at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  const byId = Object.fromEntries(page.entries.map((entry) => [entry.id, entry]));
  assert.deepEqual([byId['al-01'].area, byId['al-01'].title, byId['al-01'].text], ['bookings', 'Booked a space', 'Zed Admin booked Desk A-12']);
  assert.equal(byId['al-02'].text, 'Zed Admin cancelled their own booking');
  assert.equal(byId['al-05'].text, 'Zed Admin edited Yan Manager (admin, permissions changed)', 'the target person is named, not their id');
  assert.equal(byId['al-06'].text, 'Yan Manager saved the menu for 2026-03-05 (12 dishes (+12 -0 ~0))');
  assert.deepEqual([byId['al-07'].actorName, byId['al-07'].area, byId['al-07'].text], [null, 'security', 'Several failed sign-ins for Zed Admin: sign-in paused for 15 minutes']);
  assert.deepEqual([byId['al-09'].area, byId['al-09'].areaLabel, byId['al-09'].title], ['other', 'Other', 'Weird unknown'], 'unknown actions still show up');
  const signIns = page.entries.filter((entry) => entry.area === 'signin');
  assert.equal(signIns.length, 3);
  assert.deepEqual([signIns[0].title, signIns[0].text], ['Signed in', 'Zed Admin signed in']);
  assert.deepEqual(page.areas.map((area) => area.id), AREAS.map((area) => area.id));
  // Every known action has a title and a sentence, and every area prefix is reachable.
  for (const action of Object.keys(ACTIONS)) { const entry = describe({ id: 'x', at: new Date(), action, actor_name: 'Pat', detail: 'd', entity_id: null }); assert.ok(entry.title && entry.text.includes('Pat') || action === 'security.login-burst', action); assert.notEqual(areaOf(action).id, 'other', action); }
});

test('activity feed: filters by person, area, search text and dates, alone and together', async () => {
  const root = await signIn('root@demo.gcc');
  const zed = await feed(root, 'user=ta-x&limit=100');
  assert.deepEqual(ids(zed).filter((id) => id.startsWith('al-')).sort(), ['al-01', 'al-02', 'al-05', 'al-08', 'al-09', 'al-10', 'al-11']);
  assert.equal(zed.total, 7 + 2, 'seven log rows and two sign-ins');
  assert.deepEqual(ids(await feed(root, 'area=bookings')).sort(), ['al-01', 'al-02']);
  assert.deepEqual(ids(await feed(root, 'area=content')).sort(), ['al-08', 'al-11', 'al-12']);
  assert.deepEqual(ids(await feed(root, 'area=security')), ['al-07']);
  const signin = await feed(root, 'area=signin');
  assert.equal(signin.total, 3);
  assert.ok(signin.entries.every((entry) => entry.area === 'signin'));
  assert.equal((await feed(root, 'area=all')).total, 15);
  assert.deepEqual(ids(await feed(root, 'user=ta-x&area=users')).sort(), ['al-05', 'al-10']);

  assert.deepEqual(ids(await feed(root, 'q=town')), ['al-03'], 'matches the detail');
  assert.deepEqual(ids(await feed(root, 'q=cancelled+a+booking')), ['al-02'], 'matches the friendly title');
  assert.deepEqual(ids(await feed(root, 'q=booking.created')), ['al-01'], 'matches the action name');
  assert.deepEqual(ids(await feed(root, 'q=yan&limit=100')).filter((id) => id.startsWith('al-')).sort(), ['al-03', 'al-04', 'al-05', 'al-06', 'al-12'], 'matches the actor and the person acted on');
  assert.equal((await feed(root, 'q=signed+in')).total, 3, 'search finds sign-ins by their label');
  assert.equal((await feed(root, 'q=%25')).total, 0, 'a % in the search is literal, not a wildcard');
  assert.equal((await feed(root, 'q=_')).total, 0);
  assert.equal((await feed(root, 'q=ta-x%40t')).total, 7 + 2, 'email search');

  const window = await getJson(root, '/admin/audit?from=2026-03-03T00:00:00Z&to=2026-03-05T00:00:00Z');
  assert.deepEqual(ids(window), ['al-05', 'al-04'], 'from is inclusive, to is exclusive; the 4:00 sign-in on the 5th is out');

  for (const bad of ['area=nonsense', 'user=%27%3B--', `q=${'x'.repeat(81)}`, 'before=garbage', 'limit=0', 'limit=abc', 'from=nope', 'to=2026-01-01T00:00:00Z&from=2026-02-01T00:00:00Z']) {
    const response = await call(root, 'GET', `/admin/audit?${bad}`);
    assert.equal(response.status, 400, bad);
    assert.equal((await response.json()).error.code, 'INVALID_FILTER');
  }
  assert.equal((await feed(root, 'limit=100000')).entries.length, 15, 'a huge page size is capped, not an error');
});

test('activity feed: cursor pagination walks every entry once, including ties, and only counts on the first page', async () => {
  const root = await signIn('root@demo.gcc');
  for (const size of [1, 2, 4]) {
    const seen = [];
    let page = await feed(root, `limit=${size}`);
    assert.equal(page.total, 15);
    assert.ok(page.areas);
    for (let guard = 0; guard < 30; guard += 1) {
      seen.push(...ids(page));
      assert.ok(page.entries.length <= size);
      if (!page.hasMore) { assert.equal(page.next, null); break; }
      page = await feed(root, `limit=${size}&before=${encodeURIComponent(page.next)}`);
      assert.equal(page.total, undefined, 'the total and the area list come with the first page only');
    }
    assert.equal(seen.length, 15, `size ${size}`);
    assert.equal(new Set(seen).size, 15, 'no entry twice, none skipped');
    assert.equal(seen[0], 'al-12');
    assert.equal(seen[1], 'al-11');
  }
  const filtered = await feed(root, 'area=content&limit=2');
  assert.deepEqual([filtered.total, filtered.hasMore], [3, true]);
  assert.deepEqual(ids(await feed(root, `area=content&limit=2&before=${encodeURIComponent(filtered.next)}`)), ['al-08']);

  // Timestamps differ by microseconds (as real rows do): the cursor must not repeat or skip any of them.
  for (const [id, micro] of [['us-1', '123456'], ['us-2', '123457'], ['us-3', '123458']]) await db.query("INSERT INTO audit_log (id, actor_id, action, detail, created_at) VALUES ($1, 'ta-x', 'link.created', 'micro', $2::timestamptz)", [id, `2026-03-09T13:00:00.${micro}Z`]);
  const walked = [];
  let micro = await getJson(root, '/admin/audit?from=2026-03-09T13:00:00Z&to=2026-03-09T14:00:00Z&limit=1');
  assert.equal(micro.total, 3);
  for (let guard = 0; guard < 6; guard += 1) { walked.push(...ids(micro)); if (!micro.hasMore) break; micro = await getJson(root, `/admin/audit?from=2026-03-09T13:00:00Z&to=2026-03-09T14:00:00Z&limit=1&before=${encodeURIComponent(micro.next)}`); }
  assert.deepEqual(walked, ['us-3', 'us-2', 'us-1']);
  await db.query("DELETE FROM audit_log WHERE id LIKE 'us-%'");
});

test('activity export follows the filters, is capped, and defuses spreadsheet formulas', async () => {
  const root = await signIn('root@demo.gcc');
  const csv = async (query) => { const response = await call(root, 'GET', `/admin/audit/export?${RANGE}${query ? `&${query}` : ''}`); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/csv/); return (await response.text()).replace(/^\uFEFF/, '').trim().split('\r\n'); };
  const header = (await csv('area=bookings'))[0];
  assert.match(header, /"Time \(UTC\)","Time \(IST\)","Who","Email","Area","What happened","Action","Detail","Item id"/);
  const bookings = await csv('area=bookings');
  assert.equal(bookings.length, 3, 'header and the two booking rows only');
  assert.ok(bookings[1].includes('Zed Admin cancelled their own booking') || bookings[2].includes('Zed Admin cancelled their own booking'));
  assert.ok(bookings.every((line, index) => index === 0 || line.includes('"Bookings"')));
  assert.equal((await csv('area=signin')).length, 4);
  assert.equal((await csv('user=ta-y')).length, 1 + 5, 'ta-y: four log rows and one sign-in');
  const injected = (await csv('area=users&user=ta-x')).join('\n');
  assert.ok(injected.includes(`"'=HYPERLINK(""http://evil"")"`), 'a cell that starts with = is prefixed so a spreadsheet will not run it');
  assert.ok(!(await csv('user=nobody-here')).slice(1).length, 'no rows when nothing matches');
  assert.equal((await call(root, 'GET', '/admin/audit/export?area=bogus')).status, 400);

  await db.query("INSERT INTO audit_log (id, actor_id, action, detail, created_at) SELECT 'cap-' || g, 'ta-x', 'link.created', 'bulk', '2026-04-01T00:00:00Z'::timestamptz + g * interval '1 second' FROM generate_series(1, $1::int) g", [EXPORT_CAP + 3]);
  const capped = await call(root, 'GET', '/admin/audit/export?from=2026-04-01T00:00:00Z&to=2026-04-02T00:00:00Z');
  assert.equal((await capped.text()).trim().split('\r\n').length, EXPORT_CAP + 1, 'the export is capped');
  await db.query("DELETE FROM audit_log WHERE id LIKE 'cap-%'");
});

test('person search for the filter finds suspended people too and treats % literally', async () => {
  const root = await signIn('root@demo.gcc');
  const found = (await getJson(root, '/admin/audit/people?q=zed')).people;
  assert.deepEqual(found.map((p) => [p.id, p.active]).sort(), [['ta-gone', false], ['ta-x', true]]);
  assert.equal(found.find((p) => p.id === 'ta-x').email, 'ta-x@t.gcc');
  assert.deepEqual((await getJson(root, '/admin/audit/people?q=%25')).people, []);
  assert.deepEqual((await getJson(root, '/admin/audit/people')).people, []);
});

test('sign-ins are recorded without an IP, and a burst of failed sign-ins is logged once', async () => {
  const before = (await db.query("SELECT COUNT(*)::int AS n FROM login_events WHERE employee_id = 'emp-ava'")).rows[0].n;
  await signIn();
  const rows = (await db.query("SELECT * FROM login_events WHERE employee_id = 'emp-ava' ORDER BY id DESC")).rows;
  assert.equal(rows.length, before + 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'employee_id', 'id', 'method']);
  assert.equal(rows[0].method, 'password');
  assert.equal(await auditCount('auth.sign-in'), 0, 'sign-ins never go into audit_log');

  const attempt = (password) => fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'ta-burst@t.gcc', password }) });
  for (let i = 0; i < 7; i += 1) assert.equal((await attempt('wrong')).status, 401);
  assert.equal(await auditCount('security.login-burst'), 1, 'seven failures are not a burst yet (the 1 is the seeded row)');
  assert.equal((await attempt('wrong')).status, 401);
  assert.equal(await auditCount('security.login-burst'), 2);
  assert.equal((await attempt('wrong')).status, 429, 'sign-in is paused');
  assert.equal((await attempt('gccdemo')).status, 429);
  assert.equal(await auditCount('security.login-burst'), 2, 'one new line for the whole burst');
  const row = (await db.query("SELECT actor_id, entity_id FROM audit_log WHERE action = 'security.login-burst' AND id <> 'al-07'")).rows[0];
  assert.deepEqual([row.actor_id, row.entity_id], [null, 'ta-burst']);
  const root = await signIn('root@demo.gcc');
  const burst = (await getJson(root, '/admin/audit?area=security&limit=1')).entries[0];
  assert.match(burst.text, /Several failed sign-ins for Burst Target/);
});

test('important writes are logged: contacts, links, announcements, polls, ideas, menu dishes and moderated kudos', async () => {
  const root = await signIn('root@demo.gcc');
  const post = async (path, body, status = 201) => { const response = await call(root, 'POST', path, body); assert.equal(response.status, status, `${path}: ${await response.clone().text()}`); return response.status === 204 ? null : response.json(); };
  const send = async (method, path, body) => { const response = await call(root, method, path, body); assert.equal(response.status, 204, `${method} ${path}: ${await response.clone().text()}`); };
  const last = async (action) => (await db.query('SELECT detail, entity_id FROM audit_log WHERE action = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [action])).rows[0];

  const { id: linkId } = await post('/admin/links', { title: 'Wiki', url: 'https://example.com' });
  await send('PATCH', `/admin/links/${linkId}`, { title: 'Wiki 2' });
  assert.deepEqual(await last('link.updated'), { detail: 'Wiki 2', entity_id: linkId });
  const { id: newsId } = await post('/admin/announcements', { title: 'Hello', body: 'x' });
  await send('PATCH', `/admin/announcements/${newsId}`, { title: 'Hello again' });
  await send('DELETE', `/admin/announcements/${newsId}`);
  assert.equal((await last('announcement.updated')).detail, 'Hello again');
  assert.equal((await last('announcement.deleted')).detail, 'Hello again');
  const { id: pollId } = await post('/admin/polls', { question: 'Pizza?', options: ['Yes', 'No'] });
  await post(`/admin/polls/${pollId}/close`, undefined, 204);
  await send('DELETE', `/admin/polls/${pollId}`);
  assert.equal((await last('poll.closed')).detail, 'Pizza?');
  assert.equal((await last('poll.deleted')).detail, 'Pizza?');
  await db.query("INSERT INTO feedback (id, message) VALUES ('ta-idea', 'x')");
  await send('PATCH', '/admin/feedback/ta-idea', { status: 'seen' });
  assert.equal((await last('feedback.updated')).detail, 'seen');
  await send('DELETE', '/admin/feedback/ta-idea');
  assert.equal((await last('feedback.deleted')).entity_id, 'ta-idea');
  await db.query("INSERT INTO kudos (id, from_id, to_id, message) VALUES ('ta-kudos', 'ta-x', 'ta-y', 'nice')");
  await send('DELETE', '/kudos/ta-kudos');
  assert.equal((await last('kudos.removed')).entity_id, 'ta-kudos');
  const today = new Date().toISOString().slice(0, 10);
  const dish = await post('/admin/menu', { date: today, meal: 'lunch', name: 'Rice' });
  assert.equal(dish.added, 1);
  const dishId = (await db.query("SELECT id FROM menu_items WHERE name = 'Rice' LIMIT 1")).rows[0].id;
  await send('DELETE', `/admin/menu/${dishId}`);
  assert.equal((await last('menu.deleted')).detail, 'Rice');
});

test('cancelling a booking records when it was cancelled, one by one and in bulk', async () => {
  const ava = await signIn();
  const root = await signIn('root@demo.gcc');
  const desk = (await db.query("SELECT id FROM resources WHERE type = 'desk' AND active = TRUE ORDER BY label LIMIT 1")).rows[0].id;
  const start = new Date(Date.now() + 26 * 3_600_000);
  const booked = await call(ava, 'POST', '/bookings', { resourceId: desk, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString() });
  assert.equal(booked.status, 201, await booked.clone().text());
  const { booking } = await booked.json();
  assert.equal((await db.query('SELECT cancelled_at FROM bookings WHERE id = $1', [booking.id])).rows[0].cancelled_at, null);
  assert.equal((await call(ava, 'DELETE', `/bookings/${booking.id}`)).status, 204);
  const cancelled = (await db.query('SELECT cancelled_at FROM bookings WHERE id = $1', [booking.id])).rows[0].cancelled_at;
  assert.ok(Math.abs(Date.now() - new Date(cancelled).getTime()) < 30_000);

  await db.query("INSERT INTO resources (id, type, label, building, floor) VALUES ('ta-bulk', 'desk', 'TA Bulk', 'HQ', '1')");
  await db.query("INSERT INTO bookings (id, employee_id, resource_id, starts_at, ends_at) VALUES ('ta-bulk-b', 'ta-x', 'ta-bulk', now() + interval '2 days', now() + interval '2 days 1 hour')");
  assert.equal((await call(root, 'DELETE', '/admin/resources/ta-bulk')).status, 204);
  const row = (await db.query("SELECT status, cancelled_at FROM bookings WHERE id = 'ta-bulk-b'")).rows[0];
  assert.equal(row.status, 'cancelled');
  assert.ok(row.cancelled_at, 'retiring a space stamps the cancellations it causes');
});

test('Home contacts ride along with the bootstrap: pinned first, emergency fallback, count, switches, no extra fields', async () => {
  const root = await signIn('root@demo.gcc');
  const ava = await signIn();
  await db.exec('DELETE FROM contacts');
  const add = async (body) => (await (await call(root, 'POST', '/admin/contacts', { phone: '100', ...body })).json()).id;
  const reception = await add({ name: 'Reception', category: 'Emergency', sortOrder: 1, notes: 'private note' });
  await add({ name: 'Security', category: 'Emergency', sortOrder: 2 });
  const it = await add({ name: 'IT help', category: 'IT', email: 'it@example.com', roleTitle: 'Service desk', hours: '24x7' });
  await add({ name: 'HR', category: 'HR' });
  const homeOf = async (session) => (await getJson(session, '/bootstrap')).homeContacts;
  const names = (list) => list.map((contact) => contact.name);

  assert.deepEqual(names(await homeOf(ava)), ['Reception', 'Security'], 'nothing pinned: the first emergency contacts');
  assert.deepEqual(Object.keys((await homeOf(ava))[0]).sort(), ['email', 'emoji', 'hours', 'id', 'name', 'phone', 'role_title'], 'no notes or admin fields');

  const versionOf = async () => Number((await call(root, 'GET', '/pulse')).headers.get('x-config-version'));
  const before = await versionOf();
  assert.equal((await call(root, 'PATCH', `/admin/contacts/${it}`, { pinToHome: true })).status, 204);
  assert.ok((await versionOf()) > before, 'editing a contact tells every open app to refresh its bootstrap');
  assert.deepEqual(names(await homeOf(ava)), ['IT help'], 'pinned contacts replace the fallback');
  assert.equal((await getJson(root, '/contacts')).contacts.find((c) => c.id === it).pin_to_home, true);
  assert.equal((await call(root, 'PATCH', `/admin/contacts/${it}`, { pinToHome: 'yes' })).status, 400);

  await call(root, 'PATCH', `/admin/contacts/${reception}`, { pinToHome: true });
  assert.deepEqual(names(await homeOf(ava)), ['IT help', 'Reception'], 'ordered by sort order, then name');
  assert.equal((await call(root, 'PUT', '/admin/settings', { homeContactsCount: 1 })).status, 200);
  assert.equal((await homeOf(ava)).length, 1, 'the count setting limits the card');
  assert.equal((await call(root, 'PUT', '/admin/settings', { homeContactsCount: 4, options: { homeContacts: false } })).status, 200);
  assert.deepEqual(await homeOf(ava), [], 'switched off by the super admin');
  assert.equal((await call(root, 'PUT', '/admin/settings', { options: { homeContacts: true }, features: { contacts: false } })).status, 200);
  assert.deepEqual(await homeOf(ava), [], 'follows the Important contacts feature switch');
  assert.equal((await call(root, 'PUT', '/admin/settings', { features: { contacts: true } })).status, 200);
  assert.ok((await homeOf(ava)).length > 0);
  assert.ok((await auditCount('contact.updated')) >= 2, 'contact edits are logged');
  const noahBoot = await getJson(await signIn('noah@demo.gcc'), '/bootstrap');
  assert.ok(Array.isArray(noahBoot.homeContacts));
});
