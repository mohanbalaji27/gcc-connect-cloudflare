// The activity log keeps one short row per important change (audit_log) and, separately, one row per sign-in (login_events,
// so sign-ins never flood the log). This module turns both into one filterable, paginated, human-readable feed.

export const AREAS = [
  { id: 'bookings', label: 'Bookings', prefixes: ['booking.', 'booking-token.'] },
  { id: 'events', label: 'Events', prefixes: ['event.'] },
  { id: 'spaces', label: 'Spaces and floor plan', prefixes: ['resource.', 'floor-plan.', 'inventory.'] },
  { id: 'map', label: 'Map', prefixes: ['map.'] },
  { id: 'teams', label: 'Teams', prefixes: ['team.'] },
  { id: 'users', label: 'People', prefixes: ['user.'] },
  { id: 'roles', label: 'Roles', prefixes: ['role.'] },
  { id: 'settings', label: 'Settings', prefixes: ['settings.'] },
  { id: 'menu', label: 'Food menu', prefixes: ['menu.'] },
  { id: 'content', label: 'Content', prefixes: ['link.', 'contact.', 'announcement.'] },
  { id: 'issues', label: 'Issue box', prefixes: ['issue.', 'issue-category.'] },
  { id: 'community', label: 'Community', prefixes: ['poll.', 'kudos.', 'feedback.'] },
  { id: 'security', label: 'Security', prefixes: ['password.', 'security.'] },
  { id: 'signin', label: 'Sign-ins', prefixes: [] },
];
const OTHER = { id: 'other', label: 'Other' };
export const SIGN_IN_ACTION = 'auth.sign-in';

export const areaOf = (action) => (action === SIGN_IN_ACTION ? AREAS.find((a) => a.id === 'signin') : AREAS.find((a) => a.prefixes.some((prefix) => action.startsWith(prefix))) ?? OTHER);

