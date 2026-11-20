import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { hashPassword, expandPermissions, effectivePermissions, ALL_PERMISSIONS, LEGACY_PERMISSIONS } from '../server/security.js';
import { PERMISSION_GROUPS } from '../server/permissions.js';

let db;
let server;
let baseUrl;
let inserts = 0;

before(async () => {
  db = await openDatabase({ memory: true, inventoryPath: null });
  const query = db.query.bind(db);
  // Counts how many statements write notifications, to prove that a fan-out is a single batched INSERT.
  db.query = (sql, ...rest) => { if (/INSERT INTO notifications/i.test(sql)) inserts += 1; return query(sql, ...rest); };
  server = createApp(db, { bookingRateLimit: 1000, issueRateLimit: 1000 }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await db.close();
});

async function signIn(login = 'ava@demo.gcc', password = 'gccdemo') {
  const response = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrfToken, user: body.user };
}
const call = (session, method, path, body, extra = {}) => fetch(`${baseUrl}/api${path}`, {
  method, headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
});
const json = async (promise) => (await promise).json();
const PASSWORD = 'a-much-better-pass';

// Creates a person through the API (as a super admin) with a role template, and signs them in past the forced password change.
async function makePerson(root, email, name, extra = {}) {
  const created = await call(root, 'POST', '/admin/users', { email, name, ...extra });
  assert.equal(created.status, 201, `${email}: ${JSON.stringify(await created.clone().json())}`);
  const { temporaryPassword } = await created.json();
  const first = await signIn(extra.username && !email ? extra.username : email, temporaryPassword);
  assert.equal((await call(first, 'POST', '/me/password', { currentPassword: temporaryPassword, newPassword: PASSWORD })).status, 204);
  return signIn(extra.username && !email ? extra.username : email, PASSWORD);
}

let cast;
const getCast = async () => {
  if (cast) return cast;
  const root = await signIn('root@demo.gcc');
  const ava = await signIn();
  const noah = await signIn('noah@demo.gcc');
  const sam = await makePerson(root, 'sam.issues@demo.gcc', 'Sam Rivera');
  const fixer = await makePerson(root, 'fixer@demo.gcc', 'Ravi Fixer', { customRoleId: 'role-facility-staff' });
  const manager = await makePerson(root, 'fm@demo.gcc', 'Meera Manager', { customRoleId: 'role-facility-manager' });
  const chef = await makePerson(root, 'canteen.chef@demo.gcc', 'Chef Charu', { customRoleId: 'role-food-manager' });
  const seat = (await db.query("SELECT id, label FROM resources WHERE type = 'desk' AND active = TRUE ORDER BY label LIMIT 1")).rows[0];
  cast = { root, ava, noah, sam, fixer, manager, chef, seat };
  return cast;
};
const report = (session, body = {}, key) => call(session, 'POST', '/issues', { categoryId: 'icat-cafeteria', description: 'The coffee machine is leaking', ...body }, key ? { 'Idempotency-Key': key } : {});
const notificationsOf = async (session) => (await json(call(session, 'GET', '/notifications'))).notifications;

test('issue lifecycle: report, route, work on it, comment, fix, and reopen', async () => {
  const { ava, fixer, manager, noah, seat } = await getCast();
  const before = inserts;
  const created = await report(ava, { resourceId: seat.id, priority: 'high' });
  assert.equal(created.status, 201);
  const { id, number } = await created.json();
  assert.ok(number >= 1);
  assert.equal(inserts - before, 1, 'one batched INSERT reaches every recipient');

  const mine = await json(call(ava, 'GET', '/issues?scope=mine'));
  assert.equal(mine.issues[0].id, id);
  assert.match(mine.issues[0].locationText, new RegExp(seat.label));
  assert.equal(mine.issues[0].categoryName, 'Cafeteria & pantry');

  // Facility managers and staff who can see the queue are told; the reporter is not.
  assert.ok((await notificationsOf(manager)).some((n) => n.type === 'issue_new' && n.link === `issue:${id}`));
  assert.equal((await notificationsOf(ava)).some((n) => n.link === `issue:${id}`), false);

  // Take it, start it, add an internal note and a public comment.
  assert.equal((await call(fixer, 'PATCH', `/issues/${id}`, { status: 'in_progress' })).status, 200);
  let detail = await json(call(fixer, 'GET', `/issues/${id}`));
  assert.equal(detail.issue.assigneeId, fixer.user.id, 'starting an unassigned issue takes it');
  assert.equal((await call(fixer, 'POST', `/issues/${id}/comments`, { body: 'Part ordered', internal: true })).status, 201);
  assert.equal((await call(fixer, 'POST', `/issues/${id}/comments`, { body: 'Fixing it today' })).status, 201);
  assert.equal((await call(ava, 'POST', `/issues/${id}/comments`, { body: 'Thank you!' })).status, 201);
  const seen = await json(call(ava, 'GET', `/issues/${id}`));
  assert.equal(seen.updates.some((u) => u.internal), false, 'staff notes never reach the reporter');
  assert.ok(seen.updates.some((u) => u.body === 'Fixing it today'));
  assert.equal((await call(ava, 'POST', `/issues/${id}/comments`, { body: 'sneaky', internal: true })).status, 403);
  assert.ok((await json(call(fixer, 'GET', `/issues/${id}`))).updates.some((u) => u.internal && u.body === 'Part ordered'));

  assert.equal((await call(ava, 'PATCH', `/issues/${id}`, { status: 'closed' })).status, 403, 'the reporter cannot close their own issue');
  assert.equal((await call(fixer, 'PATCH', `/issues/${id}`, { status: 'resolved', note: 'Seal replaced' })).status, 200);
  assert.ok((await notificationsOf(ava)).some((n) => n.type === 'issue_update' && /Fixed/.test(n.title)), 'the reporter hears about the fix');
  detail = await json(call(ava, 'GET', `/issues/${id}`));
  assert.equal(detail.can.reopen, true);

  const reopened = await call(ava, 'POST', `/issues/${id}/reopen`, { note: 'Still leaking' });
  assert.equal(reopened.status, 200);
  assert.equal((await json(call(ava, 'GET', `/issues/${id}`))).issue.status, 'new');
  assert.ok((await notificationsOf(fixer)).some((n) => /Not fixed/.test(n.title)), 'the assignee is told it is not fixed');

  // Only after being fixed, and only within the window.
  await call(fixer, 'PATCH', `/issues/${id}`, { status: 'resolved' });
  await db.query("UPDATE issues SET resolved_at = now() - interval '9 days' WHERE id = $1", [id]);
  assert.equal((await call(ava, 'POST', `/issues/${id}/reopen`, {})).status, 409);
});

