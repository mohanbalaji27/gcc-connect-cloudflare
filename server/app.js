import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALL_PERMISSIONS, ADMIN_DEFAULT_PERMISSIONS, SUPER_GRANT_PERMISSIONS, RESERVED_PERMISSIONS, LEGACY_PERMISSIONS, PERMISSIONS, ROLES,
  effectivePermissions, expandPermissions, generatePassword, hashPassword, verifyPassword, sha256, cleanLinks,
} from './security.js';
import { gridPlacement, validCalibration, DEFAULT_CALIBRATION } from './layout.js';
import { importInventory } from './inventory.js';
import { registerFeatures } from './features.js';
import { bumpConfigVersion } from './config-version.js';

const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OFFICE_TZ = 'Asia/Kolkata';
const EVENT_CATEGORIES = ['Learning', 'Community', 'Company', 'Social', 'Wellness', 'Team'];
const LABEL_SIDES = ['top', 'bottom', 'left', 'right'];
const rateBuckets = new Map();

const sameSecret = (a, b) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const parseCookie = (header, key) => header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1);
const isoDate = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && value.length <= 35;
const text = (value, max, { required = false, label = 'This field' } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw fail(400, 'INVALID_INPUT', `${label} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw fail(400, 'INVALID_INPUT', `${label} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw fail(400, 'INVALID_INPUT', `${label} is required.`);
  if (trimmed.length > max) throw fail(400, 'INVALID_INPUT', `${label} must be ${max} characters or fewer.`);
  return trimmed;
};
const percent = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw fail(400, 'INVALID_POSITION', `${label} must be between 0 and 100.`);
  return Math.round(value * 100) / 100;
};
const officeDateKey = (date) => {
  const parts = new Intl.DateTimeFormat('en', { timeZone: OFFICE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};

function limit(key, maximum, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.until <= now) bucket = { count: 0, until: now + windowMs };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 3000) {
    for (const [bucketKey, entry] of rateBuckets) if (entry.until <= now) rateBuckets.delete(bucketKey);
  }
  return bucket.count <= maximum;
}

function publicResource(row, available = null, extra = {}) {
  if (!row) return null;
  return {
    id: row.id, type: row.type, label: row.label, building: row.building, floor: row.floor,
    zone: row.zone, description: row.description, amenities: row.amenities, capacity: row.capacity,
    x: row.x_pct, y: row.y_pct, gridRow: row.grid_row, gridCol: row.grid_col, labelSide: row.label_side ?? null,
    team: row.team_id ? { id: row.team_id, name: row.team_name, color: row.team_color } : null,
    active: row.active, available, ...extra,
  };
}

// now() is selected on purpose in the reads that clients cache and re-fetch right after a change (here, settings, teams, map,
// availability): a query that calls now() is never cached by Cloudflare Hyperdrive, so a reload always sees the latest data.
const RESOURCE_SELECT = `
  SELECT r.*, t.name AS team_name, t.color AS team_color, now() AS read_at
  FROM resources r LEFT JOIN teams t ON t.id = r.team_id`;