const quote = (value) => (value ? `“${value}”` : '');
// action -> [short title, sentence]. The sentence gets { who, target, detail, entity }.
export const ACTIONS = {
  'booking.created': ['Booked a space', ({ who, detail }) => `${who} booked ${detail || 'a space'}`],
  'booking.cancelled': ['Cancelled a booking', ({ who, detail }) => (detail === 'own booking' ? `${who} cancelled their own booking` : `${who} cancelled someone else’s booking (${detail || 'by a manager'})`)],
  'booking-token.created': ['Made a booking QR', ({ who }) => `${who} made a booking QR code`],
  'booking-token.revoked': ['Revoked a booking QR', ({ who }) => `${who} revoked a booking QR code`],
  'event.created': ['Created an event', ({ who, detail }) => `${who} created the event ${quote(detail)}`],
  'event.updated': ['Edited an event', ({ who, detail }) => `${who} edited the event ${quote(detail)}`],
  'event.deleted': ['Deleted an event', ({ who, detail }) => `${who} deleted the event ${quote(detail)}`],
  'resource.created': ['Added a space', ({ who, detail }) => `${who} added the space ${quote(detail)}`],
  'resource.updated': ['Edited a space', ({ who, detail }) => `${who} edited a space (${detail || 'details'})`],
  'resource.retired': ['Retired a space', ({ who, detail }) => `${who} retired the space ${quote(detail)} and cancelled its upcoming bookings`],
  'floor-plan.uploaded': ['Uploaded the floor plan', ({ who, detail }) => `${who} uploaded a new floor plan${detail ? ` (${detail})` : ''}`],
  'inventory.imported': ['Imported seats', ({ who }) => `${who} imported seats from a workbook`],
  'map.calibrated': ['Calibrated the map', ({ who, detail }) => `${who} re-calibrated the map${detail ? ` (${detail})` : ''}`],
  'map.saved': ['Saved the map layout', ({ who, detail }) => `${who} saved the map layout${detail ? `: ${detail}` : ''}`],
  'team.created': ['Created a team', ({ who, detail }) => `${who} created the team ${quote(detail)}`],
  'team.updated': ['Edited a team', ({ who, detail }) => `${who} edited the team ${quote(detail)}`],
  'team.deleted': ['Deleted a team', ({ who, detail }) => `${who} deleted the team ${quote(detail)}`],
  'team.assigned': ['Assigned desks to a team', ({ who, detail }) => `${who} assigned ${detail || 'desks'} to a team`],
  'user.created': ['Added a person', ({ who, detail }) => `${who} added ${detail || 'a person'}`],
  'user.updated': ['Edited a person', ({ who, target, detail }) => `${who} edited ${target || 'a person'}${detail ? ` (${detail})` : ''}`],
  'user.password-reset': ['Reset a password', ({ who, target }) => `${who} reset the password for ${target || 'a person'}`],
  'password.changed': ['Changed password', ({ who }) => `${who} changed their own password`],
  'role.created': ['Created a role', ({ who, detail }) => `${who} created the role ${quote(detail)}`],
  'role.updated': ['Edited a role', ({ who, detail }) => `${who} edited the role ${quote(detail)}`],
  'role.deleted': ['Deleted a role', ({ who, detail }) => `${who} deleted the role ${quote(detail)}`],
  'settings.logo-updated': ['Changed the logo', ({ who, detail }) => `${who} changed the logo${detail ? ` (${detail})` : ''}`],
  'settings.login-image-updated': ['Changed the sign-in picture', ({ who, detail }) => `${who} changed the sign-in picture${detail ? ` (${detail})` : ''}`],
  'settings.updated': ['Changed settings', ({ who, detail }) => `${who} changed settings${detail ? `: ${detail}` : ''}`],
  'menu.day-saved': ['Saved a menu day', ({ who, entity, detail }) => `${who} saved the menu for ${entity || 'a day'}${detail ? ` (${detail})` : ''}`],
  'menu.copied': ['Copied a menu', ({ who, detail }) => `${who} copied a menu${detail ? `: ${detail}` : ''}`],
  'menu.added': ['Added a dish', ({ who, detail }) => `${who} added a dish: ${detail}`],
  'menu.deleted': ['Removed a dish', ({ who, detail }) => `${who} removed the dish ${quote(detail)}`],
  'menu.template-saved': ['Saved a menu template', ({ who, detail }) => `${who} saved the menu template ${quote(detail)}`],
  'menu.template-applied': ['Applied a menu template', ({ who, detail }) => `${who} applied a menu template: ${detail}`],
  'menu.template-deleted': ['Deleted a menu template', ({ who, detail }) => `${who} deleted the menu template ${quote(detail)}`],
  'link.created': ['Added a link', ({ who, detail }) => `${who} added the link ${quote(detail)}`],
  'link.updated': ['Edited a link', ({ who, detail }) => `${who} edited the link ${quote(detail)}`],
  'link.deleted': ['Deleted a link', ({ who, detail }) => `${who} deleted the link ${quote(detail)}`],
  'contact.created': ['Added a contact', ({ who, detail }) => `${who} added the contact ${quote(detail)}`],
  'contact.updated': ['Edited a contact', ({ who, detail }) => `${who} edited the contact ${quote(detail)}`],
  'contact.deleted': ['Deleted a contact', ({ who, detail }) => `${who} deleted the contact ${quote(detail)}`],
  'announcement.created': ['Posted an announcement', ({ who, detail }) => `${who} posted the announcement ${quote(detail)}`],
  'announcement.updated': ['Edited an announcement', ({ who, detail }) => `${who} edited the announcement ${quote(detail)}`],
  'announcement.deleted': ['Deleted an announcement', ({ who, detail }) => `${who} deleted the announcement ${quote(detail)}`],
  'issue.updated': ['Updated an issue', ({ who, detail }) => `${who} updated issue ${detail}`],
  'issue-category.created': ['Added an issue category', ({ who, detail }) => `${who} added the issue category ${quote(detail)}`],
  'issue-category.updated': ['Edited an issue category', ({ who, detail }) => `${who} edited the issue category ${quote(detail)}`],
  'issue-category.routing': ['Changed issue routing', ({ who, detail }) => `${who} changed who is notified about ${quote(detail)} issues`],
  'poll.created': ['Created a poll', ({ who, detail }) => `${who} created the poll ${quote(detail)}`],
  'poll.closed': ['Closed a poll', ({ who, detail }) => `${who} closed the poll ${quote(detail)}`],
  'poll.deleted': ['Deleted a poll', ({ who, detail }) => `${who} deleted the poll ${quote(detail)}`],
  'kudos.removed': ['Removed a shout-out', ({ who, detail }) => `${who} removed a shout-out${detail ? ` (${detail})` : ''}`],
  'feedback.updated': ['Updated an idea', ({ who, detail }) => `${who} marked an idea as ${detail || 'updated'}`],
  'feedback.deleted': ['Deleted an idea', ({ who }) => `${who} deleted an idea`],
  'security.login-burst': ['Repeated failed sign-ins', ({ target, detail }) => `Several failed sign-ins${target ? ` for ${target}` : ''}${detail ? `: ${detail}` : ''}`],
  [SIGN_IN_ACTION]: ['Signed in', ({ who }) => `${who} signed in`],
};