test('issues are private: other people cannot read, change, comment on or fetch the photo of someone else’s report', async () => {
  const { ava, sam, fixer, noah } = await getCast();
  const { id } = await (await report(ava, { description: 'Door badge reader is dead', categoryId: 'icat-security' })).json();
  for (const [method, path, body] of [['GET', `/issues/${id}`], ['PATCH', `/issues/${id}`, { status: 'closed' }], ['POST', `/issues/${id}/comments`, { body: 'hi' }], ['POST', `/issues/${id}/reopen`, {}], ['GET', `/issues/${id}/photo`], ['POST', `/issues/${id}/help`, {}]]) {
    assert.equal((await call(sam, method, path, body)).status, 404, `${method} ${path}`);
  }
  assert.equal((await call(sam, 'GET', '/issues?scope=all')).status, 403);
  assert.equal((await json(call(sam, 'GET', '/issues?scope=mine'))).issues.length, 0);
  assert.equal((await json(call(sam, 'GET', '/issues?scope=assigned'))).issues.length, 0);
  assert.equal((await call(sam, 'GET', '/admin/issues/export')).status, 403);
  // Staff see it, and a person who only works on issues (no queue permission) sees just what is theirs.
  assert.equal((await call(noah, 'GET', `/issues/${id}`)).status, 200);
  const outsider = await makePerson((await getCast()).root, 'updater@demo.gcc', 'Only Updater', { permissions: ['issues.update'], role: 'user' });
  assert.equal((await call(outsider, 'GET', `/issues/${id}`)).status, 404);
  assert.equal((await call(outsider, 'PATCH', `/issues/${id}`, { status: 'in_progress' })).status, 404);
  assert.equal((await call(fixer, 'GET', `/issues/${id}`)).status, 200, 'facility staff can see the queue');
  assert.equal((await call(ava, 'GET', `/issues/${id}`)).status, 200);
});

test('+1 instead of duplicates: hints show counts only, followers hear the outcome and never see the report', async () => {
  const { ava, sam, fixer, seat } = await getCast();
  const { id } = await (await report(ava, { categoryId: 'icat-washroom', description: 'Tap is leaking', resourceId: seat.id })).json();
  const hint = await json(call(sam, 'GET', `/issues/similar?categoryId=icat-washroom&resourceId=${seat.id}`));
  assert.equal(hint.similar.length, 1);
  assert.equal(hint.similar[0].people, 1);
  assert.equal(hint.similar[0].title, undefined, 'a hint never carries the report text');
  assert.equal((await call(ava, 'PUT', `/issues/${id}/plus-one`)).status, 409, 'you cannot +1 your own report');
  assert.equal((await json(call(sam, 'PUT', `/issues/${id}/plus-one`))).people, 2);
  assert.equal((await json(call(sam, 'PUT', `/issues/${id}/plus-one`))).people, 2, 'a second tap changes nothing');
  assert.equal((await call(sam, 'GET', `/issues/${id}`)).status, 404, 'a +1 does not unlock the details');
  await call(fixer, 'PATCH', `/issues/${id}`, { status: 'resolved' });
  assert.ok((await notificationsOf(sam)).some((n) => /Fixed/.test(n.title) && n.link === 'issues'));
  assert.equal((await call(sam, 'DELETE', `/issues/${id}/plus-one`)).status, 204);
  assert.equal((await call(sam, 'PUT', `/issues/${id}/plus-one`)).status, 404, 'resolved issues take no more +1s');
});

test('routing: category recipients, default assignee and escalation of urgent issues', async () => {
  const { root, ava, manager, fixer, noah, chef } = await getCast();
  const categories = await json(call(manager, 'GET', '/admin/issue-categories'));
  assert.ok(categories.categories.length >= 10);
  assert.equal((await call(ava, 'GET', '/admin/issue-categories')).status, 403);
  // Notify Noah (an admin) for lifts, escalate to the food manager, and give new lift issues to Ravi.
  const routes = { notify: [{ employeeId: noah.user.id }], escalate: [{ employeeId: chef.user.id }], assign: [{ employeeId: fixer.user.id }] };
  assert.equal((await call(ava, 'PUT', '/admin/issue-categories/icat-lifts/routes', routes)).status, 403);
  assert.equal((await call(manager, 'PUT', '/admin/issue-categories/icat-lifts/routes', { assign: [{ roleId: 'role-admin' }] })).status, 400, 'assignees are people, not roles');
  assert.equal((await call(manager, 'PUT', '/admin/issue-categories/icat-lifts/routes', { notify: [{ employeeId: 'nobody' }] })).status, 400);
  assert.equal((await call(manager, 'PUT', '/admin/issue-categories/icat-lifts/routes', routes)).status, 204);

  const before = inserts;
  const { id } = await (await report(ava, { categoryId: 'icat-lifts', description: 'Lift 2 is stuck between floors', priority: 'urgent' })).json();
  const issue = await json(call(manager, 'GET', `/issues/${id}`));
  assert.equal(issue.issue.assigneeId, fixer.user.id, 'the default assignee gets it');
  assert.equal(inserts - before, 2, 'one INSERT for assignee notification plus one for everyone else');
  assert.ok((await notificationsOf(fixer)).some((n) => n.type === 'issue_assigned' && n.link === `issue:${id}`));
  assert.ok((await notificationsOf(noah)).some((n) => n.type === 'issue_new' && n.link === `issue:${id}`));
  assert.ok((await notificationsOf(chef)).some((n) => n.type === 'issue_urgent' && n.link === `issue:${id}`), 'escalation recipients get the urgent type');
  assert.ok((await notificationsOf(manager)).some((n) => n.type === 'issue_urgent' && n.link === `issue:${id}`), 'facility managers are escalation recipients by default');
  assert.equal((await notificationsOf(ava)).some((n) => n.link === `issue:${id}`), false);

  // "Need help" asks managers for backup.
  assert.equal((await call(fixer, 'POST', `/issues/${id}/help`, { note: 'Need a second person' })).status, 201);
  assert.ok((await notificationsOf(manager)).some((n) => /needs help/.test(n.title)));
  await call(root, 'PUT', '/admin/issue-categories/icat-lifts/routes', { notify: [], escalate: [], assign: [] });
});

