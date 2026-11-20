import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/security.js';
import { USAGE_FEATURES, OFFICE_HOURS } from '../server/analytics.js';
import { addDays, weekdayOf } from '../server/office-time.js';

// A fixed clock: Thursday 19 March 2026, 01:30 IST. In UTC it is still the 18th, so every office-day boundary below
// (midnight IST = 18:30 UTC) is exercised on purpose.
const NOW = Date.parse('2026-03-19T01:30:00+05:30');
const TODAY = '2026-03-19';
const clock = { now: NOW };

let db;
let server;
let baseUrl;

const ist = (text) => new Date(`${text}+05:30`);
const insertBooking = (id, employee, resource, startsAt, endsAt, extra = {}) => db.query(
  `INSERT INTO bookings (id, employee_id, resource_id, starts_at, ends_at, status, created_at, cancelled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [id, employee, resource, startsAt, endsAt, extra.status ?? 'confirmed', extra.createdAt ?? new Date(NOW - 40 * 86_400_000), extra.cancelledAt ?? null]);

before(async () => {
  db = await openDatabase({ memory: true, inventoryPath: null });
  server = createApp(db, { bookingRateLimit: 1000, now: () => clock.now }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const password = hashPassword('gccdemo');
  for (const [id, active] of [['an-a1', true], ['an-a2', true], ['an-a3', true], ['an-a4', true], ['an-gone', false]]) {
    await db.query("INSERT INTO employees (id, email, name, team, role, password_hash, active) VALUES ($1,$2,$3,'ZTeam','user',$4,$5)", [id, `${id}@t.gcc`, `Person ${id}`, password, active]);
  }
  await db.query("INSERT INTO teams (id, name, color) VALUES ('an-team', 'Test Team A', '#123456')");
  const space = (id, type, label, team, active = true) => db.query(
    "INSERT INTO resources (id, type, label, building, floor, team_id, active) VALUES ($1,$2,$3,'HQ','2',$4,$5)", [id, type, label, team, active]);
  await space('an-desk-1', 'desk', 'TA Desk 1', 'an-team');
  await space('an-desk-2', 'desk', 'TA Desk 2', 'an-team');
  await space('an-room-1', 'room', 'TA Room 1', null);
  await space('an-desk-old', 'desk', 'TA Retired', null, false);
  await db.exec('DELETE FROM token_redemptions; DELETE FROM idempotency; DELETE FROM bookings; DELETE FROM kudos; DELETE FROM poll_votes; DELETE FROM polls; DELETE FROM usage_daily; DELETE FROM usage_hourly;   DELETE FROM login_events; DELETE FROM feedback;');
});

after(async () => {
  await db.exec("DELETE FROM bookings WHERE id LIKE 'an-%'; DELETE FROM usage_daily WHERE employee_id LIKE 'an-%'; DELETE FROM login_events WHERE employee_id LIKE 'an-%'; DELETE FROM usage_hourly; DELETE FROM kudos WHERE id LIKE 'an-%'; DELETE FROM polls WHERE id LIKE 'an-%'");
  await db.query("UPDATE app_settings SET value = value - 'usageAnalytics' WHERE key = 'options'");
  await db.exec("DELETE FROM app_settings WHERE key IN ('general_settings', 'usage_cleanup')");
  server.close();
  await db.close();
});

async function signIn(login = 'ava@demo.gcc') {
  const response = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: 'gccdemo' }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrfToken };
}
const call = (session, method, path, body, extra = {}) => fetch(`${baseUrl}/api${path}`, {
  method, headers: { ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
});
const getJson = async (session, path, extra) => { const response = await call(session, 'GET', path, undefined, extra); assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`); return response.json(); };
// fetch() adds "Cache-Control: no-cache" to conditional requests, which makes servers skip the 304; browsers' own revalidation does not.
const revalidate = (session, path, etag) => new Promise((resolve, reject) => {
  httpGet(`${baseUrl}/api${path}`, { headers: { Cookie: session.cookie, 'If-None-Match': etag } }, (response) => { response.resume(); response.on('end', () => resolve({ status: response.statusCode, etag: response.headers.etag })); }).on('error', reject);
});