const humanize = (action) => { const text = action.replace(/[.-]/g, ' '); return text.charAt(0).toUpperCase() + text.slice(1); };

export function describe(row) {
  const area = areaOf(row.action);
  const known = ACTIONS[row.action];
  const who = row.actor_name ?? 'Someone';
  const parts = { who, target: row.target_name ?? '', detail: row.detail ?? '', entity: row.entity_id ?? '' };
  return {
    id: row.id, at: row.at, action: row.action, area: area.id, areaLabel: area.label,
    title: known ? known[0] : humanize(row.action),
    text: known ? known[1](parts).replace(/\s+/g, ' ').trim() : `${who}: ${humanize(row.action).toLowerCase()}${row.detail ? ` (${row.detail})` : ''}`,
    actorId: row.actor_id ?? null, actorName: row.actor_name ?? null, detail: row.detail ?? '', entityId: row.entity_id ?? null,
  };
}

const escapeLike = (value) => value.replace(/[\\%_]/g, (match) => `\\${match}`);
const PER_PAGE_DEFAULT = 25;
const PER_PAGE_MAX = 100;
export const EXPORT_CAP = 5000;

/** Validated filters from a query string. Anything unreadable is a 400, never silently ignored. */
export function readFilters(query, fail) {
  const bad = (message) => fail(400, 'INVALID_FILTER', message);
  const filters = { user: null, from: null, to: null, area: null, q: '', before: null, limit: PER_PAGE_DEFAULT };
  if (query.user !== undefined && query.user !== '') {
    if (typeof query.user !== 'string' || !/^[A-Za-z0-9_.@-]{1,100}$/.test(query.user)) throw bad('Choose a person from the list.');
    filters.user = query.user;
  }
  for (const key of ['from', 'to']) {
    if (query[key] === undefined || query[key] === '') continue;
    if (typeof query[key] !== 'string' || query[key].length > 35 || Number.isNaN(Date.parse(query[key]))) throw bad('Choose valid dates.');
    filters[key] = new Date(query[key]);
  }
  if (filters.from && filters.to && filters.to <= filters.from) throw bad('The end date must be after the start date.');
  if (query.area !== undefined && query.area !== '' && query.area !== 'all') {
    if (typeof query.area !== 'string' || !AREAS.some((area) => area.id === query.area)) throw bad('Choose an area from the list.');
    filters.area = query.area;
  }
  if (query.q !== undefined && query.q !== '') {
    if (typeof query.q !== 'string' || query.q.length > 80) throw bad('Search for up to 80 characters.');
    filters.q = query.q.trim();
  }
  if (query.before !== undefined && query.before !== '') {
    const match = typeof query.before === 'string' ? /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([A-Za-z0-9_-]{1,80})$/.exec(query.before) : null;
    if (!match || Number.isNaN(Date.parse(match[1]))) throw bad('That page marker is not valid.');
    filters.before = { at: match[1], id: match[2] };
  }
  if (query.limit !== undefined) {
    const size = Number.parseInt(query.limit, 10);
    if (!Number.isInteger(size) || size < 1) throw bad('Page size must be a positive number.');
    filters.limit = Math.min(size, PER_PAGE_MAX);
  }
  return filters;
}