test('categories: managers add, edit, reorder and switch off; a switched-off category cannot be used', async () => {
  const { ava, manager } = await getCast();
  assert.equal((await call(ava, 'POST', '/admin/issue-categories', { name: 'Nope' })).status, 403);
  const made = await call(manager, 'POST', '/admin/issue-categories', { name: 'Parking', emoji: '🅿️', description: 'Bays and barriers', defaultPriority: 'low', slaHours: 24 });
  assert.equal(made.status, 201);
  const { id } = await made.json();
  assert.equal((await call(manager, 'PATCH', `/admin/issue-categories/${id}`, { defaultPriority: 'extreme' })).status, 400);
  assert.equal((await call(manager, 'PATCH', `/admin/issue-categories/${id}`, { name: 'Parking & bikes', slaHours: null })).status, 204);
  const all = (await json(call(manager, 'GET', '/admin/issue-categories'))).categories;
  assert.equal(all.find((c) => c.id === id).name, 'Parking & bikes');
  assert.equal((await call(manager, 'PUT', '/admin/issue-categories-order', { ids: [id, ...all.filter((c) => c.id !== id).map((c) => c.id)] })).status, 204);
  assert.equal((await json(call(ava, 'GET', '/issues/categories'))).categories[0].id, id);
  assert.equal((await call(manager, 'PATCH', `/admin/issue-categories/${id}`, { active: false })).status, 204);
  assert.equal((await json(call(ava, 'GET', '/issues/categories'))).categories.some((c) => c.id === id), false);
  assert.equal((await report(ava, { categoryId: id })).status, 400);
});

test('queue filters, counts, assignment rules and the CSV export', async () => {
  const { ava, fixer, manager, noah } = await getCast();
  const { id } = await (await report(ava, { categoryId: 'icat-it', description: 'Meeting room display is blank' })).json();
  const queue = await json(call(manager, 'GET', '/issues?scope=all&status=open&categoryId=icat-it&assignee=none'));
  assert.ok(queue.issues.some((i) => i.id === id));
  assert.ok(queue.counts.open >= 1 && queue.counts.unassigned >= 1);
  assert.ok(typeof queue.counts.closed === 'number', 'counts include closed issues count');
  const closedQueue = await json(call(manager, 'GET', '/issues?scope=all&status=resolved,closed'));
  assert.ok(Array.isArray(closedQueue.issues), 'can fetch closed and resolved issues');
  assert.equal((await json(call(manager, 'GET', '/issues?scope=all&q=display+is+blank'))).issues.some((i) => i.id === id), true);
  assert.equal((await json(call(manager, 'GET', '/issues?scope=all&priority=urgent&categoryId=icat-it'))).issues.length, 0);
  // Only people who can work on issues can be assigned; the reporter cannot assign.
  assert.equal((await call(manager, 'PATCH', `/issues/${id}`, { assigneeId: ava.user.id })).status, 400);
  assert.equal((await call(fixer, 'PATCH', `/issues/${id}`, { assigneeId: noah.user.id })).status, 403, 'staff without the assign permission can only take issues for themselves');
  assert.equal((await call(manager, 'PATCH', `/issues/${id}`, { assigneeId: fixer.user.id, priority: 'urgent' })).status, 200);
  assert.ok((await notificationsOf(fixer)).some((n) => n.type === 'issue_assigned' && n.link === `issue:${id}`));
  assert.equal((await json(call(fixer, 'GET', '/issues?scope=assigned'))).issues.some((i) => i.id === id), true);
  assert.equal((await call(fixer, 'PATCH', `/issues/${id}`, { status: 'nonsense' })).status, 400);
  const people = await json(call(manager, 'GET', '/issues/assignees'));
  assert.ok(people.people.some((p) => p.id === fixer.user.id) && !people.people.some((p) => p.id === ava.user.id));
  const csv = await call(manager, 'GET', '/admin/issues/export');
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Meeting room display is blank/);
  assert.equal((await call(fixer, 'GET', '/admin/issues/export')).status, 403);
});

test('submitting is rate limited and a repeated request key never creates a second issue', async () => {
  const { root } = await getCast();
  const spammer = await makePerson(root, 'spam@demo.gcc', 'Sp Ammer');
  // A second app on the same database with a small limit, so the check does not disturb the other tests.
  const strict = createApp(db, { issueRateLimit: 5 }).listen(0, '127.0.0.1');
  await new Promise((resolve) => strict.once('listening', resolve));
  try {
    const send = (key) => fetch(`http://127.0.0.1:${strict.address().port}/api/issues`, {
      method: 'POST', headers: { Cookie: spammer.cookie, 'X-CSRF-Token': spammer.csrf, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify({ categoryId: 'icat-cafeteria', description: 'The coffee machine is leaking' }),
    });
    const first = await send('same-key');
    const again = await send('same-key');
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).duplicate, true);
    for (let i = 0; i < 3; i += 1) assert.equal((await send()).status, 201);
    assert.equal((await send()).status, 429);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM issues i JOIN employees e ON e.id = i.reporter_id WHERE e.email = 'spam@demo.gcc'")).rows[0].n, 4);
  } finally { strict.close(); }
});

