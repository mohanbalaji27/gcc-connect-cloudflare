import express from 'express';
import { randomUUID } from 'node:crypto';
import { effectivePermissions } from './security.js';
import { PERSON_COLUMNS, PERSON_JOINS, canReceive } from './notifications.js';

export const ISSUE_STATUSES = ['new', 'acknowledged', 'in_progress', 'waiting', 'resolved', 'closed'];
export const OPEN_STATUSES = ['new', 'acknowledged', 'in_progress', 'waiting'];
export const ISSUE_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const REOPEN_WINDOW_DAYS = 7; // the default; the live value is the issues.reopenDays setting
export const PHOTO_MAX_BYTES = 400 * 1024;
const OPEN_SQL = OPEN_STATUSES.map((status) => `'${status}'`).join(',');
const STATUS_LABEL = { new: 'New', acknowledged: 'Seen', in_progress: 'In progress', waiting: 'Waiting', resolved: 'Fixed', closed: 'Closed' };
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// What a photo really is, from its first bytes. The declared type must agree, so nothing else can be stored or served.
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const FROM_WHERE = `FROM issues i JOIN issue_categories c ON c.id = i.category_id JOIN employees rp ON rp.id = i.reporter_id LEFT JOIN employees asg ON asg.id = i.assignee_id`;
const ISSUE_FIELDS = `i.id, i.number, i.title, i.description, i.category_id, c.name AS category_name, c.emoji AS category_emoji, i.location_text, i.resource_id,
  i.priority, i.status, i.reporter_id, rp.name AS reporter_name, i.assignee_id, asg.name AS assignee_name, i.created_at, i.updated_at, i.resolved_at,
  (SELECT COUNT(*)::int FROM issue_plusones p WHERE p.issue_id = i.id) AS plus_ones,
  (SELECT EXTRACT(EPOCH FROM ph.updated_at)::bigint FROM issue_photos ph WHERE ph.issue_id = i.id) AS photo_v,
  (c.sla_hours IS NOT NULL AND i.status IN (${OPEN_SQL}) AND now() > i.created_at + make_interval(hours => c.sla_hours)) AS overdue,
  now() AS read_at`;

