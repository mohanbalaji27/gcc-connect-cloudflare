import { effectivePermissions } from './security.js';

// Notification types are listed once, here. The browser receives this catalogue (config.notificationCatalog) and shows
// a checkbox per type and channel. `requires` hides a type from people who could not open what it points to.
export const NOTIFICATION_CHANNELS = [
  { id: 'inapp', label: 'In-app', available: true },
  { id: 'push', label: 'Push (mobile & desktop)', available: true },
];
export const NOTIFICATION_TYPES = {
  issue_new: { label: 'New issue reported', description: 'A new facility issue in a category you look after.', group: 'Facility issues', requires: 'issues.view_all', default: true },
  issue_urgent: { label: 'Urgent issue', description: 'An urgent issue that needs someone right now.', group: 'Facility issues', requires: 'issues.view_all', default: true },
  issue_assigned: { label: 'Issue assigned to me', description: 'Someone gave you an issue to work on.', group: 'Facility issues', requires: null, default: true },
  issue_update: { label: 'Updates on my issues', description: 'Status changes and comments on issues you reported or work on.', group: 'Facility issues', requires: null, default: true },
  idea_new: { label: 'New idea in the idea box', description: 'Someone posted an idea or suggestion.', group: 'Community', requires: 'community.ideas', default: false },
  announcement: { label: 'Announcements', description: 'An announcement that its author chose to notify everyone about.', group: 'Office', requires: null, default: true },
};
export const RETENTION_DAYS = 30;
const TYPE_IDS = Object.keys(NOTIFICATION_TYPES);

export const notificationCatalog = () => ({
  channels: NOTIFICATION_CHANNELS,
  types: TYPE_IDS.map((id) => ({ id, ...NOTIFICATION_TYPES[id] })),
});

// effective = what the person chose, else what their role says, else the type's own default.
export const wantsInApp = (prefs, roleDefaults, type) => prefs?.types?.[type]?.inapp ?? roleDefaults?.types?.[type]?.inapp ?? NOTIFICATION_TYPES[type]?.default ?? false;

// A person row as the fan-out needs it: who they are, what they may see, and what they asked for.
export const PERSON_COLUMNS = `e.id, e.role, e.permissions, e.notify_prefs, COALESCE(cr.permissions, '{}') AS role_permissions,
  COALESCE(cr.notify_defaults, dr.notify_defaults, '{}'::jsonb) AS role_defaults`;
export const PERSON_JOINS = `LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id LEFT JOIN custom_roles dr ON dr.system_key = 'employee'`;

/** True when this person wants the type in-app AND is allowed to see what it points to. */
export function canReceive(person, type) {
  const meta = NOTIFICATION_TYPES[type];
  if (!meta || !wantsInApp(person.notify_prefs, person.role_defaults, type)) return false;
  return !meta.requires || effectivePermissions(person).includes(meta.requires);
}

const clip = (value, max) => String(value ?? '').slice(0, max);