test('photos: magic bytes, declared type, size, owner and the on/off switch are all enforced', async () => {
  const { root, ava, sam, manager } = await getCast();
  const { id } = await (await report(ava, { categoryId: 'icat-furniture', description: 'Chair is broken' })).json();
  const send = (session, type, bytes) => fetch(`${baseUrl}/api/issues/${id}/photo`, { method: 'PUT', headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': type }, body: bytes });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
  assert.equal((await send(ava, 'image/jpeg', png)).status, 400, 'bytes must match the declared type');
  assert.equal((await send(ava, 'image/png', Buffer.from('<svg onload=alert(1)>'.padEnd(40, ' ')))).status, 400);
  assert.equal((await send(ava, 'image/png', Buffer.alloc(500 * 1024, 7))).status, 413);
  assert.equal((await send(ava, 'text/html', png)).status, 400);
  assert.equal((await send(sam, 'image/png', png)).status, 404, 'only the reporter attaches a photo');
  assert.equal((await send(ava, 'image/png', png)).status, 204);
  const shown = await fetch(`${baseUrl}/api/issues/${id}/photo`, { headers: { Cookie: manager.cookie } });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('content-type'), 'image/png');
  assert.match(shown.headers.get('cache-control'), /private/);
  assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await send(ava, 'image/jpeg', jpeg)).status, 204, 'a new photo replaces the old one');
  assert.equal((await call(sam, 'GET', `/issues/${id}/photo`)).status, 404);
  assert.ok((await json(call(ava, 'GET', `/issues/${id}`))).issue.photoVersion > 0);
  await call(root, 'PUT', '/admin/settings', { options: { issuePhotosEnabled: false } });
  try {
    assert.equal((await send(ava, 'image/png', png)).status, 403);
    assert.equal((await json(call(ava, 'GET', '/issues/categories'))).photosEnabled, false);
  } finally {
    await call(root, 'PUT', '/admin/settings', { options: { issuePhotosEnabled: true } });
  }
});

test('the issue box can be switched off, and the idea box is a separate thing without issue wording', async () => {
  const { root, ava } = await getCast();
  await call(root, 'PUT', '/admin/settings', { features: { issues: false } });
  try {
    assert.equal((await call(ava, 'GET', '/issues/categories')).status, 404);
    assert.equal((await report(ava)).status, 404);
  } finally { await call(root, 'PUT', '/admin/settings', { features: { issues: true } }); }
  const config = await json(call(ava, 'GET', '/config'));
  assert.match(config.featureCatalog.feedback, /Idea box/);
  assert.doesNotMatch(config.featureCatalog.feedback, /issue|problem/i);
  assert.doesNotMatch(config.featureCatalog.issues, /kudos/i);
  // "Issue" is no longer an idea-box category; unknown categories fall back to Idea.
  assert.equal((await call(ava, 'POST', '/feedback', { message: 'The coffee machine is broken', category: 'Issue' })).status, 201);
  assert.equal((await db.query("SELECT category FROM feedback WHERE message = 'The coffee machine is broken'")).rows[0].category, 'Idea');
});

