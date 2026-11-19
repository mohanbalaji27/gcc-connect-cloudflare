import { timingSafeEqual } from 'node:crypto';
import { DAY_MS, OFFICE_TZ, addDays, dateKey, dayStart, daysBetween, hourInIndia, validDay, weekdayOf } from './office-time.js';

// Office hours used for "seat-time" utilisation (documented in the dashboard and in the README).
export const OFFICE_HOURS = { from: 9, to: 18 };
export const DEFAULT_USAGE_RETENTION_DAYS = 400;
export const USAGE_RETENTION_RANGE = [30, 1095];
const MAX_RANGE_DAYS = 400;
const MAX_BATCH_KEYS = 40;
const MAX_COUNT_PER_FEATURE = 500;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The only things that are ever counted: a screen (or a tab inside one) was opened. `flag` ties a feature to its on/off
// switch, `promote` says whether "nobody used this" is worth showing.
export const USAGE_FEATURES = {
  app_open: { label: 'App opened (session start)', promote: false },
  home: { label: 'Home', promote: false },
  booking: { label: 'Book a desk or room', promote: true },
  map: { label: 'Floor map', promote: true },
  my_bookings: { label: 'My bookings', promote: true },
  events: { label: 'Events', promote: true },
  scan: { label: 'Scan a QR code', promote: true },
  menu: { label: 'Food menu', flag: 'menu', promote: true },
  menu_reviews: { label: 'Menu reviews', flag: 'menu', promote: true },
  links: { label: 'Useful links', flag: 'links', promote: true },
  contacts: { label: 'Important contacts', flag: 'contacts', promote: true },
  announcements: { label: 'Announcements (seen on Home)', flag: 'announcements', promote: true },
  whosin: { label: 'Who is in (seen on Home)', flag: 'whosin', promote: true },
  kudos: { label: 'Kudos wall', flag: 'kudos', promote: true },
  polls: { label: 'Polls', flag: 'polls', promote: true },
  celebrations: { label: 'Celebrations', flag: 'celebrations', promote: true },
  ideas: { label: 'Idea box', flag: 'feedback', promote: true },
  issues: { label: 'Issue box', flag: 'issues', promote: true },
  notifications: { label: 'Notifications', promote: false },
  account: { label: 'Account and settings', promote: false },
  manage: { label: 'Manage', promote: false },
  more: { label: 'More menu', promote: false },
};
const hasFeature = (id) => Object.hasOwn(USAGE_FEATURES, id);

const sameSecret = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
const pct = (part, whole) => (whole > 0 ? Math.min(100, Math.round((part * 100) / whole)) : 0);