// One SELECT per source, filtered separately so each can use its own index, then merged newest first.
function conditions(filters, { cursor }) {
  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  const audit = [];
  const login = [];
  if (filters.user) { const p = add(filters.user); audit.push(`a.actor_id = ${p}`); login.push(`l.employee_id = ${p}`); }
  if (filters.from) { const p = add(filters.from); audit.push(`a.created_at >= ${p}`); login.push(`l.at >= ${p}`); }
  if (filters.to) { const p = add(filters.to); audit.push(`a.created_at < ${p}`); login.push(`l.at < ${p}`); }
  let includeAudit = true;
  let includeLogin = true;
  if (filters.area === 'signin') includeAudit = false;
  else if (filters.area) {
    includeLogin = false;
    const patterns = AREAS.find((area) => area.id === filters.area).prefixes.map((prefix) => `${escapeLike(prefix)}%`);
    audit.push(`a.action LIKE ANY(${add(patterns)}::text[])`);
  }
  if (filters.q) {
    const term = filters.q.toLowerCase();
    const matching = Object.entries(ACTIONS).filter(([action, [title]]) => action.includes(term) || title.toLowerCase().includes(term)).map(([action]) => action);
    const like = add(`%${escapeLike(filters.q)}%`);
    const actions = add(matching);
    audit.push(`(a.action ILIKE ${like} OR a.detail ILIKE ${like} OR ae.name ILIKE ${like} OR ae.email ILIKE ${like} OR te.name ILIKE ${like} OR a.action = ANY(${actions}::text[]))`);
    login.push(`(le.name ILIKE ${like} OR le.email ILIKE ${like} OR '${SIGN_IN_ACTION}' = ANY(${actions}::text[]))`);
  }
  if (cursor && filters.before) {
    const at = add(filters.before.at);
    const id = add(filters.before.id);
    audit.push(`(a.created_at, a.id) < (${at}::timestamptz, ${id})`);
    login.push(`(l.at, 'login-' || l.id::text) < (${at}::timestamptz, ${id})`);
  }
  const where = (list) => (list.length ? `WHERE ${list.join(' AND ')}` : '');
  return { params, includeAudit, includeLogin, auditWhere: where(audit), loginWhere: where(login), add };
}

const AUDIT_FROM = 'audit_log a LEFT JOIN employees ae ON ae.id = a.actor_id LEFT JOIN employees te ON te.id = a.entity_id';
const LOGIN_FROM = 'login_events l JOIN employees le ON le.id = l.employee_id';

export function feedQuery(filters, size) {
  const built = conditions(filters, { cursor: true });
  const branches = [];
  const rowLimit = built.add(size);
  if (built.includeAudit) {
    branches.push(`(SELECT a.id, a.created_at AS at, to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at, a.action, a.entity_id, a.detail, a.actor_id, ae.name AS actor_name, ae.email AS actor_email, te.name AS target_name
      FROM ${AUDIT_FROM} ${built.auditWhere} ORDER BY a.created_at DESC, a.id DESC LIMIT ${rowLimit})`);
  }
  if (built.includeLogin) {
    branches.push(`(SELECT 'login-' || l.id::text AS id, l.at, to_char(l.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at, '${SIGN_IN_ACTION}' AS action, NULL::text AS entity_id, l.method AS detail, l.employee_id AS actor_id, le.name AS actor_name, le.email AS actor_email, NULL::text AS target_name
      FROM ${LOGIN_FROM} ${built.loginWhere} ORDER BY l.at DESC, l.id DESC LIMIT ${rowLimit})`);
  }
  // now() keeps Hyperdrive from serving a cached copy of the newest entries.
  return { sql: `SELECT f.*, now() AS read_at FROM (${branches.join(' UNION ALL ')}) f ORDER BY f.at DESC, f.id DESC LIMIT ${rowLimit}`, params: built.params };
}