test('notifications: own list only, unread rides on the pulse, read and read-all, retention', async () => {
  const { root, ava, sam, manager } = await getCast();
  const person = await makePerson(root, 'bell@demo.gcc', 'Bell Ringer', { customRoleId: 'role-facility-manager' });
  await report(ava, { categoryId: 'icat-cleaning', description: 'Spill near the lifts' });
  await report(ava, { categoryId: 'icat-cleaning', description: 'Dustbin overflowing' });
  await report(ava, { categoryId: 'icat-cleaning', description: 'Sticky floor in the pantry' });
  const pulse = await json(call(person, 'GET', '/pulse'));
  assert.ok(pulse.notifications.unread >= 1, 'the bell count comes with the pulse, no extra call');
  assert.notEqual((await json(call(ava, 'GET', '/pulse'))).notifications.unread, pulse.notifications.unread, 'each person gets their own count');
  const list = await json(call(person, 'GET', '/notifications?limit=2'));
  assert.equal(list.notifications.length, 2);
  assert.equal(list.unread, pulse.notifications.unread);
  assert.ok(list.hasMore);
  const [first] = list.notifications;
  // Somebody else's id does nothing; your own id marks it read.
  const samBefore = (await json(call(sam, 'GET', '/pulse'))).notifications.unread;
  assert.equal((await json(call(sam, 'POST', '/notifications/read', { ids: [first.id] }))).unread, samBefore);
  assert.equal((await json(call(person, 'GET', '/pulse'))).notifications.unread, pulse.notifications.unread);
  assert.equal((await json(call(person, 'POST', '/notifications/read', { ids: [first.id] }))).unread, pulse.notifications.unread - 1);
  assert.equal((await call(person, 'POST', '/notifications/read', { ids: ['1; DROP'] })).status, 400);
  assert.equal((await json(call(person, 'POST', '/notifications/read', { all: true }))).unread, 0);
  assert.equal((await call(person, 'GET', '/notifications')).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/notifications`)).status, 401);
  assert.equal((await json(call(manager, 'GET', '/bootstrap'))).unread >= 0, true);

  // Old notifications disappear (once a day, opportunistically).
  await db.query("UPDATE notifications SET created_at = now() - interval '40 days' WHERE user_id = $1", [person.user.id]);
  await db.query("DELETE FROM app_settings WHERE key = 'notifications_cleanup'");
  const other = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise((resolve) => other.once('listening', resolve));
  try { await fetch(`http://127.0.0.1:${other.address().port}/api/notifications`, { headers: { Cookie: person.cookie } }); } finally { other.close(); }
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1', [person.user.id])).rows[0].n, 0);
});

test('notification preferences: role defaults, personal overrides, category alerts and what a person may see', async () => {
  const { root, ava, chef, fixer, manager } = await getCast();
  // A person only sees the types they could act on.
  const avaPrefs = await json(call(ava, 'GET', '/me/notification-prefs'));
  assert.deepEqual(avaPrefs.types.map((t) => t.id).sort(), ['announcement', 'issue_assigned', 'issue_update']);
  assert.deepEqual(avaPrefs.categories, []);
  assert.equal((await call(ava, 'PUT', '/me/notification-prefs', { types: { issue_new: { inapp: true } } })).status, 400);
  assert.equal((await call(ava, 'PUT', '/me/notification-prefs', { categories: { 'icat-it': true } })).status, 403);

  const prefs = await json(call(chef, 'GET', '/me/notification-prefs'));
  assert.equal(prefs.types.find((t) => t.id === 'issue_new').inapp.source, 'role');
  assert.equal(prefs.categories.find((c) => c.id === 'icat-cafeteria').subscribed, true, 'the food manager role subscribes to cafeteria issues');
  assert.equal(prefs.categories.find((c) => c.id === 'icat-washroom').subscribed, false);

  // The food manager hears about a cafeteria issue and not a washroom one, until they subscribe.
  await report(ava, { categoryId: 'icat-cafeteria', description: 'Water dispenser empty' });
  await report(ava, { categoryId: 'icat-washroom', description: 'No soap on floor 2' });
  const seenByChef = await notificationsOf(chef);
  assert.ok(seenByChef.some((n) => /Cafeteria/.test(n.title) && n.type === 'issue_new'));
  assert.equal(seenByChef.some((n) => /Washroom/.test(n.title)), false);
  assert.equal((await call(chef, 'PUT', '/me/notification-prefs', { categories: { 'icat-washroom': true, 'icat-cafeteria': false } })).status, 204);
  await report(ava, { categoryId: 'icat-washroom', description: 'Tap dripping' });
  await report(ava, { categoryId: 'icat-cafeteria', description: 'Fridge door open' });
  const afterChange = await notificationsOf(chef);
  assert.ok(afterChange.some((n) => /Washroom/.test(n.title) && /Tap dripping/.test(n.body)));
  assert.equal(afterChange.some((n) => /Fridge door open/.test(n.body)), false, 'a muted category stays quiet');

  // Switching a type off wins over the role default; resetting (null) brings the role default back.
  const managerPrefs = await json(call(manager, 'GET', '/me/notification-prefs'));
  assert.ok(managerPrefs.categories.every((c) => c.subscribed), 'facility managers follow every category by default');
  assert.equal((await call(manager, 'PUT', '/me/notification-prefs', { types: { issue_new: { inapp: false, push: true } } })).status, 204);
  const quietManager = await json(call(manager, 'GET', '/me/notification-prefs'));
  assert.deepEqual(quietManager.types.find((t) => t.id === 'issue_new').inapp, { value: false, source: 'you' });
  assert.deepEqual(quietManager.types.find((t) => t.id === 'issue_new').push, { value: true, source: 'you' });
  const countBefore = (await notificationsOf(manager)).length;
  await report(ava, { categoryId: 'icat-it', description: 'Wi-Fi drops' });
  assert.equal((await notificationsOf(manager)).length, countBefore, 'nothing new arrives for a switched-off type');
  assert.equal((await call(manager, 'PUT', '/me/notification-prefs', { types: { issue_new: { inapp: null } } })).status, 204);
  assert.equal((await json(call(manager, 'GET', '/me/notification-prefs'))).types.find((t) => t.id === 'issue_new').inapp.source, 'role');

  // Role defaults can be edited by the super admin and change what people inherit.
  const role = (await json(call(root, 'GET', '/admin/roles'))).roles.find((r) => r.id === 'role-facility-staff');
  assert.equal(role.simpleUi, true);
  assert.equal((await call(root, 'PATCH', '/admin/roles/role-facility-staff', { notifyDefaults: { types: { issue_new: { inapp: false } } } })).status, 204);
  assert.equal((await json(call(fixer, 'GET', '/me/notification-prefs'))).types.find((t) => t.id === 'issue_new').inapp.value, false);
  assert.equal((await call(root, 'PATCH', '/admin/roles/role-facility-staff', { notifyDefaults: { types: { made_up: { inapp: true } } } })).status, 400);
  await call(root, 'PATCH', '/admin/roles/role-facility-staff', { notifyDefaults: role.notifyDefaults });
});

test('announcements notify everyone only when asked, and new ideas reach idea handlers who opted in', async () => {
  const { root, noah, ava, sam } = await getCast();
  const quiet = await call(noah, 'POST', '/admin/announcements', { title: 'Quiet news', body: 'No bell' });
  assert.equal(quiet.status, 201);
  assert.equal((await notificationsOf(ava)).some((n) => /Quiet news/.test(n.title)), false);
  await call(sam, 'PUT', '/me/notification-prefs', { types: { announcement: { inapp: false } } });
  assert.equal((await call(noah, 'POST', '/admin/announcements', { title: 'Loud news', body: 'Ring the bell', notify: true })).status, 201);
  assert.ok((await notificationsOf(ava)).some((n) => n.type === 'announcement' && /Loud news/.test(n.title)));
  assert.equal((await notificationsOf(sam)).some((n) => /Loud news/.test(n.title)), false, 'people who switched announcements off are skipped');
  assert.equal((await notificationsOf(noah)).some((n) => /Loud news/.test(n.title)), false, 'the author is not notified about their own post');
  // Idea notifications are opt-in (off by default).
  await call(ava, 'POST', '/feedback', { message: 'More plants', category: 'Idea' });
  assert.equal((await notificationsOf(noah)).some((n) => n.type === 'idea_new'), false);
  await call(noah, 'PUT', '/me/notification-prefs', { types: { idea_new: { inapp: true } } });
  await call(ava, 'POST', '/feedback', { message: 'Standing desks', category: 'Suggestion' });
  assert.ok((await notificationsOf(noah)).some((n) => n.type === 'idea_new'));
  assert.equal((await notificationsOf(ava)).some((n) => n.type === 'idea_new'), false);
  await call(root, 'GET', '/admin/feedback');
});

test('permissions: the catalogue is the single source of truth and every permission used in the code is in it', () => {
  const ids = PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => p.id));
  assert.equal(new Set(ids).size, ids.length, 'permission ids are unique');
  assert.deepEqual(ids, ALL_PERMISSIONS);
  for (const group of PERMISSION_GROUPS) for (const p of group.permissions) assert.ok(p.label && p.description, `${p.id} needs a label and a description`);
  for (const [legacy, targets] of Object.entries(LEGACY_PERMISSIONS)) {
    assert.ok(!ids.includes(legacy), `${legacy} is legacy only`);
    targets.forEach((target) => assert.ok(ids.includes(target), `${legacy} expands to unknown ${target}`));
  }
  const pattern = /['"`]((?:bookings|events|spaces|teams|qr|users|content|menu|community|insights|settings|roles|issues|notifications|audit)\.[a-z_.]+)['"`]/g;
  // Only strings handed to a permission check count (requirePermission('x'), has('x'), can('x'), permissions.includes('x')).
  const callPattern = /(?:requirePermission|requireAnyPermissions|permissions\.includes|\bhas|\bcan|hasPermission)\(([^()]*)\)/g;
  const files = [
    ...readdirSync(new URL('../server/', import.meta.url)).filter((name) => name.endsWith('.js') && name !== 'permissions.js').map((name) => `../server/${name}`),
    ...['screens/', ''].flatMap((dir) => readdirSync(new URL(`../src/ui/${dir}`, import.meta.url)).filter((name) => /\.tsx?$/.test(name)).map((name) => `../src/ui/${dir}${name}`)),
    ...readdirSync(new URL('../src/lib/', import.meta.url)).filter((name) => /\.tsx?$/.test(name)).map((name) => `../src/lib/${name}`),
  ];
  const unknown = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const call of source.matchAll(callPattern)) {
      for (const match of call[1].matchAll(pattern)) if (!ids.includes(match[1])) unknown.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(unknown, [], 'permission strings used in code but missing from server/permissions.js');
  // The browser must not carry its own copy.
  assert.doesNotMatch(readFileSync(new URL('../src/lib/types.ts', import.meta.url), 'utf8'), /PERMISSION_LABELS|ALL_PERMISSIONS/);
});

