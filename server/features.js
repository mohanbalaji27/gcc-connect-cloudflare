import { randomUUID } from 'node:crypto';
import { ALL_PERMISSIONS, LEGACY_PERMISSIONS, RESERVED_PERMISSIONS, expandPermissions, permissionCatalog, safeUrl } from './security.js';
import { FEATURE_KEYS, DEFAULT_FEATURES, OPTION_KEYS, DEFAULT_OPTIONS, ACCENTS, DEFAULT_BRANDING, SETTING_BY_KEY, SettingsError, resolveAll, cleanScalar, mergeObject, flattenRequest, describeValue, OBJECT_KEYS, settingsSchema } from './settings-registry.js';
import { registerBranding } from './branding.js';
import { bumpConfigVersion } from './config-version.js';
import { registerMenu } from './menu.js';
import { registerNotifications, notificationCatalog, NOTIFICATION_TYPES } from './notifications.js';
import { registerIssues } from './issues.js';

export { FEATURE_KEYS, DEFAULT_FEATURES, OPTION_KEYS, DEFAULT_OPTIONS, ACCENTS, DEFAULT_BRANDING };
export const KUDOS_BADGES = ['star', 'team', 'idea', 'fire', 'helper', 'coffee'];
const TZ = 'Asia/Kolkata';
const DAY_MS = 86_400_000;

