import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COURSE_IDS, COURSES, DIET_IDS, DIETS, MEAL_IDS, MEALS, currentMeal, type DietId, type MealId } from '../../lib/menuCatalog';
import { api, messageOf } from '../../lib/api';
import { inIndia, nowTimeInIndia } from '../../lib/format';
import { loadMenu, mealKey, menuAge, peekMenu, starsText, updateMenu, withLike, withMealState, type MealState, type MenuDish, type MenuWindow, type WrittenReview } from '../../lib/menuData';
import { nav } from '../../lib/nav';
import type { Ctx } from '../App';
import { Icon, Spinner, useKit } from '../kit';
import { DietMark, Ornament, Stars } from '../MenuBits';
import { ReviewSheet } from './MenuReview';

const SHORT: Partial<Record<MealId, string>> = { snacks: 'Snacks' };
const DAY_MS = 86_400_000;
const at = (date: string) => `${date}T12:00:00+05:30`;
const shiftDay = (date: string, by: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.parse(at(date)) + by * DAY_MS));
const daysBetween = (from: string, to: string) => Math.round((Date.parse(at(to)) - Date.parse(at(from))) / DAY_MS);
const longDate = (date: string) => inIndia(at(date), { weekday: 'long', day: 'numeric', month: 'long' });

function pickMeal(window: MenuWindow, date: string): MealId {
  const has = (meal: MealId) => window.items.some((item) => item.date === date && item.meal === meal);
  if (date === window.today) {
    const [h, m] = nowTimeInIndia().split(':').map(Number);
    const now = currentMeal(h, m);
    if (has(now)) return now;
    const index = MEAL_IDS.indexOf(now);
    return MEAL_IDS.slice(index + 1).find(has) ?? [...MEAL_IDS.slice(0, index)].reverse().find(has) ?? now;
  }
  return MEAL_IDS.find(has) ?? 'lunch';
}

const kicker = (window: MenuWindow, date: string) => {
  const gap = daysBetween(window.today, date);
  if (gap === 0) return 'Today';
  if (gap === 1) return 'Tomorrow';
  if (gap === -1) return 'Yesterday';
  return gap < 0 ? `${-gap} days ago` : `In ${gap} days`;
};