export function createNotifier(db) {
  // One INSERT for any number of people: fan-out never loops over users with queries.
  async function insertRows(client, rows) {
    if (!rows.length) return 0;
    const capped = rows.slice(0, 500);
    await client.query(
      `INSERT INTO notifications (user_id, type, title, body, link, data)
       SELECT x.u, x.t, x.ti, x.b, x.l, x.d::jsonb FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(u, t, ti, b, l, d)`,
      [
        capped.map((row) => row.userId), capped.map((row) => row.type), capped.map((row) => clip(row.title, 140)),
        capped.map((row) => clip(row.body, 300)), capped.map((row) => clip(row.link, 80)), capped.map((row) => JSON.stringify(row.data ?? {})),
      ],
    );
    return capped.length;
  }

  // For recipients that are already known by id (reporter, assignee, ...): one lookup for their choices, one insert.
  async function deliverToIds(client, ids, item) {
    const unique = [...new Set(ids.filter(Boolean))].filter((id) => id !== item.exceptId);
    if (!unique.length) return 0;
    const people = (await client.query(`SELECT ${PERSON_COLUMNS} FROM employees e ${PERSON_JOINS} WHERE e.active = TRUE AND e.id = ANY($1::text[])`, [unique])).rows;
    return insertRows(client, people.filter((person) => canReceive(person, item.type)).map((person) => ({ ...item, userId: person.id })));
  }

  // For things only people with some access care about (new ideas): one lookup of everyone who holds any permission, then one insert.
  async function deliverToStaff(client, item) {
    const people = (await client.query(
      `SELECT ${PERSON_COLUMNS} FROM employees e ${PERSON_JOINS}
       WHERE e.active = TRUE AND e.id IS DISTINCT FROM $1 AND (e.role = 'super_admin' OR cardinality(e.permissions) > 0 OR cardinality(cr.permissions) > 0) LIMIT 300`, [item.exceptId ?? null])).rows;
    return insertRows(client, people.filter((person) => canReceive(person, item.type)).map((person) => ({ ...item, userId: person.id })));
  }

  // Everyone who has not switched the type off (announcements).
  async function broadcast(client, { type, title, body, link, exceptId = null }) {
    const result = await client.query(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT e.id, $1, $2, $3, $4 FROM employees e LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id LEFT JOIN custom_roles dr ON dr.system_key = 'employee'
       WHERE e.active = TRUE AND e.id IS DISTINCT FROM $5
         AND COALESCE((e.notify_prefs #>> ARRAY['types', $1, 'inapp'])::boolean, (COALESCE(cr.notify_defaults, dr.notify_defaults, '{}'::jsonb) #>> ARRAY['types', $1, 'inapp'])::boolean, $6::boolean)
       RETURNING 1`,
      [type, clip(title, 140), clip(body, 300), clip(link, 80), exceptId, NOTIFICATION_TYPES[type].default],
    );
    return result.rows.length;
  }

  // Clearing old rows is cheap but pointless to repeat: at most once a day per server, and the guard row makes sure only one
  // server instance does it.
  let cleanupMark = '';
  async function maybeCleanup(retentionDays = RETENTION_DAYS) {
    const mark = new Date().toISOString().slice(0, 10);
    if (cleanupMark === mark) return;
    cleanupMark = mark;
    try {
      const claimed = await db.query(
        `INSERT INTO app_settings (key, value) VALUES ('notifications_cleanup', to_jsonb($1::text))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE app_settings.value IS DISTINCT FROM excluded.value RETURNING key`, [mark]);
      if (claimed.rows.length) await db.query(`DELETE FROM notifications WHERE created_at < now() - make_interval(days => ${Number(retentionDays) || RETENTION_DAYS})`);
    } catch (error) {
      cleanupMark = '';
      console.error('Notification cleanup failed:', error.message);
    }
  }

  const unreadCount = async (userId) => (await db.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId])).rows[0].n;

  return { insertRows, deliverToIds, deliverToStaff, broadcast, maybeCleanup, unreadCount };
}

export function registerNotifications({ app, db, requireAuth, requireCsrf, fail, limit, readSettings }) {
  const notifier = createNotifier(db);

  // The unread count rides on the heartbeat that is already running, so the bell costs no extra request.
  app.locals.pulse?.add('notifications', async (req) => ({ unread: await notifier.unreadCount(req.user.id) }));

  const view = (row) => ({ id: row.id, type: row.type, title: row.title, body: row.body, link: row.link, data: row.data, createdAt: row.created_at, readAt: row.read_at });

  app.get('/api/notifications', requireAuth, async (req, res) => {
    if (!limit(`notifications:${req.user.id}`, 60, 60_000)) throw fail(429, 'RATE_LIMITED', 'Slow down a little.');
    const before = typeof req.query.before === 'string' && /^\d{1,18}$/.test(req.query.before) ? req.query.before : null;
    const size = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 50);
    const rows = (await db.query(
      `SELECT id::text AS id, type, title, body, link, data, created_at, read_at FROM notifications
       WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3`, [req.user.id, before, size + 1])).rows;
    await notifier.maybeCleanup((await readSettings()).values['notifications.retentionDays']);
    res.json({ notifications: rows.slice(0, size).map(view), hasMore: rows.length > size, unread: await notifier.unreadCount(req.user.id) });
  });

  app.post('/api/notifications/read', requireAuth, requireCsrf, async (req, res) => {
    const ids = req.body?.ids;
    if (req.body?.all !== true && (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !/^\d{1,18}$/.test(id)))) {
      throw fail(400, 'INVALID_INPUT', 'Say which notifications to mark as read.');
    }
    // Always scoped to the signed-in person: other people's notification ids do nothing.
    await db.query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::boolean OR id = ANY($3::bigint[]))',
      [req.user.id, req.body?.all === true, req.body?.all === true ? [] : ids],
    );
    res.json({ unread: await notifier.unreadCount(req.user.id) });
  });

  // ---------- Preferences ----------
  const visibleTypes = (user) => TYPE_IDS.filter((id) => !NOTIFICATION_TYPES[id].requires || user.permissions.includes(NOTIFICATION_TYPES[id].requires));
  const loadChoices = async (userId) => (await db.query(
    `SELECT e.notify_prefs, COALESCE(cr.notify_defaults, dr.notify_defaults, '{}'::jsonb) AS role_defaults, COALESCE(cr.system_key = 'facility_manager', FALSE) AS is_manager,
            (SELECT COALESCE(array_agg(DISTINCT r.category_id), '{}') FROM issue_category_routes r
              WHERE r.kind IN ('notify', 'escalate') AND (r.employee_id = e.id OR (r.role_id IS NOT NULL AND r.role_id = e.custom_role_id))) AS routed,
            now() AS read_at
     FROM employees e ${PERSON_JOINS} WHERE e.id = $1`, [userId])).rows[0];

  app.get('/api/me/notification-prefs', requireAuth, async (req, res) => {
    const { notify_prefs: prefs, role_defaults: defaults, routed, is_manager: manager } = await loadChoices(req.user.id);
    const types = visibleTypes(req.user).map((id) => {
      const ownInApp = prefs?.types?.[id]?.inapp;
      const fromRoleInApp = defaults?.types?.[id]?.inapp;
      const ownPush = prefs?.types?.[id]?.push;
      const fromRolePush = defaults?.types?.[id]?.push;
      return {
        id,
        inapp: { value: ownInApp ?? fromRoleInApp ?? NOTIFICATION_TYPES[id].default, source: ownInApp !== undefined ? 'you' : fromRoleInApp !== undefined ? 'role' : 'default' },
        push: { value: ownPush ?? fromRolePush ?? false, source: ownPush !== undefined ? 'you' : fromRolePush !== undefined ? 'role' : 'default' },
      };
    });
    let categories = [];
    if (req.user.permissions.includes('issues.view_all') && (await readSettings()).features.issues !== false) {
      const rows = (await db.query('SELECT id, name, emoji FROM issue_categories WHERE active = TRUE ORDER BY sort_order, name LIMIT 60')).rows;
      categories = rows.map((row) => {
        const own = prefs?.categories?.[row.id];
        const fromRole = manager || (Array.isArray(defaults?.categories) && defaults.categories.includes(row.id));
        const routing = routed.includes(row.id);
        return { id: row.id, name: row.name, emoji: row.emoji, subscribed: own ?? (fromRole || routing), source: own !== undefined ? 'you' : routing ? 'routing' : fromRole ? 'role' : 'default' };
      });
    }
    res.json({ types, categories });
  });

  app.put('/api/me/notification-prefs', requireAuth, requireCsrf, async (req, res) => {
    const body = req.body ?? {};
    const allowed = new Set(visibleTypes(req.user));
    const current = (await loadChoices(req.user.id)).notify_prefs ?? {};
    const next = { types: { ...(current.types ?? {}) }, categories: { ...(current.categories ?? {}) } };
    if (body.types !== undefined) {
      if (typeof body.types !== 'object' || body.types === null || Array.isArray(body.types)) throw fail(400, 'INVALID_INPUT', 'Choose notification types from the list.');
      for (const [id, channels] of Object.entries(body.types)) {
        if (!allowed.has(id) || typeof channels !== 'object' || channels === null) throw fail(400, 'INVALID_INPUT', 'That notification type is not available to you.');
        const merged = { ...(next.types[id] ?? {}) };
        for (const [channel, value] of Object.entries(channels)) {
          if (!['inapp', 'push'].includes(channel) || (value !== null && typeof value !== 'boolean')) throw fail(400, 'INVALID_INPUT', 'Each choice must be on, off or reset.');
          if (value === null) delete merged[channel]; else merged[channel] = value;
        }
        if (Object.keys(merged).length) next.types[id] = merged; else delete next.types[id];
      }
    }
    if (body.categories !== undefined) {
      if (typeof body.categories !== 'object' || body.categories === null || Array.isArray(body.categories)) throw fail(400, 'INVALID_INPUT', 'Choose categories from the list.');
      if (!req.user.permissions.includes('issues.view_all')) throw fail(403, 'PERMISSION_REQUIRED', 'Category alerts are for people who can see the issue queue.');
      const ids = Object.keys(body.categories);
      if (ids.length > 60) throw fail(400, 'INVALID_INPUT', 'Too many categories.');
      const known = new Set((await db.query('SELECT id FROM issue_categories WHERE id = ANY($1::text[])', [ids])).rows.map((row) => row.id));
      for (const [id, value] of Object.entries(body.categories)) {
        if (!known.has(id) || (value !== null && typeof value !== 'boolean')) throw fail(400, 'INVALID_INPUT', 'Choose issue categories from the list.');
        if (value === null) delete next.categories[id]; else next.categories[id] = value;
      }
    }
    await db.query('UPDATE employees SET notify_prefs = $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify(next)]);
    res.status(204).end();
  });

  return notifier;
}