const dateKey = (date) => {
  const parts = new Intl.DateTimeFormat('en', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
const addDays = (key, days) => dateKey(new Date(Date.parse(`${key}T12:00:00+05:30`) + days * DAY_MS));
const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export const LEVELS = [
  { name: 'Newcomer', min: 0, emoji: '🌱' },
  { name: 'Regular', min: 50, emoji: '🪴' },
  { name: 'Insider', min: 150, emoji: '🌟' },
  { name: 'Champion', min: 350, emoji: '🏆' },
  { name: 'Legend', min: 700, emoji: '👑' },
];

export function registerFeatures({ app, db, requireAuth, requireSignedIn, requireCsrf, requirePermission, requireAnyPermissions, audit, fail, text, limit, userView, sendCsv, options = {} }) {
  const requireSuper = (req, _res, next) => {
    if (!req.user) return next(fail(401, 'AUTH_REQUIRED', 'Sign in to continue.'));
    return req.user.role === 'super_admin' ? next() : next(fail(403, 'SUPER_ADMIN_REQUIRED', 'Only a super admin can do that.'));
  };

  // Everything is read through the registry (server/settings-registry.js): typed values with defaults, older rows as fallback.
  const SETTING_ROWS = "'settings_v2', 'features', 'branding', 'options', 'menu_settings', 'general_settings', 'brand_meta'";
  async function readSettings() {
    const rows = (await db.query(`SELECT key, value, now() AS read_at FROM app_settings WHERE key IN (${SETTING_ROWS})`)).rows;
    const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const { values, branding, login, home } = resolveAll(stored);
    const meta = stored.brand_meta ?? {};
    const get = (key) => values[key];
    return {
      features: Object.fromEntries(Object.keys(FEATURE_KEYS).map((name) => [name, get(`features.${name}`)])),
      options: Object.fromEntries(Object.keys(OPTION_KEYS).map((name) => [name, get(`options.${name}`)])),
      branding, login, home,
      logo: { v: meta.v ?? '', slots: meta.slots ?? [], bg: meta.bg ?? null },
      menuReviewsVisibility: get('menuReviewsVisibility'), menuHistoryDays: get('menuHistoryDays'),
      usageRetentionDays: get('usageRetentionDays'), homeContactsCount: get('homeContactsCount'),
      values,
    };
  }
  // What the browser gets in the bootstrap. The settings schema (labels, help, limits) is only for the super admin's console.
  const readConfig = async (user = null) => {
    const { values, ...rest } = await readSettings();
    return {
      ...rest, settings: values, featureCatalog: FEATURE_KEYS, optionCatalog: OPTION_KEYS, accents: ACCENTS,
      permissionCatalog: permissionCatalog(), notificationCatalog: notificationCatalog(),
      ...(user?.role === 'super_admin' ? { settingsSchema: settingsSchema() } : {}),
    };
  };
  // Managers can still read the area they run while it is switched off (GET with ?manage=1) so they can prepare content.
  const MANAGE_BYPASS = { links: 'content.links', contacts: 'content.contacts', announcements: 'content.announcements', menu: 'menu.edit', polls: 'community.polls', issues: 'issues.manage_categories' };
  const feature = (name) => async (req, _res, next) => {
    try {
      if (req.method === 'GET' && req.query.manage === '1' && MANAGE_BYPASS[name] && req.user?.permissions.includes(MANAGE_BYPASS[name])) return next();
      const settings = await readSettings();
      req.appSettings = settings;
      return settings.features[name] ? next() : next(fail(404, 'FEATURE_OFF', 'This feature is turned off.'));
    } catch (error) { return next(error); }
  };
  const id8 = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
  const sortOrder = (value) => (Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : 0);

  // ---------- Settings and branding ----------
  registerBranding({ app, db, requireSuper, requireCsrf, audit, fail, readSettings });

  app.get('/api/config', requireSignedIn, async (req, res) => {
    res.json(await readConfig(req.user));
  });

  // One call writes every changed setting. Unknown keys and out-of-range values are refused, nothing is saved unless all are valid.
  app.put('/api/admin/settings', requireSuper, requireCsrf, async (req, res) => {
    const current = await readSettings();
    let requested;
    const next = {};
    try {
      requested = flattenRequest(req.body);
      for (const [key, value] of Object.entries(requested)) {
        const setting = SETTING_BY_KEY.get(key);
        if (!setting) throw new SettingsError(`Unknown setting “${key}”.`);
        next[key] = setting.type === 'object' ? mergeObject(key, current[key], value) : cleanScalar(setting, value);
      }
      const hours = { from: next['booking.officeFrom'] ?? current.values['booking.officeFrom'], to: next['booking.officeTo'] ?? current.values['booking.officeTo'] };
      if (hours.from >= hours.to) throw new SettingsError('The office must open before it closes.');
    } catch (error) {
      if (error instanceof SettingsError) throw fail(400, 'INVALID_SETTINGS', error.message);
      throw error;
    }
    // The audit log names every change with its before and after, so a bad edit can be traced and undone.
    const changes = [];
    for (const [key, value] of Object.entries(next)) {
      if (OBJECT_KEYS.includes(key)) {
        for (const field of Object.keys(value)) {
          if (JSON.stringify(value[field]) !== JSON.stringify(current[key]?.[field])) changes.push(`${key}.${field}: ${describeValue(current[key]?.[field])} -> ${describeValue(value[field])}`);
        }
      } else if (value !== current.values[key]) changes.push(`${key}: ${describeValue(current.values[key])} -> ${describeValue(value)}`);
    }
    const version = await db.tx(async (tx) => {
      const row = (await tx.query("SELECT value FROM app_settings WHERE key = 'settings_v2' FOR UPDATE")).rows[0];
      const stored = { ...(row?.value ?? {}), ...next };
      await tx.query("INSERT INTO app_settings (key, value) VALUES ('settings_v2', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(stored)]);
      for (const change of (changes.length ? changes : ['no changes']).slice(0, 25)) {
        await tx.query('INSERT INTO audit_log (id, actor_id, action, entity_id, detail) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), req.user.id, 'settings.updated', null, change.slice(0, 300)]);
      }
      return bumpConfigVersion(tx);
    });
    // A shorter menu history takes effect straight away instead of at the next daily cleanup.
    const fresh = await readSettings();
    if (fresh.menuHistoryDays !== current.menuHistoryDays) await menu.maybeCleanup(fresh);
    const { values, ...rest } = fresh;
    res.set('X-Config-Version', String(version));
    res.json({ ...rest, settings: values, configVersion: version });
  });

  // ---------- My profile ----------
  app.patch('/api/me/profile', requireAuth, requireCsrf, async (req, res) => {
    const body = req.body ?? {};
    const avatar = body.avatar === undefined ? undefined : text(body.avatar, 8, { label: 'Avatar' }) ?? '';
    let month; let day;
    if (body.birthMonth !== undefined || body.birthDay !== undefined) {
      if (body.birthMonth === null && body.birthDay === null) { month = null; day = null; }
      else {
        month = body.birthMonth; day = body.birthDay;
        const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
        if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > maxDay) throw fail(400, 'INVALID_DATE', 'Choose a real birthday.');
      }
    }
    if (body.showInWhosin !== undefined && typeof body.showInWhosin !== 'boolean') throw fail(400, 'INVALID_INPUT', 'Choose on or off.');
    await db.query(
      `UPDATE employees SET avatar = COALESCE($2, avatar), show_in_whosin = COALESCE($3, show_in_whosin),
         birth_month = CASE WHEN $4::boolean THEN $5::int ELSE birth_month END, birth_day = CASE WHEN $4::boolean THEN $6::int ELSE birth_day END WHERE id = $1`,
      [req.user.id, avatar ?? null, body.showInWhosin ?? null, month !== undefined, month ?? null, day ?? null],
    );
    const { rows } = await db.query(`SELECT e.*, COALESCE(cr.permissions, '{}') AS role_permissions, cr.name AS role_name, cr.simple_ui, cr.landing FROM employees e LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id WHERE e.id = $1`, [req.user.id]);
    res.json({ user: userView(rows[0]) });
  });

  app.get('/api/people', requireAuth, async (_req, res) => {
    const { rows } = await db.query('SELECT id, name, team, avatar FROM employees WHERE active = TRUE ORDER BY name LIMIT 1000');
    res.json({ people: rows });
  });

  // ---------- Links ----------
  const linkBody = (body, partial) => {
    const out = {};
    const title = text(body?.title, 80, { required: !partial, label: 'Title' });
    if (title !== undefined) out.title = title;
    if (body?.url !== undefined || !partial) out.url = safeUrl(body?.url, 'The link');
    for (const [key, max] of [['description', 200], ['category', 40], ['emoji', 8]]) {
      const value = text(body?.[key], max, { label: key });
      if (value !== undefined) out[key] = value;
    }
    if (body?.sortOrder !== undefined) out.sort_order = sortOrder(body.sortOrder);
    return out;
  };
  const insertRow = (table, row) => {
    const keys = Object.keys(row);
    return [`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((key) => row[key])];
  };
  const updateRow = (table, id, row) => {
    const keys = Object.keys(row);
    if (!keys.length) throw fail(400, 'NOTHING_TO_UPDATE', 'No changes were supplied.');
    return [`UPDATE ${table} SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((key) => row[key])]];
  };

  app.get('/api/links', requireAuth, feature('links'), async (_req, res) => {
    const { rows } = await db.query('SELECT id, title, url, description, category, emoji, sort_order FROM links ORDER BY category, sort_order, title LIMIT 300');
    res.json({ links: rows });
  });
  app.post('/api/admin/links', requirePermission('content.links'), requireCsrf, async (req, res) => {
    const id = id8('link');
    const [sql, params] = insertRow('links', { id, ...linkBody(req.body, false) });
    await db.tx(async (tx) => { await tx.query(sql, params); await audit(tx, req.user.id, 'link.created', id, req.body.title); });
    res.status(201).json({ id });
  });
  app.patch('/api/admin/links/:id', requirePermission('content.links'), requireCsrf, async (req, res) => {
    const [sql, params] = updateRow('links', req.params.id, linkBody(req.body, true));
    const result = await db.query(`${sql} RETURNING title`, params);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That link no longer exists.');
    await audit(db, req.user.id, 'link.updated', req.params.id, result.rows[0].title);
    res.status(204).end();
  });
  app.delete('/api/admin/links/:id', requirePermission('content.links'), requireCsrf, async (req, res) => {
    const result = await db.query('DELETE FROM links WHERE id = $1 RETURNING title', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That link no longer exists.');
    await audit(db, req.user.id, 'link.deleted', req.params.id, result.rows[0].title);
    res.status(204).end();
  });

  // ---------- Contacts ----------
  const contactBody = (body, partial) => {
    const out = {};
    const name = text(body?.name, 80, { required: !partial, label: 'Name' });
    if (name !== undefined) out.name = name;
    for (const [key, field, max] of [['roleTitle', 'role_title', 80], ['category', 'category', 40], ['phone', 'phone', 40], ['email', 'email', 120], ['hours', 'hours', 80], ['notes', 'notes', 300], ['emoji', 'emoji', 8]]) {
      const value = text(body?.[key], max, { label: key });
      if (value !== undefined) out[field] = value;
    }
    if (out.phone && !/^[0-9+()\-.\s]{3,40}$/.test(out.phone)) throw fail(400, 'INVALID_PHONE', 'Use digits, spaces, + or - for the phone number.');
    if (out.email && !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(out.email)) throw fail(400, 'INVALID_EMAIL', 'Enter a valid email address.');
    if (!partial && !out.phone && !out.email) throw fail(400, 'INVALID_INPUT', 'Add a phone number or an email address.');
    if (body?.sortOrder !== undefined) out.sort_order = sortOrder(body.sortOrder);
    if (body?.pinToHome !== undefined) {
      if (typeof body.pinToHome !== 'boolean') throw fail(400, 'INVALID_INPUT', 'Show on Home must be on or off.');
      out.pin_to_home = body.pinToHome;
    }
    return out;
  };
  // The few contacts Home shows: the ones an admin pinned, or (when none are pinned) the first emergency contacts.
  // Bootstrap carries them, so Home never makes a request of its own for this.
  const homeContacts = async (settings) => {
    if (!settings.features.contacts || settings.options.homeContacts === false) return [];
    const size = settings.homeContactsCount;
    const columns = 'id, name, role_title, phone, email, hours, emoji';
    const pinned = (await db.query(`SELECT ${columns}, now() AS read_at FROM contacts WHERE pin_to_home = TRUE ORDER BY sort_order, name LIMIT $1`, [size])).rows;
    if (pinned.length) return pinned.map(({ read_at, ...row }) => row);
    return (await db.query(`SELECT ${columns}, now() AS read_at FROM contacts WHERE category ILIKE 'emergency' ORDER BY sort_order, name LIMIT $1`, [size])).rows.map(({ read_at, ...row }) => row);
  };
  app.get('/api/contacts', requireAuth, feature('contacts'), async (_req, res) => {
    const { rows } = await db.query('SELECT id, name, role_title, category, phone, email, hours, notes, emoji, sort_order, pin_to_home FROM contacts ORDER BY category, sort_order, name LIMIT 300');
    res.json({ contacts: rows });
  });
  app.post('/api/admin/contacts', requirePermission('content.contacts'), requireCsrf, async (req, res) => {
    const id = id8('contact');
    const [sql, params] = insertRow('contacts', { id, ...contactBody(req.body, false) });
    await db.tx(async (tx) => { await tx.query(sql, params); await audit(tx, req.user.id, 'contact.created', id, req.body.name); });
    res.status(201).json({ id });
  });
  app.patch('/api/admin/contacts/:id', requirePermission('content.contacts'), requireCsrf, async (req, res) => {
    const [sql, params] = updateRow('contacts', req.params.id, contactBody(req.body, true));
    const result = await db.query(`${sql} RETURNING name`, params);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That contact no longer exists.');
    await audit(db, req.user.id, 'contact.updated', req.params.id, result.rows[0].name);
    res.status(204).end();
  });
  app.delete('/api/admin/contacts/:id', requirePermission('content.contacts'), requireCsrf, async (req, res) => {
    const result = await db.query('DELETE FROM contacts WHERE id = $1 RETURNING name', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That contact no longer exists.');
    await audit(db, req.user.id, 'contact.deleted', req.params.id, result.rows[0].name);
    res.status(204).end();
  });

  // ---------- Food menu (see menu.js) ----------
  const menu = registerMenu({ app, db, requireAuth, requireCsrf, requirePermission, requireAnyPermissions, audit, fail, text, limit, feature, readSettings, id8, validDate, dateKey, addDays });
  const notifier = registerNotifications({ app, db, requireAuth, requireCsrf, fail, limit, readSettings });
  registerIssues({ app, db, requireAuth, requireCsrf, requireAnyPermissions, requirePermission, audit, fail, text, limit, feature, readSettings, id8, notifier, sendCsv, options });

  // ---------- Announcements ----------
  const announcementBody = (body, partial) => {
    const out = {};
    const title = text(body?.title, 100, { required: !partial, label: 'Title' });
    if (title !== undefined) out.title = title;
    const msg = text(body?.body, 600, { label: 'Message' });
    if (msg !== undefined) out.body = msg;
    const emoji = text(body?.emoji, 8, { label: 'Emoji' });
    if (emoji !== undefined) out.emoji = emoji || '📣';
    if (body?.pinned !== undefined) { if (typeof body.pinned !== 'boolean') throw fail(400, 'INVALID_INPUT', 'Pinned must be on or off.'); out.pinned = body.pinned; }
    if (body?.expiresAt !== undefined) {
      if (body.expiresAt === null || body.expiresAt === '') out.expires_at = null;
      else if (typeof body.expiresAt !== 'string' || Number.isNaN(Date.parse(body.expiresAt))) throw fail(400, 'INVALID_DATE', 'Choose a valid expiry.');
      else out.expires_at = new Date(Date.parse(body.expiresAt));
    }
    return out;
  };
  app.get('/api/announcements', requireAuth, feature('announcements'), async (req, res) => {
    const all = req.query.all === '1' && req.user.permissions.includes('content.announcements');
    const { rows } = await db.query(`SELECT id, title, body, emoji, pinned, expires_at, created_at FROM announcements
      ${all ? '' : 'WHERE expires_at IS NULL OR expires_at > now()'} ORDER BY pinned DESC, created_at DESC LIMIT 30`);
    res.json({ announcements: rows });
  });
  app.post('/api/admin/announcements', requirePermission('content.announcements'), requireCsrf, async (req, res) => {
    const id = id8('news');
    const [sql, params] = insertRow('announcements', { id, ...announcementBody(req.body, false), created_by: req.user.id });
    await db.tx(async (tx) => { await tx.query(sql, params); await audit(tx, req.user.id, 'announcement.created', id, req.body.title); });
    // Opt-in: the author ticks "notify everyone"; one INSERT reaches everybody who has not switched announcements off.
    if (req.body?.notify === true) {
      try { await notifier.broadcast(db, { type: 'announcement', title: `${req.body.emoji || '📣'} ${req.body.title}`, body: req.body.body ?? '', link: 'announcements', exceptId: req.user.id }); } catch (error) { console.error('Announcement notification failed:', error.message); }
    }
    res.status(201).json({ id });
  });
  app.patch('/api/admin/announcements/:id', requirePermission('content.announcements'), requireCsrf, async (req, res) => {
    const [sql, params] = updateRow('announcements', req.params.id, announcementBody(req.body, true));
    const result = await db.query(`${sql} RETURNING title`, params);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That announcement no longer exists.');
    await audit(db, req.user.id, 'announcement.updated', req.params.id, result.rows[0].title);
    res.status(204).end();
  });
  app.delete('/api/admin/announcements/:id', requirePermission('content.announcements'), requireCsrf, async (req, res) => {
    const result = await db.query('DELETE FROM announcements WHERE id = $1 RETURNING title', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That announcement no longer exists.');
    await audit(db, req.user.id, 'announcement.deleted', req.params.id, result.rows[0].title);
    res.status(204).end();
  });

  // ---------- Kudos ----------
  app.get('/api/kudos', requireAuth, feature('kudos'), async (req, res) => {
    const { rows } = await db.query(`
      SELECT k.id, k.badge, k.message, k.created_at, f.id AS from_id, f.name AS from_name, f.avatar AS from_avatar,
             t.id AS to_id, t.name AS to_name, t.avatar AS to_avatar,
             (SELECT COUNT(*)::int FROM kudos_cheers c WHERE c.kudos_id = k.id) AS cheers,
             EXISTS (SELECT 1 FROM kudos_cheers c WHERE c.kudos_id = k.id AND c.employee_id = $1) AS cheered
      FROM kudos k JOIN employees f ON f.id = k.from_id JOIN employees t ON t.id = k.to_id ORDER BY k.created_at DESC LIMIT 60`, [req.user.id]);
    const leaders = (await db.query(`
      SELECT t.id, t.name, t.avatar, COUNT(*)::int AS received FROM kudos k JOIN employees t ON t.id = k.to_id
      WHERE k.created_at > now() - interval '30 days' GROUP BY t.id, t.name, t.avatar ORDER BY received DESC, t.name LIMIT 5`)).rows;
    res.json({ kudos: rows.map((row) => ({ ...row, cheered: Boolean(row.cheered) })), leaders });
  });
  app.post('/api/kudos', requireAuth, feature('kudos'), requireCsrf, async (req, res) => {
    if (!limit(`kudos:${req.user.id}`, 10, 60 * 60_000)) throw fail(429, 'RATE_LIMITED', 'That is a lot of love! Try again in a bit.');
    const { toId, badge = 'star' } = req.body ?? {};
    const message = text(req.body?.message, 280, { required: true, label: 'Message' });
    if (!KUDOS_BADGES.includes(badge)) throw fail(400, 'INVALID_BADGE', 'Choose one of the badges.');
    if (typeof toId !== 'string' || toId === req.user.id) throw fail(400, 'INVALID_PERSON', 'Pick a colleague to thank (not yourself).');
    if (!(await db.query('SELECT 1 FROM employees WHERE id = $1 AND active = TRUE', [toId])).rows[0]) throw fail(404, 'NOT_FOUND', 'That person is not available.');
    const id = id8('kudos');
    await db.query('INSERT INTO kudos (id, from_id, to_id, badge, message) VALUES ($1,$2,$3,$4,$5)', [id, req.user.id, toId, badge, message]);
    res.status(201).json({ id });
  });
  app.post('/api/kudos/:id/cheer', requireAuth, feature('kudos'), requireCsrf, async (req, res) => {
    if (!(await db.query('SELECT 1 FROM kudos WHERE id = $1', [req.params.id])).rows[0]) throw fail(404, 'NOT_FOUND', 'That shout-out is gone.');
    const removed = await db.query('DELETE FROM kudos_cheers WHERE kudos_id = $1 AND employee_id = $2 RETURNING kudos_id', [req.params.id, req.user.id]);
    if (!removed.rows.length) await db.query('INSERT INTO kudos_cheers (kudos_id, employee_id) VALUES ($1,$2)', [req.params.id, req.user.id]);
    res.json({ cheered: !removed.rows.length });
  });
  app.delete('/api/kudos/:id', requireAuth, requireCsrf, async (req, res) => {
    const kudos = (await db.query('SELECT id, from_id FROM kudos WHERE id = $1', [req.params.id])).rows[0];
    if (!kudos) throw fail(404, 'NOT_FOUND', 'That shout-out is gone.');
    if (kudos.from_id !== req.user.id && !req.user.permissions.includes('community.moderation')) throw fail(403, 'NOT_OWNER', 'You can only remove your own shout-outs.');
    await db.query('DELETE FROM kudos WHERE id = $1', [kudos.id]);
    // Only a moderator removing someone else's shout-out is worth a log line; people deleting their own is routine.
    if (kudos.from_id !== req.user.id) await audit(db, req.user.id, 'kudos.removed', kudos.id, 'moderated');
    res.status(204).end();
  });

  // ---------- Polls ----------
  app.get('/api/polls', requireAuth, feature('polls'), async (req, res) => {
    const { rows } = await db.query(`SELECT id, question, options, closes_at, closed, created_at FROM polls
      WHERE created_at > now() - interval '60 days' ORDER BY (closed OR (closes_at IS NOT NULL AND closes_at <= now())), created_at DESC LIMIT 20`);
    const ids = rows.map((row) => row.id);
    const votes = ids.length ? (await db.query('SELECT poll_id, option_index, COUNT(*)::int AS n FROM poll_votes WHERE poll_id = ANY($1::text[]) GROUP BY poll_id, option_index', [ids])).rows : [];
    const mine = ids.length ? (await db.query('SELECT poll_id, option_index FROM poll_votes WHERE poll_id = ANY($1::text[]) AND employee_id = $2', [ids, req.user.id])).rows : [];
    res.json({
      polls: rows.map((poll) => {
        const counts = poll.options.map((_, index) => votes.find((v) => v.poll_id === poll.id && v.option_index === index)?.n ?? 0);
        const open = !poll.closed && !(poll.closes_at && new Date(poll.closes_at).getTime() <= Date.now());
        return { id: poll.id, question: poll.question, options: poll.options, counts, total: counts.reduce((a, b) => a + b, 0), myVote: mine.find((v) => v.poll_id === poll.id)?.option_index ?? null, open, closesAt: poll.closes_at };
      }),
    });
  });
  app.post('/api/polls/:id/vote', requireAuth, feature('polls'), requireCsrf, async (req, res) => {
    const poll = (await db.query('SELECT id, options, closed, closes_at FROM polls WHERE id = $1', [req.params.id])).rows[0];
    if (!poll) throw fail(404, 'NOT_FOUND', 'That poll is gone.');
    if (poll.closed || (poll.closes_at && new Date(poll.closes_at).getTime() <= Date.now())) throw fail(409, 'POLL_CLOSED', 'This poll has closed.');
    const option = req.body?.option;
    if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) throw fail(400, 'INVALID_OPTION', 'Choose one of the options.');
    await db.query('INSERT INTO poll_votes (poll_id, employee_id, option_index) VALUES ($1,$2,$3) ON CONFLICT (poll_id, employee_id) DO UPDATE SET option_index = excluded.option_index, voted_at = now()', [poll.id, req.user.id, option]);
    res.status(204).end();
  });
  app.post('/api/admin/polls', requirePermission('community.polls'), requireCsrf, async (req, res) => {
    const question = text(req.body?.question, 160, { required: true, label: 'Question' });
    const options = req.body?.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 6) throw fail(400, 'INVALID_OPTIONS', 'Give between 2 and 6 options.');
    const clean = options.map((option) => text(option, 80, { required: true, label: 'Each option' }));
    if (new Set(clean.map((o) => o.toLowerCase())).size !== clean.length) throw fail(400, 'INVALID_OPTIONS', 'Options must be different.');
    let closesAt = null;
    if (req.body?.closesAt) {
      if (Number.isNaN(Date.parse(req.body.closesAt)) || Date.parse(req.body.closesAt) <= Date.now()) throw fail(400, 'INVALID_DATE', 'Choose a closing time in the future.');
      closesAt = new Date(Date.parse(req.body.closesAt));
    }
    const id = id8('poll');
    await db.tx(async (tx) => {
      await tx.query('INSERT INTO polls (id, question, options, closes_at, created_by) VALUES ($1,$2,$3,$4,$5)', [id, question, JSON.stringify(clean), closesAt, req.user.id]);
      await audit(tx, req.user.id, 'poll.created', id, question);
    });
    res.status(201).json({ id });
  });
  app.post('/api/admin/polls/:id/close', requirePermission('community.polls'), requireCsrf, async (req, res) => {
    const result = await db.query('UPDATE polls SET closed = TRUE WHERE id = $1 RETURNING question', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That poll is gone.');
    await audit(db, req.user.id, 'poll.closed', req.params.id, result.rows[0].question);
    res.status(204).end();
  });
  app.delete('/api/admin/polls/:id', requirePermission('community.polls'), requireCsrf, async (req, res) => {
    const result = await db.query('DELETE FROM polls WHERE id = $1 RETURNING question', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That poll is gone.');
    await audit(db, req.user.id, 'poll.deleted', req.params.id, result.rows[0].question);
    res.status(204).end();
  });

  // ---------- Celebrations ----------
  app.get('/api/celebrations', requireAuth, feature('celebrations'), async (_req, res) => {
    const todayKey = dateKey(new Date());
    const [year, month, day] = todayKey.split('-').map(Number);
    const today = Date.UTC(year, month - 1, day);
    const { rows } = await db.query(`SELECT id, name, avatar, birth_month, birth_day, to_char(joined_on, 'YYYY-MM-DD') AS joined_on
      FROM employees WHERE active = TRUE AND (birth_month IS NOT NULL OR joined_on IS NOT NULL) LIMIT 2000`);
    const out = [];
    const upcoming = (m, d) => {
      let when = Date.UTC(year, m - 1, d);
      if (when < today) when = Date.UTC(year + 1, m - 1, d);
      return { daysAway: Math.round((when - today) / DAY_MS), year: new Date(when).getUTCFullYear() };
    };
    for (const person of rows) {
      if (person.birth_month) {
        const next = upcoming(person.birth_month, person.birth_day);
        if (next.daysAway <= 30) out.push({ id: `b-${person.id}`, personId: person.id, name: person.name, avatar: person.avatar, kind: 'birthday', daysAway: next.daysAway, label: `${String(person.birth_day).padStart(2, '0')}/${String(person.birth_month).padStart(2, '0')}` });
      }
      if (person.joined_on) {
        const [jy, jm, jd] = person.joined_on.split('-').map(Number);
        const next = upcoming(jm, jd);
        const years = next.year - jy;
        if (years >= 1 && next.daysAway <= 30) out.push({ id: `a-${person.id}`, personId: person.id, name: person.name, avatar: person.avatar, kind: 'anniversary', daysAway: next.daysAway, years, label: `${String(jd).padStart(2, '0')}/${String(jm).padStart(2, '0')}` });
      }
    }
    out.sort((a, b) => a.daysAway - b.daysAway || a.name.localeCompare(b.name));
    res.json({ celebrations: out.slice(0, 40) });
  });

  // ---------- Feedback box ----------
  app.post('/api/feedback', requireAuth, feature('feedback'), requireCsrf, async (req, res) => {
    if (!limit(`feedback:${req.user.id}`, 5, 60 * 60_000)) throw fail(429, 'RATE_LIMITED', 'Thanks for the enthusiasm! Please wait a bit before sending more.');
    const message = text(req.body?.message, 1000, { required: true, label: 'Message' });
    const category = ['Idea', 'Suggestion', 'Other'].includes(req.body?.category) ? req.body.category : 'Idea';
    const anonymous = req.body?.anonymous !== false;
    await db.query('INSERT INTO feedback (id, employee_id, category, message) VALUES ($1,$2,$3,$4)', [id8('fb'), anonymous ? null : req.user.id, category, message]);
    try { await notifier.deliverToStaff(db, { type: 'idea_new', title: `New ${category.toLowerCase()} in the idea box`, body: message.slice(0, 140), link: 'ideas', exceptId: anonymous ? null : req.user.id }); } catch (error) { console.error('Idea notification failed:', error.message); }
    res.status(201).json({ ok: true });
  });
  app.get('/api/admin/feedback', requirePermission('community.ideas'), async (_req, res) => {
    const { rows } = await db.query(`SELECT f.id, f.category, f.message, f.status, f.created_at, e.name AS from_name FROM feedback f LEFT JOIN employees e ON e.id = f.employee_id
      ORDER BY (f.status = 'done'), f.created_at DESC LIMIT 200`);
    res.json({ feedback: rows });
  });
  app.patch('/api/admin/feedback/:id', requirePermission('community.ideas'), requireCsrf, async (req, res) => {
    if (!['new', 'seen', 'done'].includes(req.body?.status)) throw fail(400, 'INVALID_STATUS', 'Choose new, seen or done.');
    const result = await db.query('UPDATE feedback SET status = $2 WHERE id = $1 RETURNING id', [req.params.id, req.body.status]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That note is gone.');
    await audit(db, req.user.id, 'feedback.updated', req.params.id, req.body.status);
    res.status(204).end();
  });
  app.delete('/api/admin/feedback/:id', requirePermission('community.ideas'), requireCsrf, async (req, res) => {
    const result = await db.query('DELETE FROM feedback WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length) await audit(db, req.user.id, 'feedback.deleted', req.params.id);
    res.status(204).end();
  });

  // ---------- Who is in ----------
  app.get('/api/whosin', requireAuth, feature('whosin'), async (req, res) => {
    const key = validDate(req.query.date) ? req.query.date : dateKey(new Date());
    const start = new Date(`${key}T00:00:00+05:30`);
    const end = new Date(start.getTime() + DAY_MS);
    const { rows } = await db.query(`
      SELECT DISTINCT e.id, e.name, e.team, e.avatar, e.show_in_whosin, r.label
      FROM bookings b JOIN employees e ON e.id = b.employee_id JOIN resources r ON r.id = b.resource_id
      WHERE b.status = 'confirmed' AND r.type = 'desk' AND b.starts_at < $2 AND b.ends_at > $1 LIMIT 500`, [start, end]);
    const visible = rows.filter((row) => row.show_in_whosin || row.id === req.user.id);
    res.json({ date: key, total: rows.length, hidden: rows.length - visible.length, people: visible.map(({ id, name, team, avatar, label }) => ({ id, name, team, avatar, desk: label })) });
  });

  // ---------- Points, levels and badges ----------
  app.get('/api/me/vibes', requireAuth, feature('vibes'), async (req, res) => {
    const row = (await db.query(`
      SELECT (SELECT COUNT(DISTINCT to_char(starts_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'))::int FROM bookings WHERE employee_id = $1 AND status = 'confirmed' AND starts_at <= now()) AS visits,
             (SELECT COUNT(*)::int FROM bookings WHERE employee_id = $1 AND status = 'confirmed') AS bookings,
             (SELECT COUNT(*)::int FROM kudos WHERE from_id = $1) AS given,
             (SELECT COUNT(*)::int FROM kudos WHERE to_id = $1) AS received,
             (SELECT COUNT(*)::int FROM event_rsvps WHERE employee_id = $1) AS rsvps,
             (SELECT COUNT(*)::int FROM poll_votes WHERE employee_id = $1) AS votes`, [req.user.id])).rows[0];
    const points = row.visits * 10 + row.given * 5 + row.received * 5 + row.rsvps * 3 + row.votes * 2;
    let level = 0;
    LEVELS.forEach((entry, index) => { if (points >= entry.min) level = index; });
    const next = LEVELS[level + 1] ?? null;
    const badges = [
      { id: 'first', emoji: '🎟️', name: 'First booking', hint: 'Book a desk or room', earned: row.bookings >= 1 },
      { id: 'regular', emoji: '🪴', name: 'Regular', hint: 'Visit the office on 10 days', earned: row.visits >= 10 },
      { id: 'giver', emoji: '💌', name: 'Kudos giver', hint: 'Send 3 shout-outs', earned: row.given >= 3 },
      { id: 'loved', emoji: '🥰', name: 'Much loved', hint: 'Receive 3 shout-outs', earned: row.received >= 3 },
      { id: 'buddy', emoji: '🎈', name: 'Event buddy', hint: 'RSVP to 3 events', earned: row.rsvps >= 3 },
      { id: 'voice', emoji: '🗳️', name: 'Your voice', hint: 'Vote in 3 polls', earned: row.votes >= 3 },
    ];
    res.json({ points, level: { ...LEVELS[level], index: level }, next: next ? { name: next.name, emoji: next.emoji, remaining: next.min - points, progress: (points - LEVELS[level].min) / (next.min - LEVELS[level].min) } : null, badges, stats: row });
  });

  // ---------- Roles (templates of permissions) ----------
  const roleBody = (body, partial) => {
    const out = {};
    const name = text(body?.name, 40, { required: !partial, label: 'Role name' });
    if (name !== undefined) out.name = name;
    const description = text(body?.description, 160, { label: 'Description' });
    if (description !== undefined) out.description = description;
    const emoji = text(body?.emoji, 8, { label: 'Emoji' });
    if (emoji !== undefined) out.emoji = emoji || '⭐';
    if (body?.permissions !== undefined || !partial) {
      const list = body?.permissions;
      if (!Array.isArray(list) || list.length > 100 || list.some((p) => typeof p !== 'string' || (!ALL_PERMISSIONS.includes(p) && !LEGACY_PERMISSIONS[p]))) throw fail(400, 'INVALID_PERMISSIONS', 'Choose permissions from the list.');
      if (list.some((p) => RESERVED_PERMISSIONS.includes(p))) throw fail(400, 'INVALID_PERMISSIONS', 'Settings and role management belong to the super admin role and cannot be given to others.');
      out.permissions = expandPermissions(list);
    }
    if (body?.simpleUi !== undefined) {
      if (typeof body.simpleUi !== 'boolean') throw fail(400, 'INVALID_INPUT', 'Simple home must be on or off.');
      out.simple_ui = body.simpleUi;
    }
    if (body?.landing !== undefined) {
      if (!['', 'tasks'].includes(body.landing)) throw fail(400, 'INVALID_INPUT', 'Choose a landing screen from the list.');
      out.landing = body.landing;
    }
    if (body?.notifyDefaults !== undefined) {
      const input = body.notifyDefaults;
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw fail(400, 'INVALID_INPUT', 'Default notifications could not be read.');
      const clean = { types: {}, categories: [] };
      for (const [id, channels] of Object.entries(input.types ?? {})) {
        if (!NOTIFICATION_TYPES[id] || typeof channels !== 'object' || channels === null) throw fail(400, 'INVALID_INPUT', 'Choose notification types from the list.');
        const entry = {};
        for (const channel of ['inapp', 'push']) if (channels[channel] !== undefined) {
          if (typeof channels[channel] !== 'boolean') throw fail(400, 'INVALID_INPUT', 'Each notification choice must be on or off.');
          entry[channel] = channels[channel];
        }
        clean.types[id] = entry;
      }
      if (input.categories !== undefined) {
        if (!Array.isArray(input.categories) || input.categories.length > 60 || input.categories.some((c) => typeof c !== 'string' || c.length > 64)) throw fail(400, 'INVALID_INPUT', 'Choose issue categories from the list.');
        clean.categories = [...new Set(input.categories)];
      }
      out.notify_defaults = JSON.stringify(clean);
    }
    return out;
  };
  const roleView = (row) => ({
    id: row.id, name: row.name, description: row.description, emoji: row.emoji, permissions: expandPermissions(row.permissions), people: row.people,
    systemKey: row.system_key, simpleUi: row.simple_ui, landing: row.landing, notifyDefaults: row.notify_defaults,
  });
  app.get('/api/admin/roles', requireSuper, async (_req, res) => {
    const { rows } = await db.query(`SELECT r.id, r.name, r.description, r.emoji, r.permissions, r.system_key, r.simple_ui, r.landing, r.notify_defaults,
      (SELECT COUNT(*)::int FROM employees e WHERE e.custom_role_id = r.id) AS people FROM custom_roles r ORDER BY (r.system_key IS NULL), r.name`);
    res.json({ roles: rows.map(roleView) });
  });
  app.post('/api/admin/roles', requireSuper, requireCsrf, async (req, res) => {
    const body = roleBody(req.body, false);
    if ((await db.query('SELECT 1 FROM custom_roles WHERE lower(name) = lower($1)', [body.name])).rows[0]) throw fail(409, 'ROLE_EXISTS', 'A role with that name already exists.');
    const id = id8('role');
    const [sql, params] = insertRow('custom_roles', { id, ...body });
    await db.tx(async (tx) => { await tx.query(sql, params); await audit(tx, req.user.id, 'role.created', id, body.name); });
    res.status(201).json({ id });
  });
  app.patch('/api/admin/roles/:id', requireSuper, requireCsrf, async (req, res) => {
    const body = roleBody(req.body, true);
    if (body.name && (await db.query('SELECT 1 FROM custom_roles WHERE lower(name) = lower($1) AND id <> $2', [body.name, req.params.id])).rows[0]) throw fail(409, 'ROLE_EXISTS', 'A role with that name already exists.');
    const [sql, params] = updateRow('custom_roles', req.params.id, body);
    const result = await db.query(`${sql} RETURNING id`, params);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That role no longer exists.');
    await audit(db, req.user.id, 'role.updated', req.params.id, body.name ?? '');
    res.status(204).end();
  });
  app.delete('/api/admin/roles/:id', requireSuper, requireCsrf, async (req, res) => {
    const role = (await db.query('SELECT name, system_key, (SELECT COUNT(*)::int FROM employees e WHERE e.custom_role_id = custom_roles.id) AS people FROM custom_roles WHERE id = $1', [req.params.id])).rows[0];
    if (!role) throw fail(404, 'NOT_FOUND', 'That role no longer exists.');
    if (role.system_key) throw fail(409, 'ROLE_SYSTEM', 'Built-in roles can be edited but not deleted.');
    if (role.people > 0) throw fail(409, 'ROLE_IN_USE', `${role.people} ${role.people === 1 ? 'person has' : 'people have'} this role. Move them to another role first.`);
    await db.query('DELETE FROM custom_roles WHERE id = $1', [req.params.id]);
    await audit(db, req.user.id, 'role.deleted', req.params.id, role.name);
    res.status(204).end();
  });

  return { readSettings, readConfig, menu, notifier, homeContacts };
}