test('permissions: older strings keep working, and effective permissions are expanded and filtered', () => {
  assert.deepEqual(expandPermissions(['menu.manage', 'junk', 'insights.view']), ['menu.edit', 'menu.reviews.view', 'insights.view']);
  assert.deepEqual(effectivePermissions({ role: 'user', permissions: ['events.manage'], role_permissions: ['content.manage'] }).sort(),
    ['content.announcements', 'content.contacts', 'content.links', 'events.create', 'events.delete', 'events.edit']);
  assert.ok(effectivePermissions({ role: 'super_admin' }).includes('settings.manage'));
  assert.equal(effectivePermissions({ role: 'admin', permissions: ['settings.manage'], role_permissions: [] }).includes('settings.manage'), false, 'reserved permissions are never held through a list');
});

test('permissions: API serves the catalogue, accepts older strings and refuses reserved or unknown ones', async () => {
  const { root, ava, manager } = await getCast();
  const config = await json(call(ava, 'GET', '/config'));
  assert.deepEqual(config.permissionCatalog.groups.flatMap((g) => g.permissions.map((p) => p.id)), ALL_PERMISSIONS);
  assert.ok(config.notificationCatalog.types.some((t) => t.id === 'issue_new'));
  assert.equal(config.notificationCatalog.channels.find((c) => c.id === 'push').available, true, 'browser push is available');
  assert.equal((await call(root, 'POST', '/admin/roles', { name: 'Sneaky', permissions: ['settings.manage'] })).status, 400);
  assert.equal((await call(root, 'POST', '/admin/roles', { name: 'Typo', permissions: ['issues.everything'] })).status, 400);
  const made = await call(root, 'POST', '/admin/roles', { name: 'Old school', permissions: ['community.manage'], simpleUi: true, landing: 'tasks', notifyDefaults: { types: { idea_new: { inapp: true } }, categories: ['icat-it'] } });
  assert.equal(made.status, 201);
  const role = (await json(call(root, 'GET', '/admin/roles'))).roles.find((r) => r.name === 'Old school');
  assert.deepEqual(role.permissions, ['community.polls', 'community.ideas', 'community.moderation']);
  assert.equal(role.simpleUi, true);
  // A role that people hold cannot be deleted, and built-in roles never can.
  assert.equal((await call(root, 'DELETE', '/admin/roles/role-facility-staff')).status, 409);
  assert.equal((await call(root, 'DELETE', '/admin/roles/role-employee')).status, 409);
  assert.equal((await call(root, 'DELETE', `/admin/roles/${role.id}`)).status, 204);
  assert.equal((await call(manager, 'GET', '/admin/roles')).status, 403);
  // "Super admin" is shown as a role for reference but cannot be handed out as a template.
  const roster = await json(call(root, 'GET', '/admin/users'));
  assert.equal(roster.roles.some((r) => r.systemKey === 'super_admin'), false);
  assert.equal((await call(root, 'POST', '/admin/users', { email: 'tmpl@demo.gcc', name: 'T', customRoleId: 'role-super-admin' })).status, 400);
  assert.ok(roster.roles.map((r) => r.name).includes('Facility staff'));
});