export function registerAnalytics({ app, db, requireAuth, requirePermission, fail, limit, readSettings, now = () => Date.now() }) {
  const clock = () => new Date(now());

  // ---------- Insights (bookings and community numbers) ----------
  // Every number counts one clearly stated thing; the dashboard shows the same definitions next to each figure.
  //  * "Last 30 days" = the 30 office days (IST) ending today, today included, so every window starts at midnight.
  //  * Booking volume counts every confirmed booking that STARTS in the window (even if the space was retired later).
  //  * Space measures (utilisation, coverage, per team, top spaces) only look at spaces that are active right now.
  //  * Cancellations are counted by the day they were cancelled, not the day they were booked.
  async function insights(settings) {
    const current = clock();
    const today = dateKey(current);
    const todayStart = dayStart(today);
    const todayEnd = new Date(todayStart.getTime() + DAY_MS);
    const from30 = dayStart(addDays(today, -29));
    const from60 = dayStart(addDays(today, -59));
    const trendFrom = dayStart(addDays(today, -13));
    const trendUntil = dayStart(addDays(today, 8));
    const openFrom = new Date(todayStart.getTime() + OFFICE_HOURS.from * 3_600_000);
    const openTo = new Date(todayStart.getTime() + OFFICE_HOURS.to * 3_600_000);
    const openMinutes = (OFFICE_HOURS.to - OFFICE_HOURS.from) * 60;
    const { features, options } = settings;

    const minutes = (type) => `(SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(b.ends_at, $4) - GREATEST(b.starts_at, $3))) / 60), 0)::float FROM bookings b JOIN resources r ON r.id = b.resource_id
      WHERE r.type = '${type}' AND r.active = TRUE AND b.status = 'confirmed' AND b.starts_at < $4 AND b.ends_at > $3)`;
    const seats = (type) => `(SELECT COUNT(DISTINCT b.resource_id)::int FROM bookings b JOIN resources r ON r.id = b.resource_id
      WHERE r.type = '${type}' AND r.active = TRUE AND b.status = 'confirmed' AND b.starts_at < $2 AND b.ends_at > $1)`;
    const windowCount = (type) => `(SELECT COUNT(*)::int FROM bookings b JOIN resources r ON r.id = b.resource_id
      WHERE r.type = '${type}' AND b.status = 'confirmed' AND b.starts_at >= $5 AND b.starts_at < $2)`;

    const [totals, perDay, byTeam, topSpaces, perWeekday] = await Promise.all([
      db.query(`
        SELECT now() AS read_at,
          (SELECT COUNT(*)::int FROM employees WHERE active = TRUE) AS people,
          (SELECT COUNT(*)::int FROM resources WHERE type = 'desk' AND active = TRUE) AS desks,
          (SELECT COUNT(*)::int FROM resources WHERE type = 'room' AND active = TRUE) AS rooms,
          ${seats('desk')} AS desks_today, ${seats('room')} AS rooms_today,
          ${minutes('desk')} AS desk_minutes, ${minutes('room')} AS room_minutes,
          (SELECT COUNT(DISTINCT b.employee_id)::int FROM bookings b JOIN employees e ON e.id = b.employee_id
            WHERE e.active = TRUE AND b.status = 'confirmed' AND b.starts_at >= $5 AND b.starts_at < $2) AS active_bookers,
          ${windowCount('desk')} AS desk_bookings, ${windowCount('room')} AS room_bookings,
          (SELECT COUNT(*)::int FROM bookings WHERE status = 'cancelled' AND COALESCE(cancelled_at, created_at) >= $5 AND COALESCE(cancelled_at, created_at) < $2) AS cancelled,
          (SELECT COUNT(DISTINCT b.resource_id)::int FROM bookings b JOIN resources r ON r.id = b.resource_id
            WHERE r.type = 'desk' AND r.active = TRUE AND b.status = 'confirmed' AND b.starts_at >= $5 AND b.starts_at < $2) AS desks_used,
          (SELECT COUNT(*)::int FROM kudos WHERE created_at >= $5 AND created_at < $2) AS kudos,
          (SELECT COUNT(*)::int FROM poll_votes WHERE voted_at >= $5 AND voted_at < $2) AS votes,
          (SELECT COUNT(*)::int FROM feedback WHERE status = 'new') AS feedback_new,
          (SELECT COUNT(*)::int FROM events WHERE ends_at >= $6) AS events_upcoming,
          (SELECT COUNT(*)::int FROM event_rsvps r JOIN events e ON e.id = r.event_id JOIN employees p ON p.id = r.employee_id WHERE p.active = TRUE AND e.ends_at >= $6) AS rsvps_upcoming`,
      [todayStart, todayEnd, openFrom, openTo, from30, current]),
      db.query(`
        SELECT to_char(b.starts_at AT TIME ZONE '${OFFICE_TZ}', 'YYYY-MM-DD') AS day, r.type, COUNT(*)::int AS n, now() AS read_at
        FROM bookings b JOIN resources r ON r.id = b.resource_id WHERE b.status = 'confirmed' AND b.starts_at >= $1 AND b.starts_at < $2 GROUP BY 1, 2`, [trendFrom, trendUntil]),
      db.query(`
        SELECT COALESCE(t.name, 'Unassigned') AS name, COALESCE(t.color, '#8f9a94') AS color, COUNT(DISTINCT r.id)::int AS seats, COUNT(b.id)::int AS bookings, now() AS read_at
        FROM resources r LEFT JOIN teams t ON t.id = r.team_id
        LEFT JOIN bookings b ON b.resource_id = r.id AND b.status = 'confirmed' AND b.starts_at >= $1 AND b.starts_at < $2
        WHERE r.type = 'desk' AND r.active = TRUE GROUP BY t.id, t.name, t.color ORDER BY bookings DESC, name LIMIT 20`, [from30, todayEnd]),
      db.query(`
        SELECT r.label, r.type, COUNT(*)::int AS n, now() AS read_at FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE r.active = TRUE AND b.status = 'confirmed' AND b.starts_at >= $1 AND b.starts_at < $2 GROUP BY r.id, r.label, r.type ORDER BY n DESC, r.label LIMIT 8`, [from30, todayEnd]),
      db.query(`
        SELECT EXTRACT(DOW FROM b.starts_at AT TIME ZONE '${OFFICE_TZ}')::int AS dow, r.type, COUNT(*)::int AS n, now() AS read_at
        FROM bookings b JOIN resources r ON r.id = b.resource_id WHERE b.status = 'confirmed' AND b.starts_at >= $1 AND b.starts_at < $2 GROUP BY 1, 2`, [from60, todayEnd]),
    ]);
    const t = totals.rows[0];

    const trend = [];
    for (let i = -13; i <= 7; i += 1) {
      const day = addDays(today, i);
      trend.push({ date: day, desks: perDay.rows.find((r) => r.day === day && r.type === 'desk')?.n ?? 0, rooms: perDay.rows.find((r) => r.day === day && r.type === 'room')?.n ?? 0, future: i > 0 });
    }
    // Each weekday appears 8 or 9 times in 60 days, so the chart shows the average per day, not the raw total.
    const occurrences = Array(7).fill(0);
    for (let i = 0; i < 60; i += 1) occurrences[weekdayOf(addDays(today, -i))] += 1;
    const weekdays = WEEKDAYS.map((name, index) => {
      const desks = perWeekday.rows.find((r) => r.dow === index && r.type === 'desk')?.n ?? 0;
      const rooms = perWeekday.rows.find((r) => r.dow === index && r.type === 'room')?.n ?? 0;
      return { name, days: occurrences[index], desks, rooms, avgDesks: occurrences[index] ? Math.round((desks / occurrences[index]) * 10) / 10 : 0 };
    });

    return {
      today,
      officeHours: OFFICE_HOURS,
      totals: {
        people: t.people, desks: t.desks, rooms: t.rooms, desksToday: t.desks_today, roomsToday: t.rooms_today,
        deskUtilisationToday: pct(t.desk_minutes, t.desks * openMinutes), roomUtilisationToday: pct(t.room_minutes, t.rooms * openMinutes),
        deskCoverage30d: pct(t.desks_used, t.desks),
        activeBookers30d: t.active_bookers, bookings30d: t.desk_bookings + t.room_bookings, deskBookings30d: t.desk_bookings, roomBookings30d: t.room_bookings, cancelled30d: t.cancelled,
        kudos30d: features.kudos ? t.kudos : null, votes30d: features.polls ? t.votes : null, feedbackNew: features.feedback ? t.feedback_new : null,
        eventsUpcoming: t.events_upcoming, rsvpsUpcoming: options.eventsRsvpEnabled === false ? null : t.rsvps_upcoming,
      },
      trend,
      byTeam: byTeam.rows.map(({ name, color, seats: count, bookings }) => ({ name, color, seats: count, bookings })),
      topSpaces: topSpaces.rows.map(({ label, type, n }) => ({ label, type, n })),
      weekdays,
    };
  }

  app.get('/api/admin/insights', requirePermission('insights.view'), async (_req, res) => {
    const body = await insights(await readSettings());
    // The ETag (added by Express from the body) changes whenever a number changes, so a revalidation is a cheap 304.
    res.set('Cache-Control', 'private, no-cache');
    res.json(body);
  });

  // ---------- Usage: collecting ----------
  const cleanEvents = (raw) => {
    if (raw === undefined || raw === null) return { features: [], counts: [] };
    if (typeof raw !== 'object' || Array.isArray(raw)) throw fail(400, 'INVALID_USAGE', 'Usage counts could not be read.');
    const entries = Object.entries(raw);
    if (entries.length > MAX_BATCH_KEYS) throw fail(400, 'BATCH_TOO_LARGE', 'That is too many usage counts for one request.');
    const featuresList = [];
    const counts = [];
    for (const [id, value] of entries) {
      // Unknown features and unreadable counts are dropped, never stored.
      if (!hasFeature(id) || !Number.isInteger(value) || value < 1) continue;
      featuresList.push(id);
      counts.push(Math.min(value, MAX_COUNT_PER_FEATURE));
    }
    return { features: featuresList, counts };
  };

  let cleanupMark = '';
  // Old usage rows are removed at most once a day per server (and again when the retention is changed); the guard row makes
  // sure only one server instance does the work.
  async function maybeCleanup(settings) {
    const days = settings.usageRetentionDays;
    const today = dateKey(clock());
    const mark = `${today}:${days}`;
    if (cleanupMark === mark) return false;
    cleanupMark = mark;
    try {
      const claimed = await db.query(
        `INSERT INTO app_settings (key, value) VALUES ('usage_cleanup', to_jsonb($1::text))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE app_settings.value IS DISTINCT FROM excluded.value RETURNING key`, [mark]);
      if (!claimed.rows.length) return false;
      const cutoff = addDays(today, -days);
      await db.tx(async (tx) => {
        await tx.query('DELETE FROM usage_daily WHERE day < $1::date', [cutoff]);
        await tx.query('DELETE FROM usage_hourly WHERE day < $1::date', [cutoff]);
        await tx.query('DELETE FROM login_events WHERE at < $1', [dayStart(cutoff)]);
      });
      return true;
    } catch (error) {
      cleanupMark = '';
      console.error('Usage cleanup failed:', error.message);
      return false;
    }
  }

  // Stores one batch of "screen opened" counts for the signed-in person. Pre-aggregated: one row per person, feature and day.
  async function ingest(req, events) {
    const { features: ids, counts } = cleanEvents(events);
    if (!ids.length) return { accepted: 0 };
    if (!limit(`usage:${req.user.id}`, 20, 60_000)) throw fail(429, 'RATE_LIMITED', 'Slow down a little.');
    const settings = await readSettings();
    if (settings.options.usageAnalytics === false) return { accepted: 0, enabled: false };
    const when = clock();
    await db.query(
      `WITH d AS (
         INSERT INTO usage_daily (day, feature, employee_id, count)
         SELECT $1::date, t.f, $2, t.c FROM unnest($3::text[], $4::int[]) AS t(f, c)
         ON CONFLICT (day, feature, employee_id) DO UPDATE SET count = LEAST(usage_daily.count + excluded.count, 1000000)
         RETURNING 1)
       INSERT INTO usage_hourly (day, hour, count) VALUES ($1::date, $5::int, $6::int)
       ON CONFLICT (day, hour) DO UPDATE SET count = LEAST(usage_hourly.count + excluded.count, 100000000)`,
      [dateKey(when), req.user.id, ids, counts, hourInIndia(when), counts.reduce((a, b) => a + b, 0)]);
    await maybeCleanup(settings);
    return { accepted: ids.length };
  }

  // sendBeacon cannot set headers, so this one endpoint also accepts the CSRF token inside the body.
  const requireUsageCsrf = (req, _res, next) => {
    const supplied = req.get('X-CSRF-Token') ?? (typeof req.body?.csrf === 'string' ? req.body.csrf : '');
    return supplied && req.csrfToken && sameSecret(supplied, req.csrfToken) ? next() : next(fail(403, 'CSRF_INVALID', 'Your session needs a refresh. Reload the page and try again.'));
  };
  app.post('/api/usage', requireAuth, requireUsageCsrf, async (req, res) => {
    res.json(await ingest(req, req.body?.events));
  });

  async function recordLogin(employeeId, method = 'password') {
    try {
      await db.query('INSERT INTO login_events (employee_id, method) VALUES ($1, $2)', [employeeId, method]);
      await maybeCleanup(await readSettings());
    } catch (error) {
      console.error('Recording a sign-in failed:', error.message);
    }
  }

  // ---------- Usage: reading ----------
  async function usageSummary(settings, query) {
    const today = dateKey(clock());
    const to = query.to === undefined || query.to === '' ? today : query.to;
    if (!validDay(to) || to > today) throw fail(400, 'INVALID_RANGE', 'Choose an end date that is today or earlier.');
    // "days=30" (the presets) counts back from the end date; explicit from/to is the custom range.
    const span = query.days === undefined || query.days === '' ? 30 : Number(query.days);
    if (!Number.isInteger(span) || span < 1 || span > MAX_RANGE_DAYS) throw fail(400, 'INVALID_RANGE', `Choose between 1 and ${MAX_RANGE_DAYS} days.`);
    const from = query.from === undefined || query.from === '' ? addDays(to, -(span - 1)) : query.from;
    if (!validDay(from) || from > to) throw fail(400, 'INVALID_RANGE', 'Choose a start date that is on or before the end date.');
    const days = daysBetween(from, to) + 1;
    if (days > MAX_RANGE_DAYS) throw fail(400, 'INVALID_RANGE', `Choose at most ${MAX_RANGE_DAYS} days.`);
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(from, -days);
    const [rangeStart, rangeEnd] = [dayStart(from), dayStart(addDays(to, 1))];
    const [prevStart] = [dayStart(prevFrom)];
    const monthFrom = addDays(to, -29);
    const weekFrom = addDays(to, -6);

    const active = `SELECT day, employee_id FROM usage_daily WHERE day BETWEEN $1::date AND $2::date
      UNION SELECT (at AT TIME ZONE '${OFFICE_TZ}')::date, employee_id FROM login_events WHERE at >= $3 AND at < $4`;
    const [logins, dailyActive, cohort, reach, featureRows, hourRows, newcomers, teamRows, since] = await Promise.all([
      db.query(`SELECT to_char(at AT TIME ZONE '${OFFICE_TZ}', 'YYYY-MM-DD') AS day, COUNT(*)::int AS logins, COUNT(DISTINCT employee_id)::int AS people, now() AS read_at
        FROM login_events WHERE at >= $1 AND at < $2 GROUP BY 1`, [rangeStart, rangeEnd]),
      db.query(`WITH act AS (${active}) SELECT to_char(day, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n, now() AS read_at FROM act GROUP BY day`, [from, to, rangeStart, rangeEnd]),
      db.query(`WITH act AS (${active})
        SELECT COUNT(*) FILTER (WHERE in_cur)::int AS cur, COUNT(*) FILTER (WHERE in_prev)::int AS prev, COUNT(*) FILTER (WHERE in_cur AND in_prev)::int AS retained, now() AS read_at
        FROM (SELECT employee_id, bool_or(day >= $5::date) AS in_cur, bool_or(day <= $6::date) AS in_prev FROM act GROUP BY employee_id) t`,
      [prevFrom, to, prevStart, rangeEnd, from, prevTo]),
      db.query(`WITH act AS (${active})
        SELECT COUNT(DISTINCT employee_id) FILTER (WHERE day = $5::date)::int AS dau, COUNT(DISTINCT employee_id) FILTER (WHERE day >= $6::date)::int AS wau,
               COUNT(DISTINCT employee_id)::int AS mau, COUNT(*)::int AS active_days, now() AS read_at FROM act`,
      [monthFrom, to, dayStart(monthFrom), rangeEnd, to, weekFrom]),
      db.query(`SELECT feature,
          COALESCE(SUM(count) FILTER (WHERE day >= $1::date), 0)::int AS opens, COUNT(DISTINCT employee_id) FILTER (WHERE day >= $1::date)::int AS users,
          COALESCE(SUM(count) FILTER (WHERE day <= $3::date), 0)::int AS prev_opens, COUNT(DISTINCT employee_id) FILTER (WHERE day <= $3::date)::int AS prev_users, now() AS read_at
        FROM usage_daily WHERE day BETWEEN $4::date AND $2::date GROUP BY feature`, [from, to, prevTo, prevFrom]),
      db.query('SELECT hour::int AS hour, SUM(count)::int AS n, now() AS read_at FROM usage_hourly WHERE day BETWEEN $1::date AND $2::date GROUP BY hour', [from, to]),
      db.query(`SELECT COUNT(*) FILTER (WHERE first_at >= $1)::int AS fresh, COUNT(*) FILTER (WHERE first_at < $1)::int AS returning, now() AS read_at
        FROM (SELECT employee_id, MIN(at) AS first_at FROM login_events GROUP BY employee_id HAVING bool_or(at >= $1 AND at < $2)) t`, [rangeStart, rangeEnd]),
      db.query(`SELECT COALESCE(NULLIF(e.team, ''), 'No team') AS team, COUNT(*)::int AS people, COUNT(a.employee_id)::int AS active, now() AS read_at
        FROM employees e LEFT JOIN (SELECT DISTINCT employee_id FROM (${active}) x) a ON a.employee_id = e.id
        WHERE e.active = TRUE GROUP BY 1 ORDER BY 1 LIMIT 60`, [from, to, rangeStart, rangeEnd]),
      db.query(`SELECT (SELECT to_char(MIN(day), 'YYYY-MM-DD') FROM usage_daily) AS features_since, (SELECT to_char(MIN(at) AT TIME ZONE '${OFFICE_TZ}', 'YYYY-MM-DD') FROM login_events) AS logins_since, now() AS read_at`),
    ]);

    const loginByDay = new Map(logins.rows.map((r) => [r.day, r]));
    const activeByDay = new Map(dailyActive.rows.map((r) => [r.day, r.n]));
    const series = [];
    for (let i = 0; i < days; i += 1) {
      const day = addDays(from, i);
      series.push({ date: day, logins: loginByDay.get(day)?.logins ?? 0, loginPeople: loginByDay.get(day)?.people ?? 0, active: activeByDay.get(day) ?? 0 });
    }
    const sum = (key) => series.reduce((total, row) => total + row[key], 0);

    const byFeature = new Map(featureRows.rows.map((r) => [r.feature, r]));
    const collecting = settings.options.usageAnalytics !== false;
    const featuresOut = Object.entries(USAGE_FEATURES).filter(([id]) => id !== 'app_open').map(([id, info]) => {
      const row = byFeature.get(id);
      return { id, label: info.label, opens: row?.opens ?? 0, users: row?.users ?? 0, prevOpens: row?.prev_opens ?? 0, prevUsers: row?.prev_users ?? 0 };
    }).sort((a, b) => b.users - a.users || b.opens - a.opens || a.label.localeCompare(b.label));
    // "Try promoting these": features that are switched on, available to everyone, and had no users in the period.
    const unused = collecting ? Object.entries(USAGE_FEATURES)
      .filter(([id, info]) => info.promote && (!info.flag || settings.features[info.flag] !== false) && (byFeature.get(id)?.users ?? 0) === 0)
      .map(([id, info]) => ({ id, label: info.label })) : [];

    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, n: hourRows.rows.find((r) => r.hour === hour)?.n ?? 0 }));
    // Teams with fewer than three people would point at individuals, so they are merged into one row.
    const teams = []; let small = { team: 'Smaller teams', people: 0, active: 0 };
    for (const row of teamRows.rows) {
      if (row.people >= 3) teams.push({ team: row.team, people: row.people, active: row.active });
      else small = { ...small, people: small.people + row.people, active: small.active + row.active };
    }
    if (small.people > 0) teams.push(small);
    teams.sort((a, b) => pct(b.active, b.people) - pct(a.active, a.people) || b.people - a.people);

    const c = cohort.rows[0];
    const r = reach.rows[0];
    const n = newcomers.rows[0];
    return {
      from, to, days, previous: { from: prevFrom, to: prevTo }, collecting, retentionDays: settings.usageRetentionDays,
      since: { features: since.rows[0].features_since, logins: since.rows[0].logins_since },
      series,
      totals: { logins: sum('logins'), activePeople: c.cur, avgDailyActive: Math.round((sum('active') / days) * 10) / 10, people: teamRows.rows.reduce((total, row) => total + row.people, 0) },
      reach: { dau: r.dau, wau: r.wau, mau: r.mau, stickiness: pct(r.active_days, 30 * r.mau) },
      cohort: { current: c.cur, previous: c.prev, retained: c.retained, retention: pct(c.retained, c.prev), newPeople: n.fresh, returningPeople: n.returning },
      features: featuresOut, unused, hours, teams,
    };
  }

  app.get('/api/admin/usage', requirePermission('insights.view'), async (req, res) => {
    if (!limit(`usage-read:${req.user.id}`, 60, 60_000)) throw fail(429, 'RATE_LIMITED', 'Slow down a little.');
    const settings = await readSettings();
    const body = await usageSummary(settings, req.query);
    await maybeCleanup(settings);
    // Usage changes slowly: a minute of browser caching, then a cheap 304 when nothing changed.
    res.set('Cache-Control', 'private, max-age=60');
    res.json(body);
  });

  return { ingest, recordLogin, maybeCleanup, insights, usageSummary };
}
