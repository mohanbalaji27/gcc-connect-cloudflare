import { randomUUID } from 'node:crypto';
import { COMMENT_MAX, COURSES, DIETS, MAX_COPY_DATES, MAX_DAY_ITEMS, MAX_TEMPLATES, MEALS, NAME_MAX, NOTE_MAX } from './menu-catalog.js';

const UPCOMING_DAYS = 7; // how far ahead the default window reaches
const FUTURE_EDIT_DAYS = 180;
const MEAL_RANK = `CASE m.meal ${MEALS.map((meal, index) => `WHEN '${meal}' THEN ${index + 1}`).join(' ')} ELSE 99 END`;
const COURSE_RANK = `CASE m.course ${COURSES.map((course, index) => `WHEN '${course}' THEN ${index + 1}`).join(' ')} ELSE 99 END`;
const ITEM_FIELDS = `m.id, to_char(m.menu_date, 'YYYY-MM-DD') AS date, m.meal, m.course, m.name, m.description, m.diet, m.emoji, m.special`;
const ORDER = `ORDER BY m.menu_date, ${MEAL_RANK}, ${COURSE_RANK}, m.sort_order, m.name, m.id`;
const CONTROL = /[\u0000-\u001f\u007f]/;
const itemKey = (meal, name) => `${meal}|${name.normalize('NFKC').toLowerCase()}`;
const average = (value) => (value === null || value === undefined ? null : Number(value));