export function MenuScreen({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const [win, setWin] = useState<MenuWindow | null>(peekMenu());
  const [day, setDay] = useState<string | null>(null);
  const [meal, setMeal] = useState<MealId>('lunch');
  const [diet, setDiet] = useState<'all' | DietId>('all');
  const [sheet, setSheet] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [written, setWritten] = useState<Record<string, { restricted: boolean; reviews: WrittenReview[] } | 'loading'>>({});
  const strip = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const canManage = ctx.user.permissions.includes('menu.edit');
  const appName = ctx.config.branding.appName;

  useEffect(() => {
    let live = true;
    loadMenu().then((data) => { if (live) setWin(data); }).catch((reason) => { if (live) toast(messageOf(reason), 'error'); });
    // Coming back to a tab that was left open for a while checks the menu once (a cheap 304 when nothing changed).
    const onVisible = () => { if (document.visibilityState === 'visible' && menuAge() > 10 * 60_000) loadMenu(true).then((data) => live && setWin(data)).catch(() => {}); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; document.removeEventListener('visibilitychange', onVisible); };
  }, [toast]);

  // Open on today and on the meal people are most likely looking for right now.
  useEffect(() => {
    if (!win || day !== null) return;
    const start = nav.menuDate && nav.menuDate >= win.from && nav.menuDate <= win.to ? nav.menuDate : win.today >= win.from && win.today <= win.to ? win.today : win.to;
    nav.menuDate = '';
    setDay(start);
    setMeal(pickMeal(win, start));
  }, [win, day]);

  const days = useMemo(() => (win ? Array.from({ length: daysBetween(win.from, win.to) + 1 }, (_, i) => shiftDay(win.from, i)) : []), [win]);
  useEffect(() => {
    const target = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const box = strip.current;
    if (target && box) box.scrollTo({ left: target.offsetLeft - box.clientWidth / 2 + target.clientWidth / 2, behavior: 'smooth' });
  }, [day, days.length]);

  const dayItems = useMemo(() => (win && day ? win.items.filter((item) => item.date === day) : []), [win, day]);
  const mealItems = useMemo(() => dayItems.filter((item) => item.meal === meal), [dayItems, meal]);
  const shown = useMemo(() => mealItems.filter((item) => diet === 'all' || item.diet === diet), [mealItems, diet]);
  const sections = useMemo(() => COURSE_IDS.map((course) => ({ course, items: shown.filter((item) => item.course === course) })).filter((section) => section.items.length), [shown]);
  const specials = shown.filter((item) => item.special);

  const go = useCallback((by: number) => {
    if (!win || !day) return;
    const next = shiftDay(day, by);
    if (next >= win.from && next <= win.to) { setDay(next); setReviewsOpen(false); }
  }, [win, day]);

  async function like(item: MenuDish) {
    const next = !item.liked;
    const apply = (liked: boolean) => { setWin((current) => (current ? withLike(current, item.id, liked) : current)); updateMenu((current) => withLike(current, item.id, liked)); };
    apply(next);
    try { await api(`/menu/${item.id}/like`, { method: 'POST' }); } catch (reason) { apply(!next); toast(messageOf(reason), 'error'); }
  }

  const key = day ? mealKey(day, meal) : '';
  const rating = win?.ratings[key];
  const mine = win?.mine.meals[key];
  const canRead = Boolean(win && (win.canSeeReviews || win.visibility === 'everyone'));
  const loadedReviews = written[key];

  useEffect(() => {
    if (!reviewsOpen || !day || !win || written[key]) return;
    setWritten((current) => ({ ...current, [key]: 'loading' }));
    api<{ restricted: boolean; reviews: WrittenReview[] }>(`/menu/reviews?date=${day}&meal=${meal}`)
      .then((result) => setWritten((current) => ({ ...current, [key]: result })))
      .catch((reason) => { toast(messageOf(reason), 'error'); setWritten((current) => { const { [key]: _drop, ...rest } = current; return rest; }); setReviewsOpen(false); });
  }, [reviewsOpen, key, day, meal, win, written, toast]);

  function saved(state: MealState) {
    setWin((current) => (current ? withMealState(current, state) : current));
    updateMenu((current) => withMealState(current, state));
    setWritten((current) => { const { [state.key]: _drop, ...rest } = current; return rest; });
    setSheet(false);
  }

  const closeSheet = useCallback(() => setSheet(false), []);

  async function download() {
    if (!day) return;
    try {
      const { downloadMenuPdf } = await import('../../lib/menuPdf');
      await downloadMenuPdf({ appName, date: day, dateLabel: longDate(day), items: dayItems });
    } catch (reason) { toast(messageOf(reason), 'error'); }
  }

  function edit() {
    nav.manageTab = 'menu';
    nav.menuDate = day ?? '';
    ctx.go('manage');
  }

  if (!win || !day) return <div><div className="page-head"><div><span className="eyebrow">FOOD MENU</span><h1>What&apos;s cooking?</h1></div></div><Spinner label="Setting the table" /></div>;

  const isFuture = day > win.today;
  const hasAnyThisDay = dayItems.length > 0;
  const canReview = mealItems.length > 0 && !isFuture;
  const hasMeal = (id: MealId) => dayItems.some((item) => item.meal === id);

  return (
    <div className="mc">
      <div className="page-head mc-screen">
        <div><span className="eyebrow">FOOD MENU</span><h1>What&apos;s cooking?</h1></div>
        <div className="panel-tools">
          <button className="button button-small" onClick={() => void download()} disabled={!hasAnyThisDay} title={hasAnyThisDay ? 'Download this day as a one-page PDF' : 'Nothing to download for this day'}><Icon name="download" size={16} /> PDF</button>
          <button className="button button-small" onClick={() => window.print()} disabled={!hasAnyThisDay} title={hasAnyThisDay ? 'Print this day' : 'Nothing to print for this day'}><Icon name="print" size={16} /> Print</button>
          {canManage && <button className="button button-primary button-small" onClick={edit}><Icon name="edit" size={16} /> Edit menu</button>}
        </div>
      </div>

      <div className="mc-days mc-screen" role="tablist" aria-label="Choose a day" ref={strip}>
        {days.map((d) => {
          const count = win.items.filter((item) => item.date === d).length;
          return (
            <button key={d} role="tab" aria-selected={d === day} className={`mc-day ${d === day ? 'on' : ''} ${d < win.today ? 'past' : ''} ${d === win.today ? 'today' : ''}`} onClick={() => { setDay(d); setReviewsOpen(false); }}>
              <span>{d === win.today ? 'Today' : inIndia(at(d), { weekday: 'short' })}</span>
              <strong>{inIndia(at(d), { day: 'numeric' })}</strong>
              <i className={count ? 'has' : ''} aria-label={count ? `${count} dishes` : 'No menu yet'} />
            </button>
          );
        })}
      </div>

      <div className="mc-controls mc-screen">
        <div className="mc-meals" role="tablist" aria-label="Choose a meal">
          {MEAL_IDS.map((id) => (
            <button key={id} role="tab" aria-selected={meal === id} className={`${meal === id ? 'on' : ''} ${hasMeal(id) ? 'has' : ''}`} onClick={() => { setMeal(id); setReviewsOpen(false); }}>
              <span aria-hidden="true">{MEALS[id].emoji}</span><b className="long">{MEALS[id].label}</b><b className="short">{SHORT[id] ?? MEALS[id].label}</b>
            </button>
          ))}
        </div>
        <div className="mc-diets" role="group" aria-label="Diet filter">
          <button className={diet === 'all' ? 'on' : ''} aria-pressed={diet === 'all'} onClick={() => setDiet('all')}>All</button>
          {DIET_IDS.map((id) => <button key={id} className={diet === id ? 'on' : ''} aria-pressed={diet === id} onClick={() => setDiet(diet === id ? 'all' : id)}><DietMark diet={id} small /> {DIETS[id].label}</button>)}
        </div>
      </div>

      <article
        className="mc-card mc-screen" aria-live="polite"
        onTouchStart={(event) => { const t = event.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }}
        onTouchEnd={(event) => {
          const start = touch.current; touch.current = null;
          if (!start) return;
          const t = event.changedTouches[0];
          const dx = t.clientX - start.x;
          if (Math.abs(dx) > 70 && Math.abs(t.clientY - start.y) < 45) go(dx < 0 ? 1 : -1);
        }}
      >
        <button className="mc-arrow left" onClick={() => go(-1)} disabled={day <= win.from} aria-label="Previous day"><Icon name="back" size={20} /></button>
        <button className="mc-arrow right" onClick={() => go(1)} disabled={day >= win.to} aria-label="Next day"><Icon name="arrow" size={20} /></button>
        <header className="mc-head">
          <span className="mc-kicker">{kicker(win, day)} · {appName}</span>
          <h2 className="mc-title">{MEALS[meal].label}</h2>
          <span className="mc-date">{longDate(day)}</span>
          <Ornament />
        </header>

        {mealItems.length === 0 ? (
          <div className="mc-empty">
            <span aria-hidden="true">{MEALS[meal].emoji}</span>
            <strong>{day < win.today ? `No ${MEALS[meal].label.toLowerCase()} menu was posted.` : isFuture ? `${MEALS[meal].label} is still being planned.` : `${MEALS[meal].label} has not been posted yet.`}</strong>
            <p>{day < win.today ? 'That day has no menu on record.' : 'The kitchen has not shared it yet. Check back a little later, and pack a snack just in case 🍪'}</p>
            {canManage && <button className="button button-small" onClick={edit}><Icon name="plus" size={16} /> Add the menu</button>}
          </div>
        ) : shown.length === 0 ? (
          <div className="mc-empty"><strong>No {diet === 'all' ? '' : `${DIETS[diet].label.toLowerCase()} `}dishes in {MEALS[meal].label.toLowerCase()}.</strong><p>Try another filter.</p><button className="button button-small" onClick={() => setDiet('all')}>Show everything</button></div>
        ) : (
          <>
            {specials.length > 0 && (
              <div className="mc-special">
                <span className="mc-special-tag">★ Today&apos;s special</span>
                <strong>{specials.map((item) => item.name).join(' · ')}</strong>
              </div>
            )}
            {sections.map(({ course, items }) => (
              <section key={course} className="mc-course">
                <h3><span>{COURSES[course].label}</span></h3>
                <ul>
                  {items.map((item) => (
                    <li key={item.id} className={`mc-dish ${item.special ? 'special' : ''}`}>
                      <div className="mc-dish-line">
                        <DietMark diet={item.diet} />
                        <span className="mc-dish-name">{item.emoji && item.emoji !== '🍽️' ? `${item.emoji} ` : ''}{item.name}{item.special && <b className="mc-star" aria-label="special"> ★</b>}</span>
                        {win.dishRatings[item.id]?.count ? <small className="mc-dish-rating" title={`${win.dishRatings[item.id].count} ratings`}>★ {starsText(win.dishRatings[item.id].avg)}</small> : null}
                        <button className={`mc-like ${item.liked ? 'on' : ''}`} aria-pressed={item.liked} aria-label={`${item.liked ? 'Unlike' : 'Like'} ${item.name}`} onClick={() => void like(item)}>
                          <Icon name="heart" size={15} />{item.likes > 0 && <span>{item.likes}</span>}
                        </button>
                      </div>
                      {item.description && <p className="mc-dish-note">{item.description}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <Ornament />
            <footer className="mc-foot">
              <div className="mc-score">
                {rating && rating.count > 0 ? (
                  <><Stars value={rating.avg} /><strong>{starsText(rating.avg)}</strong><span>{rating.count} {rating.count === 1 ? 'review' : 'reviews'}</span></>
                ) : <span>{canReview ? 'No reviews yet. Be the first to rate it.' : isFuture ? 'Reviews open on the day.' : ''}</span>}
              </div>
              {mine && <p className="mc-mine">Your rating: <Stars value={mine.rating} /> {mine.comment && <em>“{mine.comment}”</em>}</p>}
              <div className="mc-foot-actions">
                {canReview && <button className="mc-cta" onClick={() => setSheet(true)}><Icon name="sparkle" size={16} /> {mine ? 'Edit my review' : `Rate ${MEALS[meal].label.toLowerCase()}`}</button>}
                {canRead && rating && rating.count > 0 && <button className="mc-link" onClick={() => setReviewsOpen((open) => !open)} aria-expanded={reviewsOpen}>{reviewsOpen ? 'Hide reviews' : 'Read reviews'}</button>}
              </div>
              {!canRead && rating && rating.count > 0 && <small className="mc-note">Comments are read by the food team.</small>}
              {!canRead && win.visibility === 'managers' && mealItems.length > 0 && !isFuture && <small className="mc-note">Reviews go to the food team.</small>}
            </footer>
            {reviewsOpen && (
              <div className="mc-reviews">
                {loadedReviews === 'loading' || !loadedReviews ? <Spinner /> : loadedReviews.reviews.length === 0 ? <p className="mc-note">No written reviews yet.</p> : (
                  <ul>
                    {loadedReviews.reviews.map((review) => (
                      <li key={review.id}>
                        <div><Stars value={review.rating} /><strong>{review.mine ? 'You' : review.author ?? 'Anonymous'}</strong><small>{inIndia(review.at, { day: 'numeric', month: 'short' })}</small></div>
                        {review.comment && <p>{review.comment}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </article>
      <p className="mc-hint mc-screen">Swipe the card to change day. The last {win.historyDays} days are kept.</p>

      {hasAnyThisDay && (
        <div className="mc-print" aria-hidden="true">
          <h1>{appName}</h1>
          <p className="mc-print-date">{longDate(day)}</p>
          <Ornament />
          <div className="mc-print-cols">
            {MEAL_IDS.filter(hasMeal).map((id) => (
              <section key={id}>
                <h2>{MEALS[id].label}</h2>
                {COURSE_IDS.map((course) => {
                  const list = dayItems.filter((item) => item.meal === id && item.course === course);
                  return list.length ? (
                    <div key={course}>
                      <h3>{COURSES[course].label}</h3>
                      <ul>{list.map((item) => <li key={item.id}><DietMark diet={item.diet} small /> {item.name}{item.special ? ' ★' : ''}{item.description && <em> {item.description}</em>}</li>)}</ul>
                    </div>
                  ) : null;
                })}
              </section>
            ))}
          </div>
          <p className="mc-print-legend">{DIET_IDS.map((id) => <span key={id}><DietMark diet={id} small /> {DIETS[id].label}</span>)}</p>
        </div>
      )}

      {sheet && (
        <ReviewSheet
          date={day} dateLabel={longDate(day)} meal={meal} dishes={mealItems} mine={mine ?? null} myDishes={win.mine.dishes} visibility={win.visibility} canSeeReviews={win.canSeeReviews}
          onClose={closeSheet} onSaved={saved}
        />
      )}
    </div>
  );
}