export function registerIssues({ app, db, requireAuth, requireCsrf, requireAnyPermissions, requirePermission, audit, fail, text, limit, feature, readSettings, id8, notifier, sendCsv, options = {} }) {
  const has = (user, permission) => user.permissions.includes(permission);
  const isStaff = (user) => has(user, 'issues.view_all') || has(user, 'issues.update') || has(user, 'issues.assign');
  const canView = (user, row) => row.reporter_id === user.id || row.assignee_id === user.id || has(user, 'issues.view_all');
  // Working on an issue means holding the permission and either owning the issue or being allowed to see the whole queue.
  const canWork = (user, row) => has(user, 'issues.update') && (row.assignee_id === user.id || has(user, 'issues.view_all'));
  const notFound = () => fail(404, 'ISSUE_NOT_FOUND', 'That issue is not available.');

  const shape = (row, user) => ({
    id: row.id, number: row.number, title: row.title, description: row.description,
    categoryId: row.category_id, categoryName: row.category_name, categoryEmoji: row.category_emoji,
    locationText: row.location_text, resourceId: row.resource_id, priority: row.priority, status: row.status,
    reporterId: row.reporter_id, reporterName: isStaff(user) || row.reporter_id === user.id ? row.reporter_name : undefined,
    assigneeId: row.assignee_id, assigneeName: row.assignee_name, createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at,
    plusOnes: row.plus_ones + 1, overdue: Boolean(row.overdue), photoVersion: row.photo_v === null ? null : Number(row.photo_v), mine: row.reporter_id === user.id,
  });
  const loadIssue = async (client, id, lock = false) => {
    if (typeof id !== 'string' || id.length > 64) throw notFound();
    const row = (await client.query(`SELECT ${ISSUE_FIELDS} ${FROM_WHERE} WHERE i.id = $1${lock ? ' FOR UPDATE OF i' : ''}`, [id])).rows[0];
    return row;
  };

  const photosOn = async () => (await readSettings()).options.issuePhotosEnabled !== false;
  const reopenDays = async () => (await readSettings()).values['issues.reopenDays'] ?? REOPEN_WINDOW_DAYS;

  // People who are told about a category: routed people and roles, facility managers, and anyone who subscribed. Their own
  // choices and permissions are applied afterwards, so nobody hears about what they cannot open or have switched off.
  async function routingPeople(categoryId, exceptIds = []) {
    const rows = (await db.query(
      `SELECT ${PERSON_COLUMNS}, (cr.system_key = 'facility_manager') AS is_manager,
              EXISTS (SELECT 1 FROM issue_category_routes r WHERE r.category_id = $1 AND r.kind = 'escalate' AND (r.employee_id = e.id OR (r.role_id IS NOT NULL AND r.role_id = e.custom_role_id))) AS escalate
       FROM employees e ${PERSON_JOINS}
       WHERE e.active = TRUE AND NOT (e.id = ANY($2::text[])) AND (
         EXISTS (SELECT 1 FROM issue_category_routes r WHERE r.category_id = $1 AND r.kind IN ('notify', 'escalate') AND (r.employee_id = e.id OR (r.role_id IS NOT NULL AND r.role_id = e.custom_role_id)))
         OR cr.system_key = 'facility_manager'
         OR e.notify_prefs #>> ARRAY['categories', $1] = 'true'
         OR COALESCE(cr.notify_defaults -> 'categories', '[]'::jsonb) @> to_jsonb($1::text)
       ) LIMIT 400`, [categoryId, exceptIds])).rows;
    return rows.filter((person) => person.notify_prefs?.categories?.[categoryId] !== false);
  }

  const short = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
  const where = (issue) => [issue.category_name, issue.location_text].filter(Boolean).join(' · ');

  async function announceNew(issue, actorId, { reopened = false } = {}) {
    const urgent = issue.priority === 'urgent';
    const people = await routingPeople(issue.category_id, [actorId, issue.assignee_id ?? '']);
    const rows = [];
    for (const person of people) {
      const type = urgent && (person.escalate || person.is_manager) ? 'issue_urgent' : 'issue_new';
      if (!canReceive(person, type)) continue;
      rows.push({
        userId: person.id, type,
        title: `${type === 'issue_urgent' ? '🚨 Urgent' : reopened ? 'Not fixed' : 'New issue'} #${issue.number}: ${issue.category_name}`,
        body: [issue.location_text, short(issue.title, 100)].filter(Boolean).join(' · '),
        link: `issue:${issue.id}`, data: { issueId: issue.id, number: issue.number },
      });
    }
    await notifier.insertRows(db, rows);
  }

  async function announceChange(issue, actor, { statusChanged, priorityRaisedToUrgent, assignedTo, note }) {
    const base = { link: `issue:${issue.id}`, data: { issueId: issue.id, number: issue.number }, exceptId: actor.id };
    const label = `#${issue.number} ${issue.category_name}`;
    if (assignedTo && assignedTo !== actor.id) {
      await notifier.deliverToIds(db, [assignedTo], { ...base, type: 'issue_assigned', title: `Assigned to you: ${label}`, body: [issue.location_text, short(issue.title, 100)].filter(Boolean).join(' · ') });
    }
    if (statusChanged || assignedTo || note) {
      const headline = statusChanged ? `${STATUS_LABEL[issue.status]}: ${label}` : assignedTo ? `${issue.assignee_name} is on it: ${label}` : `New note: ${label}`;
      const recipients = [issue.reporter_id, issue.assignee_id].filter((id) => id && id !== assignedTo);
      await notifier.deliverToIds(db, recipients, { ...base, type: 'issue_update', title: headline, body: note ? short(note, 200) : issue.location_text });
    }
    if (statusChanged && ['resolved', 'closed'].includes(issue.status)) {
      const followers = (await db.query('SELECT employee_id FROM issue_plusones WHERE issue_id = $1 LIMIT 500', [issue.id])).rows.map((row) => row.employee_id);
      // Followers only learn the outcome; they never get the details of somebody else's report.
      await notifier.deliverToIds(db, followers, { type: 'issue_update', title: `Fixed: ${label}`, body: 'The issue you added a +1 to was marked fixed.', link: 'issues', data: { number: issue.number }, exceptId: actor.id });
    }
    if (priorityRaisedToUrgent) {
      const people = (await routingPeople(issue.category_id, [actor.id])).filter((person) => person.escalate || person.is_manager);
      await notifier.insertRows(db, people.filter((person) => canReceive(person, 'issue_urgent')).map((person) => ({
        userId: person.id, type: 'issue_urgent', title: `🚨 Urgent #${issue.number}: ${issue.category_name}`, body: [issue.location_text, short(issue.title, 100)].filter(Boolean).join(' · '), link: `issue:${issue.id}`, data: base.data,
      })));
    }
  }

  const quietly = (task) => task.catch((error) => console.error('Notification fan-out failed:', error.message));

  // ---------- Categories (everyone) ----------
  app.get('/api/issues/categories', requireAuth, feature('issues'), async (_req, res) => {
    const rows = (await db.query("SELECT id, name, emoji, description, default_priority, now() AS read_at FROM issue_categories WHERE active = TRUE ORDER BY sort_order, name LIMIT 60")).rows;
    res.set('Cache-Control', 'private, no-cache');
    res.json({
      categories: rows.map((row) => ({ id: row.id, name: row.name, emoji: row.emoji, description: row.description, defaultPriority: row.default_priority })),
      photosEnabled: await photosOn(), reopenDays: await reopenDays(),
    });
  });

  // Open issues at the same place or in the same category: enough to say "3 people already reported this", never their content.
  app.get('/api/issues/similar', requireAuth, feature('issues'), async (req, res) => {
    if (!limit(`issue-similar:${req.user.id}`, 60, 60_000)) throw fail(429, 'RATE_LIMITED', 'Slow down a little.');
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId.slice(0, 64) : '';
    const resourceId = typeof req.query.resourceId === 'string' && req.query.resourceId ? req.query.resourceId.slice(0, 64) : null;
    if (!categoryId) throw fail(400, 'INVALID_INPUT', 'Choose a category first.');
    const rows = (await db.query(
      `SELECT i.id, i.number, i.status, i.location_text, i.created_at, i.reporter_id,
              (SELECT COUNT(*)::int FROM issue_plusones p WHERE p.issue_id = i.id) AS plus_ones,
              EXISTS (SELECT 1 FROM issue_plusones p WHERE p.issue_id = i.id AND p.employee_id = $3) AS plus_oned
       FROM issues i WHERE i.category_id = $1 AND i.status IN (${OPEN_SQL}) AND ($2::text IS NULL OR i.resource_id = $2)
       ORDER BY i.created_at DESC LIMIT 5`, [categoryId, resourceId, req.user.id])).rows;
    res.json({ similar: rows.map((row) => ({ id: row.id, number: row.number, status: row.status, locationText: row.location_text, createdAt: row.created_at, people: row.plus_ones + 1, mine: row.reporter_id === req.user.id, plusOned: row.plus_oned })) });
  });

  // ---------- Reporting ----------
  app.post('/api/issues', requireAuth, feature('issues'), requireCsrf, async (req, res) => {
    if (!limit(`issue:${req.user.id}`, options.issueRateLimit ?? 10, 60 * 60_000)) throw fail(429, 'RATE_LIMITED', 'You have sent a few reports already. Please wait a bit, or add a +1 to an existing one.');
    const body = req.body ?? {};
    const description = text(body.description, 1000, { required: true, label: 'Description' });
    if (description.length < 3) throw fail(400, 'INVALID_INPUT', 'Say a few words about the problem.');
    const rawTitle = text(body.title, 120, { label: 'Title' });
    const title = rawTitle || short(description.split('\n')[0], 80);
    if (typeof body.categoryId !== 'string') throw fail(400, 'INVALID_INPUT', 'Pick a category.');
    const priority = body.priority === undefined ? null : body.priority;
    if (priority !== null && !ISSUE_PRIORITIES.includes(priority)) throw fail(400, 'INVALID_PRIORITY', 'Choose low, normal, high or urgent.');
    let locationText = text(body.locationText, 120, { label: 'Location' }) ?? '';
    const key = req.get('Idempotency-Key');
    if (key && key.length > 100) throw fail(400, 'INVALID_INPUT', 'That request key is too long.');

    const created = await db.tx(async (tx) => {
      const category = (await tx.query('SELECT id, name, default_priority FROM issue_categories WHERE id = $1 AND active = TRUE', [body.categoryId])).rows[0];
      if (!category) throw fail(400, 'INVALID_CATEGORY', 'That category is not available. Pick another.');
      let resourceId = null;
      if (body.resourceId !== undefined && body.resourceId !== null && body.resourceId !== '') {
        const resource = typeof body.resourceId === 'string' ? (await tx.query('SELECT id, label, type, zone, floor FROM resources WHERE id = $1 AND active = TRUE', [body.resourceId])).rows[0] : null;
        if (!resource) throw fail(400, 'INVALID_RESOURCE', 'That seat or room is not available.');
        resourceId = resource.id;
        if (!locationText) locationText = `${resource.type === 'room' ? 'Room' : 'Seat'} ${resource.label}${resource.floor ? ` · ${resource.floor}` : ''}`.slice(0, 120);
      }
      const assignee = (await tx.query(
        `SELECT e.id, e.name, e.role, e.permissions, COALESCE(cr.permissions, '{}') AS role_permissions
         FROM issue_category_routes r JOIN employees e ON e.id = r.employee_id AND e.active = TRUE LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id
         WHERE r.category_id = $1 AND r.kind = 'assign' AND e.id <> $2
         ORDER BY (SELECT COUNT(*) FROM issues x WHERE x.assignee_id = e.id AND x.status IN (${OPEN_SQL})), r.id LIMIT 3`, [category.id, req.user.id])).rows
        .find((person) => effectivePermissions(person).includes('issues.update'));
      const id = randomUUID();
      const inserted = (await tx.query(
        `INSERT INTO issues (id, title, description, category_id, location_text, resource_id, priority, reporter_id, assignee_id, client_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (reporter_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id, number`,
        [id, title, description, category.id, locationText, resourceId, priority ?? category.default_priority, req.user.id, assignee?.id ?? null, key ?? null])).rows[0];
      if (!inserted) {
        const existing = (await tx.query('SELECT id, number FROM issues WHERE reporter_id = $1 AND client_key = $2', [req.user.id, key])).rows[0];
        return { ...existing, duplicate: true };
      }
      if (assignee) await tx.query("INSERT INTO issue_updates (issue_id, author_id, kind, body, to_value) VALUES ($1, NULL, 'assign', 'Assigned automatically for this category', $2)", [id, assignee.id]);
      return { id, number: inserted.number, duplicate: false, assignee };
    });
    if (!created.duplicate) {
      await quietly((async () => {
        const issue = await loadIssue(db, created.id);
        await announceNew(issue, req.user.id);
        if (created.assignee) await notifier.deliverToIds(db, [created.assignee.id], { type: 'issue_assigned', title: `Assigned to you: #${issue.number} ${issue.category_name}`, body: [issue.location_text, short(issue.title, 100)].filter(Boolean).join(' · '), link: `issue:${issue.id}`, data: { issueId: issue.id, number: issue.number } });
      })());
    }
    res.status(created.duplicate ? 200 : 201).json({ id: created.id, number: created.number, duplicate: created.duplicate });
  });

  app.put('/api/issues/:id/plus-one', requireAuth, feature('issues'), requireCsrf, async (req, res) => {
    if (!limit(`issue-plus:${req.user.id}`, 40, 60 * 60_000)) throw fail(429, 'RATE_LIMITED', 'That is a lot of +1s. Please wait a bit.');
    const issue = (await db.query('SELECT id, reporter_id, status FROM issues WHERE id = $1', [req.params.id])).rows[0];
    if (!issue || !OPEN_STATUSES.includes(issue.status)) throw fail(404, 'ISSUE_NOT_FOUND', 'That issue is no longer open.');
    if (issue.reporter_id === req.user.id) throw fail(409, 'OWN_ISSUE', 'You reported this one already.');
    await db.query('INSERT INTO issue_plusones (issue_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [issue.id, req.user.id]);
    res.json({ people: (await db.query('SELECT COUNT(*)::int AS n FROM issue_plusones WHERE issue_id = $1', [issue.id])).rows[0].n + 1 });
  });
  app.delete('/api/issues/:id/plus-one', requireAuth, feature('issues'), requireCsrf, async (req, res) => {
    await db.query('DELETE FROM issue_plusones WHERE issue_id = $1 AND employee_id = $2', [req.params.id, req.user.id]);
    res.status(204).end();
  });

  // ---------- Lists ----------
  app.get('/api/issues', requireAuth, feature('issues'), async (req, res) => {
    const scope = req.query.scope ?? 'mine';
    if (!['mine', 'assigned', 'all'].includes(scope)) throw fail(400, 'INVALID_INPUT', 'Choose mine, assigned or all.');
    if (scope === 'all' && !has(req.user, 'issues.view_all')) throw fail(403, 'PERMISSION_REQUIRED', 'You need permission to see all issues.');
    const params = [req.user.id];
    const clauses = ['$1::text IS NOT NULL'];
    const add = (sql, value) => { params.push(value); clauses.push(sql.replace('?', `$${params.length}`)); };
    if (scope === 'mine') clauses.push('i.reporter_id = $1');
    if (scope === 'assigned') { clauses.push('i.assignee_id = $1'); if (req.query.status !== 'any') clauses.push(`i.status IN (${OPEN_SQL})`); }
    if (scope === 'all') {
      const status = typeof req.query.status === 'string' ? req.query.status : 'open';
      if (status === 'open') clauses.push(`i.status IN (${OPEN_SQL})`);
      else if (status === 'closed' || status === 'resolved,closed') clauses.push("i.status IN ('resolved', 'closed')");
      else if (status !== 'any') {
        const list = status.split(',').filter((item) => ISSUE_STATUSES.includes(item));
        if (!list.length) throw fail(400, 'INVALID_INPUT', 'Choose a valid status.');
        add('i.status = ANY(?::text[])', list);
      }
      if (typeof req.query.categoryId === 'string' && req.query.categoryId) add('i.category_id = ?', req.query.categoryId.slice(0, 64));
      if (ISSUE_PRIORITIES.includes(req.query.priority)) add('i.priority = ?', req.query.priority);
      if (req.query.assignee === 'none') clauses.push('i.assignee_id IS NULL');
      else if (req.query.assignee === 'me') clauses.push('i.assignee_id = $1');
      else if (typeof req.query.assignee === 'string' && req.query.assignee) add('i.assignee_id = ?', req.query.assignee.slice(0, 64));
      const days = Number.parseInt(req.query.olderThanDays, 10);
      if (Number.isInteger(days) && days > 0 && days < 3650) add("i.created_at < now() - make_interval(days => ?::int)", days);
      if (req.query.overdue === '1') clauses.push(`(c.sla_hours IS NOT NULL AND i.status IN (${OPEN_SQL}) AND now() > i.created_at + make_interval(hours => c.sla_hours))`);
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
      if (q) {
        const number = /^#?(\d{1,9})$/.exec(q);
        if (number) add('i.number = ?::int', Number(number[1]));
        else {
          params.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
          const n = params.length;
          clauses.push(`(i.title ILIKE $${n} OR i.description ILIKE $${n} OR i.location_text ILIKE $${n})`);
        }
      }
    }
    const order = req.query.sort === 'oldest' ? 'i.created_at ASC' : req.query.sort === 'priority'
      ? "CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, i.created_at ASC"
      : scope === 'mine' ? 'i.updated_at DESC' : 'i.created_at DESC';
    const size = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 60, 1), 100);
    const offset = Math.min(Math.max(Number.parseInt(req.query.offset, 10) || 0, 0), 5000);
    const rows = (await db.query(`SELECT ${ISSUE_FIELDS} ${FROM_WHERE} WHERE ${clauses.join(' AND ') || 'TRUE'} ORDER BY ${order}, i.number DESC LIMIT ${size + 1} OFFSET ${offset}`, params)).rows;
    const reply = { issues: rows.slice(0, size).map((row) => shape(row, req.user)), hasMore: rows.length > size };
    if (scope !== 'mine' && (scope === 'assigned' || has(req.user, 'issues.view_all'))) {
      const counts = (await db.query(
        `SELECT COUNT(*) FILTER (WHERE i.status = 'new' AND i.status IN (${OPEN_SQL}))::int AS new_count,
                COUNT(*) FILTER (WHERE i.assignee_id IS NULL AND i.status IN (${OPEN_SQL}))::int AS unassigned,
                COUNT(*) FILTER (WHERE i.assignee_id = $1 AND i.status IN (${OPEN_SQL}))::int AS mine,
                COUNT(*) FILTER (WHERE i.status IN (${OPEN_SQL}))::int AS open,
                COUNT(*) FILTER (WHERE i.status IN ('resolved', 'closed'))::int AS closed,
                COUNT(*) FILTER (WHERE c.sla_hours IS NOT NULL AND i.status IN (${OPEN_SQL}) AND now() > i.created_at + make_interval(hours => c.sla_hours))::int AS overdue
         FROM issues i JOIN issue_categories c ON c.id = i.category_id`, [req.user.id])).rows[0];
      reply.counts = { open: counts.open, closed: counts.closed, new: counts.new_count, unassigned: has(req.user, 'issues.view_all') ? counts.unassigned : 0, mine: counts.mine, overdue: has(req.user, 'issues.view_all') ? counts.overdue : 0 };
    }
    res.json(reply);
  });

  // People an issue can be given to: active people who can work on issues.
  app.get('/api/issues/assignees', requireAnyPermissions('issues.assign', 'issues.view_all'), feature('issues'), async (_req, res) => {
    const rows = (await db.query(
      `SELECT e.id, e.name, e.team, e.role, e.permissions, COALESCE(cr.permissions, '{}') AS role_permissions
       FROM employees e LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id
       WHERE e.active = TRUE AND (e.role = 'super_admin' OR cardinality(e.permissions) > 0 OR cardinality(cr.permissions) > 0) ORDER BY e.name LIMIT 300`)).rows;
    res.json({ people: rows.filter((row) => effectivePermissions(row).includes('issues.update')).map((row) => ({ id: row.id, name: row.name, team: row.team })) });
  });

  const detail = async (user, id) => {
    const row = await loadIssue(db, id);
    if (!row || !canView(user, row)) throw notFound();
    const staffView = isStaff(user);
    const updates = (await db.query(
      `SELECT u.id::text AS id, u.kind, u.body, u.internal, u.from_value, u.to_value, u.created_at, u.author_id, a.name AS author_name
       FROM issue_updates u LEFT JOIN employees a ON a.id = u.author_id WHERE u.issue_id = $1 AND (u.internal = FALSE OR $2::boolean) ORDER BY u.id LIMIT 300`, [row.id, staffView])).rows;
    const windowOpen = row.resolved_at && Date.now() - new Date(row.resolved_at).getTime() <= (await reopenDays()) * 86_400_000;
    return {
      issue: shape(row, user),
      updates: updates.map((u) => ({ id: u.id, kind: u.kind, body: u.body, internal: u.internal, from: u.from_value, to: u.to_value, createdAt: u.created_at, authorId: u.author_id, authorName: u.author_name })),
      can: {
        reopen: row.reporter_id === user.id && ['resolved', 'closed'].includes(row.status) && Boolean(windowOpen),
        work: canWork(user, row), assign: has(user, 'issues.assign'), comment: row.reporter_id === user.id || canWork(user, row), internalNote: canWork(user, row),
        photo: row.reporter_id === user.id && (await photosOn()),
      },
    };
  };
  app.get('/api/issues/:id', requireAuth, feature('issues'), async (req, res) => res.json(await detail(req.user, req.params.id)));

  // ---------- Working on an issue ----------
  app.patch('/api/issues/:id', requireAuth, feature('issues'), requireCsrf, async (req, res) => {
    if (!limit(`issue-work:${req.user.id}`, 120, 60 * 60_000)) throw fail(429, 'RATE_LIMITED', 'Slow down a little.');
    const body = req.body ?? {};
    const note = text(body.note, 500, { label: 'Note' }) || '';
    if (body.status !== undefined && !ISSUE_STATUSES.includes(body.status)) throw fail(400, 'INVALID_STATUS', 'Choose a valid status.');
    if (body.priority !== undefined && !ISSUE_PRIORITIES.includes(body.priority)) throw fail(400, 'INVALID_PRIORITY', 'Choose low, normal, high or urgent.');
    if (body.assigneeId !== undefined && body.assigneeId !== null && typeof body.assigneeId !== 'string') throw fail(400, 'INVALID_INPUT', 'Choose a person to assign.');
    if (body.status === undefined && body.priority === undefined && body.assigneeId === undefined) throw fail(400, 'NOTHING_TO_UPDATE', 'No changes were supplied.');

    const result = await db.tx(async (tx) => {
      const before = await loadIssue(tx, req.params.id, true);
      if (!before || !canView(req.user, before)) throw notFound();
      const changesWork = (body.status !== undefined && body.status !== before.status) || (body.priority !== undefined && body.priority !== before.priority);
      if (changesWork && !canWork(req.user, before)) throw fail(403, 'PERMISSION_REQUIRED', 'You cannot change this issue.');

      let nextAssignee = before.assignee_id;
      let assignmentChanged = false;
      if (body.assigneeId !== undefined && (body.assigneeId ?? null) !== before.assignee_id) {
        const target = body.assigneeId;
        const mayAssign = has(req.user, 'issues.assign');
        const takingForMyself = target === req.user.id && has(req.user, 'issues.update') && (before.assignee_id === null || mayAssign);
        const releasing = target === null && before.assignee_id === req.user.id && has(req.user, 'issues.update');
        if (!mayAssign && !takingForMyself && !releasing) throw fail(403, 'PERMISSION_REQUIRED', 'You cannot assign this issue.');
        if (target !== null) {
          const person = (await tx.query(`SELECT e.id, e.role, e.permissions, COALESCE(cr.permissions, '{}') AS role_permissions FROM employees e LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id WHERE e.id = $1 AND e.active = TRUE`, [target])).rows[0];
          if (!person || !effectivePermissions(person).includes('issues.update')) throw fail(400, 'INVALID_ASSIGNEE', 'That person cannot work on issues.');
        }
        nextAssignee = target;
        assignmentChanged = true;
      } else if (body.status !== undefined && body.status !== before.status && before.assignee_id === null && has(req.user, 'issues.update') && ['acknowledged', 'in_progress'].includes(body.status)) {
        // Starting an unassigned issue takes it.
        nextAssignee = req.user.id;
        assignmentChanged = true;
      }
      const nextStatus = body.status ?? before.status;
      const nextPriority = body.priority ?? before.priority;
      const statusChanged = nextStatus !== before.status;
      const priorityChanged = nextPriority !== before.priority;
      if (!statusChanged && !priorityChanged && !assignmentChanged) return { before, unchanged: true };

      const closing = ['resolved', 'closed'].includes(nextStatus);
      await tx.query(
        `UPDATE issues SET status = $2, priority = $3, assignee_id = $4, updated_at = now(),
           resolved_at = CASE WHEN $5::boolean THEN COALESCE(resolved_at, now()) ELSE NULL END WHERE id = $1`,
        [before.id, nextStatus, nextPriority, nextAssignee, closing]);
      const timeline = [];
      if (statusChanged) timeline.push(['status', note, before.status, nextStatus]);
      if (priorityChanged) timeline.push(['priority', statusChanged ? '' : note, before.priority, nextPriority]);
      if (assignmentChanged) timeline.push(['assign', !statusChanged && !priorityChanged ? note : '', before.assignee_id, nextAssignee]);
      for (const [kind, noteText, from, to] of timeline) {
        await tx.query('INSERT INTO issue_updates (issue_id, author_id, kind, body, from_value, to_value) VALUES ($1,$2,$3,$4,$5,$6)', [before.id, req.user.id, kind, noteText, from, to]);
      }
      await audit(tx, req.user.id, 'issue.updated', before.id, `#${before.number} ${[statusChanged && nextStatus, priorityChanged && nextPriority, assignmentChanged && 'assignment'].filter(Boolean).join(', ')}`);
      return { before, statusChanged, priorityChanged, assignmentChanged, nextAssignee, nextPriority };
    });
    if (!result.unchanged) {
      await quietly((async () => {
        const after = await loadIssue(db, req.params.id);
        await announceChange(after, req.user, {
          statusChanged: result.statusChanged, priorityRaisedToUrgent: result.priorityChanged && result.nextPriority === 'urgent',
          assignedTo: result.assignmentChanged ? result.nextAssignee : null, note,
        });
      })());
    }
    try { res.json(await detail(req.user, req.params.id)); } catch (error) {
      // Letting go of an issue you may no longer see is a success, not an error.
      if (error.code === 'ISSUE_NOT_FOUND') res.json({ released: true }); else throw error;
    }
  });

  app.post('/api/issues/:id/comments', requireAuth, feature('issues'), requireCsrf, async (req, res) => {
    if (!limit(`issue-comment:${req.user.id}`, 60, 60 * 60_000)) throw fail(429, 'RATE_LIMITED', 'That is a lot of comments. Please wait a bit.');
    const body = text(req.body?.body, 1000, { required: true, label: 'Comment' });
    if (req.body?.internal !== undefined && typeof req.body.internal !== 'boolean') throw fail(400, 'INVALID_INPUT', 'Internal must be on or off.');
    const internal = req.body?.internal === true;
    const issue = await loadIssue(db, req.params.id);
    if (!issue || !canView(req.user, issue)) throw notFound();
    const work = canWork(req.user, issue);
    if (issue.reporter_id !== req.user.id && !work) throw fail(403, 'PERMISSION_REQUIRED', 'You cannot comment on this issue.');
    if (internal && !work) throw fail(403, 'PERMISSION_REQUIRED', 'Only people working on issues can leave staff notes.');
    await db.tx(async (tx) => {
      await tx.query('INSERT INTO issue_updates (issue_id, author_id, kind, body, internal) VALUES ($1,$2,$3,$4,$5)', [issue.id, req.user.id, 'comment', body, internal]);
      await tx.query('UPDATE issues SET updated_at = now() WHERE id = $1', [issue.id]);
    });
    await quietly(notifier.deliverToIds(db, internal ? [issue.assignee_id] : [issue.reporter_id, issue.assignee_id], {
      type: 'issue_update', title: `${internal ? 'Staff note' : 'New comment'}: #${issue.number} ${issue.category_name}`, body: short(body, 200), link: `issue:${issue.id}`, data: { issueId: issue.id, number: issue.number }, exceptId: req.user.id,
    }));
    res.status(201).json(await detail(req.user, issue.id));
  });

  // "Still not fixed": the reporter can reopen within a week of the fix.
  app.post('/api/issues/:id/reopen', requireAuth, feature('issues'), requireCsrf, async (req, res) => {
    if (!limit(`issue-reopen:${req.user.id}`, 10, 60 * 60_000)) throw fail(429, 'RATE_LIMITED', 'Please wait a bit before trying again.');
    const note = text(req.body?.note, 500, { label: 'Note' }) || '';
    const windowDays = await reopenDays();
    const result = await db.tx(async (tx) => {
      const issue = await loadIssue(tx, req.params.id, true);
      if (!issue || issue.reporter_id !== req.user.id) throw notFound();
      if (!['resolved', 'closed'].includes(issue.status)) throw fail(409, 'NOT_RESOLVED', 'This issue is still open.');
      if (!issue.resolved_at || Date.now() - new Date(issue.resolved_at).getTime() > windowDays * 86_400_000) throw fail(409, 'REOPEN_WINDOW_OVER', `This was fixed more than ${windowDays} days ago. Please report it again.`);
      await tx.query("UPDATE issues SET status = 'new', resolved_at = NULL, updated_at = now() WHERE id = $1", [issue.id]);
      await tx.query("INSERT INTO issue_updates (issue_id, author_id, kind, body, from_value, to_value) VALUES ($1,$2,'reopen',$3,$4,'new')", [issue.id, req.user.id, note || 'Still not fixed', issue.status]);
      return issue;
    });
    await quietly((async () => {
      const issue = await loadIssue(db, result.id);
      if (issue.assignee_id) {
        await notifier.deliverToIds(db, [issue.assignee_id], { type: 'issue_update', title: `Not fixed: #${issue.number} ${issue.category_name}`, body: note || 'The reporter says it is still not fixed.', link: `issue:${issue.id}`, data: { issueId: issue.id, number: issue.number } });
      } else await announceNew(issue, req.user.id, { reopened: true });
    })());
    res.json(await detail(req.user, req.params.id));
  });

  // "Need help": a person on the job asks the managers for backup without changing the status.
  app.post('/api/issues/:id/help', requireAuth, feature('issues'), requireCsrf, async (req, res) => {
    if (!limit(`issue-help:${req.user.id}`, 20, 60 * 60_000)) throw fail(429, 'RATE_LIMITED', 'Please wait a bit before asking again.');
    const note = text(req.body?.note, 300, { label: 'Note' }) || '';
    const issue = await loadIssue(db, req.params.id);
    if (!issue || !canView(req.user, issue) || !canWork(req.user, issue)) throw notFound();
    await db.query("INSERT INTO issue_updates (issue_id, author_id, kind, body, internal) VALUES ($1,$2,'help',$3,TRUE)", [issue.id, req.user.id, note || 'Needs help']);
    await quietly((async () => {
      const people = (await routingPeople(issue.category_id, [req.user.id])).filter((person) => person.escalate || person.is_manager);
      await notifier.insertRows(db, people.filter((person) => canReceive(person, 'issue_urgent')).map((person) => ({
        userId: person.id, type: 'issue_urgent', title: `🙋 ${req.user.name} needs help: #${issue.number} ${issue.category_name}`, body: note || short(issue.title, 100), link: `issue:${issue.id}`, data: { issueId: issue.id, number: issue.number },
      })));
    })());
    res.status(201).json(await detail(req.user, issue.id));
  });

  // ---------- Photo (one small picture per issue) ----------
  app.put('/api/issues/:id/photo', requireAuth, feature('issues'), requireCsrf, express.raw({ type: PHOTO_TYPES, limit: PHOTO_MAX_BYTES }), async (req, res) => {
    if (!(await photosOn())) throw fail(403, 'PHOTOS_OFF', 'Photos are turned off.');
    if (!limit(`issue-photo:${req.user.id}`, 20, 60 * 60_000)) throw fail(429, 'RATE_LIMITED', 'Please wait a bit before sending more photos.');
    const issue = (await db.query('SELECT id, reporter_id FROM issues WHERE id = $1', [req.params.id])).rows[0];
    if (!issue || issue.reporter_id !== req.user.id) throw notFound();
    const kind = sniffImage(req.body);
    if (!kind || kind !== req.get('Content-Type')?.split(';')[0].trim().toLowerCase()) throw fail(400, 'INVALID_PHOTO', 'Use a JPEG, PNG or WebP photo (up to 400 KB).');
    await db.query(
      `INSERT INTO issue_photos (issue_id, content_type, data, size) VALUES ($1,$2,$3,$4)
       ON CONFLICT (issue_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, size = excluded.size, updated_at = now()`,
      [issue.id, kind, req.body, req.body.length]);
    await db.query('UPDATE issues SET updated_at = now() WHERE id = $1', [issue.id]);
    res.status(204).end();
  });
  app.get('/api/issues/:id/photo', requireAuth, feature('issues'), async (req, res) => {
    const issue = (await db.query('SELECT id, reporter_id, assignee_id FROM issues WHERE id = $1', [req.params.id])).rows[0];
    if (!issue || !canView(req.user, issue)) throw notFound();
    const photo = (await db.query('SELECT content_type, data FROM issue_photos WHERE issue_id = $1', [issue.id])).rows[0];
    if (!photo) throw fail(404, 'NO_PHOTO', 'There is no photo on this issue.');
    const buffer = Buffer.from(photo.data);
    res.set({ 'Content-Type': photo.content_type, 'Content-Length': buffer.length, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.end(buffer);
  });

  // ---------- Categories and routing (managers) ----------
  const clampText = (value, max, label, required) => text(typeof value === 'string' ? value.replace(/\s+/g, ' ') : value, max, { required, label });
  const categoryBody = (body, partial) => {
    const out = {};
    const name = clampText(body?.name, 60, 'Name', !partial);
    if (name !== undefined) out.name = name;
    const description = clampText(body?.description, 160, 'Description', false);
    if (description !== undefined) out.description = description;
    const emoji = clampText(body?.emoji, 8, 'Emoji', false);
    if (emoji !== undefined) out.emoji = emoji || '🔧';
    if (body?.defaultPriority !== undefined) {
      if (!ISSUE_PRIORITIES.includes(body.defaultPriority)) throw fail(400, 'INVALID_PRIORITY', 'Choose low, normal, high or urgent.');
      out.default_priority = body.defaultPriority;
    }
    if (body?.slaHours !== undefined) {
      if (body.slaHours !== null && (!Number.isInteger(body.slaHours) || body.slaHours < 1 || body.slaHours > 2160)) throw fail(400, 'INVALID_INPUT', 'The target must be between 1 and 2160 hours, or empty.');
      out.sla_hours = body.slaHours;
    }
    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') throw fail(400, 'INVALID_INPUT', 'Active must be on or off.');
      out.active = body.active;
    }
    return out;
  };
  const MANAGER = requireAnyPermissions('issues.manage_categories', 'notifications.route');

  app.get('/api/admin/issue-categories', MANAGER, async (_req, res) => {
    const categories = (await db.query(
      `SELECT c.id, c.name, c.emoji, c.description, c.sort_order, c.active, c.default_priority, c.sla_hours,
              (SELECT COUNT(*)::int FROM issues i WHERE i.category_id = c.id AND i.status IN (${OPEN_SQL})) AS open_issues
       FROM issue_categories c ORDER BY c.sort_order, c.name LIMIT 100`)).rows;
    const routes = (await db.query(
      `SELECT r.category_id, r.kind, r.employee_id, r.role_id, e.name AS employee_name, cr.name AS role_name, cr.emoji AS role_emoji
       FROM issue_category_routes r LEFT JOIN employees e ON e.id = r.employee_id LEFT JOIN custom_roles cr ON cr.id = r.role_id ORDER BY r.id LIMIT 2000`)).rows;
    const roles = (await db.query('SELECT id, name, emoji FROM custom_roles ORDER BY name LIMIT 100')).rows;
    res.json({
      categories: categories.map((row) => ({
        id: row.id, name: row.name, emoji: row.emoji, description: row.description, sortOrder: row.sort_order, active: row.active, defaultPriority: row.default_priority, slaHours: row.sla_hours, openIssues: row.open_issues,
        routes: Object.fromEntries(['notify', 'escalate', 'assign'].map((kind) => [kind, routes.filter((r) => r.category_id === row.id && r.kind === kind).map((r) => (r.employee_id
          ? { employeeId: r.employee_id, name: r.employee_name } : { roleId: r.role_id, name: r.role_name, emoji: r.role_emoji }))])),
      })),
      roles,
    });
  });

  app.post('/api/admin/issue-categories', requirePermission('issues.manage_categories'), requireCsrf, async (req, res) => {
    const body = categoryBody(req.body, false);
    const id = id8('icat');
    const next = (await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM issue_categories')).rows[0].n;
    await db.tx(async (tx) => {
      await tx.query('INSERT INTO issue_categories (id, name, emoji, description, default_priority, sla_hours, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, body.name, body.emoji ?? '🔧', body.description ?? '', body.default_priority ?? 'normal', body.sla_hours ?? null, next]);
      await audit(tx, req.user.id, 'issue-category.created', id, body.name);
    });
    res.status(201).json({ id });
  });

  app.patch('/api/admin/issue-categories/:id', requirePermission('issues.manage_categories'), requireCsrf, async (req, res) => {
    const body = categoryBody(req.body, true);
    const keys = Object.keys(body);
    if (!keys.length) throw fail(400, 'NOTHING_TO_UPDATE', 'No changes were supplied.');
    const result = await db.query(`UPDATE issue_categories SET ${keys.map((key, index) => `${key} = $${index + 2}`).join(', ')} WHERE id = $1 RETURNING name`, [req.params.id, ...keys.map((key) => body[key])]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That category no longer exists.');
    await audit(db, req.user.id, 'issue-category.updated', req.params.id, result.rows[0].name);
    res.status(204).end();
  });

  app.put('/api/admin/issue-categories-order', requirePermission('issues.manage_categories'), requireCsrf, async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw fail(400, 'INVALID_INPUT', 'Send the categories in the order you want.');
    await db.query('UPDATE issue_categories c SET sort_order = x.n FROM unnest($1::text[], $2::int[]) AS x(id, n) WHERE c.id = x.id', [ids, ids.map((_, index) => index + 1)]);
    res.status(204).end();
  });

  app.put('/api/admin/issue-categories/:id/routes', requirePermission('notifications.route'), requireCsrf, async (req, res) => {
    const category = (await db.query('SELECT id, name FROM issue_categories WHERE id = $1', [req.params.id])).rows[0];
    if (!category) throw fail(404, 'NOT_FOUND', 'That category no longer exists.');
    const rows = [];
    for (const kind of ['notify', 'escalate', 'assign']) {
      const list = req.body?.[kind] ?? [];
      if (!Array.isArray(list) || list.length > 30) throw fail(400, 'INVALID_INPUT', 'Pick up to 30 people or roles per list.');
      for (const entry of list) {
        const employeeId = typeof entry?.employeeId === 'string' ? entry.employeeId : null;
        const roleId = typeof entry?.roleId === 'string' ? entry.roleId : null;
        if ((employeeId === null) === (roleId === null) || (kind === 'assign' && !employeeId)) throw fail(400, 'INVALID_INPUT', kind === 'assign' ? 'Default assignees must be people, not roles.' : 'Pick a person or a role.');
        rows.push({ kind, employeeId, roleId });
      }
    }
    const employeeIds = [...new Set(rows.map((row) => row.employeeId).filter(Boolean))];
    const roleIds = [...new Set(rows.map((row) => row.roleId).filter(Boolean))];
    const foundEmployees = employeeIds.length ? (await db.query('SELECT id FROM employees WHERE active = TRUE AND id = ANY($1::text[])', [employeeIds])).rows.length : 0;
    const foundRoles = roleIds.length ? (await db.query('SELECT id FROM custom_roles WHERE id = ANY($1::text[])', [roleIds])).rows.length : 0;
    if (foundEmployees !== employeeIds.length || foundRoles !== roleIds.length) throw fail(400, 'INVALID_INPUT', 'One of the chosen people or roles is not available.');
    await db.tx(async (tx) => {
      await tx.query('DELETE FROM issue_category_routes WHERE category_id = $1', [category.id]);
      const unique = rows.filter((row, index) => rows.findIndex((other) => other.kind === row.kind && other.employeeId === row.employeeId && other.roleId === row.roleId) === index);
      if (unique.length) {
        await tx.query(
          `INSERT INTO issue_category_routes (category_id, kind, employee_id, role_id)
           SELECT $1, x.k, NULLIF(x.e, ''), NULLIF(x.r, '') FROM unnest($2::text[], $3::text[], $4::text[]) AS x(k, e, r)`,
          [category.id, unique.map((row) => row.kind), unique.map((row) => row.employeeId ?? ''), unique.map((row) => row.roleId ?? '')]);
      }
      await audit(tx, req.user.id, 'issue-category.routing', category.id, category.name);
    });
    res.status(204).end();
  });

  app.get('/api/admin/issues/export', requirePermission('issues.export'), async (req, res) => {
    const from = typeof req.query.from === 'string' && !Number.isNaN(Date.parse(req.query.from)) ? new Date(req.query.from) : null;
    const to = typeof req.query.to === 'string' && !Number.isNaN(Date.parse(req.query.to)) ? new Date(req.query.to) : null;
    const rows = (await db.query(
      `SELECT ${ISSUE_FIELDS} ${FROM_WHERE} WHERE ($1::timestamptz IS NULL OR i.created_at >= $1) AND ($2::timestamptz IS NULL OR i.created_at < $2) ORDER BY i.number DESC LIMIT 20000`, [from, to])).rows;
    sendCsv(res, 'issues.csv', ['Number', 'Created (UTC)', 'Status', 'Priority', 'Category', 'Location', 'Title', 'Description', 'Reported by', 'Assigned to', 'Resolved (UTC)', 'People affected', 'Overdue'],
      rows.map((r) => [r.number, r.created_at, r.status, r.priority, r.category_name, r.location_text, r.title, r.description, r.reporter_name, r.assignee_name ?? '', r.resolved_at ?? '', r.plus_ones + 1, r.overdue ? 'yes' : '']));
  });

  return { announceNew };
}