export function createApp(db, options = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '256kb', strict: true }));

  const sessionCookie = (token, maxAge) =>
    `gcc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge};${options.secureCookies ? ' Secure;' : ''}`;
  // Anything that changes what browsers cache (settings, teams, map, floor plan, spaces) also bumps the config version,
  // so the audit call itself is the single place that keeps clients in sync.
  const CONFIG_ACTIONS = /^(settings|resource|team|map|floor-plan|inventory)\./;
  const audit = async (client, actorId, action, entityId = null, detail = '') => {
    await client.query('INSERT INTO audit_log (id, actor_id, action, entity_id, detail) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), actorId, action, entityId, String(detail).slice(0, 300)]);
    return CONFIG_ACTIONS.test(action) ? bumpConfigVersion(client) : null;
  };
  const userView = (row) => ({
    id: row.id, email: row.email ?? '', name: row.name, team: row.team, role: row.role,
    permissions: effectivePermissions(row), mustChangePassword: row.must_change_password,
    avatar: row.avatar ?? '', roleName: row.role_name ?? null, showInWhosin: row.show_in_whosin ?? true,
    birthMonth: row.birth_month ?? null, birthDay: row.birth_day ?? null,
    username: row.username ?? null, simpleUi: row.simple_ui === true, landing: row.landing ?? '',
  });

  app.use('/api', async (req, res, next) => {
    const token = parseCookie(req.headers.cookie, 'gcc_session');
    if (token) {
      let decoded = '';
      try { decoded = decodeURIComponent(token); } catch { decoded = ''; }
      const { rows } = await db.query(`
        SELECT s.csrf_token, e.id, e.email, e.name, e.team, e.role, e.permissions, e.must_change_password,
               e.avatar, e.show_in_whosin, e.birth_month, e.birth_day, e.username, COALESCE(cr.permissions, '{}') AS role_permissions, cr.name AS role_name, cr.simple_ui, cr.landing,
               (SELECT value FROM app_settings WHERE key = 'config_version') AS config_version
        FROM sessions s JOIN employees e ON e.id = s.employee_id LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND e.active = TRUE`, [sha256(decoded)]);
      if (rows[0]) {
        req.user = userView(rows[0]);
        req.csrfToken = rows[0].csrf_token;
        req.sessionHash = sha256(decoded);
        req.configVersion = Number(rows[0].config_version ?? 0);
        // Every response tells the browser the current settings version, so a change is noticed on the very next call.
        res.set('X-Config-Version', String(req.configVersion));
      }
    }
    next();
  });

  const requireSignedIn = (req, res, next) => (req.user ? next() : next(fail(401, 'AUTH_REQUIRED', 'Sign in to continue.')));
  const requireAuth = (req, res, next) => {
    if (!req.user) return next(fail(401, 'AUTH_REQUIRED', 'Sign in to continue.'));
    if (req.user.mustChangePassword) return next(fail(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before continuing.'));
    return next();
  };
  const requirePermission = (permission) => (req, res, next) => {
    if (!req.user) return next(fail(401, 'AUTH_REQUIRED', 'Sign in to continue.'));
    if (req.user.mustChangePassword) return next(fail(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before continuing.'));
    return req.user.permissions.includes(permission) ? next() : next(fail(403, 'PERMISSION_REQUIRED', `You need the “${PERMISSIONS[permission]}” permission for this.`));
  };
  const requireAnyPermissions = (...permissions) => (req, res, next) => {
    if (!req.user) return next(fail(401, 'AUTH_REQUIRED', 'Sign in to continue.'));
    if (req.user.mustChangePassword) return next(fail(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before continuing.'));
    return permissions.some((permission) => req.user.permissions.includes(permission)) ? next() : next(fail(403, 'PERMISSION_REQUIRED', 'You do not have permission for this.'));
  };
  const requireCsrf = (req, res, next) => {
    const supplied = req.get('X-CSRF-Token');
    return supplied && req.csrfToken && sameSecret(supplied, req.csrfToken)
      ? next()
      : next(fail(403, 'CSRF_INVALID', 'Your session needs a refresh. Reload the page and try again.'));
  };

  // ---------- Authentication ----------
  app.post('/api/login', async (req, res) => {
    // One box for either the work email or a username / employee ID. The answer never says which of the two was wrong.
    const rawLogin = typeof req.body?.login === 'string' ? req.body.login : typeof req.body?.email === 'string' ? req.body.email : '';
    const email = rawLogin.trim().toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (email.length > 200 || password.length > 200) throw fail(400, 'INVALID_INPUT', 'Enter a valid email or username and password.');
    const ipKey = `login-ip:${req.ip}`;
    const accountKey = `login-account:${req.ip}:${sha256(email)}`;
    const blocked = (key, maximum) => { const bucket = rateBuckets.get(key); return bucket && bucket.until > Date.now() && bucket.count >= maximum; };
    if (blocked(ipKey, 60) || blocked(accountKey, 8)) throw fail(429, 'RATE_LIMITED', 'Too many sign-in attempts. Wait a little and try again.');
    const { rows } = await db.query(`SELECT e.*, COALESCE(cr.permissions, '{}') AS role_permissions, cr.name AS role_name, cr.simple_ui, cr.landing FROM employees e LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id WHERE (e.email = $1 OR lower(e.username) = $1) AND e.active = TRUE LIMIT 1`, [email]);
    const employee = rows[0];
    const passwordOk = verifyPassword(password, employee?.password_hash);
    if (!employee || !passwordOk) {
      limit(ipKey, 60, 15 * 60 * 1000);
      limit(accountKey, 8, 15 * 60 * 1000);
      throw fail(401, 'LOGIN_FAILED', 'Those sign-in details do not match an account.');
    }
    rateBuckets.delete(accountKey);
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    await db.query("DELETE FROM idempotency WHERE created_at < now() - interval '3 days'");
    await db.query('INSERT INTO sessions (token_hash, employee_id, csrf_token, expires_at) VALUES ($1,$2,$3,$4)', [sha256(sessionToken), employee.id, csrfToken, new Date(Date.now() + SESSION_DURATION_MS)]);
    res.set('Set-Cookie', sessionCookie(sessionToken, SESSION_DURATION_MS / 1000));
    res.json({ user: userView(employee), csrfToken });
  });

  app.get('/api/session', (req, res) => {
    if (!req.user) return res.json({ user: null });
    return res.json({ user: req.user, csrfToken: req.csrfToken });
  });

  app.post('/api/logout', requireSignedIn, requireCsrf, async (req, res) => {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionHash]);
    res.set('Set-Cookie', sessionCookie('', 0));
    res.status(204).end();
  });

  app.post('/api/me/password', requireSignedIn, requireCsrf, async (req, res) => {
    const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const next = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (!limit(`password:${req.user.id}`, 10, 15 * 60 * 1000)) throw fail(429, 'RATE_LIMITED', 'Too many attempts. Wait a little and try again.');
    if (next.length < 10 || next.length > 128) throw fail(400, 'WEAK_PASSWORD', 'Use a password with at least 10 characters.');
    if (next === current) throw fail(400, 'SAME_PASSWORD', 'Choose a password different from the current one.');
    const { rows } = await db.query('SELECT password_hash FROM employees WHERE id = $1', [req.user.id]);
    if (!verifyPassword(current, rows[0]?.password_hash)) throw fail(403, 'WRONG_PASSWORD', 'Your current password is not correct.');
    await db.tx(async (tx) => {
      await tx.query('UPDATE employees SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [hashPassword(next), req.user.id]);
      await tx.query('DELETE FROM sessions WHERE employee_id = $1 AND token_hash <> $2', [req.user.id, req.sessionHash]);
      await audit(tx, req.user.id, 'password.changed', req.user.id);
    });
    res.status(204).end();
  });

  const loadSummary = async (user) => {
    const past = await db.query("SELECT starts_at FROM bookings WHERE employee_id = $1 AND status = 'confirmed' AND starts_at <= now() ORDER BY starts_at DESC LIMIT 400", [user.id]);
    const days = new Set(past.rows.map((row) => officeDateKey(new Date(row.starts_at))));
    let cursor = new Date();
    const isWeekend = (date) => ['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en', { timeZone: OFFICE_TZ, weekday: 'short' }).format(date));
    while (isWeekend(cursor)) cursor = new Date(cursor.getTime() - DAY_MS);
    if (!days.has(officeDateKey(cursor))) {
      cursor = new Date(cursor.getTime() - DAY_MS);
      while (isWeekend(cursor)) cursor = new Date(cursor.getTime() - DAY_MS);
    }
    let streak = 0;
    while (days.has(officeDateKey(cursor)) && streak < 400) {
      streak += 1;
      cursor = new Date(cursor.getTime() - DAY_MS);
      while (isWeekend(cursor)) cursor = new Date(cursor.getTime() - DAY_MS);
    }
    const monthPrefix = officeDateKey(new Date()).slice(0, 7);
    const monthCount = [...days].filter((day) => day.startsWith(monthPrefix)).length;
    const dayStart = new Date(`${officeDateKey(new Date())}T00:00:00+05:30`);
    const totals = (await db.query(`
      SELECT (SELECT COUNT(*)::int FROM resources WHERE type = 'desk' AND active = TRUE) AS desks_total,
             (SELECT COUNT(DISTINCT b.resource_id)::int FROM bookings b JOIN resources r ON r.id = b.resource_id
               WHERE r.type = 'desk' AND r.active = TRUE AND b.status = 'confirmed' AND b.starts_at < $2 AND b.ends_at > $1) AS desks_booked`,
    [dayStart, new Date(dayStart.getTime() + DAY_MS)])).rows[0];
    return { streak, monthCount, totalVisits: days.size, desksTotal: totals.desks_total, desksLeftToday: Math.max(0, totals.desks_total - totals.desks_booked) };
  };
  app.get('/api/me/summary', requireAuth, async (req, res) => res.json(await loadSummary(req.user)));

  // Pulse: the cheapest possible "has anything changed?" call. Features add small fields through pulse.add(name, fn);
  // keep each one to a single indexed query (or none), because every open browser tab calls this every few minutes.
  const pulseProviders = new Map();
  const pulse = { add: (name, provider) => pulseProviders.set(name, provider) };
  app.locals.pulse = pulse;
  app.get('/api/pulse', requireAuth, async (req, res) => {
    if (!limit(`pulse:${req.user.id}`, 60, 60_000)) throw fail(429, 'RATE_LIMITED', 'Slow down a little.');
    const body = { configVersion: req.configVersion, serverTime: new Date().toISOString() };
    for (const [name, provider] of pulseProviders) body[name] = await provider(req);
    res.json(body);
  });

  // ---------- Spaces ----------
  app.get('/api/resources', requireAuth, async (req, res) => {
    if (!limit(`resources:${req.user.id}`, 120, 60_000)) throw fail(429, 'RATE_LIMITED', 'Please pause before searching again.');
    const type = req.query.type;
    const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (type && type !== 'desk' && type !== 'room') throw fail(400, 'INVALID_TYPE', 'Choose desks or rooms.');
    const { startsAt, endsAt } = req.query;
    if ((startsAt || endsAt) && (!isoDate(startsAt) || !isoDate(endsAt) || Date.parse(endsAt) <= Date.parse(startsAt))) {
      throw fail(400, 'INVALID_TIME', 'Choose a valid date and time to check availability.');
    }
    const pattern = `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const { rows } = await db.query(`${RESOURCE_SELECT}
      WHERE r.active = TRUE AND ($1::text IS NULL OR r.type = $1)
        AND (r.label ILIKE $2 OR r.zone ILIKE $2 OR r.floor ILIKE $2 OR r.amenities::text ILIKE $2 OR COALESCE(t.name, '') ILIKE $2)
      ORDER BY r.type, r.label LIMIT 2000`, [type ?? null, pattern]);
    let busy = new Map();
    if (startsAt) {
      const manager = req.user.permissions.includes('bookings.view_all');
      const conflicts = await db.query(`
        SELECT b.resource_id, e.name FROM bookings b JOIN employees e ON e.id = b.employee_id
        WHERE b.status = 'confirmed' AND b.starts_at < $2 AND b.ends_at > $1`, [new Date(startsAt), new Date(endsAt)]);
      busy = new Map(conflicts.rows.map((row) => [row.resource_id, manager ? row.name : true]));
    }
    if (!startsAt) res.set('Cache-Control', 'private, no-cache');
    res.json({
      resources: rows.map((row) => publicResource(row, startsAt ? !busy.has(row.id) : null, typeof busy.get(row.id) === 'string' ? { bookedBy: busy.get(row.id) } : {})),
    });
  });

  app.get('/api/resources/:id', requireAuth, async (req, res) => {
    const { rows } = await db.query(`${RESOURCE_SELECT} WHERE r.id = $1 AND r.active = TRUE`, [req.params.id]);
    if (!rows[0]) throw fail(404, 'RESOURCE_NOT_FOUND', 'This space is unavailable.');
    res.json({ resource: publicResource(rows[0]) });
  });

  const loadTeams = async () => {
    const { rows } = await db.query(`
      SELECT t.id, t.name, t.color, t.sort_order, now() AS read_at,
             (SELECT COUNT(*)::int FROM resources r WHERE r.team_id = t.id AND r.active = TRUE AND r.type = 'desk') AS seat_count
      FROM teams t ORDER BY t.sort_order, t.name`);
    const unassigned = (await db.query("SELECT COUNT(*)::int AS count, now() AS read_at FROM resources WHERE team_id IS NULL AND active = TRUE AND type = 'desk'")).rows[0].count;
    return { teams: rows.map((row) => ({ id: row.id, name: row.name, color: row.color, seatCount: row.seat_count })), unassignedSeats: unassigned };
  };
  app.get('/api/teams', requireAuth, async (_req, res) => res.json(await loadTeams()));

  // floorPlanVersion changes whenever a new PDF is uploaded, so clients only re-download the (large) plan when needed.
  const loadMapInfo = async () => {
    const setting = (await db.query("SELECT value, now() AS read_at FROM app_settings WHERE key = 'calibration'")).rows[0];
    const stored = (await db.query("SELECT updated_at, now() AS read_at FROM app_files WHERE key = 'floor-plan'")).rows[0];
    const planPath = options.floorPlanPath ?? resolve(process.cwd(), 'local-data/floor-plan.pdf');
    return {
      calibration: setting?.value ?? DEFAULT_CALIBRATION,
      floorPlanAvailable: Boolean(stored) || existsSync(planPath),
      floorPlanVersion: stored ? new Date(stored.updated_at).getTime() : 0,
    };
  };
  app.get('/api/map', requireAuth, async (_req, res) => res.json(await loadMapInfo()));

  // ---------- Bookings ----------
  app.get('/api/bookings', requireAuth, async (req, res) => {
    const { rows } = await db.query(`
      SELECT b.id, b.resource_id, b.starts_at, b.ends_at, b.status, r.type, r.label, r.building, r.floor, r.zone
      FROM bookings b JOIN resources r ON r.id = b.resource_id
      WHERE b.employee_id = $1 AND b.status = 'confirmed' AND b.ends_at > now()
      ORDER BY b.starts_at LIMIT 100`, [req.user.id]);
    res.json({ bookings: rows });
  });

  app.get('/api/admin/bookings', requirePermission('bookings.view_all'), async (_req, res) => {
    const { rows } = await db.query(`
      SELECT b.id, b.resource_id, b.starts_at, b.ends_at, b.status, r.type, r.label, e.name AS employee_name, e.email AS employee_email
      FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN employees e ON e.id = b.employee_id
      WHERE b.status = 'confirmed' AND b.ends_at > now() ORDER BY b.starts_at LIMIT 300`);
    res.json({ bookings: rows });
  });

  app.post('/api/bookings', requireAuth, requireCsrf, async (req, res) => {
    if (!limit(`booking:${req.user.id}`, options.bookingRateLimit ?? 20, 60_000)) throw fail(429, 'RATE_LIMITED', 'You have made several booking attempts. Please wait a minute.');
    const { resourceId, startsAt, endsAt, token } = req.body ?? {};
    const idempotencyKey = req.get('Idempotency-Key');
    if (typeof resourceId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(resourceId) || !isoDate(startsAt) || !isoDate(endsAt) || !idempotencyKey || idempotencyKey.length > 100) {
      throw fail(400, 'INVALID_BOOKING', 'Review the space and booking times, then try again.');
    }
    const start = Date.parse(startsAt);
    const end = Date.parse(endsAt);
    const now = Date.now();
    if (start < now - 60_000 || end <= start || end - start > DAY_MS || start > now + 60 * DAY_MS) {
      throw fail(400, 'INVALID_TIME', 'Choose a valid time within the next 60 days.');
    }
    const payloadHash = sha256(JSON.stringify({ resourceId, startsAt, endsAt, token: typeof token === 'string' ? sha256(token) : null }));
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    const result = await db.tx(async (tx) => {
      await tx.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [req.user.id]);
      const prior = (await tx.query('SELECT request_hash, booking_id FROM idempotency WHERE employee_id = $1 AND key = $2', [req.user.id, idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_hash !== payloadHash) throw fail(409, 'IDEMPOTENCY_MISMATCH', 'This request key was already used for a different booking.');
        const original = (await tx.query('SELECT * FROM bookings WHERE id = $1', [prior.booking_id])).rows[0];
        if (original?.status !== 'confirmed') throw fail(409, 'BOOKING_CANCELLED', 'That booking was cancelled. Start a new booking to try again.');
        return { booking: original, duplicate: true };
      }
      const resource = (await tx.query('SELECT * FROM resources WHERE id = $1 AND active = TRUE FOR UPDATE', [resourceId])).rows[0];
      if (!resource) throw fail(404, 'RESOURCE_NOT_FOUND', 'This space is unavailable.');
      if (resource.type === 'room' && end - start > 8 * 60 * 60 * 1000) throw fail(400, 'DURATION_LIMIT', 'Room bookings are limited to eight hours.');
      let tokenRecord;
      if (token !== undefined) {
        if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw fail(400, 'INVALID_TOKEN', 'This booking QR is invalid.');
        tokenRecord = (await tx.query('SELECT * FROM booking_tokens WHERE token_hash = $1 FOR UPDATE', [sha256(token)])).rows[0];
        const expired = tokenRecord?.expires_at && new Date(tokenRecord.expires_at).getTime() <= now;
        const exhausted = tokenRecord?.max_redemptions !== null && tokenRecord?.redemption_count >= tokenRecord?.max_redemptions;
        if (!tokenRecord || tokenRecord.resource_id !== resourceId || tokenRecord.revoked || expired || exhausted ||
            (tokenRecord.eligible_employee_id && tokenRecord.eligible_employee_id !== req.user.id)) {
          throw fail(403, 'TOKEN_UNAVAILABLE', 'This booking QR is expired, restricted, revoked, or already used up.');
        }
        if (tokenRecord.max_redemptions !== null) {
          const used = (await tx.query('SELECT 1 FROM token_redemptions WHERE token_id = $1 AND employee_id = $2', [tokenRecord.id, req.user.id])).rows[0];
          if (used) throw fail(409, 'TOKEN_REDEEMED', 'You have already used this booking QR.');
        }
      }
      const upcoming = (await tx.query("SELECT COUNT(*)::int AS count FROM bookings WHERE employee_id = $1 AND status = 'confirmed' AND ends_at > now()", [req.user.id])).rows[0].count;
      if (upcoming >= 3) throw fail(409, 'BOOKING_QUOTA', 'You have reached the limit of three upcoming bookings.');
      if (resource.type === 'desk') {
        const own = (await tx.query(`
          SELECT 1 FROM bookings b JOIN resources r ON r.id = b.resource_id
          WHERE b.employee_id = $1 AND b.status = 'confirmed' AND r.type = 'desk' AND b.starts_at < $3 AND b.ends_at > $2 LIMIT 1`, [req.user.id, startIso, endIso])).rows[0];
        if (own) throw fail(409, 'ALREADY_BOOKED', 'You already have a desk for that time.');
      }
      const clash = (await tx.query("SELECT 1 FROM bookings WHERE resource_id = $1 AND status = 'confirmed' AND starts_at < $3 AND ends_at > $2 LIMIT 1", [resourceId, startIso, endIso])).rows[0];
      if (clash) throw fail(409, 'BOOKING_CONFLICT', 'That time was just booked. Choose another space or time.');
      const id = randomUUID();
      await tx.query('INSERT INTO bookings (id, employee_id, resource_id, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5)', [id, req.user.id, resourceId, startIso, endIso]);
      await tx.query('INSERT INTO idempotency (employee_id, key, request_hash, booking_id) VALUES ($1,$2,$3,$4)', [req.user.id, idempotencyKey, payloadHash, id]);
      if (tokenRecord) {
        const updated = await tx.query(`
          UPDATE booking_tokens SET redemption_count = redemption_count + 1
          WHERE id = $1 AND revoked = FALSE AND (max_redemptions IS NULL OR redemption_count < max_redemptions)
            AND (expires_at IS NULL OR expires_at > now()) RETURNING id`, [tokenRecord.id]);
        if (updated.rows.length !== 1) throw fail(409, 'TOKEN_UNAVAILABLE', 'This booking QR has already been used.');
        await tx.query('INSERT INTO token_redemptions (token_id, employee_id, booking_id) VALUES ($1,$2,$3)', [tokenRecord.id, req.user.id, id]);
      }
      await audit(tx, req.user.id, 'booking.created', id, resource.label);
      return { booking: { id, employee_id: req.user.id, resource_id: resourceId, starts_at: startIso, ends_at: endIso, status: 'confirmed' }, duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json({ booking: result.booking, duplicate: result.duplicate });
  });

  app.delete('/api/bookings/:id', requireAuth, requireCsrf, async (req, res) => {
    const booking = (await db.query("SELECT id, employee_id, ends_at FROM bookings WHERE id = $1 AND status = 'confirmed'", [req.params.id])).rows[0];
    if (!booking) throw fail(404, 'BOOKING_NOT_FOUND', 'This booking is no longer available.');
    if (booking.employee_id !== req.user.id && !req.user.permissions.includes('bookings.cancel_others')) throw fail(403, 'NOT_BOOKING_OWNER', 'You can only cancel your own bookings.');
    if (new Date(booking.ends_at).getTime() <= Date.now()) throw fail(409, 'BOOKING_ENDED', 'That booking is already over, so it stays in the history.');
    await db.tx(async (tx) => {
      // The status guard makes a double tap (or two admins) cancel and log exactly once.
      const cancelled = await tx.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING id", [booking.id]);
      if (!cancelled.rows.length) throw fail(404, 'BOOKING_NOT_FOUND', 'This booking is no longer available.');
      await audit(tx, req.user.id, 'booking.cancelled', booking.id, booking.employee_id === req.user.id ? 'own booking' : 'cancelled by manager');
    });
    res.status(204).end();
  });

  // ---------- Availability ----------
  // One compact answer per office day: the confirmed busy intervals (minutes after local midnight) for every space that has
  // any. Browsers keep it in memory and work out free/booked for any arrival time and stay without asking again.
  let readSettings = async () => ({ options: {} });
  const validDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  app.get('/api/availability', requireAuth, async (req, res) => {
    if (!limit(`availability:${req.user.id}`, 120, 60_000)) throw fail(429, 'RATE_LIMITED', 'Please pause before checking again.');
    const date = req.query.date;
    if (!validDay(date) || date < officeDateKey(new Date(Date.now() - DAY_MS)) || date > officeDateKey(new Date(Date.now() + 62 * DAY_MS))) {
      throw fail(400, 'INVALID_DATE', 'Choose a date within the next 60 days.');
    }
    const dayStart = new Date(`${date}T00:00:00+05:30`);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const { options: settings } = await readSettings();
    const showNames = settings.showBookerNames === true || req.user.permissions.includes('bookings.view_all');
    const { rows } = await db.query(`
      SELECT b.resource_id, b.starts_at, b.ends_at, b.employee_id, now() AS read_at${showNames ? ', e.name' : ''}
      FROM bookings b ${showNames ? 'JOIN employees e ON e.id = b.employee_id' : ''}
      WHERE b.status = 'confirmed' AND b.starts_at < $2 AND b.ends_at > $1
      ORDER BY b.resource_id, b.starts_at LIMIT 3000`, [dayStart, dayEnd]);
    const busy = {};
    for (const row of rows) {
      const from = Math.max(0, Math.round((new Date(row.starts_at).getTime() - dayStart.getTime()) / 60_000));
      const to = Math.min(1440, Math.round((new Date(row.ends_at).getTime() - dayStart.getTime()) / 60_000));
      if (to <= from) continue;
      (busy[row.resource_id] ??= []).push(showNames ? [from, to, row.employee_id === req.user.id ? 1 : 0, row.name] : [from, to, row.employee_id === req.user.id ? 1 : 0]);
    }
    res.set('Cache-Control', 'private, no-cache');
    res.json({ date, showNames, busy });
  });

  // ---------- Events ----------
  const eventBody = (body, partial = false) => {
    const title = text(body?.title, 120, { required: !partial, label: 'Title' });
    const description = text(body?.description, 1000, { label: 'Description' });
    const venue = text(body?.venue, 120, { required: !partial, label: 'Venue' });
    const audience = text(body?.audience, 100, { label: 'Audience' });
    const category = body?.category;
    if (category !== undefined && !EVENT_CATEGORIES.includes(category)) throw fail(400, 'INVALID_CATEGORY', 'Choose a listed event category.');
    if (!partial && category === undefined) throw fail(400, 'INVALID_CATEGORY', 'Choose a listed event category.');
    const { startsAt, endsAt } = body ?? {};
    if (!partial || startsAt !== undefined) if (!isoDate(startsAt)) throw fail(400, 'INVALID_TIME', 'Choose a valid start time.');
    if (!partial || endsAt !== undefined) if (!isoDate(endsAt)) throw fail(400, 'INVALID_TIME', 'Choose a valid end time.');
    const links = body?.links === undefined ? undefined : cleanLinks(body.links);
    return { title, description, venue, audience, category, startsAt, endsAt, links };
  };
  const checkEventTimes = (start, end) => {
    if (end <= start) throw fail(400, 'INVALID_TIME', 'The event must end after it starts.');
    if (end - start > 14 * DAY_MS) throw fail(400, 'INVALID_TIME', 'Events can last at most 14 days.');
  };

  const rsvpsOn = async () => (await readSettings()).options.eventsRsvpEnabled !== false;
  app.get('/api/events', requireAuth, async (req, res) => {
    const showRsvp = await rsvpsOn();
    const { rows } = await db.query(`
      SELECT ev.id, ev.title, ev.description, ev.starts_at, ev.ends_at, ev.venue, ev.category, ev.audience, ev.links,
             (SELECT COUNT(*)::int FROM event_rsvps r WHERE r.event_id = ev.id) AS going_count,
             EXISTS (SELECT 1 FROM event_rsvps r WHERE r.event_id = ev.id AND r.employee_id = $1) AS going
      FROM events ev WHERE ev.ends_at >= now() ORDER BY ev.starts_at LIMIT 100`, [req.user.id]);
    res.json({ rsvpEnabled: showRsvp, events: rows.map((row) => ({ ...row, going_count: showRsvp ? row.going_count : 0, going: showRsvp && Boolean(row.going) })) });
  });

  app.post('/api/events', requirePermission('events.create'), requireCsrf, async (req, res) => {
    const input = eventBody(req.body);
    checkEventTimes(Date.parse(input.startsAt), Date.parse(input.endsAt));
    const id = randomUUID();
    await db.tx(async (tx) => {
      await tx.query(
        'INSERT INTO events (id, title, description, starts_at, ends_at, venue, category, audience, created_by, links) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, input.title, input.description ?? '', new Date(input.startsAt), new Date(input.endsAt), input.venue, input.category, input.audience || 'All employees', req.user.id, JSON.stringify(input.links ?? [])],
      );
      await audit(tx, req.user.id, 'event.created', id, input.title);
    });
    res.status(201).json({ id });
  });

  app.patch('/api/events/:id', requirePermission('events.edit'), requireCsrf, async (req, res) => {
    const existing = (await db.query('SELECT * FROM events WHERE id = $1', [req.params.id])).rows[0];
    if (!existing) throw fail(404, 'EVENT_NOT_FOUND', 'This event no longer exists.');
    const input = eventBody(req.body, true);
    const start = input.startsAt ? Date.parse(input.startsAt) : new Date(existing.starts_at).getTime();
    const end = input.endsAt ? Date.parse(input.endsAt) : new Date(existing.ends_at).getTime();
    checkEventTimes(start, end);
    await db.tx(async (tx) => {
      await tx.query(
        'UPDATE events SET title=$2, description=$3, starts_at=$4, ends_at=$5, venue=$6, category=$7, audience=$8, links=$9 WHERE id=$1',
        [existing.id, input.title || existing.title, input.description ?? existing.description, new Date(start), new Date(end), input.venue || existing.venue, input.category ?? existing.category, input.audience || existing.audience, JSON.stringify(input.links ?? existing.links ?? [])],
      );
      await audit(tx, req.user.id, 'event.updated', existing.id, input.title || existing.title);
    });
    res.status(204).end();
  });

  app.delete('/api/events/:id', requirePermission('events.delete'), requireCsrf, async (req, res) => {
    const existing = (await db.query('SELECT id, title FROM events WHERE id = $1', [req.params.id])).rows[0];
    if (!existing) throw fail(404, 'EVENT_NOT_FOUND', 'This event no longer exists.');
    await db.tx(async (tx) => {
      await tx.query('DELETE FROM events WHERE id = $1', [existing.id]);
      await audit(tx, req.user.id, 'event.deleted', existing.id, existing.title);
    });
    res.status(204).end();
  });

  app.put('/api/events/:id/rsvp', requireAuth, requireCsrf, async (req, res) => {
    if (!(await rsvpsOn())) throw fail(403, 'RSVP_DISABLED', 'RSVPs are turned off for events.');
    const event = (await db.query('SELECT id FROM events WHERE id = $1 AND ends_at >= now()', [req.params.id])).rows[0];
    if (!event) throw fail(404, 'EVENT_NOT_FOUND', 'This event is no longer open.');
    await db.query('INSERT INTO event_rsvps (event_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [event.id, req.user.id]);
    res.status(204).end();
  });

  app.delete('/api/events/:id/rsvp', requireAuth, requireCsrf, async (req, res) => {
    if (!(await rsvpsOn())) throw fail(403, 'RSVP_DISABLED', 'RSVPs are turned off for events.');
    await db.query('DELETE FROM event_rsvps WHERE event_id = $1 AND employee_id = $2', [req.params.id, req.user.id]);
    res.status(204).end();
  });

  // ---------- Booking QR codes ----------
  app.post('/api/admin/tokens', requirePermission('qr.manage'), requireCsrf, async (req, res) => {
    const { resourceId, expiresAt, noExpiry, eligibleEmployeeId, maxRedemptions } = req.body ?? {};
    if (typeof resourceId !== 'string') throw fail(400, 'INVALID_TOKEN_POLICY', 'Choose a space for this QR.');
    let expiry = null;
    if (!noExpiry) {
      if (!isoDate(expiresAt) || Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 365 * DAY_MS) {
        throw fail(400, 'INVALID_TOKEN_POLICY', 'Choose an expiry within the next year, or pick “No expiry”.');
      }
      expiry = new Date(Date.parse(expiresAt));
    }
    let max = null;
    if (maxRedemptions !== null && maxRedemptions !== undefined) {
      if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 10_000) throw fail(400, 'INVALID_TOKEN_POLICY', 'Use 1 to 10,000 uses, or unlimited.');
      max = maxRedemptions;
    }
    if (!(await db.query('SELECT 1 FROM resources WHERE id = $1 AND active = TRUE', [resourceId])).rows[0]) throw fail(404, 'RESOURCE_NOT_FOUND', 'This space is unavailable.');
    if (eligibleEmployeeId && !(await db.query('SELECT 1 FROM employees WHERE id = $1 AND active = TRUE', [eligibleEmployeeId])).rows[0]) {
      throw fail(400, 'INVALID_EMPLOYEE', 'Choose an active employee for this restricted QR.');
    }
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    await db.tx(async (tx) => {
      await tx.query('INSERT INTO booking_tokens (id, token_hash, resource_id, eligible_employee_id, expires_at, max_redemptions, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, sha256(token), resourceId, eligibleEmployeeId || null, expiry, max, req.user.id]);
      await audit(tx, req.user.id, 'booking-token.created', id, resourceId);
    });
    res.status(201).json({ token, id });
  });

  app.get('/api/admin/tokens', requirePermission('qr.manage'), async (_req, res) => {
    const { rows } = await db.query(`
      SELECT t.id, t.expires_at, t.max_redemptions, t.redemption_count, t.revoked, t.created_at, r.label, r.type
      FROM booking_tokens t JOIN resources r ON r.id = t.resource_id ORDER BY t.created_at DESC LIMIT 50`);
    res.json({ tokens: rows });
  });

  app.delete('/api/admin/tokens/:id', requirePermission('qr.manage'), requireCsrf, async (req, res) => {
    const updated = await db.query('UPDATE booking_tokens SET revoked = TRUE WHERE id = $1 AND revoked = FALSE RETURNING id', [req.params.id]);
    if (!updated.rows.length) throw fail(404, 'TOKEN_NOT_FOUND', 'This QR is already revoked or unavailable.');
    await audit(db, req.user.id, 'booking-token.revoked', req.params.id);
    res.status(204).end();
  });

  app.get('/api/admin/employee-options', requireAnyPermissions('qr.manage', 'users.view', 'users.create', 'issues.assign', 'notifications.route'), async (_req, res) => {
    const { rows } = await db.query('SELECT id, name, email FROM employees WHERE active = TRUE ORDER BY name LIMIT 500');
    res.json({ employees: rows });
  });

  // ---------- Space administration ----------
  app.get('/api/admin/resources', requirePermission('spaces.manage'), async (_req, res) => {
    const { rows } = await db.query(`${RESOURCE_SELECT} ORDER BY r.active DESC, r.type, r.label LIMIT 1000`);
    res.json({ resources: rows.map((row) => publicResource(row)) });
  });

  const resourceBody = async (client, body, partial) => {
    const fields = {};
    const label = text(body?.label, 40, { required: !partial, label: 'Label' });
    if (label !== undefined) fields.label = label;
    const zone = text(body?.zone, 100, { label: 'Zone' });
    if (zone !== undefined) fields.zone = zone;
    const description = text(body?.description, 300, { label: 'Description' });
    if (description !== undefined) fields.description = description;
    if (body?.amenities !== undefined) {
      if (!Array.isArray(body.amenities) || body.amenities.length > 12 || body.amenities.some((item) => typeof item !== 'string' || !item.trim() || item.length > 40)) {
        throw fail(400, 'INVALID_INPUT', 'Amenities must be a short list of text values.');
      }
      fields.amenities = JSON.stringify(body.amenities.map((item) => item.trim()));
    }
    if (body?.capacity !== undefined) {
      if (body.capacity !== null && (!Number.isInteger(body.capacity) || body.capacity < 1 || body.capacity > 500)) throw fail(400, 'INVALID_INPUT', 'Capacity must be between 1 and 500.');
      fields.capacity = body.capacity;
    }
    if (body?.teamId !== undefined) {
      if (body.teamId !== null) {
        if (typeof body.teamId !== 'string' || !(await client.query('SELECT 1 FROM teams WHERE id = $1', [body.teamId])).rows[0]) throw fail(400, 'INVALID_TEAM', 'Choose an existing team.');
      }
      fields.team_id = body.teamId;
    }
    if (body?.x !== undefined || body?.y !== undefined) {
      if (body.x === null && body.y === null) { fields.x_pct = null; fields.y_pct = null; fields.placed_manually = false; }
      else { fields.x_pct = percent(body.x, 'Horizontal position'); fields.y_pct = percent(body.y, 'Vertical position'); fields.placed_manually = true; }
    }
    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') throw fail(400, 'INVALID_INPUT', 'Active must be true or false.');
      fields.active = body.active;
    }
    if (body?.labelSide !== undefined) {
      if (body.labelSide !== null && !LABEL_SIDES.includes(body.labelSide)) throw fail(400, 'INVALID_INPUT', 'Choose top, bottom, left, right or automatic for the label.');
      fields.label_side = body.labelSide;
    }
    return fields;
  };

  app.post('/api/admin/resources', requirePermission('spaces.manage'), requireCsrf, async (req, res) => {
    const type = req.body?.type;
    if (type !== 'desk' && type !== 'room') throw fail(400, 'INVALID_TYPE', 'Choose desk or room.');
    const fields = await resourceBody(db, req.body, false);
    const id = `${type === 'desk' ? 'seat' : 'room'}-${randomUUID().slice(0, 8)}`;
    if ((await db.query('SELECT 1 FROM resources WHERE type = $1 AND lower(label) = lower($2) AND active = TRUE', [type, fields.label])).rows[0]) {
      throw fail(409, 'LABEL_IN_USE', `A ${type} called “${fields.label}” already exists.`);
    }
    await db.tx(async (tx) => {
      await tx.query(
        `INSERT INTO resources (id, type, label, building, floor, zone, description, amenities, capacity, team_id, x_pct, y_pct, placed_manually)
         VALUES ($1,$2,$3,'GCC Office','Main floor',$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, type, fields.label, fields.zone ?? '', fields.description ?? '', fields.amenities ?? '[]', fields.capacity ?? null, fields.team_id ?? null, fields.x_pct ?? 50, fields.y_pct ?? 50, true],
      );
      await audit(tx, req.user.id, 'resource.created', id, fields.label);
    });
    res.status(201).json({ id });
  });

  app.patch('/api/admin/resources/:id', requirePermission('spaces.manage'), requireCsrf, async (req, res) => {
    const existing = (await db.query('SELECT * FROM resources WHERE id = $1', [req.params.id])).rows[0];
    if (!existing) throw fail(404, 'RESOURCE_NOT_FOUND', 'This space does not exist.');
    const fields = await resourceBody(db, req.body, true);
    const keys = Object.keys(fields);
    if (!keys.length) throw fail(400, 'NOTHING_TO_UPDATE', 'No changes were supplied.');
    const willBeActive = fields.active ?? existing.active;
    const nextLabel = fields.label ?? existing.label;
    if ((fields.label || fields.active === true) && willBeActive && (await db.query('SELECT 1 FROM resources WHERE type = $1 AND lower(label) = lower($2) AND active = TRUE AND id <> $3', [existing.type, nextLabel, existing.id])).rows[0]) {
      throw fail(409, 'LABEL_IN_USE', `A ${existing.type} called “${nextLabel}” already exists.`);
    }
    await db.tx(async (tx) => {
      await tx.query(`UPDATE resources SET ${keys.map((key, index) => `${key} = $${index + 2}`).join(', ')} WHERE id = $1`, [existing.id, ...keys.map((key) => fields[key])]);
      if (fields.active === false && existing.active) {
        await tx.query("UPDATE bookings SET status = 'cancelled' WHERE resource_id = $1 AND status = 'confirmed' AND ends_at > now()", [existing.id]);
      }
      await audit(tx, req.user.id, 'resource.updated', existing.id, keys.join(','));
    });
    res.status(204).end();
  });

  app.delete('/api/admin/resources/:id', requirePermission('spaces.manage'), requireCsrf, async (req, res) => {
    const resource = (await db.query('SELECT id, active, label FROM resources WHERE id = $1', [req.params.id])).rows[0];
    if (!resource || !resource.active) throw fail(404, 'RESOURCE_NOT_FOUND', 'This space is already removed or unavailable.');
    await db.tx(async (tx) => {
      await tx.query('UPDATE resources SET active = FALSE WHERE id = $1', [resource.id]);
      await tx.query("UPDATE bookings SET status = 'cancelled' WHERE resource_id = $1 AND status = 'confirmed' AND ends_at > now()", [resource.id]);
      await audit(tx, req.user.id, 'resource.retired', resource.id, resource.label);
    });
    res.status(204).end();
  });

  app.put('/api/admin/map/calibration', requirePermission('spaces.manage'), requireCsrf, async (req, res) => {
    const calibration = req.body?.calibration;
    if (!validCalibration(calibration)) throw fail(400, 'INVALID_CALIBRATION', 'Use a layout area that is at least 5% wide and tall.');
    const includeManual = req.body?.includeManual === true;
    const changed = await db.tx(async (tx) => {
      await tx.query("INSERT INTO app_settings (key, value) VALUES ('calibration', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(calibration)]);
      const seats = (await tx.query(`SELECT id, grid_row, grid_col, placed_manually FROM resources WHERE type = 'desk' AND active = TRUE AND grid_row IS NOT NULL AND grid_col IS NOT NULL`)).rows;
      const placement = gridPlacement(seats.map((seat) => ({ id: seat.id, row: seat.grid_row, col: seat.grid_col })), calibration);
      let count = 0;
      for (const seat of seats) {
        if (seat.placed_manually && !includeManual) continue;
        const point = placement.get(seat.id);
        await tx.query('UPDATE resources SET x_pct = $2, y_pct = $3, placed_manually = FALSE WHERE id = $1', [seat.id, point.x, point.y]);
        count += 1;
      }
      await audit(tx, req.user.id, 'map.calibrated', null, `${count} seats`);
      return count;
    });
    res.json({ updated: changed });
  });

  // ---------- Teams ----------
  const teamBody = (body, partial) => {
    const name = text(body?.name, 100, { required: !partial, label: 'Team name' });
    const color = body?.color;
    if (color !== undefined && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color))) throw fail(400, 'INVALID_COLOR', 'Choose a colour like #2f9e6f.');
    if (!partial && color === undefined) throw fail(400, 'INVALID_COLOR', 'Choose a colour for the team.');
    return { name, color: color?.toLowerCase() };
  };

  app.post('/api/admin/teams', requirePermission('teams.manage'), requireCsrf, async (req, res) => {
    const { name, color } = teamBody(req.body, false);
    const id = `team-${randomUUID().slice(0, 8)}`;
    if ((await db.query('SELECT 1 FROM teams WHERE lower(name) = lower($1)', [name])).rows[0]) throw fail(409, 'TEAM_EXISTS', 'A team with that name already exists.');
    const order = (await db.query('SELECT COALESCE(MAX(sort_order), -1)::int + 1 AS next FROM teams')).rows[0].next;
    await db.tx(async (tx) => {
      await tx.query('INSERT INTO teams (id, name, color, sort_order) VALUES ($1,$2,$3,$4)', [id, name, color, order]);
      await audit(tx, req.user.id, 'team.created', id, name);
    });
    res.status(201).json({ id });
  });

  app.patch('/api/admin/teams/:id', requirePermission('teams.manage'), requireCsrf, async (req, res) => {
    const team = (await db.query('SELECT * FROM teams WHERE id = $1', [req.params.id])).rows[0];
    if (!team) throw fail(404, 'TEAM_NOT_FOUND', 'This team no longer exists.');
    const { name, color } = teamBody(req.body, true);
    if (name && (await db.query('SELECT 1 FROM teams WHERE lower(name) = lower($1) AND id <> $2', [name, team.id])).rows[0]) throw fail(409, 'TEAM_EXISTS', 'A team with that name already exists.');
    await db.tx(async (tx) => {
      await tx.query('UPDATE teams SET name = $2, color = $3 WHERE id = $1', [team.id, name ?? team.name, color ?? team.color]);
      if (name) await tx.query("UPDATE resources SET zone = $2 WHERE team_id = $1 AND type = 'desk'", [team.id, name]);
      await audit(tx, req.user.id, 'team.updated', team.id, name ?? team.name);
    });
    res.status(204).end();
  });

  app.delete('/api/admin/teams/:id', requirePermission('teams.manage'), requireCsrf, async (req, res) => {
    const team = (await db.query('SELECT id, name FROM teams WHERE id = $1', [req.params.id])).rows[0];
    if (!team) throw fail(404, 'TEAM_NOT_FOUND', 'This team no longer exists.');
    await db.tx(async (tx) => {
      await tx.query("UPDATE resources SET zone = '' WHERE team_id = $1 AND type = 'desk'", [team.id]);
      await tx.query('DELETE FROM teams WHERE id = $1', [team.id]);
      await audit(tx, req.user.id, 'team.deleted', team.id, team.name);
    });
    res.status(204).end();
  });

  app.post('/api/admin/teams/assign', requirePermission('teams.manage'), requireCsrf, async (req, res) => {
    const { teamId, resourceIds } = req.body ?? {};
    if (!Array.isArray(resourceIds) || !resourceIds.length || resourceIds.length > 500 || resourceIds.some((id) => typeof id !== 'string' || id.length > 64)) {
      throw fail(400, 'INVALID_INPUT', 'Choose between 1 and 500 desks to assign.');
    }
    let team = null;
    if (teamId !== null) {
      team = (await db.query('SELECT id, name FROM teams WHERE id = $1', [teamId])).rows[0];
      if (!team) throw fail(404, 'TEAM_NOT_FOUND', 'Choose an existing team.');
    }
    const updated = await db.tx(async (tx) => {
      const result = await tx.query("UPDATE resources SET team_id = $1, zone = $2 WHERE id = ANY($3::text[]) AND type = 'desk' AND active = TRUE RETURNING id", [team?.id ?? null, team?.name ?? '', resourceIds]);
      await audit(tx, req.user.id, 'team.assigned', team?.id ?? null, `${result.rows.length} desks`);
      return result.rows.length;
    });
    res.json({ updated });
  });

  // Saves a batch of seat moves and team assignments in one go, so the editor can stage changes and apply them with a Save button.
  app.put('/api/admin/map/layout', requireAnyPermissions('spaces.manage', 'teams.manage'), requireCsrf, async (req, res) => {
    const moves = req.body?.moves ?? [];
    const assignments = req.body?.assignments ?? [];
    const labels = req.body?.labels ?? [];
    if (!Array.isArray(moves) || !Array.isArray(assignments) || !Array.isArray(labels) || moves.length > 600 || assignments.length > 100 || labels.length > 600) throw fail(400, 'INVALID_INPUT', 'That is too many changes to save at once.');
    if ((moves.length || labels.length) && !req.user.permissions.includes('spaces.manage')) throw fail(403, 'PERMISSION_REQUIRED', 'Moving seats needs the space management permission.');
    if (assignments.length && !req.user.permissions.includes('teams.manage')) throw fail(403, 'PERMISSION_REQUIRED', 'Changing teams needs the team management permission.');
    for (const move of moves) {
      if (typeof move?.id !== 'string' || move.id.length > 64) throw fail(400, 'INVALID_INPUT', 'A seat in the list is not valid.');
      percent(move.x, 'Horizontal position'); percent(move.y, 'Vertical position');
    }
    for (const label of labels) {
      if (typeof label?.id !== 'string' || label.id.length > 64 || (label.side !== null && !LABEL_SIDES.includes(label.side))) throw fail(400, 'INVALID_INPUT', 'A label setting is not valid.');
    }
    for (const item of assignments) {
      if (!Array.isArray(item?.resourceIds) || item.resourceIds.length > 600 || item.resourceIds.some((id) => typeof id !== 'string' || id.length > 64)) throw fail(400, 'INVALID_INPUT', 'A team change is not valid.');
      if (item.teamId !== null && typeof item.teamId !== 'string') throw fail(400, 'INVALID_INPUT', 'A team change is not valid.');
    }
    const result = await db.tx(async (tx) => {
      let moved = 0; let assigned = 0; let relabelled = 0;
      for (const label of labels) {
        relabelled += (await tx.query('UPDATE resources SET label_side = $2 WHERE id = $1 AND active = TRUE RETURNING id', [label.id, label.side])).rows.length;
      }
      for (const move of moves) {
        const done = await tx.query('UPDATE resources SET x_pct = $2, y_pct = $3, placed_manually = TRUE WHERE id = $1 AND active = TRUE RETURNING id', [move.id, percent(move.x, 'x'), percent(move.y, 'y')]);
        moved += done.rows.length;
      }
      for (const item of assignments) {
        let team = null;
        if (item.teamId !== null) {
          team = (await tx.query('SELECT id, name FROM teams WHERE id = $1', [item.teamId])).rows[0];
          if (!team) throw fail(404, 'TEAM_NOT_FOUND', 'One of the teams no longer exists. Reload and try again.');
        }
        const done = await tx.query("UPDATE resources SET team_id = $1, zone = $2 WHERE id = ANY($3::text[]) AND type = 'desk' AND active = TRUE RETURNING id", [team?.id ?? null, team?.name ?? '', item.resourceIds]);
        assigned += done.rows.length;
      }
      await audit(tx, req.user.id, 'map.saved', null, `${moved} seats moved, ${assigned} team assignments, ${relabelled} labels`);
      return { moved, assigned, relabelled };
    });
    res.json(result);
  });

  // ---------- Users and permissions ----------
  // Accepts current and older permission strings; older ones are expanded. Settings and role management are reserved for the super admin role.
  const permissionList = (value) => {
    if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string' || (!ALL_PERMISSIONS.includes(item) && !LEGACY_PERMISSIONS[item]))) throw fail(400, 'INVALID_PERMISSIONS', 'Choose permissions from the list.');
    if (value.some((item) => RESERVED_PERMISSIONS.includes(item))) throw fail(400, 'INVALID_PERMISSIONS', 'Settings and role management belong to the super admin role and cannot be given to others.');
    return expandPermissions(value);
  };
  const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
  const usernameOf = (value) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !USERNAME_PATTERN.test(value.trim())) throw fail(400, 'INVALID_USERNAME', 'A username is 3 to 32 letters, numbers, dots, dashes or underscores.');
    return value.trim();
  };
  const employeeView = (row) => ({
    id: row.id, email: row.email ?? '', username: row.username ?? null, name: row.name, team: row.team, role: row.role, active: row.active,
    permissions: effectivePermissions(row), ownPermissions: expandPermissions(row.permissions), customRoleId: row.custom_role_id, joinedOn: row.joined_on ?? '', createdAt: row.created_at,
  });
  const roleTemplate = async (client, id) => {
    if (id === null || id === undefined || id === '') return null;
    const found = typeof id === 'string' ? (await client.query('SELECT id, permissions, system_key FROM custom_roles WHERE id = $1', [id])).rows[0] : null;
    if (!found) throw fail(400, 'INVALID_ROLE_TEMPLATE', 'Choose an existing role template.');
    if (found.system_key === 'super_admin') throw fail(400, 'INVALID_ROLE_TEMPLATE', 'Choose “Super admin” in the Role field instead of using it as a template.');
    return { ...found, permissions: expandPermissions(found.permissions) };
  };
  const joinedDate = (value) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw fail(400, 'INVALID_DATE', 'Use a valid joining date.');
    return value;
  };
  const superOnly = () => fail(403, 'SUPER_ADMIN_REQUIRED', 'Only a super admin can do that.');
  const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));
  // People who are not super admins may only hand out permissions they hold themselves, and never the super-admin-only ones.
  const assertGrantable = (actor, added) => {
    if (actor.role === 'super_admin') return;
    if (added.some((permission) => SUPER_GRANT_PERMISSIONS.includes(permission) || !actor.permissions.includes(permission))) throw superOnly();
  };

  app.get('/api/admin/users', requireAnyPermissions('users.view', 'users.create', 'users.edit', 'users.change_roles', 'users.reset_password'), async (_req, res) => {
    const { rows } = await db.query('SELECT e.id, e.email, e.username, e.name, e.team, e.role, e.permissions, e.active, e.created_at, e.custom_role_id, to_char(e.joined_on, \'YYYY-MM-DD\') AS joined_on, COALESCE(cr.permissions, \'{}\') AS role_permissions FROM employees e LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id ORDER BY e.active DESC, e.name LIMIT 500');
    const roles = (await db.query('SELECT id, name, emoji, description, permissions, system_key, simple_ui FROM custom_roles ORDER BY (system_key IS NULL), name')).rows;
    res.json({
      users: rows.map(employeeView),
      roles: roles.filter((role) => role.system_key !== 'super_admin').map((role) => ({ id: role.id, name: role.name, emoji: role.emoji, description: role.description, permissions: expandPermissions(role.permissions), systemKey: role.system_key, simpleUi: role.simple_ui })),
    });
  });

  app.post('/api/admin/users', requirePermission('users.create'), requireCsrf, async (req, res) => {
    const rawEmail = text(req.body?.email, 200, { label: 'Email' });
    const email = rawEmail ? rawEmail.toLowerCase() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'INVALID_EMAIL', 'Enter a valid email address.');
    const username = usernameOf(req.body?.username) ?? null;
    if (!email && !username) throw fail(400, 'LOGIN_REQUIRED', 'Give the person a work email, a username (employee ID), or both.');
    const name = text(req.body?.name, 100, { required: true, label: 'Name' });
    const team = text(req.body?.team, 100, { label: 'Team' }) ?? '';
    const role = req.body?.role ?? 'user';
    if (!ROLES.includes(role)) throw fail(400, 'INVALID_ROLE', 'Choose a supported role.');
    if (role === 'super_admin' && req.user.role !== 'super_admin') throw superOnly();
    const permissions = role === 'super_admin' ? [] : permissionList(req.body?.permissions ?? (role === 'admin' ? ADMIN_DEFAULT_PERMISSIONS.filter((p) => req.user.permissions.includes(p)) : []));
    const template = await roleTemplate(db, req.body?.customRoleId);
    // Making someone more than a plain employee is a role change, which needs its own permission.
    if ((role !== 'user' || permissions.length || template) && !req.user.permissions.includes('users.change_roles')) throw fail(403, 'PERMISSION_REQUIRED', 'You can create people as employees. Choosing roles and permissions needs the “Change roles and permissions” permission.');
    assertGrantable(req.user, permissions);
    if (template) assertGrantable(req.user, template.permissions);
    const joinedOn = joinedDate(req.body?.joinedOn) ?? null;
    let password = req.body?.password;
    const generated = password === undefined || password === '';
    if (generated) password = generatePassword();
    else if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw fail(400, 'WEAK_PASSWORD', 'Use a password with at least 10 characters.');
    if (email && (await db.query('SELECT 1 FROM employees WHERE email = $1', [email])).rows[0]) throw fail(409, 'EMAIL_IN_USE', 'Someone already has that email address.');
    if (username && (await db.query('SELECT 1 FROM employees WHERE lower(username) = lower($1)', [username])).rows[0]) throw fail(409, 'USERNAME_IN_USE', 'Someone already has that username.');
    const id = randomUUID();
    await db.tx(async (tx) => {
      await tx.query('INSERT INTO employees (id, email, username, name, team, role, permissions, password_hash, must_change_password, custom_role_id, joined_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10)', [id, email, username, name, team, role, permissions, hashPassword(password), template?.id ?? null, joinedOn]);
      await audit(tx, req.user.id, 'user.created', id, `${email ?? username} (${role})`);
    });
    res.status(201).json({ id, temporaryPassword: password });
  });

  app.patch('/api/admin/users/:id', requireAnyPermissions('users.edit', 'users.change_roles'), requireCsrf, async (req, res) => {
    const employee = (await db.query("SELECT *, to_char(joined_on, 'YYYY-MM-DD') AS joined_text FROM employees WHERE id = $1", [req.params.id])).rows[0];
    if (!employee) throw fail(404, 'EMPLOYEE_NOT_FOUND', 'This person no longer exists.');
    const name = text(req.body?.name, 100, { label: 'Name' }) || employee.name;
    const team = text(req.body?.team, 100, { label: 'Team' }) ?? employee.team;
    const role = req.body?.role ?? employee.role;
    if (!ROLES.includes(role)) throw fail(400, 'INVALID_ROLE', 'Choose a supported role.');
    if (req.body?.active !== undefined && typeof req.body.active !== 'boolean') throw fail(400, 'INVALID_STATUS', 'Choose an active or suspended status.');
    const active = req.body?.active ?? employee.active;
    const username = usernameOf(req.body?.username);
    const nextUsername = username === undefined ? employee.username : username;
    if (!employee.email && !nextUsername) throw fail(400, 'LOGIN_REQUIRED', 'This person has no work email, so they need a username to sign in.');
    const had = expandPermissions(employee.permissions);
    let permissions = req.body?.permissions !== undefined ? permissionList(req.body.permissions) : had;
    if (role === 'super_admin') permissions = [];
    if (role !== employee.role && req.body?.permissions === undefined) permissions = role === 'admin' ? ADMIN_DEFAULT_PERMISSIONS.filter((p) => req.user.role === 'super_admin' || req.user.permissions.includes(p)) : role === 'user' ? [] : permissions;
    const permissionsChanged = !sameSet(permissions, had);
    const isSuper = req.user.role === 'super_admin';
    if ((employee.role === 'super_admin' || role === 'super_admin') && !isSuper) throw superOnly();
    let customRoleId = employee.custom_role_id;
    let template = null;
    const roleChanging = req.body?.customRoleId !== undefined && (req.body.customRoleId || null) !== (employee.custom_role_id || null);
    if (roleChanging) {
      template = await roleTemplate(db, req.body.customRoleId);
      customRoleId = template?.id ?? null;
    }
    // Who may change what: names, teams, usernames and suspension are "edit"; roles and permissions are "change roles".
    const joinedOn = joinedDate(req.body?.joinedOn);
    const editing = name !== employee.name || team !== employee.team || active !== employee.active || nextUsername !== employee.username || (joinedOn !== undefined && joinedOn !== null && joinedOn !== employee.joined_text);
    const changingRoles = role !== employee.role || permissionsChanged || roleChanging;
    if (editing && !req.user.permissions.includes('users.edit')) throw fail(403, 'PERMISSION_REQUIRED', 'You need the “Edit people” permission for this.');
    if (changingRoles && !req.user.permissions.includes('users.change_roles')) throw fail(403, 'PERMISSION_REQUIRED', 'You need the “Change roles and permissions” permission for this.');
    if (employee.id === req.user.id) {
      if (active === false) throw fail(400, 'SELF_SUSPEND', 'You cannot suspend your own account.');
      if (!isSuper && changingRoles) throw superOnly();
    }
    assertGrantable(req.user, permissions.filter((permission) => !had.includes(permission)));
    if (template) assertGrantable(req.user, template.permissions);
    if (nextUsername && nextUsername !== employee.username && (await db.query('SELECT 1 FROM employees WHERE lower(username) = lower($1) AND id <> $2', [nextUsername, employee.id])).rows[0]) throw fail(409, 'USERNAME_IN_USE', 'Someone already has that username.');
    await db.tx(async (tx) => {
      if (employee.role === 'super_admin' && (role !== 'super_admin' || !active)) {
        const admins = (await tx.query("SELECT id FROM employees WHERE role = 'super_admin' AND active = TRUE FOR UPDATE")).rows;
        if (admins.filter((admin) => admin.id !== employee.id).length < 1) throw fail(409, 'LAST_SUPER_ADMIN', 'At least one active super admin must remain.');
      }
      await tx.query('UPDATE employees SET name=$2, team=$3, role=$4, permissions=$5, active=$6, custom_role_id=$7, joined_on=COALESCE($8::date, joined_on), username=$9 WHERE id=$1', [employee.id, name, team, role, permissionsChanged || role !== employee.role ? permissions : employee.permissions, active, customRoleId, joinedOn === undefined ? null : joinedOn, nextUsername]);
      if (!active || role !== employee.role) await tx.query('DELETE FROM sessions WHERE employee_id = $1', [employee.id]);
      await audit(tx, req.user.id, 'user.updated', employee.id, `${role}${active ? '' : ', suspended'}${permissionsChanged ? ', permissions changed' : ''}${roleChanging ? ', role template changed' : ''}`);
    });
    res.status(204).end();
  });

  app.post('/api/admin/users/:id/reset-password', requirePermission('users.reset_password'), requireCsrf, async (req, res) => {
    const employee = (await db.query('SELECT id, role FROM employees WHERE id = $1', [req.params.id])).rows[0];
    if (!employee) throw fail(404, 'EMPLOYEE_NOT_FOUND', 'This person no longer exists.');
    if (employee.role === 'super_admin' && req.user.role !== 'super_admin') throw superOnly();
    const password = generatePassword();
    await db.tx(async (tx) => {
      await tx.query('UPDATE employees SET password_hash = $2, must_change_password = TRUE WHERE id = $1', [employee.id, hashPassword(password)]);
      await tx.query('DELETE FROM sessions WHERE employee_id = $1', [employee.id]);
      await audit(tx, req.user.id, 'user.password-reset', employee.id);
    });
    res.json({ temporaryPassword: password });
  });

  // Spreadsheet-safe CSV: quotes values and defuses cells that a spreadsheet would run as a formula.
  const csvCell = (value) => {
    let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const sendCsv = (res, filename, header, rows) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
    res.send('\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
  };
  const rangeFilter = (query) => {
    const from = typeof query.from === 'string' && !Number.isNaN(Date.parse(query.from)) ? new Date(query.from) : null;
    const to = typeof query.to === 'string' && !Number.isNaN(Date.parse(query.to)) ? new Date(query.to) : null;
    return { from, to };
  };

  app.get('/api/admin/audit/export', requirePermission('users.audit'), async (req, res) => {
    const { from, to } = rangeFilter(req.query);
    const { rows } = await db.query(`
      SELECT a.created_at, e.name AS actor, e.email, a.action, a.detail, a.entity_id
      FROM audit_log a LEFT JOIN employees e ON e.id = a.actor_id
      WHERE ($1::timestamptz IS NULL OR a.created_at >= $1) AND ($2::timestamptz IS NULL OR a.created_at < $2)
      ORDER BY a.created_at DESC LIMIT 20000`, [from, to]);
    sendCsv(res, 'activity-log.csv', ['Time (UTC)', 'Who', 'Email', 'Action', 'Detail', 'Item id'], rows.map((r) => [r.created_at, r.actor ?? 'System', r.email ?? '', r.action, r.detail, r.entity_id ?? '']));
  });

  app.get('/api/admin/bookings/export', requirePermission('bookings.view_all'), async (req, res) => {
    const { from, to } = rangeFilter(req.query);
    const { rows } = await db.query(`
      SELECT b.starts_at, b.ends_at, b.status, r.label, r.type, e.name, e.email, e.team
      FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN employees e ON e.id = b.employee_id
      WHERE ($1::timestamptz IS NULL OR b.starts_at >= $1) AND ($2::timestamptz IS NULL OR b.starts_at < $2)
      ORDER BY b.starts_at DESC LIMIT 20000`, [from, to]);
    sendCsv(res, 'bookings.csv', ['Starts (UTC)', 'Ends (UTC)', 'Status', 'Space', 'Type', 'Person', 'Email', 'Team'], rows.map((r) => [r.starts_at, r.ends_at, r.status, r.label, r.type, r.name, r.email, r.team]));
  });

  app.get('/api/admin/audit', requirePermission('users.audit'), async (_req, res) => {
    const { rows } = await db.query(`
      SELECT a.id, a.action, a.entity_id, a.detail, a.created_at, e.name AS actor_name
      FROM audit_log a LEFT JOIN employees e ON e.id = a.actor_id ORDER BY a.created_at DESC LIMIT 100`);
    res.json({ entries: rows });
  });

  // ---------- Private floor plan ----------
  app.get('/api/floor-plan', requireAuth, async (req, res, next) => {
    const headers = { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="office-layout.pdf"', 'Cache-Control': 'private, no-store' };
    const stored = (await db.query("SELECT data FROM app_files WHERE key = 'floor-plan'")).rows[0];
    if (stored) {
      const buffer = Buffer.from(stored.data);
      res.set({ ...headers, 'Content-Length': buffer.length });
      return res.end(buffer);
    }
    const planPath = options.floorPlanPath ?? resolve(process.cwd(), 'local-data/floor-plan.pdf');
    if (!existsSync(planPath)) throw fail(404, 'FLOOR_PLAN_NOT_CONFIGURED', 'No floor plan has been uploaded yet.');
    res.set({ ...headers, 'Content-Length': statSync(planPath).size });
    const stream = createReadStream(planPath);
    stream.once('error', (error) => (res.headersSent ? res.destroy(error) : next(error)));
    return stream.pipe(res);
  });

  app.put('/api/admin/floor-plan', requirePermission('spaces.manage'), requireCsrf, express.raw({ type: 'application/pdf', limit: '25mb' }), async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 100 || body.subarray(0, 5).toString('latin1') !== '%PDF-') throw fail(400, 'INVALID_PDF', 'Upload a PDF file (up to 25 MB).');
    await db.tx(async (tx) => {
      await tx.query(
        `INSERT INTO app_files (key, content_type, data, updated_by) VALUES ('floor-plan', 'application/pdf', $1, $2)
         ON CONFLICT (key) DO UPDATE SET data = excluded.data, updated_at = now(), updated_by = excluded.updated_by`,
        [body, req.user.id],
      );
      await audit(tx, req.user.id, 'floor-plan.uploaded', null, `${Math.round(body.length / 1024)} KB`);
    });
    res.status(204).end();
  });

  app.post('/api/admin/inventory/import', requirePermission('spaces.manage'), requireCsrf, async (req, res) => {
    if (!req.user.permissions.includes('teams.manage')) throw fail(403, 'PERMISSION_REQUIRED', 'Importing seats also needs the team management permission.');
    const result = await db.tx(async (tx) => {
      const outcome = await importInventory(tx, req.body, { replace: req.body?.replace === true });
      await audit(tx, req.user.id, 'inventory.imported', null, JSON.stringify(outcome));
      return outcome;
    });
    res.json(result);
  });

  app.get('/api/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  });

  const features = registerFeatures({ app, db, requireAuth, requireSignedIn, requireCsrf, requirePermission, requireAnyPermissions, audit, fail, text, limit, isoDate, userView, sendCsv, options });
  readSettings = features.readSettings;

  // Everything the app needs right after sign-in, in one request. The ETag makes repeat calls a cheap 304.
  app.get('/api/bootstrap', requireAuth, async (req, res) => {
    const [config, teams, map, summary, unread] = await Promise.all([features.readConfig(), loadTeams(), loadMapInfo(), loadSummary(req.user), features.notifier.unreadCount(req.user.id)]);
    res.set('Cache-Control', 'private, no-cache');
    res.json({ configVersion: req.configVersion, user: req.user, config, ...teams, map, summary, unread });
  });

  app.use('/api', (_req, _res, next) => next(fail(404, 'NOT_FOUND', 'This API route does not exist.')));
  const buildDirectory = resolve(process.cwd(), 'dist');
  if (existsSync(buildDirectory)) {
    app.use(express.static(buildDirectory, { etag: true, maxAge: '1h', index: false }));
    app.get('/{*path}', (_req, res, next) => res.sendFile('index.html', { root: buildDirectory }, (error) => error && next(error)));
  }
  app.use((error, _req, res, _next) => {
    let { status = 500, code = 'INTERNAL_ERROR', message } = error;
    if (error.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'That request could not be read.'; }
    if (error.type === 'entity.too.large') { status = 413; code = 'TOO_LARGE'; message = 'That request is too large.'; }
    if (error.code === '23505') { status = 409; code = 'DUPLICATE'; message = 'That already exists.'; }
    if (error.code === '23503') { status = 409; code = 'IN_USE'; message = 'That is still in use by other records.'; }
    if (status >= 500) console.error('Request failed:', error.message);
    res.status(status).json({ error: { code, message: status >= 500 ? 'Something went wrong. Please try again.' : message } });
  });
  return app;
}