export function countQuery(filters) {
  const built = conditions(filters, { cursor: false });
  const parts = [];
  if (built.includeAudit) parts.push(`(SELECT COUNT(*) FROM ${AUDIT_FROM} ${built.auditWhere})`);
  if (built.includeLogin) parts.push(`(SELECT COUNT(*) FROM ${LOGIN_FROM} ${built.loginWhere})`);
  return { sql: `SELECT (${parts.join(' + ')})::int AS total, now() AS read_at`, params: built.params };
}

export function registerActivity({ app, db, requirePermission, fail, limit, sendCsv }) {
  // The cursor keeps the full microsecond timestamp, so rows that differ by less than a millisecond are never repeated or skipped.
  const cursorOf = (row) => `${row.cursor_at}|${row.id}`;

  app.get('/api/admin/audit', requirePermission('users.audit'), async (req, res) => {
    if (!limit(`audit:${req.user.id}`, 120, 60_000)) throw fail(429, 'RATE_LIMITED', 'Slow down a little.');
    const filters = readFilters(req.query, fail);
    const feed = feedQuery(filters, filters.limit + 1);
    const first = !filters.before;
    const count = first ? countQuery(filters) : null;
    const [rows, total] = await Promise.all([db.query(feed.sql, feed.params), count ? db.query(count.sql, count.params) : null]);
    const page = rows.rows.slice(0, filters.limit);
    res.json({
      entries: page.map(describe),
      hasMore: rows.rows.length > filters.limit,
      next: rows.rows.length > filters.limit ? cursorOf(page[page.length - 1]) : null,
      ...(first ? { total: total.rows[0].total, areas: AREAS.map(({ id, label }) => ({ id, label })) } : {}),
    });
  });

  // People to pick in the "by person" filter. Includes suspended people, because their past actions are still in the log.
  app.get('/api/admin/audit/people', requirePermission('users.audit'), async (req, res) => {
    if (!limit(`audit-people:${req.user.id}`, 120, 60_000)) throw fail(429, 'RATE_LIMITED', 'Slow down a little.');
    const term = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    if (!term) return res.json({ people: [] });
    const { rows } = await db.query(
      `SELECT id, name, COALESCE(email, username, '') AS email, active, now() AS read_at FROM employees
       WHERE name ILIKE $1 OR email ILIKE $1 OR username ILIKE $1 ORDER BY active DESC, name LIMIT 8`, [`%${escapeLike(term)}%`]);
    return res.json({ people: rows.map(({ id, name, email, active }) => ({ id, name, email, active })) });
  });

  app.get('/api/admin/audit/export', requirePermission('users.audit'), async (req, res) => {
    const filters = readFilters({ ...req.query, before: undefined, limit: undefined }, fail);
    const feed = feedQuery(filters, EXPORT_CAP);
    const { rows } = await db.query(feed.sql, feed.params);
    const istTime = (value) => new Date(new Date(value).getTime() + 19_800_000).toISOString().slice(0, 19).replace('T', ' ');
    sendCsv(res, 'activity-log.csv', ['Time (UTC)', 'Time (IST)', 'Who', 'Email', 'Area', 'What happened', 'Action', 'Detail', 'Item id'], rows.map((row) => {
      const entry = describe(row);
      return [new Date(row.at), istTime(row.at), row.actor_name ?? 'System', row.actor_email ?? '', entry.areaLabel, entry.text, row.action, row.detail, row.entity_id ?? ''];
    }));
  });

  return { areas: AREAS };
}