test('role escalation: people can only grant what they hold, never the super-admin-only permissions, and need change-roles to touch roles', async () => {
  const { root, ava } = await getCast();
  const hrAdmin = await makePerson(root, 'people.mgr@demo.gcc', 'People Mgr', { permissions: ['users.view', 'users.create', 'users.edit', 'users.change_roles', 'events.create', 'issues.update'] });
  const creator = await makePerson(root, 'only.create@demo.gcc', 'Only Create', { permissions: ['users.view', 'users.create'] });
  // Creating a plain employee is fine; picking roles or permissions needs users.change_roles.
  assert.equal((await call(creator, 'POST', '/admin/users', { email: 'plain@demo.gcc', name: 'Plain' })).status, 201);
  assert.equal((await call(creator, 'POST', '/admin/users', { email: 'plain2@demo.gcc', name: 'Plain2', permissions: ['events.create'] })).status, 403);
  assert.equal((await call(creator, 'POST', '/admin/users', { email: 'plain3@demo.gcc', name: 'Plain3', customRoleId: 'role-employee' })).status, 403);
  // Holders of change-roles hand out only what they hold.
  assert.equal((await call(hrAdmin, 'POST', '/admin/users', { email: 'ok1@demo.gcc', name: 'Ok1', permissions: ['events.create', 'issues.update'] })).status, 201);
  assert.equal((await call(hrAdmin, 'POST', '/admin/users', { email: 'no1@demo.gcc', name: 'No1', permissions: ['events.delete'] })).status, 403, 'not held');
  assert.equal((await call(hrAdmin, 'POST', '/admin/users', { email: 'no2@demo.gcc', name: 'No2', permissions: ['users.view'] })).status, 403, 'super-admin-only to grant');
  assert.equal((await call(hrAdmin, 'POST', '/admin/users', { email: 'no3@demo.gcc', name: 'No3', role: 'super_admin' })).status, 403);
  assert.equal((await call(hrAdmin, 'POST', '/admin/users', { email: 'no4@demo.gcc', name: 'No4', customRoleId: 'role-facility-manager' })).status, 403, 'a template that holds permissions you lack');
  assert.equal((await call(hrAdmin, 'POST', '/admin/users', { email: 'no5@demo.gcc', name: 'No5', permissions: ['roles.manage'] })).status, 400, 'reserved permissions can never be granted');
  const roster = await json(call(root, 'GET', '/admin/users'));
  const ok1 = roster.users.find((u) => u.email === 'ok1@demo.gcc');
  assert.deepEqual(ok1.ownPermissions.sort(), ['events.create', 'issues.update']);
  // Editing the name needs "edit people"; the creator-only account cannot, and nobody can edit themselves into more power.
  assert.equal((await call(creator, 'PATCH', `/admin/users/${ok1.id}`, { name: 'Renamed' })).status, 403);
  assert.equal((await call(hrAdmin, 'PATCH', `/admin/users/${ok1.id}`, { name: 'Renamed', permissions: ['events.create'] })).status, 204);
  const me = roster.users.find((u) => u.email === 'people.mgr@demo.gcc');
  assert.equal((await call(hrAdmin, 'PATCH', `/admin/users/${me.id}`, { permissions: [...me.ownPermissions, 'events.edit'] })).status, 403);
  assert.equal((await call(hrAdmin, 'POST', `/admin/users/${ok1.id}/reset-password`)).status, 403, 'reset needs its own permission');
  assert.equal((await call(ava, 'GET', '/admin/users')).status, 403);

  // Someone who may only change roles can resend the unchanged details, but cannot edit them.
  const rolesOnly = await makePerson(root, 'roles.only@demo.gcc', 'Roles Only', { permissions: ['users.view', 'users.change_roles', 'events.create'] });
  assert.equal((await call(root, 'POST', '/admin/users', { email: 'dated@demo.gcc', name: 'Dated Person', team: 'Ops', joinedOn: '2024-05-06' })).status, 201);
  const dated = (await json(call(root, 'GET', '/admin/users'))).users.find((u) => u.email === 'dated@demo.gcc');
  assert.equal(dated.joinedOn, '2024-05-06');
  assert.equal((await call(rolesOnly, 'PATCH', `/admin/users/${dated.id}`, { name: 'Dated Person', team: 'Ops', active: true, joinedOn: '2024-05-06', permissions: ['events.create'] })).status, 204);
  assert.equal((await call(rolesOnly, 'PATCH', `/admin/users/${dated.id}`, { joinedOn: '2025-01-01' })).status, 403);
  assert.equal((await call(rolesOnly, 'PATCH', `/admin/users/${dated.id}`, { name: 'Renamed' })).status, 403);
});

test('username sign-in: people without an email can log in, case-insensitively, with no enumeration and a rate limit', async () => {
  const { root } = await getCast();
  assert.equal((await call(root, 'POST', '/admin/users', { name: 'No Login', team: 'x' })).status, 400, 'an email or a username is required');
  assert.equal((await call(root, 'POST', '/admin/users', { name: 'Bad', username: 'a b' })).status, 400);
  assert.equal((await call(root, 'POST', '/admin/users', { name: 'Bad', username: 'me@work' })).status, 400, 'a username cannot look like an email');
  const created = await call(root, 'POST', '/admin/users', { name: 'Gate Guard', username: 'Emp-0042', customRoleId: 'role-facility-staff' });
  assert.equal(created.status, 201);
  const { temporaryPassword } = await created.json();
  assert.equal((await call(root, 'POST', '/admin/users', { name: 'Twin', username: 'emp-0042' })).status, 409, 'usernames are unique regardless of case');
  const login = (name, password) => fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: name, password }) });
  const ok = await login('eMP-0042', temporaryPassword);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.user.email, '');
  assert.equal(body.user.username, 'Emp-0042');
  assert.equal(body.user.mustChangePassword, true, 'the same forced password change applies');
  assert.equal(body.user.simpleUi, true);
  assert.equal(body.user.landing, 'tasks');
  // A wrong password and an unknown name look exactly the same.
  const wrong = await login('emp-0042', 'nope-nope-nope');
  const unknown = await login('emp-9999', 'nope-nope-nope');
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
  // Old clients that still send `email` keep working.
  const legacy = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ava@demo.gcc', password: 'gccdemo' }) });
  assert.equal(legacy.status, 200);
  // Eight wrong tries lock that name for a while (from this address), without revealing whether it exists.
  let status = 0;
  for (let i = 0; i < 9; i += 1) status = (await login('ghost-account', 'wrong-password')).status;
  assert.equal(status, 429);
  // A person with only a username must keep one.
  const roster = await json(call(root, 'GET', '/admin/users'));
  const guard = roster.users.find((u) => u.username === 'Emp-0042');
  assert.equal((await call(root, 'PATCH', `/admin/users/${guard.id}`, { username: '' })).status, 400);
  assert.equal((await call(root, 'PATCH', `/admin/users/${guard.id}`, { username: 'emp-0043' })).status, 204);
});