// Everything about the food menu: reading it, the whole-day bulk editor, copies and templates, reviews and retention.
export function registerMenu({ app, db, requireAuth, requireCsrf, requirePermission, requireAnyPermissions, audit, fail, text, limit, feature, readSettings, id8, validDate, dateKey, addDays }) {
  const canSeeReviews = (user) => user.permissions.includes('menu.manage') || user.permissions.includes('menu.reviews.view');
  const settingsOf = async (req) => req.appSettings ?? readSettings();

  // ---------- Retention: at most one cheap cleanup per day, started by whoever touches the menu first ----------
  let cleanupMark = '';
  async function maybeCleanup(settings) {
    const days = settings.menuHistoryDays;
    const mark = `${dateKey(new Date())}:${days}`;
    if (cleanupMark === mark) return false;
    cleanupMark = mark;
    try {
      // The guard row makes sure only one server instance does the work per day (and again if the retention is changed).
      const claimed = await db.query(
        `INSERT INTO app_settings (key, value) VALUES ('menu_cleanup', to_jsonb($1::text))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE app_settings.value IS DISTINCT FROM excluded.value RETURNING key`, [mark]);
      if (!claimed.rows.length) return false;
      const cutoff = addDays(dateKey(new Date()), -days);
      await db.tx(async (tx) => {
        await tx.query('DELETE FROM menu_reviews WHERE menu_date < $1::date', [cutoff]);
        await tx.query('DELETE FROM menu_items WHERE menu_date < $1::date', [cutoff]);
      });
      return true;
    } catch (error) {
      cleanupMark = '';
      console.error('Menu cleanup failed:', error.message);
      return false;
    }
  }

  // ---------- Validation ----------
  const clean = (value, max, label, required = false) => {
    const collapsed = typeof value === 'string' ? value.replace(/\s+/g, ' ') : value;
    const result = text(collapsed, max, { required, label });
    if (result && CONTROL.test(result)) throw fail(400, 'INVALID_INPUT', `${label} has characters that are not allowed.`);
    return result;
  };
  function cleanItems(raw) {
    if (!Array.isArray(raw)) throw fail(400, 'INVALID_MENU', 'Send the dishes as a list.');
    if (raw.length > MAX_DAY_ITEMS) throw fail(400, 'TOO_MANY_DISHES', `One day can have up to ${MAX_DAY_ITEMS} dishes.`);
    const seen = new Set();
    const items = [];
    let duplicates = 0;
    raw.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail(400, 'INVALID_MENU', `Dish ${index + 1} could not be read.`);
      const label = `Dish ${index + 1}`;
      if (!MEALS.includes(entry.meal)) throw fail(400, 'INVALID_MEAL', `${label}: choose breakfast, lunch, snacks or dinner.`);
      const course = entry.course ?? 'mains';
      if (!COURSES.includes(course)) throw fail(400, 'INVALID_COURSE', `${label}: choose one of ${COURSES.join(', ')}.`);
      const diet = entry.diet ?? 'veg';
      if (!DIETS.includes(diet)) throw fail(400, 'INVALID_DIET', `${label}: choose veg, non-veg, egg or vegan.`);
      const name = clean(entry.name, NAME_MAX, `${label} name`, true);
      const key = itemKey(entry.meal, name);
      if (seen.has(key)) { duplicates += 1; return; }
      seen.add(key);
      items.push({
        id: typeof entry.id === 'string' && entry.id.length <= 60 ? entry.id : null,
        meal: entry.meal, course, name, diet,
        description: clean(entry.description, NOTE_MAX, `${label} note`) ?? '',
        emoji: clean(entry.emoji, 8, `${label} emoji`) ?? '',
        special: entry.special === true,
      });
    });
    return { items, duplicates };
  }

  const dayRange = async (settings) => {
    const today = dateKey(new Date());
    return { today, min: addDays(today, -settings.menuHistoryDays), max: addDays(today, FUTURE_EDIT_DAYS) };
  };
  function cleanDates(value, range, single = false) {
    const dates = Array.isArray(value) ? value : [value];
    if (!dates.length || dates.length > (single ? 1 : MAX_COPY_DATES) || dates.some((date) => !validDate(date))) {
      throw fail(400, 'INVALID_DATE', single ? 'Choose a valid date.' : `Choose between 1 and ${MAX_COPY_DATES} valid dates.`);
    }
    const unique = [...new Set(dates)];
    if (unique.some((date) => date < range.min || date > range.max)) throw fail(400, 'DATE_OUT_OF_RANGE', 'That date is outside the days the menu keeps (see Settings for how many past days are kept).');
    return unique;
  }

  // ---------- The whole-day write ----------
  const readDay = async (client, date) => (await client.query(
    `SELECT ${ITEM_FIELDS}, m.sort_order, now() AS read_at FROM menu_items m WHERE m.menu_date = $1::date ${ORDER}`, [date])).rows;
  const shape = (row) => ({ id: row.id, date: row.date, meal: row.meal, course: row.course, name: row.name, description: row.description, diet: row.diet, emoji: row.emoji, special: row.special });

  // Replaces one day's dishes in a single transaction. Dishes that stay keep their ids, so likes and dish ratings survive:
  // a dish is "the same" when its id was sent back, or (for pasted text) when meal and name match an existing dish.
  async function replaceDay(tx, date, items) {
    await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [727311, Number(date.replaceAll('-', ''))]);
    const existing = await readDay(tx, date);
    const byId = new Map(existing.map((row) => [row.id, row]));
    const claimed = new Set();
    const plan = items.map((item, order) => ({ ...item, order, match: null }));
    for (const entry of plan) {
      if (entry.id && byId.has(entry.id) && !claimed.has(entry.id)) { claimed.add(entry.id); entry.match = byId.get(entry.id); }
    }
    const free = new Map();
    for (const row of existing) if (!claimed.has(row.id)) free.set(itemKey(row.meal, row.name), [...(free.get(itemKey(row.meal, row.name)) ?? []), row]);
    for (const entry of plan) {
      if (entry.match) continue;
      const hit = free.get(itemKey(entry.meal, entry.name))?.find((row) => !claimed.has(row.id));
      if (hit) { claimed.add(hit.id); entry.match = hit; }
    }
    const removed = existing.filter((row) => !claimed.has(row.id));
    const added = plan.filter((entry) => !entry.match);
    const updated = plan.filter((entry) => entry.match && (
      entry.match.meal !== entry.meal || entry.match.course !== entry.course || entry.match.name !== entry.name || entry.match.description !== entry.description
      || entry.match.diet !== entry.diet || entry.match.emoji !== entry.emoji || entry.match.special !== entry.special || entry.match.sort_order !== entry.order));
    const record = (entry, id) => ({ id, meal: entry.meal, course: entry.course, name: entry.name, description: entry.description, diet: entry.diet, emoji: entry.emoji, special: entry.special, sort_order: entry.order });
    const columns = 'id text, meal text, course text, name text, description text, diet text, emoji text, special boolean, sort_order int';
    if (removed.length) await tx.query('DELETE FROM menu_items WHERE id = ANY($1::text[])', [removed.map((row) => row.id)]);
    if (updated.length) {
      await tx.query(
        `UPDATE menu_items m SET meal = v.meal, course = v.course, name = v.name, description = v.description, diet = v.diet, emoji = v.emoji,
                special = v.special, sort_order = v.sort_order, updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS v(${columns}) WHERE m.id = v.id`, [JSON.stringify(updated.map((entry) => record(entry, entry.match.id)))]);
      const moved = updated.filter((entry) => entry.match.meal !== entry.meal);
      if (moved.length) {
        await tx.query('UPDATE menu_reviews r SET meal = v.meal FROM jsonb_to_recordset($1::jsonb) AS v(id text, meal text) WHERE r.item_id = v.id', [JSON.stringify(moved.map((entry) => ({ id: entry.match.id, meal: entry.meal })))]);
      }
    }
    for (const entry of added) entry.newId = id8('dish');
    if (added.length) {
      await tx.query(
        `INSERT INTO menu_items (id, menu_date, meal, course, name, description, diet, emoji, special, sort_order)
         SELECT v.id, $2::date, v.meal, v.course, v.name, v.description, v.diet, v.emoji, v.special, v.sort_order
         FROM jsonb_to_recordset($1::jsonb) AS v(${columns})`, [JSON.stringify(added.map((entry) => record(entry, entry.newId))), date]);
    }
    return {
      items: plan.map((entry) => ({ id: entry.match?.id ?? entry.newId, date, meal: entry.meal, course: entry.course, name: entry.name, description: entry.description, diet: entry.diet, emoji: entry.emoji, special: entry.special })),
      previous: existing.map(shape),
      counts: { added: added.length, updated: updated.length, removed: removed.length },
    };
  }

  // Puts the same dishes on several days (replace, or append the ones that are not there yet).
  async function applyToDates(tx, dates, items, replace) {
    let touched = 0;
    for (const date of dates) {
      let list = items;
      if (!replace) {
        const current = await readDay(tx, date);
        const have = new Set(current.map((row) => itemKey(row.meal, row.name)));
        list = [...current.map(shape), ...items.filter((item) => !have.has(itemKey(item.meal, item.name))).map((item) => ({ ...item, id: null }))].slice(0, MAX_DAY_ITEMS);
      }
      await replaceDay(tx, date, list.map((item) => ({ ...item, id: replace ? null : item.id })));
      touched += 1;
    }
    return touched;
  }

  // ---------- Reading the menu (one call covers history, today and what is coming) ----------
  app.get('/api/menu', requireAuth, feature('menu'), async (req, res) => {
    const settings = await settingsOf(req);
    await maybeCleanup(settings);
    const { menuHistoryDays: history, menuReviewsVisibility: visibility } = settings;
    const today = dateKey(new Date());
    const from = validDate(req.query.from) ? req.query.from : addDays(today, -history);
    const days = Math.min(45, Math.max(1, Number(req.query.days) || history + 1 + UPCOMING_DAYS));
    const to = addDays(from, days - 1);
    const privileged = canSeeReviews(req.user);
    const showRatings = privileged || visibility !== 'managers';
    const [items, ratings, mine] = await Promise.all([
      db.query(`
        SELECT ${ITEM_FIELDS}, now() AS read_at,
               (SELECT COUNT(*)::int FROM menu_reactions r WHERE r.item_id = m.id) AS likes,
               EXISTS (SELECT 1 FROM menu_reactions r WHERE r.item_id = m.id AND r.employee_id = $3) AS liked
        FROM menu_items m WHERE m.menu_date BETWEEN $1::date AND $2::date ${ORDER} LIMIT 2000`, [from, to, req.user.id]),
      showRatings ? db.query(`
        SELECT to_char(menu_date, 'YYYY-MM-DD') AS date, meal, item_id, COUNT(*)::int AS n, ROUND(AVG(rating)::numeric, 1)::float8 AS avg, now() AS read_at
        FROM menu_reviews WHERE menu_date BETWEEN $1::date AND $2::date GROUP BY menu_date, meal, item_id`, [from, to]) : { rows: [] },
      db.query(`
        SELECT to_char(menu_date, 'YYYY-MM-DD') AS date, meal, item_id, rating, comment, anonymous, now() AS read_at
        FROM menu_reviews WHERE employee_id = $3 AND menu_date BETWEEN $1::date AND $2::date`, [from, to, req.user.id]),
    ]);
    const body = { from, to, today, historyDays: history, visibility, canSeeReviews: privileged, ratings: {}, dishRatings: {}, mine: { meals: {}, dishes: {} } };
    body.items = items.rows.map(({ read_at: _read, ...row }) => ({ ...row, liked: Boolean(row.liked) }));
    for (const row of ratings.rows) {
      if (row.item_id) body.dishRatings[row.item_id] = { avg: average(row.avg), count: row.n };
      else body.ratings[`${row.date}|${row.meal}`] = { avg: average(row.avg), count: row.n };
    }
    for (const row of mine.rows) {
      if (row.item_id) body.mine.dishes[row.item_id] = row.rating;
      else body.mine.meals[`${row.date}|${row.meal}`] = { rating: row.rating, comment: row.comment, anonymous: row.anonymous };
    }
    res.set('Cache-Control', 'private, no-cache');
    res.json(body);
  });

  app.post('/api/menu/:id/like', requireAuth, feature('menu'), requireCsrf, async (req, res) => {
    const item = (await db.query('SELECT id, now() AS read_at FROM menu_items WHERE id = $1', [req.params.id])).rows[0];
    if (!item) throw fail(404, 'NOT_FOUND', 'That dish is no longer on the menu.');
    const removed = await db.query('DELETE FROM menu_reactions WHERE item_id = $1 AND employee_id = $2 RETURNING item_id', [item.id, req.user.id]);
    if (!removed.rows.length) await db.query('INSERT INTO menu_reactions (item_id, employee_id) VALUES ($1,$2)', [item.id, req.user.id]);
    res.json({ liked: !removed.rows.length });
  });

  // ---------- Reviews ----------
  // The rules (server side, never only hidden in the screen):
  //   everyone: everyone reads ratings and comments, with names unless the author posted anonymously
  //   summary:  everyone sees the average and count; comments only for managers (and each person's own review)
  //   managers: only managers see ratings and comments; people see just their own review
  // Managers are people with menu.manage or menu.reviews.view. An anonymous review never exposes its author to anyone.
  async function mealState(client, user, date, meal, showRatings) {
    const [ratings, mine] = await Promise.all([
      showRatings ? client.query(`
        SELECT item_id, COUNT(*)::int AS n, ROUND(AVG(rating)::numeric, 1)::float8 AS avg, now() AS read_at
        FROM menu_reviews WHERE menu_date = $1::date AND meal = $2 GROUP BY item_id`, [date, meal]) : { rows: [] },
      client.query(`
        SELECT item_id, rating, comment, anonymous, now() AS read_at FROM menu_reviews WHERE employee_id = $3 AND menu_date = $1::date AND meal = $2`, [date, meal, user.id]),
    ]);
    const state = { key: `${date}|${meal}`, rating: null, dishRatings: {}, mine: { meal: null, dishes: {} } };
    for (const row of ratings.rows) {
      if (row.item_id) state.dishRatings[row.item_id] = { avg: average(row.avg), count: row.n };
      else state.rating = { avg: average(row.avg), count: row.n };
    }
    for (const row of mine.rows) {
      if (row.item_id) state.mine.dishes[row.item_id] = row.rating;
      else state.mine.meal = { rating: row.rating, comment: row.comment, anonymous: row.anonymous };
    }
    return state;
  }
  const rating = (value, label, min = 1) => {
    if (!Number.isInteger(value) || value < min || value > 5) throw fail(400, 'INVALID_RATING', `${label} must be a whole number of stars from ${min} to 5.`);
    return value;
  };
  async function reviewTarget(req, settings, source) {
    const range = await dayRange(settings);
    const date = source.date;
    if (!validDate(date)) throw fail(400, 'INVALID_DATE', 'Choose a valid date.');
    if (date > range.today) throw fail(400, 'TOO_EARLY', 'You can review a meal once its day has started.');
    if (date < range.min) throw fail(400, 'TOO_OLD', 'That menu is no longer kept, so it cannot be reviewed.');
    if (!MEALS.includes(source.meal)) throw fail(400, 'INVALID_MEAL', 'Choose breakfast, lunch, snacks or dinner.');
    return { date, meal: source.meal };
  }

  app.put('/api/menu/review', requireAuth, feature('menu'), requireCsrf, async (req, res) => {
    if (!limit(`menu-review:${req.user.id}`, 40, 10 * 60_000)) throw fail(429, 'RATE_LIMITED', 'That is a lot of reviews. Take a breather and try again soon.');
    const settings = await settingsOf(req);
    const body = req.body ?? {};
    const { date, meal } = await reviewTarget(req, settings, body);
    const stars = rating(body.rating, 'Your rating');
    const comment = clean(body.comment, COMMENT_MAX, 'Your comment') ?? '';
    if (body.anonymous !== undefined && typeof body.anonymous !== 'boolean') throw fail(400, 'INVALID_INPUT', 'Anonymous must be on or off.');
    const anonymous = body.anonymous === true;
    const dishInput = body.dishes === undefined ? [] : body.dishes;
    if (!Array.isArray(dishInput) || dishInput.length > 80) throw fail(400, 'INVALID_INPUT', 'Dish ratings could not be read.');
    const dishes = dishInput.map((entry) => {
      if (!entry || typeof entry.itemId !== 'string') throw fail(400, 'INVALID_INPUT', 'Dish ratings could not be read.');
      return { itemId: entry.itemId, rating: rating(entry.rating, 'A dish rating', 0) };
    });
    const onMenu = new Set((await db.query('SELECT id, now() AS read_at FROM menu_items WHERE menu_date = $1::date AND meal = $2', [date, meal])).rows.map((row) => row.id));
    if (!onMenu.size) throw fail(404, 'NOT_FOUND', 'That meal is not on the menu for that day.');
    if (dishes.some((entry) => !onMenu.has(entry.itemId))) throw fail(400, 'INVALID_DISH', 'One of those dishes is not part of that meal.');
    await db.tx(async (tx) => {
      await tx.query(
        `INSERT INTO menu_reviews (id, menu_date, meal, item_id, employee_id, rating, comment, anonymous) VALUES ($1, $2::date, $3, NULL, $4, $5, $6, $7)
         ON CONFLICT (employee_id, menu_date, meal) WHERE item_id IS NULL DO UPDATE SET rating = excluded.rating, comment = excluded.comment, anonymous = excluded.anonymous, updated_at = now()`,
        [randomUUID(), date, meal, req.user.id, stars, comment, anonymous]);
      for (const entry of dishes) {
        if (entry.rating === 0) await tx.query('DELETE FROM menu_reviews WHERE employee_id = $1 AND item_id = $2', [req.user.id, entry.itemId]);
        else {
          await tx.query(
            `INSERT INTO menu_reviews (id, menu_date, meal, item_id, employee_id, rating, anonymous) VALUES ($1, $2::date, $3, $4, $5, $6, $7)
             ON CONFLICT (employee_id, item_id) WHERE item_id IS NOT NULL DO UPDATE SET rating = excluded.rating, anonymous = excluded.anonymous, updated_at = now()`,
            [randomUUID(), date, meal, entry.itemId, req.user.id, entry.rating, anonymous]);
        }
      }
    });
    const showRatings = canSeeReviews(req.user) || settings.menuReviewsVisibility !== 'managers';
    res.json(await mealState(db, req.user, date, meal, showRatings));
  });

  app.delete('/api/menu/review', requireAuth, feature('menu'), requireCsrf, async (req, res) => {
    const settings = await settingsOf(req);
    const { date, meal } = await reviewTarget(req, settings, req.query);
    await db.tx(async (tx) => {
      await tx.query('DELETE FROM menu_reviews WHERE employee_id = $1 AND menu_date = $2::date AND meal = $3', [req.user.id, date, meal]);
    });
    const showRatings = canSeeReviews(req.user) || settings.menuReviewsVisibility !== 'managers';
    res.json(await mealState(db, req.user, date, meal, showRatings));
  });

  // Written reviews of one meal. What comes back depends on the visibility setting; the author of an anonymous review is never selected.
  app.get('/api/menu/reviews', requireAuth, feature('menu'), async (req, res) => {
    if (!limit(`menu-reviews-read:${req.user.id}`, 60, 60_000)) throw fail(429, 'RATE_LIMITED', 'Please pause a moment.');
    if (!validDate(req.query.date) || !MEALS.includes(req.query.meal)) throw fail(400, 'INVALID_INPUT', 'Choose a day and a meal.');
    const settings = await settingsOf(req);
    const everything = canSeeReviews(req.user);
    const open = everything || settings.menuReviewsVisibility === 'everyone';
    const { rows } = await db.query(`
      SELECT r.id, r.rating, r.comment, r.anonymous, r.updated_at AS at, (r.employee_id = $3) AS mine,
             CASE WHEN r.anonymous THEN NULL ELSE e.name END AS author, now() AS read_at
      FROM menu_reviews r JOIN employees e ON e.id = r.employee_id
      WHERE r.menu_date = $1::date AND r.meal = $2 AND r.item_id IS NULL
        AND (r.employee_id = $3 OR ($4::boolean AND ($5::boolean OR r.comment <> '')))
      ORDER BY r.updated_at DESC LIMIT 100`, [req.query.date, req.query.meal, req.user.id, open, everything]);
    res.json({ restricted: !open, reviews: rows.map(({ read_at: _read, ...row }) => ({ ...row, mine: Boolean(row.mine) })) });
  });

  // ---------- Manager reviews view ----------
  app.get('/api/admin/menu/reviews', requireAnyPermissions('menu.manage', 'menu.reviews.view'), async (req, res) => {
    const settings = await settingsOf(req);
    const today = dateKey(new Date());
    const from = validDate(req.query.from) ? req.query.from : addDays(today, -6);
    const to = validDate(req.query.to) ? req.query.to : today;
    if (to < from || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 92 * 86_400_000) throw fail(400, 'INVALID_DATE', 'Choose a range of up to 92 days.');
    const meal = MEALS.includes(req.query.meal) ? req.query.meal : null;
    const dish = typeof req.query.dish === 'string' && req.query.dish.trim() ? req.query.dish.trim().toLowerCase().slice(0, 100) : null;
    const base = [from, to, meal];
    const [summary, dishes, trend, comments] = await Promise.all([
      db.query(`
        SELECT to_char(menu_date, 'YYYY-MM-DD') AS date, meal, COUNT(*)::int AS count, ROUND(AVG(rating)::numeric, 2)::float8 AS avg, now() AS read_at
        FROM menu_reviews WHERE item_id IS NULL AND menu_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR meal = $3)
        GROUP BY menu_date, meal ORDER BY menu_date DESC, meal`, base),
      db.query(`
        SELECT MIN(i.name) AS name, COUNT(*)::int AS count, ROUND(AVG(r.rating)::numeric, 2)::float8 AS avg, now() AS read_at
        FROM menu_reviews r JOIN menu_items i ON i.id = r.item_id
        WHERE r.menu_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR r.meal = $3)
        GROUP BY lower(i.name) ORDER BY AVG(r.rating) DESC, COUNT(*) DESC, MIN(i.name) LIMIT 200`, base),
      db.query(`
        SELECT to_char(r.menu_date, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count, ROUND(AVG(r.rating)::numeric, 2)::float8 AS avg, now() AS read_at
        FROM menu_reviews r LEFT JOIN menu_items i ON i.id = r.item_id
        WHERE r.menu_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR r.meal = $3)
          AND (($4::text IS NULL AND r.item_id IS NULL) OR ($4::text IS NOT NULL AND lower(i.name) = $4))
        GROUP BY r.menu_date ORDER BY r.menu_date`, [...base, dish]),
      db.query(`
        SELECT r.id, to_char(r.menu_date, 'YYYY-MM-DD') AS date, r.meal, r.rating, r.comment, r.anonymous, r.updated_at AS at, i.name AS dish,
               CASE WHEN r.anonymous THEN NULL ELSE e.name END AS author, now() AS read_at
        FROM menu_reviews r JOIN employees e ON e.id = r.employee_id LEFT JOIN menu_items i ON i.id = r.item_id
        WHERE r.menu_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR r.meal = $3)
          AND (($4::text IS NULL AND r.item_id IS NULL) OR ($4::text IS NOT NULL AND lower(i.name) = $4))
        ORDER BY r.menu_date DESC, r.updated_at DESC LIMIT 1000`, [...base, dish]),
    ]);
    const strip = ({ read_at: _read, ...row }) => row;
    res.set('Cache-Control', 'private, no-cache');
    res.json({ from, to, visibility: settings.menuReviewsVisibility, summary: summary.rows.map(strip), dishes: dishes.rows.map(strip), trend: trend.rows.map(strip), reviews: comments.rows.map(strip) });
  });

  // ---------- Managers: the whole-day editor ----------
  app.get('/api/admin/menu/day/:date', requirePermission('menu.manage'), async (req, res) => {
    if (!validDate(req.params.date)) throw fail(400, 'INVALID_DATE', 'Choose a valid date.');
    res.json({ date: req.params.date, items: (await readDay(db, req.params.date)).map(shape) });
  });

  app.put('/api/admin/menu/day/:date', requirePermission('menu.manage'), requireCsrf, async (req, res) => {
    if (!limit(`menu-day:${req.user.id}`, 90, 10 * 60_000)) throw fail(429, 'RATE_LIMITED', 'Many saves in a row. Wait a moment and try again.');
    const settings = await settingsOf(req);
    const [date] = cleanDates(req.params.date, await dayRange(settings), true);
    const { items, duplicates } = cleanItems(req.body?.items);
    await maybeCleanup(settings);
    const result = await db.tx(async (tx) => {
      const outcome = await replaceDay(tx, date, items);
      await audit(tx, req.user.id, 'menu.day-saved', date, `${items.length} dishes (+${outcome.counts.added} -${outcome.counts.removed} ~${outcome.counts.updated})`);
      return outcome;
    });
    res.json({ date, ...result, duplicatesDropped: duplicates });
  });

  app.post('/api/admin/menu/copy', requirePermission('menu.manage'), requireCsrf, async (req, res) => {
    if (!limit(`menu-day:${req.user.id}`, 90, 10 * 60_000)) throw fail(429, 'RATE_LIMITED', 'Many saves in a row. Wait a moment and try again.');
    const settings = await settingsOf(req);
    const body = req.body ?? {};
    const dates = cleanDates(body.dates, await dayRange(settings));
    let source;
    if (body.items !== undefined) source = cleanItems(body.items).items;
    else if (validDate(body.from)) source = (await readDay(db, body.from)).map(shape);
    else throw fail(400, 'INVALID_MENU', 'Say which day to copy from, or send the dishes.');
    if (!source.length) throw fail(400, 'NOTHING_TO_COPY', 'There are no dishes to copy.');
    const days = await db.tx(async (tx) => {
      const count = await applyToDates(tx, dates, source, body.replace !== false);
      await audit(tx, req.user.id, 'menu.copied', null, `${source.length} dishes to ${dates.join(', ')}`);
      return count;
    });
    res.json({ days, dates });
  });

  // ---------- Managers: templates ("weekly repeating menu") ----------
  const templateName = (value) => clean(value, 60, 'Template name', true);
  app.get('/api/admin/menu/templates', requirePermission('menu.manage'), async (_req, res) => {
    const { rows } = await db.query(`SELECT id, name, jsonb_array_length(items)::int AS count, created_at, now() AS read_at FROM menu_templates ORDER BY lower(name) LIMIT 100`);
    res.json({ templates: rows.map(({ read_at: _read, ...row }) => row) });
  });
  app.get('/api/admin/menu/templates/:id', requirePermission('menu.manage'), async (req, res) => {
    const row = (await db.query('SELECT id, name, items, now() AS read_at FROM menu_templates WHERE id = $1', [req.params.id])).rows[0];
    if (!row) throw fail(404, 'NOT_FOUND', 'That template no longer exists.');
    res.json({ id: row.id, name: row.name, items: row.items });
  });
  app.post('/api/admin/menu/templates', requirePermission('menu.manage'), requireCsrf, async (req, res) => {
    const name = templateName(req.body?.name);
    const { items } = cleanItems(req.body?.items);
    if (!items.length) throw fail(400, 'NOTHING_TO_SAVE', 'Add some dishes before saving a template.');
    const id = id8('tpl');
    await db.tx(async (tx) => {
      if ((await tx.query('SELECT COUNT(*)::int AS count FROM menu_templates')).rows[0].count >= MAX_TEMPLATES) throw fail(409, 'TOO_MANY_TEMPLATES', `You can keep up to ${MAX_TEMPLATES} templates. Delete one first.`);
      // A template with the same name is replaced, so "save again" works as an update.
      await tx.query('DELETE FROM menu_templates WHERE lower(name) = lower($1)', [name]);
      await tx.query('INSERT INTO menu_templates (id, name, items, created_by) VALUES ($1,$2,$3::jsonb,$4)', [id, name, JSON.stringify(items.map(({ id: _id, ...item }) => item)), req.user.id]);
      await audit(tx, req.user.id, 'menu.template-saved', id, name);
    });
    res.status(201).json({ id, name, count: items.length });
  });
  app.delete('/api/admin/menu/templates/:id', requirePermission('menu.manage'), requireCsrf, async (req, res) => {
    const result = await db.query('DELETE FROM menu_templates WHERE id = $1 RETURNING name', [req.params.id]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'That template is already gone.');
    await audit(db, req.user.id, 'menu.template-deleted', req.params.id, result.rows[0].name);
    res.status(204).end();
  });
  app.post('/api/admin/menu/templates/:id/apply', requirePermission('menu.manage'), requireCsrf, async (req, res) => {
    const settings = await settingsOf(req);
    const dates = cleanDates(req.body?.dates, await dayRange(settings));
    const row = (await db.query('SELECT name, items, now() AS read_at FROM menu_templates WHERE id = $1', [req.params.id])).rows[0];
    if (!row) throw fail(404, 'NOT_FOUND', 'That template no longer exists.');
    const { items } = cleanItems(row.items);
    const days = await db.tx(async (tx) => {
      const count = await applyToDates(tx, dates, items, req.body?.replace !== false);
      await audit(tx, req.user.id, 'menu.template-applied', req.params.id, `${row.name} to ${dates.join(', ')}`);
      return count;
    });
    res.json({ days, dates });
  });

  // ---------- Single dishes (older, still supported) ----------
  app.post('/api/admin/menu', requirePermission('menu.manage'), requireCsrf, async (req, res) => {
    const body = req.body ?? {};
    const dates = Array.isArray(body.dates) ? body.dates : [body.date];
    if (!dates.length || dates.length > 31 || dates.some((d) => !validDate(d))) throw fail(400, 'INVALID_DATE', 'Choose between 1 and 31 valid dates.');
    if (!MEALS.includes(body.meal)) throw fail(400, 'INVALID_MEAL', 'Choose breakfast, lunch, snacks or dinner.');
    const diet = body.diet ?? 'veg';
    if (!DIETS.includes(diet)) throw fail(400, 'INVALID_DIET', 'Choose veg, non-veg, vegan or egg.');
    const course = body.course ?? 'mains';
    if (!COURSES.includes(course)) throw fail(400, 'INVALID_COURSE', 'Choose a valid section.');
    const name = clean(body.name, NAME_MAX, 'Dish name', true);
    const description = clean(body.description, NOTE_MAX, 'Description') ?? '';
    const emoji = clean(body.emoji, 8, 'Emoji') || '';
    await db.tx(async (tx) => {
      for (const date of [...new Set(dates)]) {
        await tx.query(
          `INSERT INTO menu_items (id, menu_date, meal, course, name, description, diet, emoji, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE((SELECT MAX(sort_order) + 1 FROM menu_items WHERE menu_date = $2::date), 0))`,
          [id8('dish'), date, body.meal, course, name, description, diet, emoji]);
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

  return { maybeCleanup };
}