test('migration 008 columns exist and the usage tables hold counters only (no IP, no page content, no click log)', async () => {
  const columns = async (table) => (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position", [table])).rows.map((row) => row.column_name);
  assert.deepEqual(await columns('usage_daily'), ['day', 'feature', 'employee_id', 'count']);
  assert.deepEqual(await columns('usage_hourly'), ['day', 'hour', 'count']);
  assert.deepEqual(await columns('login_events'), ['id', 'employee_id', 'at', 'method']);
  assert.ok((await columns('bookings')).includes('cancelled_at'));
  assert.ok((await columns('contacts')).includes('pin_to_home'));
});

test('insights: every dashboard number against known bookings across days, midnight in India and retired spaces', async () => {
  const day = (offset) => addDays(TODAY, offset);
  // Today (Thu 19 Mar IST): two full desk bookings, one short one, one that starts exactly at IST midnight (still 18 Mar in UTC).
  await insertBooking('an-b1', 'an-a1', 'an-desk-1', ist('2026-03-19T09:00:00'), ist('2026-03-19T11:00:00'));
  await insertBooking('an-b2', 'an-a2', 'an-desk-2', ist('2026-03-19T10:00:00'), ist('2026-03-19T18:00:00'));
  await insertBooking('an-b3', 'an-a1', 'an-room-1', ist('2026-03-19T14:00:00'), ist('2026-03-19T15:00:00'));
  await insertBooking('an-b5', 'an-a3', 'an-desk-2', ist('2026-03-19T00:00:00'), ist('2026-03-19T01:00:00'));
  await insertBooking('an-b16', 'an-a2', 'an-desk-1', ist('2026-03-19T17:30:00'), ist('2026-03-19T19:00:00')); // only 30 minutes fall inside office hours
  // Last second of 18 Mar IST, running past midnight: belongs to the 18th (the day it starts).
  await insertBooking('an-b4', 'an-a1', 'an-desk-1', new Date('2026-03-18T18:29:59Z'), ist('2026-03-19T01:00:00'));
  await insertBooking('an-b6', 'an-a2', 'an-desk-1', ist('2026-03-18T10:30:00'), ist('2026-03-18T11:30:00'));
  await insertBooking('an-b14', 'an-a1', 'an-desk-old', ist('2026-03-17T10:00:00'), ist('2026-03-17T11:00:00')); // retired space: history counts, space measures do not
  await insertBooking('an-b15', 'an-gone', 'an-desk-1', ist('2026-03-16T10:00:00'), ist('2026-03-16T11:00:00')); // suspended person: volume counts, "people who booked" does not
  // Edges of the 30-day window (18 Feb ... 19 Mar) and the trend (to 26 Mar).
  await insertBooking('an-b9', 'an-a2', 'an-desk-2', ist('2026-02-18T00:30:00'), ist('2026-02-18T01:30:00'));
  await insertBooking('an-b10', 'an-a2', 'an-desk-2', ist('2026-02-17T23:30:00'), ist('2026-02-18T00:15:00'));
  await insertBooking('an-b7', 'an-a1', 'an-desk-1', ist(`${day(7)}T10:00:00`), ist(`${day(7)}T11:00:00`));
  await insertBooking('an-b8', 'an-a1', 'an-desk-1', ist(`${day(8)}T10:00:00`), ist(`${day(8)}T11:00:00`));
  // Cancellations are counted by the day they were cancelled.
  await insertBooking('an-c1', 'an-a3', 'an-desk-1', ist('2026-03-25T10:00:00'), ist('2026-03-25T11:00:00'), { status: 'cancelled', createdAt: new Date('2026-03-01T00:00:00Z'), cancelledAt: new Date('2026-03-18T10:00:00Z') });
  await insertBooking('an-c2', 'an-a3', 'an-desk-1', ist('2026-03-26T10:00:00'), ist('2026-03-26T11:00:00'), { status: 'cancelled', createdAt: new Date('2026-02-20T00:00:00Z'), cancelledAt: new Date('2026-02-10T00:00:00Z') });
  await insertBooking('an-c3', 'an-a3', 'an-desk-1', ist('2026-03-27T10:00:00'), ist('2026-03-27T11:00:00'), { status: 'cancelled', createdAt: new Date('2026-03-10T00:00:00Z') });
  // Community numbers.
  await db.query("INSERT INTO kudos (id, from_id, to_id, message, created_at) VALUES ('an-k1','an-a1','an-a2','x',$1),('an-k2','an-a1','an-a3','x',$2),('an-k3','an-a1','an-a3','x',$3)", [new Date('2026-03-10T00:00:00Z'), new Date('2026-03-18T18:29:00Z'), new Date('2026-02-01T00:00:00Z')]);
  await db.query("INSERT INTO polls (id, question, options) VALUES ('an-p1', 'Q?', '[\"a\",\"b\"]'::jsonb)");
  await db.query("INSERT INTO poll_votes (poll_id, employee_id, option_index, voted_at) VALUES ('an-p1','an-a1',0,$1),('an-p1','an-a2',1,$2),('an-p1','an-a3',1,$3)", [new Date('2026-03-12T00:00:00Z'), new Date('2026-03-18T20:00:00Z'), new Date('2026-01-01T00:00:00Z')]);
  await db.query("INSERT INTO feedback (id, message, status) VALUES ('an-f1', 'idea', 'new')");
  await db.query(`INSERT INTO app_settings (key, value) VALUES ('features', '{"kudos": true, "polls": true, "feedback": true}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  await db.query(`INSERT INTO app_settings (key, value) VALUES ('options', '{}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);

  const root = await signIn('root@demo.gcc');
  const data = await getJson(root, '/admin/insights');
  const desks = (await db.query("SELECT COUNT(*)::int AS n FROM resources WHERE type = 'desk' AND active = TRUE")).rows[0].n;
  const rooms = (await db.query("SELECT COUNT(*)::int AS n FROM resources WHERE type = 'room' AND active = TRUE")).rows[0].n;
  const people = (await db.query('SELECT COUNT(*)::int AS n FROM employees WHERE active = TRUE')).rows[0].n;
  const openMinutes = (OFFICE_HOURS.to - OFFICE_HOURS.from) * 60;
  const t = data.totals;

  assert.equal(data.today, TODAY);
  assert.equal(t.people, people);
  assert.equal(t.desks, desks);
  assert.equal(t.rooms, rooms);
  assert.equal(t.desksToday, 2, 'distinct active desks with any booking today (the midnight booking and the one running past midnight count)');
  assert.equal(t.roomsToday, 1);
  // Seat-time inside office hours: 120 + 480 + 30 desk minutes; 60 room minutes. Not "distinct seats".
  assert.equal(t.deskUtilisationToday, Math.round((630 * 100) / (desks * openMinutes)));
  assert.equal(t.roomUtilisationToday, Math.round((60 * 100) / (rooms * openMinutes)));
  assert.equal(t.deskBookings30d, 9, 'b1 b2 b4 b5 b6 b9 b14 b15 b16; not b10 (outside), b7 and b8 (future)');
  assert.equal(t.roomBookings30d, 1);
  assert.equal(t.bookings30d, 10);
  assert.equal(t.activeBookers30d, 3, 'a1, a2, a3: the suspended person is not an active booker');
  assert.equal(t.cancelled30d, 2, 'by cancel time: c1 (18 Mar) and c3 (no cancel time recorded, falls back to when it was booked); not c2 (cancelled 10 Feb)');
  assert.equal(t.deskCoverage30d, Math.round((2 * 100) / desks), 'only active desks: the retired desk does not count');
  assert.equal(t.kudos30d, 2);
  assert.equal(t.votes30d, 2, 'votes are counted by when they were cast');
  assert.equal(t.feedbackNew, 1);
  assert.equal(t.rsvpsUpcoming, (await db.query("SELECT COUNT(*)::int AS n FROM event_rsvps r JOIN events e ON e.id = r.event_id JOIN employees p ON p.id = r.employee_id WHERE p.active AND e.ends_at >= $1", [new Date(NOW)])).rows[0].n);

  // Trend: 14 past days (today included) and 7 upcoming days; the last upcoming day must not be dropped.
  assert.equal(data.trend.length, 21);
  assert.equal(data.trend[0].date, day(-13));
  assert.equal(data.trend[20].date, day(7));
  const at = (date) => data.trend.find((row) => row.date === date);
  assert.deepEqual([at(TODAY).desks, at(TODAY).rooms, at(TODAY).future], [4, 1, false], 'b1 b2 b5 b16 (b5 starts at IST midnight, which is still the 18th in UTC)');
  assert.deepEqual([at(day(-1)).desks, at(day(-1)).rooms], [2, 0], 'b4 starts at 23:59:59 IST on the 18th, b6');
  assert.equal(at(day(-2)).desks, 1, 'the retired space still shows in history');
  assert.equal(at(day(-3)).desks, 1, 'and so does the suspended person');
  assert.deepEqual([at(day(7)).desks, at(day(7)).future], [1, true]);
  assert.ok(!data.trend.some((row) => row.date === day(8)));

  assert.deepEqual(data.topSpaces.map((s) => [s.label, s.n]), [['TA Desk 1', 5], ['TA Desk 2', 3], ['TA Room 1', 1]], 'retired space excluded; ties broken by label');
  const team = data.byTeam.find((row) => row.name === 'Test Team A');
  assert.deepEqual([team.seats, team.bookings], [2, 8]);

  // Weekdays: 60 office days, desk bookings only, averaged by how often each weekday occurs.
  assert.equal(data.weekdays.length, 7);
  assert.equal(data.weekdays.reduce((sum, row) => sum + row.days, 0), 60);
  const expected = Array(7).fill(0);
  for (const when of ['2026-03-19T09:00', '2026-03-19T10:00', '2026-03-19T00:00', '2026-03-19T17:30', '2026-03-18T23:59:59', '2026-03-18T10:30', '2026-03-17T10:00', '2026-03-16T10:00', '2026-02-18T00:30', '2026-02-17T23:30']) {
    expected[new Date(new Date(`${when}+05:30`).getTime() + 19_800_000).getUTCDay()] += 1;
  }
  data.weekdays.forEach((row, index) => { assert.equal(row.desks, expected[index], row.name); assert.equal(row.avgDesks, Math.round((row.desks / row.days) * 10) / 10); });
  assert.equal(data.weekdays[weekdayOf(TODAY)].name, 'Thu');
  assert.deepEqual([...new Set(data.weekdays.map((row) => row.name))], ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

  // Features that are switched off report nothing instead of zero.
  await db.query(`UPDATE app_settings SET value = '{"kudos": false, "polls": false, "feedback": false}' WHERE key = 'features'`);
  await db.query(`UPDATE app_settings SET value = '{"eventsRsvpEnabled": false}' WHERE key = 'options'`);
  const off = (await getJson(root, '/admin/insights')).totals;
  assert.deepEqual([off.kudos30d, off.votes30d, off.feedbackNew, off.rsvpsUpcoming], [null, null, null, null]);
  await db.query(`UPDATE app_settings SET value = '{"kudos": true, "polls": true, "feedback": true}' WHERE key = 'features'`);
  await db.query(`UPDATE app_settings SET value = '{}' WHERE key = 'options'`);
});

test('insights never divide by zero when there are no spaces, bookings or people to count', { skip: Boolean(process.env.DATABASE_URL) }, async () => {
  const empty = await openDatabase({ memory: true, inventoryPath: null });
  const app = createApp(empty, { now: () => NOW }).listen(0, '127.0.0.1');
  await new Promise((resolve) => app.once('listening', resolve));
  try {
    await empty.exec('DELETE FROM bookings; DELETE FROM resources');
    const url = `http://127.0.0.1:${app.address().port}`;
    const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'root@demo.gcc', password: 'gccdemo' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const insights = await (await fetch(`${url}/api/admin/insights`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual([insights.totals.desks, insights.totals.deskUtilisationToday, insights.totals.roomUtilisationToday, insights.totals.deskCoverage30d], [0, 0, 0, 0]);
    const usage = await (await fetch(`${url}/api/admin/usage`, { headers: { Cookie: cookie } })).json();
    assert.ok(Number.isFinite(usage.reach.stickiness) && usage.reach.stickiness >= 0);
  } finally {
    app.close();
    await empty.close();
  }
});

test('insights and usage are permission-gated and their ETag changes exactly when the data changes', async () => {
  assert.equal((await call(null, 'GET', '/admin/insights')).status, 401);
  assert.equal((await call(null, 'GET', '/admin/usage')).status, 401);
  const ava = await signIn();
  assert.equal((await call(ava, 'GET', '/admin/insights')).status, 403);
  assert.equal((await call(ava, 'GET', '/admin/usage')).status, 403);
  const noah = await signIn('noah@demo.gcc');
  assert.equal((await call(noah, 'GET', '/admin/insights')).status, 200, 'admins hold insights.view by default');
  const root = await signIn('root@demo.gcc');
  for (const path of ['/admin/insights', '/admin/usage']) {
    const first = await call(root, 'GET', path);
    const etag = first.headers.get('etag');
    assert.ok(etag, `${path} has an ETag`);
    assert.equal((await revalidate(root, path, etag)).status, 304);
  }
  const before = (await call(root, 'GET', '/admin/insights')).headers.get('etag');
  await insertBooking('an-etag', 'an-a4', 'an-desk-2', ist('2026-03-19T12:00:00'), ist('2026-03-19T13:00:00'));
  const changed = await revalidate(root, '/admin/insights', before);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.etag, before);
  await db.query("DELETE FROM bookings WHERE id = 'an-etag'");
  const usageTag = (await call(root, 'GET', '/admin/usage')).headers.get('etag');
  await db.query("INSERT INTO usage_daily (day, feature, employee_id, count) VALUES ('2026-03-19', 'scan', 'an-a4', 1)");
  const usageChanged = await revalidate(root, '/admin/usage', usageTag);
  assert.equal(usageChanged.status, 200);
  assert.notEqual(usageChanged.etag, usageTag);
  await db.query("DELETE FROM usage_daily WHERE employee_id = 'an-a4' AND feature = 'scan'");
});

test('usage summary: logins per day across the IST midnight, active users, features, hours, new vs returning, teams', async () => {
  await db.exec('DELETE FROM usage_daily; DELETE FROM usage_hourly; DELETE FROM login_events;');
  const use = (dayText, feature, who, count) => db.query('INSERT INTO usage_daily (day, feature, employee_id, count) VALUES ($1,$2,$3,$4)', [dayText, feature, who, count]);
  await use('2026-03-19', 'booking', 'an-a1', 3); await use('2026-03-19', 'booking', 'an-a2', 1); await use('2026-03-19', 'map', 'an-a1', 1); await use('2026-03-19', 'menu', 'an-a1', 2);
  await use('2026-03-18', 'booking', 'an-a1', 1); await use('2026-03-18', 'links', 'an-a3', 2);
  for (const who of ['an-a1', 'an-a2', 'an-a3']) await use('2026-03-18', 'app_open', who, 1);
  await use('2026-03-13', 'events', 'an-a2', 1);
  await use('2026-03-12', 'booking', 'an-a1', 4); await use('2026-03-12', 'booking', 'an-a4', 1); await use('2026-03-12', 'menu', 'an-a2', 1);
  const login = (who, at) => db.query('INSERT INTO login_events (employee_id, at) VALUES ($1,$2)', [who, new Date(at)]);
  await login('an-a1', '2026-01-10T05:00:00Z'); await login('an-a1', '2026-03-18T18:29:59Z'); // 23:59:59 IST on the 18th
  await login('an-a2', '2026-03-18T18:30:00Z'); await login('an-a2', '2026-03-19T02:00:00Z'); // 00:00:00 IST on the 19th, then again later
  await login('an-a3', '2026-03-18T05:00:00Z'); await login('an-a4', '2026-03-12T05:00:00Z');
  await db.query("INSERT INTO usage_hourly (day, hour, count) VALUES ('2026-03-19', 9, 7), ('2026-03-18', 9, 2), ('2026-03-12', 9, 100), ('2026-03-18', 14, 4)");
  await db.query(`INSERT INTO app_settings (key, value) VALUES ('features', '{"kudos": true, "polls": false}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);

  const root = await signIn('root@demo.gcc');
  const usage = await getJson(root, '/admin/usage?from=2026-03-13&to=2026-03-19');
  assert.deepEqual([usage.from, usage.to, usage.days, usage.previous.from, usage.previous.to], ['2026-03-13', '2026-03-19', 7, '2026-03-06', '2026-03-12']);
  const row = (date) => usage.series.find((entry) => entry.date === date);
  assert.equal(usage.series.length, 7);
  assert.deepEqual([row('2026-03-18').logins, row('2026-03-18').loginPeople], [2, 2], 'a1 at 23:59:59 IST and a3');
  assert.deepEqual([row('2026-03-19').logins, row('2026-03-19').loginPeople], [2, 1], 'a2 twice: logins counts both, people counts once');
  assert.equal(usage.totals.logins, 4, '4 sign-ins in range; the ones on 10 Jan and 12 Mar are outside it');
  assert.deepEqual([row('2026-03-19').active, row('2026-03-18').active, row('2026-03-13').active, row('2026-03-14').active], [2, 3, 1, 0]);
  assert.equal(usage.totals.avgDailyActive, 0.9);
  assert.deepEqual(usage.cohort, { current: 3, previous: 3, retained: 2, retention: 67, newPeople: 2, returningPeople: 1 });
  assert.deepEqual([usage.reach.dau, usage.reach.wau, usage.reach.mau, usage.reach.stickiness], [2, 3, 4, 8]);

  const feature = (id) => usage.features.find((entry) => entry.id === id);
  assert.deepEqual([feature('booking').opens, feature('booking').users, feature('booking').prevOpens, feature('booking').prevUsers], [5, 2, 5, 2]);
  assert.deepEqual([feature('menu').opens, feature('menu').users, feature('menu').prevOpens, feature('menu').prevUsers], [2, 1, 1, 1]);
  assert.deepEqual([feature('links').opens, feature('links').users, feature('events').opens], [2, 1, 1]);
  assert.ok(!usage.features.some((entry) => entry.id === 'app_open'), 'session starts feed active users, not the feature list');
  assert.equal(usage.features[0].id, 'booking', 'sorted by unique users, then opens');
  const unused = usage.unused.map((entry) => entry.id);
  assert.ok(unused.includes('scan') && unused.includes('my_bookings') && unused.includes('kudos'));
  assert.ok(!unused.includes('booking') && !unused.includes('menu') && !unused.includes('polls'), 'used features and features that are switched off are not suggested');
  assert.ok(!unused.includes('home') && !unused.includes('account'), 'always-on screens are never "promote me"');

  assert.equal(usage.hours.length, 24);
  assert.deepEqual([usage.hours[9].n, usage.hours[14].n, usage.hours[10].n], [9, 4, 0], 'the 12 Mar hour is outside the range');

  const zteam = usage.teams.find((team) => team.team === 'ZTeam');
  assert.deepEqual([zteam.people, zteam.active], [4, 3]);
  assert.ok(usage.teams.every((team) => team.people >= 3 || team.team === 'Smaller teams'), 'small teams are merged so nobody can be singled out');
  assert.equal(usage.totals.people, (await db.query('SELECT COUNT(*)::int AS n FROM employees WHERE active')).rows[0].n);
  assert.equal(usage.since.logins, '2026-01-10');

  // Default range is the last 30 days ending today.
  const dflt = await getJson(root, '/admin/usage');
  assert.deepEqual([dflt.from, dflt.to, dflt.days], ['2026-02-18', TODAY, 30]);
  for (const bad of ['from=2026-03-19&to=2026-03-01', 'to=2026-03-20', 'from=nope', 'from=2024-01-01&to=2026-03-19', 'to=2026-02-30']) {
    const response = await call(root, 'GET', `/admin/usage?${bad}`);
    assert.equal(response.status, 400, bad);
    assert.equal((await response.json()).error.code, 'INVALID_RANGE');
  }
});

test('usage ingest: whitelist, validation, caps, upsert, hourly total and CSRF for sendBeacon', async () => {
  await db.exec('DELETE FROM usage_daily; DELETE FROM usage_hourly;');
  const ava = await signIn();
  const stored = async () => Object.fromEntries((await db.query("SELECT feature, count FROM usage_daily WHERE employee_id = 'emp-ava' AND day = '2026-03-19' ORDER BY feature")).rows.map((r) => [r.feature, r.count]));

  assert.equal((await call(null, 'POST', '/usage', { events: { booking: 1 } })).status, 401);
  const first = await call(ava, 'POST', '/usage', { events: { booking: 2, map: 1, evil: 5, constructor: 1, toString: 3, [`a`.repeat(60)]: 1 } });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { accepted: 2 });
  assert.deepEqual(await stored(), { booking: 2, map: 1 }, 'unknown features are ignored, not stored');
  assert.deepEqual((await (await call(ava, 'POST', '/usage', { events: { booking: -1, map: 1.5, scan: '4', events: null } })).json()), { accepted: 0 });
  assert.deepEqual(await stored(), { booking: 2, map: 1 });
  await call(ava, 'POST', '/usage', { events: { booking: 3, scan: 99_999 } });
  assert.deepEqual(await stored(), { booking: 5, map: 1, scan: 500 }, 'counts add up per person, feature and day; one batch entry is capped at 500');
  const hourly = (await db.query('SELECT day::text AS day, hour, count FROM usage_hourly')).rows;
  assert.deepEqual(hourly.map((r) => [r.day.slice(0, 10), r.hour, r.count]), [['2026-03-19', 1, 2 + 1 + 3 + 500]], 'one row for the IST hour of the clock, holding the total of the opens');

  for (const events of [[1, 2], 'booking', 5]) assert.equal((await call(ava, 'POST', '/usage', { events })).status, 400);
  const tooMany = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`f${index}`, 1]));
  const large = await call(ava, 'POST', '/usage', { events: tooMany });
  assert.equal(large.status, 400);
  assert.equal((await large.json()).error.code, 'BATCH_TOO_LARGE');
  assert.equal((await call(ava, 'POST', '/usage', {})).status, 200, 'nothing to store is fine');

  // sendBeacon cannot send headers: the CSRF token travels in the body, and only a correct one is accepted.
  const beacon = (csrf) => fetch(`${baseUrl}/api/usage`, { method: 'POST', headers: { Cookie: ava.cookie, 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ csrf, events: { events: 1 } }) });
  assert.equal((await beacon('wrong')).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/usage`, { method: 'POST', headers: { Cookie: ava.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: { events: 1 } }) })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/usage`, { method: 'POST', headers: { Cookie: ava.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf: ava.csrf, events: { events: 1 } }) })).status, 200);
  assert.equal((await stored()).events, 1);

  // The whitelist covers exactly the features the browser reports.
  const source = readFileSync(new URL('../src/lib/usage.ts', import.meta.url), 'utf8');
  const clientIds = [...source.match(/USAGE_FEATURE_IDS = \[([^\]]+)\]/)[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(clientIds, Object.keys(USAGE_FEATURES).sort());
});

test('usage ingest rides on the heartbeat (POST /api/pulse), is rate limited and honours the off switch on the server', async () => {
  await db.exec('DELETE FROM usage_daily; DELETE FROM usage_hourly;');
  const ravi = await signIn('ravi@demo.gcc');
  const root = await signIn('root@demo.gcc');
  const pulse = await call(ravi, 'POST', '/pulse', { usage: { notifications: 2, scan: 1 } });
  assert.equal(pulse.status, 200);
  const reply = await pulse.json();
  assert.equal(typeof reply.configVersion, 'number');
  assert.deepEqual(reply.usage, { accepted: 2 });
  assert.equal((await call(ravi, 'POST', '/pulse', {})).status, 200, 'a heartbeat without usage still works');
  assert.equal((await call(ravi, 'POST', '/pulse', { usage: [] })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/pulse`, { method: 'POST', headers: { Cookie: ravi.cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'POST needs the CSRF header');

  // Switched off by the super admin: the server stores nothing even if a browser still sends counts.
  const save = (usageAnalytics) => call(root, 'PUT', '/admin/settings', { options: { usageAnalytics } });
  assert.equal((await save(false)).status, 200);
  const before = (await db.query('SELECT COALESCE(SUM(count), 0)::int AS n FROM usage_daily')).rows[0].n;
  assert.deepEqual(await (await call(ravi, 'POST', '/usage', { events: { map: 5 } })).json(), { accepted: 0, enabled: false });
  assert.deepEqual((await (await call(ravi, 'POST', '/pulse', { usage: { map: 5 } })).json()).usage, { accepted: 0, enabled: false });
  assert.equal((await db.query('SELECT COALESCE(SUM(count), 0)::int AS n FROM usage_daily')).rows[0].n, before);
  assert.equal((await getJson(root, '/admin/usage')).collecting, false);
  assert.deepEqual((await getJson(root, '/admin/usage')).unused, [], 'nothing is called unused while collection is off');
  assert.equal((await save(true)).status, 200);
  assert.deepEqual(await (await call(ravi, 'POST', '/usage', { events: { map: 5 } })).json(), { accepted: 1 });

  // 20 requests a minute per person.
  const busy = await signIn('noah@demo.gcc');
  const codes = [];
  for (let i = 0; i < 24; i += 1) codes.push((await call(busy, 'POST', '/usage', { events: { home: 1 } })).status);
  assert.equal(codes.filter((code) => code === 200).length, 20);
  assert.equal(codes.filter((code) => code === 429).length, 4);
});

test('settings: usage retention and the Home contact count are validated, stored, shown to the app and written to the log', async () => {
  const root = await signIn('root@demo.gcc');
  for (const body of [{ usageRetentionDays: 5 }, { usageRetentionDays: 'x' }, { usageRetentionDays: 2000 }, { homeContactsCount: 0 }, { homeContactsCount: 9 }, { options: { nonsense: true } }]) {
    assert.equal((await call(root, 'PUT', '/admin/settings', body)).status, 400, JSON.stringify(body));
  }
  const saved = await call(root, 'PUT', '/admin/settings', { usageRetentionDays: 120, homeContactsCount: 3, options: { homeContacts: false } });
  assert.equal(saved.status, 200);
  const config = (await getJson(root, '/bootstrap')).config;
  assert.deepEqual([config.usageRetentionDays, config.homeContactsCount, config.options.homeContacts, config.options.usageAnalytics], [120, 3, false, true]);
  const log = await getJson(root, '/admin/audit?area=settings&limit=3');
  const details = log.entries.map((entry) => entry.detail).join(' | ');
  assert.match(details, /usageRetentionDays: 400 -> 120/);
  assert.match(details, /options\.homeContacts: true -> false/);
  assert.equal((await call(root, 'PUT', '/admin/settings', { usageRetentionDays: 400, homeContactsCount: 4, options: { homeContacts: true } })).status, 200);
});

test('retention: old usage rows and sign-ins are removed once a day, newer ones stay, and the setting is honoured', async () => {
  await db.exec('DELETE FROM usage_daily; DELETE FROM usage_hourly; DELETE FROM login_events;');
  const root = await signIn('root@demo.gcc');
  await db.query("INSERT INTO usage_daily (day, feature, employee_id, count) VALUES ('2025-01-01','booking','an-a1',1), ('2026-03-12','booking','an-a1',1), ('2026-02-10','booking','an-a1',1)");
  await db.query("INSERT INTO usage_hourly (day, hour, count) VALUES ('2025-01-01', 9, 1), ('2026-03-12', 9, 1)");
  await db.query("INSERT INTO login_events (employee_id, at) VALUES ('an-a1', '2025-01-01T05:00:00Z'), ('an-a1', '2026-03-12T05:00:00Z')");
  clock.now = NOW + 86_400_000; // a new office day, so the once-a-day cleanup runs again
  await getJson(root, '/admin/usage');
  const days = async () => (await db.query("SELECT day::text AS day FROM usage_daily ORDER BY day")).rows.map((r) => r.day.slice(0, 10));
  assert.deepEqual(await days(), ['2026-02-10', '2026-03-12'], 'default retention is 400 days');
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM login_events WHERE employee_id = 'an-a1'")).rows[0].n, 1);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM usage_hourly')).rows[0].n, 1);
  assert.equal((await call(root, 'PUT', '/admin/settings', { usageRetentionDays: 30 })).status, 200);
  await getJson(root, '/admin/usage');
  assert.deepEqual(await days(), ['2026-03-12'], 'a shorter retention applies at the next cleanup');
  assert.equal((await call(root, 'PUT', '/admin/settings', { usageRetentionDays: 400 })).status, 200);
  clock.now = NOW;
});
