import { randomUUID } from 'node:crypto';
import { ALL_PERMISSIONS, PERMISSIONS, safeUrl } from './security.js';

export const FEATURE_KEYS = {
  links: 'Useful links (user guides, portals)',
  contacts: 'Important contacts',
  menu: 'Food menu',
  announcements: 'Announcements',
  kudos: 'Kudos wall',
  polls: 'Quick polls',
  celebrations: 'Birthdays and work anniversaries',
  feedback: 'Anonymous feedback box',
  whosin: 'Who is in today',
  vibes: 'Points, levels and badges',
};
export const DEFAULT_FEATURES = Object.fromEntries(Object.keys(FEATURE_KEYS).map((key) => [key, true]));
export const ACCENTS = ['green', 'ocean', 'sunset', 'berry', 'mono'];
export const DEFAULT_BRANDING = { appName: 'GCC Connect', tagline: 'Your office day, sorted.', accent: 'green', welcome: '' };
export const KUDOS_BADGES = ['star', 'team', 'idea', 'fire', 'helper', 'coffee'];
const MEALS = ['breakfast', 'lunch', 'snacks', 'dinner'];
const DIETS = ['veg', 'non-veg', 'vegan', 'egg'];
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

export function registerFeatures({ app, db, requireAuth, requireSignedIn, requireCsrf, requirePermission, audit, fail, text, limit, userView }) {
  const requireSuper = (req, _res, next) => {
    if (!req.user) return next(fail(401, 'AUTH_REQUIRED', 'Sign in to continue.'));
    return req.user.role === 'super_admin' ? next() : next(fail(403, 'SUPER_ADMIN_REQUIRED', 'Only a super admin can do that.'));
  };

  async function readSettings() {
    const rows = (await db.query("SELECT key, value FROM app_settings WHERE key IN ('features', 'branding')")).rows;
    const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return { features: { ...DEFAULT_FEATURES, ...(stored.features ?? {}) }, branding: { ...DEFAULT_BRANDING, ...(stored.branding ?? {}) } };
  }
  // Managers can still read the area they run while it is switched off (GET with ?manage=1) so they can prepare content.
  const MANAGE_BYPASS = { links: 'content.manage', contacts: 'content.manage', announcements: 'content.manage', menu: 'menu.manage', polls: 'community.manage' };
  const feature = (name) => async (req, _res, next) => {
    try {
      if (req.method === 'GET' && req.query.manage === '1' && MANAGE_BYPASS[name] && req.user?.permissions.includes(MANAGE_BYPASS[name])) return next();
      const { features } = await readSettings();
      return features[name] ? next() : next(fail(404, 'FEATURE_OFF', 'This feature is turned off.'));
    } catch (error) { return next(error); }
  };
  const id8 = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
  const sortOrder = (value) => (Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : 0);

  // ---------- Settings and branding ----------
  app.get('/api/public-config', async (_req, res) => {
    const { branding } = await readSettings();
    res.json({ branding });
  });

  app.get('/api/config', requireSignedIn, async (_req, res) => {
    res.json({ ...(await readSettings()), featureCatalog: FEATURE_KEYS, accents: ACCENTS });
  });

  app.put('/api/admin/settings', requireSuper, requireCsrf, async (req, res) => {
    const current = await readSettings();
    const features = { ...current.features };
    if (req.body?.features !== undefined) {
      if (typeof req.body.features !== 'object' || req.body.features === null) throw fail(400, 'INVALID_SETTINGS', 'Features must be on/off switches.');
      for (const [key, value] of Object.entries(req.body.features)) {
        if (!(key in FEATURE_KEYS) || typeof value !== 'boolean') throw fail(400, 'INVALID_SETTINGS', `Unknown feature “${key}”.`);
        features[key] = value;
      }
    }
    const branding = { ...current.branding };
    if (req.body?.branding !== undefined) {
      const input = req.body.branding ?? {};
      if (input.appName !== undefined) branding.appName = text(input.appName, 40, { required: true, label: 'App name' });
      if (input.tagline !== undefined) branding.tagline = text(input.tagline, 80, { label: 'Tagline' }) ?? '';
      if (input.welcome !== undefined) branding.welcome = text(input.welcome, 200, { label: 'Welcome note' }) ?? '';
      if (input.accent !== undefined) {
        if (!ACCENTS.includes(input.accent)) throw fail(400, 'INVALID_SETTINGS', 'Choose one of the listed colour themes.');
        branding.accent = input.accent;
      }
    }
    await db.tx(async (tx) => {
      await tx.query("INSERT INTO app_settings (key, value) VALUES ('features', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(features)]);
      await tx.query("INSERT INTO app_settings (key, value) VALUES ('branding', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(branding)]);
      await audit(tx, req.user.id, 'settings.updated', null, Object.entries(features).filter(([, on]) => !on).map(([key]) => key).join(',') || 'all features on');
    });
    res.json({ features, branding });
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
    const { rows } = await db.query(`SELECT e.*, COALESCE(cr.permissions, '{}') AS role_permissions, cr.name AS role_name FROM employees e LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id WHERE e.id = $1`, [req.user.id]);
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
  app.post('/api/admin/links', requirePermission('content.manage'), requireCsrf, async (req, res) => {
    const id = id8('link');
    const [sql, params] = insertRow('links', { id, ...linkBody(req.body, false) });
    await db.tx(async (tx) => { await tx.query(sql, params); await audit(tx, req.user.id, 'link.created', id, req.body.title); });
    res.status(201).json({ id });
  });
  app.patch('/api/admin/links/:id', requirePermission('content.manage'), requireCsrf, async (req, res) => {
    const [sql, params] = updateRow('links', req.params.id, linkBody(req.body, true));
    const result = await db.query(`${sql} RETURNING id`, params);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That link no longer exists.');
    res.status(204).end();
  });
  app.delete('/api/admin/links/:id', requirePermission('content.manage'), requireCsrf, async (req, res) => {
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
    return out;
  };
  app.get('/api/contacts', requireAuth, feature('contacts'), async (_req, res) => {
    const { rows } = await db.query('SELECT id, name, role_title, category, phone, email, hours, notes, emoji, sort_order FROM contacts ORDER BY category, sort_order, name LIMIT 300');
    res.json({ contacts: rows });
  });
  app.post('/api/admin/contacts', requirePermission('content.manage'), requireCsrf, async (req, res) => {
    const id = id8('contact');
    const [sql, params] = insertRow('contacts', { id, ...contactBody(req.body, false) });
    await db.tx(async (tx) => { await tx.query(sql, params); await audit(tx, req.user.id, 'contact.created', id, req.body.name); });
    res.status(201).json({ id });
  });
  app.patch('/api/admin/contacts/:id', requirePermission('content.manage'), requireCsrf, async (req, res) => {
    const [sql, params] = updateRow('contacts', req.params.id, contactBody(req.body, true));
    const result = await db.query(`${sql} RETURNING id`, params);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That contact no longer exists.');
    res.status(204).end();
  });
  app.delete('/api/admin/contacts/:id', requirePermission('content.manage'), requireCsrf, async (req, res) => {
    const result = await db.query('DELETE FROM contacts WHERE id = $1 RETURNING name', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That contact no longer exists.');
    await audit(db, req.user.id, 'contact.deleted', req.params.id, result.rows[0].name);
    res.status(204).end();
  });

  // ---------- Food menu ----------
  app.get('/api/menu', requireAuth, feature('menu'), async (req, res) => {
    const from = validDate(req.query.from) ? req.query.from : dateKey(new Date());
    const days = Math.min(31, Math.max(1, Number(req.query.days) || 7));
    const to = addDays(from, days - 1);
    const { rows } = await db.query(`
      SELECT m.id, to_char(m.menu_date, 'YYYY-MM-DD') AS date, m.meal, m.name, m.description, m.diet, m.emoji,
             (SELECT COUNT(*)::int FROM menu_reactions r WHERE r.item_id = m.id) AS likes,
             EXISTS (SELECT 1 FROM menu_reactions r WHERE r.item_id = m.id AND r.employee_id = $3) AS liked
      FROM menu_items m WHERE m.menu_date BETWEEN $1::date AND $2::date
      ORDER BY m.menu_date, CASE m.meal WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 WHEN 'snacks' THEN 3 ELSE 4 END, m.name LIMIT 600`, [from, to, req.user.id]);
    res.json({ from, to, items: rows.map((row) => ({ ...row, liked: Boolean(row.liked) })) });
  });
  app.post('/api/menu/:id/like', requireAuth, feature('menu'), requireCsrf, async (req, res) => {
    const item = (await db.query('SELECT id FROM menu_items WHERE id = $1', [req.params.id])).rows[0];
    if (!item) throw fail(404, 'NOT_FOUND', 'That dish is no longer on the menu.');
    const removed = await db.query('DELETE FROM menu_reactions WHERE item_id = $1 AND employee_id = $2 RETURNING item_id', [item.id, req.user.id]);
    if (!removed.rows.length) await db.query('INSERT INTO menu_reactions (item_id, employee_id) VALUES ($1,$2)', [item.id, req.user.id]);
    res.json({ liked: !removed.rows.length });
  });
  app.post('/api/admin/menu', requirePermission('menu.manage'), requireCsrf, async (req, res) => {
    const body = req.body ?? {};
    const dates = Array.isArray(body.dates) ? body.dates : [body.date];
    if (!dates.length || dates.length > 31 || dates.some((d) => !validDate(d))) throw fail(400, 'INVALID_DATE', 'Choose between 1 and 31 valid dates.');
    if (!MEALS.includes(body.meal)) throw fail(400, 'INVALID_MEAL', 'Choose breakfast, lunch, snacks or dinner.');
    const diet = body.diet ?? 'veg';
    if (!DIETS.includes(diet)) throw fail(400, 'INVALID_DIET', 'Choose veg, non-veg, vegan or egg.');
    const name = text(body.name, 80, { required: true, label: 'Dish name' });
    const description = text(body.description, 200, { label: 'Description' }) ?? '';
    const emoji = text(body.emoji, 8, { label: 'Emoji' }) || '🍽️';
    await db.tx(async (tx) => {
      for (const date of [...new Set(dates)]) {
        await tx.query('INSERT INTO menu_items (id, menu_date, meal, name, description, diet, emoji) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id8('dish'), date, body.meal, name, description, diet, emoji]);
      }
      await audit(tx, req.user.id, 'menu.added', null, `${name} x${dates.length}`);
    });
    res.status(201).json({ added: new Set(dates).size });
  });
  app.delete('/api/admin/menu/:id', requirePermission('menu.manage'), requireCsrf, async (req, res) => {
    const result = await db.query('DELETE FROM menu_items WHERE id = $1 RETURNING name', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That dish is already gone.');
    res.status(204).end();
  });

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
    const all = req.query.all === '1' && req.user.permissions.includes('content.manage');
    const { rows } = await db.query(`SELECT id, title, body, emoji, pinned, expires_at, created_at FROM announcements
      ${all ? '' : 'WHERE expires_at IS NULL OR expires_at > now()'} ORDER BY pinned DESC, created_at DESC LIMIT 30`);
    res.json({ announcements: rows });
  });
  app.post('/api/admin/announcements', requirePermission('content.manage'), requireCsrf, async (req, res) => {
    const id = id8('news');
    const [sql, params] = insertRow('announcements', { id, ...announcementBody(req.body, false), created_by: req.user.id });
    await db.tx(async (tx) => { await tx.query(sql, params); await audit(tx, req.user.id, 'announcement.created', id, req.body.title); });
    res.status(201).json({ id });
  });
  app.patch('/api/admin/announcements/:id', requirePermission('content.manage'), requireCsrf, async (req, res) => {
    const [sql, params] = updateRow('announcements', req.params.id, announcementBody(req.body, true));
    const result = await db.query(`${sql} RETURNING id`, params);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That announcement no longer exists.');
    res.status(204).end();
  });
  app.delete('/api/admin/announcements/:id', requirePermission('content.manage'), requireCsrf, async (req, res) => {
    const result = await db.query('DELETE FROM announcements WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That announcement no longer exists.');
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
    if (kudos.from_id !== req.user.id && !req.user.permissions.includes('community.manage')) throw fail(403, 'NOT_OWNER', 'You can only remove your own shout-outs.');
    await db.query('DELETE FROM kudos WHERE id = $1', [kudos.id]);
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
    await db.query('INSERT INTO poll_votes (poll_id, employee_id, option_index) VALUES ($1,$2,$3) ON CONFLICT (poll_id, employee_id) DO UPDATE SET option_index = excluded.option_index', [poll.id, req.user.id, option]);
    res.status(204).end();
  });
  app.post('/api/admin/polls', requirePermission('community.manage'), requireCsrf, async (req, res) => {
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
  app.post('/api/admin/polls/:id/close', requirePermission('community.manage'), requireCsrf, async (req, res) => {
    const result = await db.query('UPDATE polls SET closed = TRUE WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That poll is gone.');
    res.status(204).end();
  });
  app.delete('/api/admin/polls/:id', requirePermission('community.manage'), requireCsrf, async (req, res) => {
    const result = await db.query('DELETE FROM polls WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That poll is gone.');
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
    const category = ['Idea', 'Issue', 'Kudos', 'Other'].includes(req.body?.category) ? req.body.category : 'Idea';
    const anonymous = req.body?.anonymous !== false;
    await db.query('INSERT INTO feedback (id, employee_id, category, message) VALUES ($1,$2,$3,$4)', [id8('fb'), anonymous ? null : req.user.id, category, message]);
    res.status(201).json({ ok: true });
  });
  app.get('/api/admin/feedback', requirePermission('community.manage'), async (_req, res) => {
    const { rows } = await db.query(`SELECT f.id, f.category, f.message, f.status, f.created_at, e.name AS from_name FROM feedback f LEFT JOIN employees e ON e.id = f.employee_id
      ORDER BY (f.status = 'done'), f.created_at DESC LIMIT 200`);
    res.json({ feedback: rows });
  });
  app.patch('/api/admin/feedback/:id', requirePermission('community.manage'), requireCsrf, async (req, res) => {
    if (!['new', 'seen', 'done'].includes(req.body?.status)) throw fail(400, 'INVALID_STATUS', 'Choose new, seen or done.');
    const result = await db.query('UPDATE feedback SET status = $2 WHERE id = $1 RETURNING id', [req.params.id, req.body.status]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That note is gone.');
    res.status(204).end();
  });
  app.delete('/api/admin/feedback/:id', requirePermission('community.manage'), requireCsrf, async (req, res) => {
    await db.query('DELETE FROM feedback WHERE id = $1', [req.params.id]);
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

  // ---------- Insights dashboard ----------
  app.get('/api/admin/insights', requirePermission('insights.view'), async (_req, res) => {
    const todayKey = dateKey(new Date());
    const dayStart = new Date(`${todayKey}T00:00:00+05:30`);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const from = new Date(dayStart.getTime() - 13 * DAY_MS);
    const until = new Date(dayStart.getTime() + 7 * DAY_MS);
    const since30 = new Date(Date.now() - 30 * DAY_MS);
    const since60 = new Date(Date.now() - 60 * DAY_MS);

    const totals = (await db.query(`
      SELECT (SELECT COUNT(*)::int FROM employees WHERE active = TRUE) AS people,
             (SELECT COUNT(*)::int FROM resources WHERE type = 'desk' AND active = TRUE) AS desks,
             (SELECT COUNT(*)::int FROM resources WHERE type = 'room' AND active = TRUE) AS rooms,
             (SELECT COUNT(DISTINCT b.resource_id)::int FROM bookings b JOIN resources r ON r.id = b.resource_id WHERE r.type = 'desk' AND r.active = TRUE AND b.status = 'confirmed' AND b.starts_at < $2 AND b.ends_at > $1) AS desks_today,
             (SELECT COUNT(DISTINCT b.resource_id)::int FROM bookings b JOIN resources r ON r.id = b.resource_id WHERE r.type = 'room' AND r.active = TRUE AND b.status = 'confirmed' AND b.starts_at < $2 AND b.ends_at > $1) AS rooms_today,
             (SELECT COUNT(DISTINCT employee_id)::int FROM bookings WHERE status = 'confirmed' AND starts_at >= $3 AND starts_at < now()) AS active_bookers,
             (SELECT COUNT(*)::int FROM bookings WHERE status = 'confirmed' AND starts_at >= $3 AND starts_at < now()) AS bookings_30d,
             (SELECT COUNT(*)::int FROM bookings WHERE status = 'cancelled' AND created_at >= $3) AS cancelled_30d,
             (SELECT COUNT(DISTINCT b.resource_id)::int FROM bookings b JOIN resources r ON r.id = b.resource_id WHERE r.type = 'desk' AND r.active = TRUE AND b.status = 'confirmed' AND b.starts_at >= $3 AND b.starts_at < now()) AS desks_used_30d,
             (SELECT COUNT(*)::int FROM kudos WHERE created_at >= $3) AS kudos_30d,
             (SELECT COUNT(*)::int FROM poll_votes pv JOIN polls p ON p.id = pv.poll_id WHERE p.created_at >= $3) AS votes_30d,
             (SELECT COUNT(*)::int FROM feedback WHERE status = 'new') AS feedback_new,
             (SELECT COUNT(*)::int FROM events WHERE ends_at >= now()) AS events_upcoming,
             (SELECT COUNT(*)::int FROM event_rsvps r JOIN events e ON e.id = r.event_id WHERE e.ends_at >= now()) AS rsvps_upcoming`, [dayStart, dayEnd, since30])).rows[0];

    const perDay = (await db.query(`
      SELECT to_char(b.starts_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, r.type, COUNT(*)::int AS n
      FROM bookings b JOIN resources r ON r.id = b.resource_id WHERE b.status = 'confirmed' AND b.starts_at >= $1 AND b.starts_at < $2 GROUP BY day, r.type`, [from, until])).rows;
    const trend = [];
    for (let i = -13; i <= 7; i += 1) {
      const day = addDays(todayKey, i);
      trend.push({ date: day, desks: perDay.find((r) => r.day === day && r.type === 'desk')?.n ?? 0, rooms: perDay.find((r) => r.day === day && r.type === 'room')?.n ?? 0, future: i > 0 });
    }

    const byTeam = (await db.query(`
      SELECT COALESCE(t.name, 'Unassigned') AS name, COALESCE(t.color, '#8f9a94') AS color,
             COUNT(DISTINCT r.id)::int AS seats, COUNT(b.id)::int AS bookings
      FROM resources r LEFT JOIN teams t ON t.id = r.team_id
      LEFT JOIN bookings b ON b.resource_id = r.id AND b.status = 'confirmed' AND b.starts_at >= $1 AND b.starts_at < now()
      WHERE r.type = 'desk' AND r.active = TRUE GROUP BY t.name, t.color ORDER BY bookings DESC, name LIMIT 20`, [since30])).rows;

    const topSpaces = (await db.query(`
      SELECT r.label, r.type, COUNT(*)::int AS n FROM bookings b JOIN resources r ON r.id = b.resource_id
      WHERE b.status = 'confirmed' AND b.starts_at >= $1 AND b.starts_at < now() GROUP BY r.label, r.type ORDER BY n DESC, r.label LIMIT 8`, [since30])).rows;

    const dow = (await db.query(`
      SELECT EXTRACT(DOW FROM starts_at AT TIME ZONE 'Asia/Kolkata')::int AS dow, COUNT(*)::int AS n FROM bookings
      WHERE status = 'confirmed' AND starts_at >= $1 AND starts_at < now() GROUP BY dow`, [since60])).rows;
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, index) => ({ name, n: dow.find((r) => r.dow === index)?.n ?? 0 }));

    res.json({
      generatedAt: new Date().toISOString(), today: todayKey,
      totals: {
        people: totals.people, desks: totals.desks, rooms: totals.rooms, desksToday: totals.desks_today, roomsToday: totals.rooms_today,
        deskUtilisationToday: totals.desks ? Math.round((totals.desks_today / totals.desks) * 100) : 0,
        deskCoverage30d: totals.desks ? Math.round((totals.desks_used_30d / totals.desks) * 100) : 0,
        activeBookers30d: totals.active_bookers, bookings30d: totals.bookings_30d, cancelled30d: totals.cancelled_30d,
        kudos30d: totals.kudos_30d, votes30d: totals.votes_30d, feedbackNew: totals.feedback_new,
        eventsUpcoming: totals.events_upcoming, rsvpsUpcoming: totals.rsvps_upcoming,
      },
      trend, byTeam, topSpaces, weekdays,
    });
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
      if (!Array.isArray(list) || list.some((p) => !ALL_PERMISSIONS.includes(p))) throw fail(400, 'INVALID_PERMISSIONS', 'Choose permissions from the list.');
      out.permissions = [...new Set(list)];
    }
    return out;
  };
  app.get('/api/admin/roles', requireSuper, async (_req, res) => {
    const { rows } = await db.query(`SELECT r.id, r.name, r.description, r.emoji, r.permissions, (SELECT COUNT(*)::int FROM employees e WHERE e.custom_role_id = r.id) AS people FROM custom_roles r ORDER BY r.name`);
    res.json({ roles: rows, permissionCatalog: PERMISSIONS });
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
    const result = await db.query('DELETE FROM custom_roles WHERE id = $1 RETURNING name', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That role no longer exists.');
    await audit(db, req.user.id, 'role.deleted', req.params.id, result.rows[0].name);
    res.status(204).end();
  });
}