test('simple-home staff: tasks come from scope=assigned, the queue only with permission', async () => {
  const { root, ava, manager } = await getCast();
  const guard = await makePerson(root, '', 'Gate Two', { username: 'emp-0100', customRoleId: 'role-facility-staff' }).catch(() => null);
  assert.ok(guard, 'a username-only person can be created and signed in');
  assert.equal(guard.user.simpleUi, true);
  const { id } = await (await report(ava, { categoryId: 'icat-electrical', description: 'Flickering tube light' })).json();
  assert.equal((await call(manager, 'PATCH', `/issues/${id}`, { assigneeId: guard.user.id })).status, 200);
  const tasks = await json(call(guard, 'GET', '/issues?scope=assigned'));
  assert.equal(tasks.issues[0].id, id);
  assert.equal(tasks.counts.mine >= 1, true);
  assert.equal((await call(guard, 'PATCH', `/issues/${id}`, { status: 'in_progress' })).status, 200);
  assert.equal((await call(guard, 'PATCH', `/issues/${id}`, { status: 'resolved' })).status, 200);
  assert.equal((await json(call(guard, 'GET', '/issues?scope=assigned'))).issues.length, 0, 'finished tasks leave the list');
});

test('migration 006 keeps every older permission, adds the finer ones next to them and leaves kudos as it was', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate, readMigrationFiles } = await import('../server/setup.js');
  const lite = new PGlite('memory://');
  await lite.waitReady;
  const wrap = { query: (sql, params) => lite.query(sql, params), exec: (sql) => lite.exec(sql), tx: (fn) => lite.transaction((client) => fn({ query: (sql, params) => client.query(sql, params), exec: (sql) => client.exec(sql) })) };
  try {
    const all = readMigrationFiles();
    await migrate(wrap, all.filter((m) => m.version < 6));
    await wrap.query("INSERT INTO employees (id, email, name, role, permissions, password_hash) VALUES ('a1', 'a1@x.gcc', 'A', 'admin', ARRAY['menu.manage','insights.view'], 'x'), ('u1', 'u1@x.gcc', 'U', 'user', ARRAY['users.manage'], 'x'), ('p1', 'p1@x.gcc', 'P', 'user', '{}', 'x')");
    await wrap.query("UPDATE custom_roles SET permissions = ARRAY['events.manage','qr.manage'] WHERE id = 'role-hr'");
    await wrap.query("INSERT INTO app_settings (key, value) VALUES ('features', '{\"links\": false}')");
    await migrate(wrap, all);
    await migrate(wrap, all);
    const row = async (id) => (await wrap.query('SELECT permissions FROM employees WHERE id = $1', [id])).rows[0].permissions;
    const admin = await row('a1');
    assert.ok(['menu.manage', 'insights.view', 'menu.edit', 'menu.reviews.view', 'issues.view_all', 'issues.update', 'notifications.route'].every((p) => admin.includes(p)), 'existing admins keep everything and gain the issue tools');
    const user = await row('u1');
    assert.ok(user.includes('users.manage') && user.includes('users.change_roles') && user.includes('users.audit'));
    assert.deepEqual(await row('p1'), [], 'people without permissions gain nothing');
    const hr = (await wrap.query("SELECT permissions FROM custom_roles WHERE id = 'role-hr'")).rows[0].permissions;
    assert.ok(hr.includes('events.manage') && hr.includes('events.create') && hr.includes('events.delete') && hr.includes('qr.manage'));
    // Existing installs keep kudos on; other stored switches are untouched; the finer permissions work through effectivePermissions.
    const features = (await wrap.query("SELECT value FROM app_settings WHERE key = 'features'")).rows[0].value;
    assert.deepEqual(features, { kudos: true, links: false });
    const seeded = (await wrap.query("SELECT id, system_key, permissions FROM custom_roles WHERE system_key IS NOT NULL ORDER BY id")).rows;
    assert.deepEqual(seeded.map((r) => r.system_key).sort(), ['admin', 'employee', 'facility_manager', 'facility_staff', 'floor_warden', 'food_manager', 'hr_people', 'reception', 'super_admin']);
    for (const role of seeded) for (const permission of role.permissions) assert.ok(ALL_PERMISSIONS.includes(permission), `${role.id} seeds unknown permission ${permission}`);
    assert.equal((await wrap.query("SELECT COUNT(*)::int AS n FROM issue_categories")).rows[0].n, 10);
  } finally { await lite.close(); }

  // A brand-new install (no people yet) gets kudos switched off; the switch is still there to turn on.
  const fresh = new PGlite('memory://');
  await fresh.waitReady;
  const freshDb = { query: (sql, params) => fresh.query(sql, params), exec: (sql) => fresh.exec(sql), tx: (fn) => fresh.transaction((client) => fn({ query: (sql, params) => client.query(sql, params), exec: (sql) => client.exec(sql) })) };
  try {
    await migrate(freshDb, readMigrationFiles());
    assert.equal((await freshDb.query("SELECT COUNT(*)::int AS n FROM app_settings WHERE key = 'features'")).rows[0].n, 0);
  } finally { await fresh.close(); }
});

test('a fresh install starts with kudos off and the issue box on', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { prepareDatabase } = await import('../server/setup.js');
  const lite = new PGlite('memory://');
  await lite.waitReady;
  const fresh = { query: (sql, params) => lite.query(sql, params), exec: (sql) => lite.exec(sql), tx: (fn) => lite.transaction((client) => fn({ query: (sql, params) => client.query(sql, params), exec: (sql) => client.exec(sql) })), close: () => lite.close() };
  await prepareDatabase(fresh, { seedDemo: true, inventoryPath: null });
  const app = createApp(fresh, {}).listen(0, '127.0.0.1');
  await new Promise((resolve) => app.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${app.address().port}`;
    const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'ava@demo.gcc', password: 'gccdemo' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const config = await (await fetch(`${url}/api/config`, { headers: { Cookie: cookie } })).json();
    assert.equal(config.features.kudos, false);
    assert.equal(config.features.issues, true);
    assert.equal((await fetch(`${url}/api/kudos`, { headers: { Cookie: cookie } })).status, 404);
  } finally { app.close(); await lite.close(); }
});
