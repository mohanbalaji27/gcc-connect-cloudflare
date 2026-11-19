import { useEffect, useMemo, useState } from 'react';
import { MEAL_IDS, MEALS, type MealId } from '../../lib/menuCatalog';
import { api, messageOf } from '../../lib/api';
import { inIndia, todayInIndia } from '../../lib/format';
import { starsText, toCsv } from '../../lib/menuData';
import type { Ctx } from '../App';
import { Empty, Icon, Spinner, useKit } from '../kit';
import { Stars } from '../MenuBits';

interface AdminReviews {
  from: string; to: string;
  summary: { date: string; meal: MealId; count: number; avg: number }[];
  dishes: { name: string; count: number; avg: number }[];
  trend: { date: string; count: number; avg: number }[];
  reviews: { id: string; date: string; meal: MealId; rating: number; comment: string; anonymous: boolean; at: string; dish: string | null; author: string | null }[];
}

const DAY_MS = 86_400_000;
const at = (date: string) => `${date}T12:00:00+05:30`;
const shiftDay = (date: string, by: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.parse(at(date)) + by * DAY_MS));
const VISIBILITY_TEXT = {
  everyone: 'Everyone can read comments (with names, unless anonymous).',
  summary: 'Everyone sees the average stars; comments are for the food team only.',
  managers: 'Only the food team sees ratings and comments.',
} as const;

export function MenuReviews({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const today = todayInIndia();
  const history = ctx.config.menuHistoryDays;
  const [range, setRange] = useState('7');
  const [meal, setMeal] = useState<'' | MealId>('');
  const [dish, setDish] = useState('');
  const [data, setData] = useState<AdminReviews | null>(null);
  const [dishOptions, setDishOptions] = useState<string[]>([]);
  const [shown, setShown] = useState(30);

  const from = range === 'all' ? shiftDay(today, -history) : shiftDay(today, -(Number(range) - 1));
  useEffect(() => {
    let live = true;
    setData(null);
    const query = new URLSearchParams({ from, to: today });
    if (meal) query.set('meal', meal);
    if (dish) query.set('dish', dish);
    api<AdminReviews>(`/admin/menu/reviews?${query}`)
      .then((result) => { if (!live) return; setData(result); setShown(30); if (!dish) setDishOptions(result.dishes.map((entry) => entry.name).sort((a, b) => a.localeCompare(b))); })
      .catch((reason) => { toast(messageOf(reason), 'error'); if (live) setData({ from, to: today, summary: [], dishes: [], trend: [], reviews: [] }); });
    return () => { live = false; };
  }, [from, today, meal, dish, toast]);

  const days = useMemo(() => {
    const count = Math.round((Date.parse(at(today)) - Date.parse(at(from))) / DAY_MS) + 1;
    return Array.from({ length: Math.max(1, count) }, (_, i) => shiftDay(from, i));
  }, [from, today]);
  const trend = useMemo(() => new Map((data?.trend ?? []).map((row) => [row.date, row])), [data]);
  const totals = useMemo(() => {
    const rows = data?.trend ?? [];
    const count = rows.reduce((sum, row) => sum + row.count, 0);
    return { count, avg: count ? rows.reduce((sum, row) => sum + row.avg * row.count, 0) / count : null };
  }, [data]);

  function exportCsv() {
    if (!data) return;
    const csv = toCsv([['Date', 'Meal', 'Dish', 'Stars', 'Comment', 'Author', 'Updated'], ...data.reviews.map((row) => [row.date, MEALS[row.meal].label, row.dish ?? 'Whole meal', row.rating, row.comment, row.author ?? 'Anonymous', row.at])]);
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `menu-reviews-${data.from}_${data.to}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const written = (data?.reviews ?? []).filter((row) => row.comment || row.dish);
  const top = (data?.dishes ?? []).slice(0, 5);
  const low = (data?.dishes ?? []).length > 5 ? [...(data?.dishes ?? [])].reverse().slice(0, 3).filter((row) => row.avg < 3.5) : [];

  return (
    <div className="mr">
      <p className="muted mr-note">{VISIBILITY_TEXT[ctx.config.menuReviewsVisibility]} A super admin can change this in Settings. Reviews older than {history} days are removed automatically.</p>
      <div className="mr-filters">
        <label className="field"><span>Period</span><select value={range} onChange={(event) => setRange(event.target.value)}><option value="1">Today</option><option value="7">Last 7 days</option><option value="14" disabled={history < 14}>Last 14 days</option><option value="all">Everything kept ({history} days)</option></select></label>
        <label className="field"><span>Meal</span><select value={meal} onChange={(event) => setMeal(event.target.value as '' | MealId)}><option value="">All meals</option>{MEAL_IDS.map((id) => <option key={id} value={id}>{MEALS[id].label}</option>)}</select></label>
        <label className="field"><span>Dish</span><select value={dish} onChange={(event) => setDish(event.target.value)}><option value="">All (whole meals)</option>{dishOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <button className="button button-small" onClick={exportCsv} disabled={!data || data.reviews.length === 0}><Icon name="download" size={16} /> Export CSV</button>
      </div>

      {data === null ? <Spinner /> : totals.count === 0 && data.reviews.length === 0 ? (
        <Empty icon="chat" title="No reviews in this period">When people rate a meal, the averages, the trend and their comments show up here.</Empty>
      ) : (
        <>
          <div className="mr-kpis">
            <div><span>Average</span><strong>{totals.avg === null ? '–' : starsText(Math.round(totals.avg * 10) / 10)}</strong>{totals.avg !== null && <Stars value={totals.avg} />}</div>
            <div><span>{dish ? 'Dish ratings' : 'Reviews'}</span><strong>{totals.count}</strong></div>
            <div><span>Days with reviews</span><strong>{data.trend.length}</strong></div>
          </div>

          <section className="mr-card">
            <h3>Rating trend <small>{dish ? dish : meal ? MEALS[meal].label : 'all meals'}</small></h3>
            <div className="mr-bars" role="img" aria-label={`Daily average stars, ${data.trend.map((row) => `${row.date}: ${row.avg}`).join(', ') || 'no data'}`}>
              {days.map((d) => {
                const row = trend.get(d);
                return (
                  <div key={d} className="mr-bar" title={row ? `${inIndia(at(d), { weekday: 'short', day: 'numeric', month: 'short' })}: ${starsText(row.avg)} from ${row.count}` : 'No reviews'}>
                    <b>{row ? starsText(row.avg) : ''}</b>
                    <span><i style={{ height: `${row ? (row.avg / 5) * 100 : 0}%` }} className={row ? (row.avg >= 4 ? 'good' : row.avg >= 3 ? 'ok' : 'bad') : ''} /></span>
                    <small>{days.length > 10 ? inIndia(at(d), { day: 'numeric' }) : inIndia(at(d), { weekday: 'short' })}</small>
                  </div>
                );
              })}
            </div>
          </section>

          {!dish && data.summary.length > 0 && (
            <section className="mr-card">
              <h3>By day and meal</h3>
              <ul className="mr-rows">
                {data.summary.map((row) => <li key={`${row.date}-${row.meal}`}><span>{inIndia(at(row.date), { weekday: 'short', day: 'numeric', month: 'short' })} · {MEALS[row.meal].label}</span><span><Stars value={row.avg} /> <strong>{starsText(row.avg)}</strong> <small>{row.count} {row.count === 1 ? 'review' : 'reviews'}</small></span></li>)}
              </ul>
            </section>
          )}

          {top.length > 0 && (
            <section className="mr-card mr-two">
              <div><h3>Best rated dishes</h3><ul className="mr-rows">{top.map((row) => <li key={row.name}><span>{row.name}</span><span><strong>★ {starsText(row.avg)}</strong> <small>{row.count}</small></span></li>)}</ul></div>
              {low.length > 0 && <div><h3>Needs attention</h3><ul className="mr-rows">{low.map((row) => <li key={row.name}><span>{row.name}</span><span><strong>★ {starsText(row.avg)}</strong> <small>{row.count}</small></span></li>)}</ul></div>}
            </section>
          )}

          <section className="mr-card">
            <h3>{dish ? `Ratings for ${dish}` : 'Comments'} <small>{written.length}</small></h3>
            {written.length === 0 ? <p className="muted">{dish ? 'Single dish ratings have stars only.' : 'Nobody has written a comment in this period.'}</p> : (
              <ul className="mr-comments">
                {written.slice(0, shown).map((row) => (
                  <li key={row.id}>
                    <div className="mr-comment-head"><Stars value={row.rating} /><strong>{row.author ?? 'Anonymous'}</strong><small>{inIndia(at(row.date), { weekday: 'short', day: 'numeric', month: 'short' })} · {MEALS[row.meal].label}{row.dish ? ` · ${row.dish}` : ''}</small></div>
                    {row.comment && <p>{row.comment}</p>}
                  </li>
                ))}
              </ul>
            )}
            {written.length > shown && <button className="button button-small" onClick={() => setShown(shown + 30)}>Show more</button>}
          </section>
        </>
      )}
    </div>
  );
}
