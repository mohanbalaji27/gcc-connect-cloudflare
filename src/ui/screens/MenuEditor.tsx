import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COURSE_IDS, COURSES, DIETS, MAX_DAY_ITEMS, MEAL_IDS, MEALS, NAME_MAX, NOTE_MAX, nextDiet, type CourseId, type MealId } from '../../lib/menuCatalog';
import { dishKey, formatMenuText, menuSignature, parseMenuText, reconcileIds, sortMenuItems, type DraftDish } from '../../lib/menuText';
import { clearMenu, toDraft, toPayload, type MenuDish } from '../../lib/menuData';
import { api, messageOf } from '../../lib/api';
import { inIndia, todayInIndia } from '../../lib/format';
import { nav } from '../../lib/nav';
import type { Ctx } from '../App';
import { Icon, Modal, Spinner, useKit } from '../kit';
import { DietMark } from '../MenuBits';

interface Row extends DraftDish { key: string }
interface SaveResult { date: string; items: MenuDish[]; previous: MenuDish[]; counts: { added: number; updated: number; removed: number }; duplicatesDropped: number }
interface StoredDraft { items: DraftDish[]; text: string; at: number }
interface Template { id: string; name: string; count: number }

const DAY_MS = 86_400_000;
const at = (date: string) => `${date}T12:00:00+05:30`;
const shiftDay = (date: string, by: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.parse(at(date)) + by * DAY_MS));
const weekStartOf = (date: string) => shiftDay(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
const dayLabel = (date: string, options: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'short' }) => inIndia(at(date), options);
let counter = 0;
const uid = () => { counter += 1; return `row-${counter}`; };
const toRow = (dish: DraftDish): Row => ({ ...dish, key: uid() });
const plain = (rows: Row[]): DraftDish[] => rows.map(({ key: _key, ...rest }) => rest);
const named = (dish: { name: string }) => dish.name.trim().length > 0;
const draftKey = (userId: string, date: string) => `gcc-menu-draft:${userId}:${date}`;

function readDraft(userId: string, date: string): StoredDraft | null {
  try { const raw = localStorage.getItem(draftKey(userId, date)); return raw ? (JSON.parse(raw) as StoredDraft) : null; } catch { return null; }
}
const writeDraft = (userId: string, date: string, draft: StoredDraft) => { try { localStorage.setItem(draftKey(userId, date), JSON.stringify(draft)); } catch { /* storage full or blocked: the draft is only a safety net */ } };
const clearDraft = (userId: string, date: string) => { try { localStorage.removeItem(draftKey(userId, date)); } catch { /* ignore */ } };

const EXAMPLE = `Breakfast
v: Idli, Vada, Sambar
Egg bhurji (egg)
Lunch
Starters:
Paneer tikka (v) ★
Chicken 65 (nv)
Mains:
Dal tadka (v)
nv: Chicken curry
Breads & Rice:
Jeera rice, Roti, Naan (v)
Desserts:
Gulab jamun (v) - served hot
Evening snacks
Samosa (v), Masala chai (vegan)
Dinner
v: Veg pulao, Raita`;

export function MenuEditor({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const userId = ctx.user.id;
  const today = todayInIndia();
  const minDay = shiftDay(today, -ctx.config.menuHistoryDays);
  const [date, setDate] = useState(() => { const wanted = nav.menuDate; nav.menuDate = ''; return wanted || today; });
  const [mode, setMode] = useState<'type' | 'grid'>('type');
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ date: string; previous: DraftDish[] } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [offer, setOffer] = useState<StoredDraft | null>(null);
  const [dialog, setDialog] = useState<'from' | 'to' | 'templates' | null>(null);
  const [weekView, setWeekView] = useState<Record<string, DraftDish[]>>({});
  const week = useRef<Record<string, DraftDish[]>>({});
  const loadedWeeks = useRef(new Set<string>());

  const setDay = (day: string, items: DraftDish[]) => { week.current = { ...week.current, [day]: items }; setWeekView(week.current); };
  const fetchWeek = useCallback(async (start: string, force = false) => {
    if (!force && loadedWeeks.current.has(start)) return;
    const result = await api<{ items: MenuDish[] }>(`/menu?from=${start}&days=7&manage=1`);
    const next = { ...week.current };
    for (let i = 0; i < 7; i += 1) next[shiftDay(start, i)] = [];
    for (const item of result.items) next[item.date].push(toDraft(item));
    week.current = next;
    loadedWeeks.current.add(start);
    setWeekView(next);
  }, []);

  const apply = useCallback((items: DraftDish[], nextText?: string) => {
    setRows(items.map(toRow));
    setText(nextText ?? formatMenuText(items));
  }, []);

  const open = useCallback(async (target: string) => {
    setLoading(true);
    try { await fetchWeek(weekStartOf(target)); } catch (reason) { toast(messageOf(reason), 'error'); }
    const items = week.current[target] ?? [];
    const stored = readDraft(userId, target);
    setDate(target);
    apply(items);
    setOffer(stored && menuSignature(stored.items) !== menuSignature(items) ? stored : null);
    if (stored && menuSignature(stored.items) === menuSignature(items)) clearDraft(userId, target);
    setLoading(false);
  }, [fetchWeek, apply, toast, userId]);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; void open(date); } }, [open, date]);

  const savedItems = weekView[date] ?? [];
  const live = useMemo(() => rows.filter(named), [rows]);
  const dirty = !loading && menuSignature(live) !== menuSignature(savedItems);
  const parsed = useMemo(() => (mode === 'type' ? parseMenuText(text) : null), [mode, text]);
  const tooOld = date < minDay;

  // The draft is kept on this device while there are unsaved changes, so a closed tab or a crash loses nothing.
  useEffect(() => {
    if (loading) return undefined;
    const timer = window.setTimeout(() => {
      if (dirty) writeDraft(userId, date, { items: plain(live), text, at: Date.now() });
      else if (!offer) clearDraft(userId, date);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [live, text, dirty, loading, date, offer, userId]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const go = (target: string) => {
    if (target === date) return;
    if (dirty && !window.confirm('This day has unsaved changes. Leave without saving?\n\nA draft stays on this device and you can restore it when you come back.')) return;
    void open(target);
  };

  const commit = (next: Row[]) => {
    const sorted = sortMenuItems(next);
    setRows(sorted);
    setText(formatMenuText(sorted.filter(named)));
  };
  const onText = (value: string) => {
    setText(value);
    const result = parseMenuText(value);
    const withIds = reconcileIds(result.items, [...plain(rows), ...savedItems]);
    const kept = new Map(rows.filter((row) => row.id).map((row) => [row.id, row.key]));
    setRows(withIds.map(({ line: _line, dietMarked: _marked, ...dish }) => ({ ...dish, key: (dish.id && kept.get(dish.id)) || uid() })));
  };

  async function save() {
    if (!dirty || busy || tooOld) return;
    setBusy(true);
    try {
      const result = await api<SaveResult>(`/admin/menu/day/${date}`, { method: 'PUT', body: { items: live.map((row) => toPayload(row)) } });
      const items = result.items.map(toDraft);
      setDay(date, items);
      apply(items);
      setOffer(null);
      clearDraft(userId, date);
      clearMenu();
      setUndo({ date, previous: result.previous.map(toDraft) });
      setSavedAt(Date.now());
      toast(`${items.length === 0 ? 'Day cleared' : `${items.length} ${items.length === 1 ? 'dish' : 'dishes'} saved`} for ${dayLabel(date)}.${result.duplicatesDropped ? ` ${result.duplicatesDropped} repeat skipped.` : ''}`, 'success');
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveRef.current(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function undoSave() {
    if (!undo || undo.date !== date) return;
    setBusy(true);
    try {
      const result = await api<SaveResult>(`/admin/menu/day/${date}`, { method: 'PUT', body: { items: undo.previous.map(toPayload) } });
      const items = result.items.map(toDraft);
      setDay(date, items);
      apply(items);
      clearMenu();
      setUndo(null);
      toast('Went back to the version before your last save.', 'success');
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }

  const loadInto = (items: DraftDish[], replace: boolean) => {
    const fresh = items.map(({ id: _id, ...dish }) => dish);
    if (replace) { apply(sortMenuItems(fresh), undefined); return; }
    const have = new Set(live.map((dish) => dishKey(dish.meal, dish.name)));
    const merged = sortMenuItems([...plain(live), ...fresh.filter((dish) => !have.has(dishKey(dish.meal, dish.name)))]).slice(0, MAX_DAY_ITEMS);
    apply(merged);
  };

  const strip = Array.from({ length: 7 }, (_, i) => shiftDay(weekStartOf(date), i));
  const meals = new Set(live.map((row) => row.meal)).size;

  return (
    <div className="mm">
      <div className="mm-nav">
        <button className="icon-button" onClick={() => go(shiftDay(date, -7))} aria-label="Previous week"><Icon name="back" /></button>
        <div className="mm-week" role="tablist" aria-label="Choose a day to edit">
          {strip.map((d) => {
            const count = weekView[d]?.length ?? 0;
            return (
              <button key={d} role="tab" aria-selected={d === date} className={`${d === date ? 'on' : ''} ${d === today ? 'today' : ''} ${d < minDay ? 'old' : ''}`} onClick={() => go(d)}>
                <span><b className="long">{dayLabel(d, { weekday: 'short' })}</b><b className="short">{dayLabel(d, { weekday: 'narrow' })}</b></span><strong>{dayLabel(d, { day: 'numeric' })}</strong>
                <i className={count ? 'has' : ''}>{count || '·'}</i>
              </button>
            );
          })}
        </div>
        <button className="icon-button" onClick={() => go(shiftDay(date, 7))} aria-label="Next week"><Icon name="arrow" /></button>
      </div>
      <div className="mm-subnav">
        <strong>{dayLabel(date)}{date === today ? ' · today' : ''}</strong>
        <label className="mm-jump"><span className="sr-only">Jump to a date</span><input type="date" value={date} onChange={(event) => event.target.value && go(event.target.value)} /></label>
        {date !== today && <button className="button button-small" onClick={() => go(today)}>Today</button>}
      </div>

      {offer && (
        <div className="banner mm-offer" role="status">
          <span>You have an unsaved draft from {inIndia(new Date(offer.at), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} on this device.</span>
          <span className="mm-offer-actions">
            <button className="button button-small button-primary" onClick={() => { apply(offer.items, offer.text); setOffer(null); }}>Restore draft</button>
            <button className="button button-small" onClick={() => { clearDraft(userId, date); setOffer(null); }}>Discard</button>
          </span>
        </div>
      )}
      {tooOld && <div className="banner" role="status">This day is older than the {ctx.config.menuHistoryDays} days the menu keeps, so it cannot be changed.</div>}

      <div className="mm-tools">
        <div className="segmented small" role="tablist" aria-label="Editing style">
          <button role="tab" aria-selected={mode === 'type'} className={mode === 'type' ? 'active' : ''} onClick={() => setMode('type')}><Icon name="edit" size={15} /> Type or paste</button>
          <button role="tab" aria-selected={mode === 'grid'} className={mode === 'grid' ? 'active' : ''} onClick={() => setMode('grid')}><Icon name="list" size={15} /> Grid</button>
        </div>
        <div className="mm-actions">
          <button className="button button-small" onClick={() => setDialog('from')}><Icon name="copy" size={15} /> Copy from…</button>
          <button className="button button-small" onClick={() => setDialog('to')} disabled={live.length === 0}><Icon name="calendar" size={15} /> Copy to dates…</button>
          <button className="button button-small" onClick={() => setDialog('templates')}><Icon name="layers" size={15} /> Templates</button>
          <button className="button button-small button-danger-soft" disabled={rows.length === 0} onClick={() => { if (window.confirm(`Empty ${dayLabel(date)}? Nothing is deleted until you press Save.`)) { apply([]); } }}><Icon name="trash" size={15} /> Clear day</button>
        </div>
      </div>

      {loading ? <Spinner label="Opening the day" /> : mode === 'type' ? (
        <div className="mm-split">
          <section className="mm-type">
            <label className="mm-label" htmlFor="menu-text">The whole day, one dish per line or separated by commas</label>
            <textarea id="menu-text" className="mm-text" value={text} onChange={(event) => onText(event.target.value)} spellCheck={false} placeholder={EXAMPLE} rows={16} aria-describedby="menu-help" />
            <div className="mm-type-foot">
              <button className="button button-small" onClick={() => onText(EXAMPLE)}>Insert an example</button>
              <details className="mm-help" id="menu-help">
                <summary>How to type it</summary>
                <ul>
                  <li><b>Meal heading</b> on its own line: <code>Breakfast</code>, <code>Lunch</code>, <code>Dinner</code>, <code>Evening snacks</code>. Also <code>== Lunch ==</code> or <code>Lunch (12:30-2pm)</code>.</li>
                  <li><b>Section heading</b>: <code>Starters:</code> <code>Mains:</code> <code>Breads &amp; rice:</code> <code>Sides:</code> <code>Desserts:</code> <code>Drinks:</code> <code>Others:</code>. No section means Mains.</li>
                  <li><b>Dishes</b>: one per line, or comma separated. Bullets (<code>-</code> <code>•</code> <code>1.</code>) are optional.</li>
                  <li><b>Veg / non-veg</b>: <code>(v)</code> <code>(nv)</code> <code>(egg)</code> <code>(vegan)</code> after the name, or <code>v:</code> <code>nv:</code> at the start of a line, or the dots 🟢 🔴 🟡 🌱. No mark means veg (names with chicken or fish are marked non-veg for you).</li>
                  <li><b>Note</b>: <code>Gulab jamun (v) - served hot</code>. <b>Special</b>: add <code>★</code> or <code>(special)</code>. <b>Emoji</b>: put it first, <code>🍛 Biryani (nv)</code>.</li>
                  <li>Use <code>\,</code> for a comma inside a name. Repeats in the same meal are skipped.</li>
                </ul>
              </details>
            </div>
          </section>
          <Preview rows={live} warnings={parsed?.warnings ?? []} />
        </div>
      ) : (
        <GridEditor rows={rows} onCommit={commit} />
      )}

      <div className="mm-savebar" role="region" aria-label="Save">
        <div className="mm-status" aria-live="polite">
          {tooOld ? 'Too old to change' : dirty ? <><i className="mm-dot warn" /> Unsaved changes</> : savedAt && undo?.date === date ? <><i className="mm-dot ok" /> Saved</> : <><i className="mm-dot" /> Up to date</>}
          <small>{live.length} {live.length === 1 ? 'dish' : 'dishes'} · {meals} {meals === 1 ? 'meal' : 'meals'}{live.length >= MAX_DAY_ITEMS ? ' (limit)' : ''}</small>
        </div>
        <div className="mm-save-actions">
          {undo?.date === date && !dirty && <button className="button button-small" disabled={busy} onClick={() => void undoSave()}>Undo last save</button>}
          {dirty && <button className="button button-small" disabled={busy} onClick={() => { if (window.confirm('Throw away your changes and show what is saved?')) { clearDraft(userId, date); apply(savedItems); } }}>Discard</button>}
          <button className="button button-primary" disabled={!dirty || busy || tooOld} onClick={() => void save()}>{busy ? 'Saving…' : 'Save day'}</button>
        </div>
      </div>

      {dialog === 'from' && <CopyFromDialog date={date} today={today} onClose={() => setDialog(null)} fetchDay={async (day) => { await fetchWeek(weekStartOf(day)); return week.current[day] ?? []; }} onPick={(items, replace) => { loadInto(items, replace); setDialog(null); toast(`Copied into the editor. Press Save to publish ${dayLabel(date)}.`, 'info'); }} hasRows={live.length > 0} />}
      {dialog === 'to' && <CopyToDialog date={date} today={today} minDay={minDay} items={live} onClose={() => setDialog(null)} onDone={async () => { for (const start of [...loadedWeeks.current]) loadedWeeks.current.delete(start); await fetchWeek(weekStartOf(date), true).catch(() => {}); clearMenu(); setDialog(null); }} />}
      {dialog === 'templates' && <TemplatesDialog date={date} today={today} minDay={minDay} items={live} onClose={() => setDialog(null)} onLoad={(items) => { loadInto(items, true); setDialog(null); toast(`Template loaded. Press Save to publish ${dayLabel(date)}.`, 'info'); }} onApplied={async () => { for (const start of [...loadedWeeks.current]) loadedWeeks.current.delete(start); await fetchWeek(weekStartOf(date), true).catch(() => {}); clearMenu(); }} />}
    </div>
  );
}

// What will be saved, exactly as people will see it, with the line-level notes from the parser.
function Preview({ rows, warnings }: { rows: DraftDish[]; warnings: { line: number; level: 'warn' | 'info'; message: string }[] }) {
  return (
    <section className="mm-preview" aria-label="Preview of what will be saved">
      <h3>Preview <small>{rows.length} {rows.length === 1 ? 'dish' : 'dishes'}</small></h3>
      {warnings.length > 0 && (
        <ul className="mm-warnings">{warnings.map((warning, index) => <li key={index} className={warning.level}><b>Line {warning.line}</b> {warning.message}</li>)}</ul>
      )}
      {rows.length === 0 ? <p className="muted">Start typing on the left and the menu appears here.</p> : MEAL_IDS.map((meal) => {
        const inMeal = rows.filter((row) => row.meal === meal);
        if (!inMeal.length) return null;
        return (
          <div key={meal} className="mm-pv-meal">
            <h4>{MEALS[meal].emoji} {MEALS[meal].label}</h4>
            {COURSE_IDS.map((course) => {
              const list = inMeal.filter((row) => row.course === course);
              return list.length ? (
                <div key={course}>
                  <h5>{COURSES[course].label}</h5>
                  <ul>{list.map((row, index) => <li key={`${row.name}-${index}`}><DietMark diet={row.diet} small /><span>{row.emoji && `${row.emoji} `}{row.name}{row.special && <b className="mm-special"> ★</b>}{row.note && <em> · {row.note}</em>}</span></li>)}</ul>
                </div>
              ) : null;
            })}
          </div>
        );
      })}
    </section>
  );
}

function GridEditor({ rows, onCommit }: { rows: Row[]; onCommit: (next: Row[]) => void }) {
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [quick, setQuick] = useState<Record<string, string>>({});
  const [quickCourse, setQuickCourse] = useState<Record<string, CourseId>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const controls = (row: Row, position: number, count: number) => (
    <>
      <button type="button" className={`mm-star ${row.special ? 'on' : ''}`} aria-pressed={row.special} aria-label={`Mark ${row.name || 'dish'} as a special`} title="Today's special" onClick={() => patch(row.key, { special: !row.special })}>★</button>
      <button type="button" className="icon-button mm-up" onClick={() => move(row.key, -1)} disabled={position === 0} aria-label={`Move ${row.name || 'dish'} up`}><Icon name="back" size={14} /></button>
      <button type="button" className="icon-button mm-down" onClick={() => move(row.key, 1)} disabled={position === count - 1} aria-label={`Move ${row.name || 'dish'} down`}><Icon name="arrow" size={14} /></button>
    </>
  );

  useEffect(() => {
    if (focusKey && inputs.current[focusKey]) { inputs.current[focusKey]!.focus(); setFocusKey(null); }
  }, [focusKey, rows]);

  const patch = (key: string, change: Partial<DraftDish>) => onCommit(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const remove = (key: string) => onCommit(rows.filter((row) => row.key !== key));
  const sameGroup = (a: Row, b: Row) => a.meal === b.meal && a.course === b.course;
  const move = (key: string, delta: number) => {
    const index = rows.findIndex((row) => row.key === key);
    let other = index + delta;
    while (other >= 0 && other < rows.length && !sameGroup(rows[other], rows[index])) other += delta;
    if (index < 0 || other < 0 || other >= rows.length) return;
    const next = [...rows];
    [next[index], next[other]] = [next[other], next[index]];
    onCommit(next);
    setFocusKey(key);
  };
  const addAfter = (after: Row, base: Row[] = rows) => {
    const fresh: Row = { key: uid(), meal: after.meal, course: after.course, name: '', diet: after.diet, note: '', special: false, emoji: '' };
    const index = base.findIndex((row) => row.key === after.key);
    onCommit([...base.slice(0, index + 1), fresh, ...base.slice(index + 1)]);
    setFocusKey(fresh.key);
  };
  // Marks typed into a name ("Fish fry (nv)", "Idli, Vada") are understood when you leave the box or press Enter.
  const tidy = (key: string): Row[] => {
    const row = rows.find((entry) => entry.key === key);
    if (!row || !row.name.trim()) return rows;
    const [first, ...more] = parseMenuText(`${MEALS[row.meal].label}\n${COURSES[row.course].label}:\n${row.name}`).items;
    if (!first) return rows;
    const updated: Row = { ...row, name: first.name, diet: first.dietMarked ? first.diet : row.diet, note: first.note || row.note, special: row.special || first.special, emoji: first.emoji || row.emoji };
    const extra = more.map(({ line: _line, dietMarked: _marked, ...dish }) => toRow(dish));
    if (!extra.length && updated.name === row.name && updated.diet === row.diet && updated.note === row.note && updated.special === row.special && updated.emoji === row.emoji) return rows;
    return rows.flatMap((entry) => (entry.key === key ? [updated, ...extra] : [entry]));
  };
  const tidyNow = (key: string) => { const next = tidy(key); if (next !== rows) onCommit(next); };
  const dropOn = (target: Row) => {
    if (!dragKey || dragKey === target.key) return;
    const dragged = rows.find((row) => row.key === dragKey);
    if (!dragged) return;
    const rest = rows.filter((row) => row.key !== dragKey);
    const index = rest.findIndex((row) => row.key === target.key);
    onCommit([...rest.slice(0, index), { ...dragged, meal: target.meal, course: target.course }, ...rest.slice(index)]);
    setDragKey(null);
  };
  const quickAdd = (meal: MealId) => {
    const value = (quick[meal] ?? '').trim();
    if (!value) return;
    const course = quickCourse[meal] ?? 'mains';
    const result = parseMenuText(`${MEALS[meal].label}\n${COURSES[course].label}:\n${value}`);
    const have = new Set(rows.map((row) => dishKey(row.meal, row.name)));
    const fresh = result.items.filter((item) => !have.has(dishKey(item.meal, item.name))).map(({ line: _l, dietMarked: _m, ...dish }) => toRow(dish));
    if (fresh.length) onCommit([...rows, ...fresh]);
    setQuick((current) => ({ ...current, [meal]: '' }));
  };

  return (
    <div className="mm-grid">
      {MEAL_IDS.map((meal) => {
        const inMeal = rows.filter((row) => row.meal === meal);
        return (
          <section key={meal} className="mm-meal">
            <h3>{MEALS[meal].emoji} {MEALS[meal].label} <small>{inMeal.filter(named).length}</small></h3>
            {COURSE_IDS.map((course) => {
              const list = inMeal.filter((row) => row.course === course);
              if (!list.length) return null;
              return (
                <div key={course} className="mm-course">
                  <h4>{COURSES[course].label}</h4>
                  <ul>
                    {list.map((row, position) => (
                      <li key={row.key} className={`mm-row ${dragKey === row.key ? 'dragging' : ''}`} onDragOver={(event) => { if (dragKey) event.preventDefault(); }} onDrop={() => dropOn(row)}>
                        <span className="mm-grip" draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.key); setDragKey(row.key); }} onDragEnd={() => setDragKey(null)} aria-hidden="true" title="Drag to reorder">⠿</span>
                        <button type="button" className="mm-diet" onClick={() => patch(row.key, { diet: nextDiet(row.diet) })} aria-label={`${row.name || 'Dish'}: ${DIETS[row.diet].label}. Tap to change`} title={`${DIETS[row.diet].label} (tap to change)`}><DietMark diet={row.diet} /></button>
                        <input
                          ref={(element) => { inputs.current[row.key] = element; }} className="mm-name" value={row.name} maxLength={NAME_MAX} placeholder="Dish name" aria-label="Dish name"
                          onChange={(event) => patch(row.key, { name: event.target.value })}
                          onBlur={() => tidyNow(row.key)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') { event.preventDefault(); if (row.name.trim()) { const base = tidy(row.key); const current = base.find((entry) => entry.key === row.key) ?? row; addAfter(current, base); } }
                            else if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); move(row.key, -1); }
                            else if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); move(row.key, 1); }
                            else if (event.key === 'Backspace' && !row.name) {
                              event.preventDefault();
                              const index = rows.findIndex((entry) => entry.key === row.key);
                              remove(row.key);
                              if (index > 0) setFocusKey(rows[index - 1].key);
                            }
                          }}
                        />
                        <span className="mm-ctrl wide">{controls(row, position, list.length)}</span>
                        <button type="button" className={`icon-button mm-more ${expanded.has(row.key) ? 'on' : ''}`} aria-expanded={expanded.has(row.key)} onClick={() => setExpanded((current) => { const next = new Set(current); if (!next.delete(row.key)) next.add(row.key); return next; })} aria-label={`More options for ${row.name || 'dish'}`} title="Section, meal, note, emoji"><Icon name="settings" size={15} /></button>
                        <button type="button" className="icon-button danger" onClick={() => remove(row.key)} aria-label={`Delete ${row.name || 'dish'}`}><Icon name="trash" size={15} /></button>
                        {!expanded.has(row.key) && (row.note || row.emoji) && <small className="mm-summary">{row.emoji} {row.note}</small>}
                        {expanded.has(row.key) && (
                          <div className="mm-sub">
                            <span className="mm-ctrl narrow">{controls(row, position, list.length)}</span>
                            <select value={row.course} onChange={(event) => patch(row.key, { course: event.target.value as CourseId })} aria-label="Section">{COURSE_IDS.map((id) => <option key={id} value={id}>{COURSES[id].label}</option>)}</select>
                            <select value={row.meal} onChange={(event) => patch(row.key, { meal: event.target.value as MealId })} aria-label="Meal">{MEAL_IDS.map((id) => <option key={id} value={id}>{MEALS[id].label}</option>)}</select>
                            <input value={row.note} maxLength={NOTE_MAX} placeholder="Note (optional)" aria-label="Note" onChange={(event) => patch(row.key, { note: event.target.value })} />
                            <input className="mm-emoji" value={row.emoji} maxLength={8} placeholder="🍽️" aria-label="Emoji" onChange={(event) => patch(row.key, { emoji: event.target.value })} />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <div className="mm-quick">
              <select value={quickCourse[meal] ?? 'mains'} onChange={(event) => setQuickCourse((current) => ({ ...current, [meal]: event.target.value as CourseId }))} aria-label={`Section for new ${MEALS[meal].label} dishes`}>{COURSE_IDS.map((id) => <option key={id} value={id}>{COURSES[id].label}</option>)}</select>
              <input
                value={quick[meal] ?? ''} placeholder="Add dishes, e.g. Paneer tikka (v), Fish fry (nv)" aria-label={`Add dishes to ${MEALS[meal].label}`}
                onChange={(event) => setQuick((current) => ({ ...current, [meal]: event.target.value }))}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); quickAdd(meal); } }}
              />
              <button type="button" className="button button-small" onClick={() => quickAdd(meal)} disabled={!(quick[meal] ?? '').trim()}><Icon name="plus" size={15} /> Add</button>
            </div>
          </section>
        );
      })}
      <p className="muted mm-grid-hint">Tap a dot to switch veg, non-veg, egg and vegan. Enter adds a row, Alt + ↑ / ↓ moves it, Backspace on an empty row removes it.</p>
    </div>
  );
}

function DatePicks({ dates, onChange, from, anchor, minDay }: { dates: string[]; onChange: (dates: string[]) => void; from: string; anchor: string; minDay: string }) {
  const options = Array.from({ length: 14 }, (_, i) => shiftDay(from, i)).filter((d) => d >= minDay);
  const toggle = (d: string) => onChange(dates.includes(d) ? dates.filter((x) => x !== d) : [...dates, d].slice(0, 14));
  const extra = dates.filter((d) => !options.includes(d)).sort();
  return (
    <div className="mm-dates">
      <div className="chip-row">
        {[...options, ...extra].map((d) => <button type="button" key={d} className={`chip ${dates.includes(d) ? 'on' : ''}`} aria-pressed={dates.includes(d)} onClick={() => toggle(d)}>{dayLabel(d, { weekday: 'short', day: 'numeric', month: 'short' })}</button>)}
      </div>
      <div className="mm-date-quick">
        <input type="date" aria-label="Add another date" min={minDay} onChange={(event) => { if (event.target.value && !dates.includes(event.target.value)) onChange([...dates, event.target.value].slice(0, 14)); event.target.value = ''; }} />
        <button type="button" className="button button-small" onClick={() => onChange([1, 2, 3, 4].map((w) => shiftDay(anchor, 7 * w)))}>Same weekday, next 4 weeks</button>
        <button type="button" className="button button-small" onClick={() => onChange(options.filter((d) => { const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); return dow >= 1 && dow <= 5; }).slice(0, 10))}>Weekdays</button>
        {dates.length > 0 && <button type="button" className="button button-small" onClick={() => onChange([])}>None</button>}
      </div>
    </div>
  );
}

function CopyFromDialog({ date, today, hasRows, onClose, fetchDay, onPick }: { date: string; today: string; hasRows: boolean; onClose: () => void; fetchDay: (day: string) => Promise<DraftDish[]>; onPick: (items: DraftDish[], replace: boolean) => void }) {
  const { toast } = useKit();
  const [replace, setReplace] = useState(true);
  const [other, setOther] = useState(shiftDay(today, -1));
  const [busy, setBusy] = useState(false);
  async function pick(day: string) {
    setBusy(true);
    try {
      const items = await fetchDay(day);
      if (!items.length) { toast(`${dayLabel(day)} has no saved menu to copy.`, 'info'); return; }
      onPick(items, replace);
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title="Copy a day into the editor" onClose={onClose}>
      <div className="form-stack">
        <p className="muted">Pick a saved day to start from. It lands in the editor, so you can tweak it before pressing Save.</p>
        <div className="mm-radio" role="radiogroup" aria-label="What to do with what is already there">
          <label><input type="radio" checked={replace} onChange={() => setReplace(true)} /> Replace what is in the editor</label>
          <label><input type="radio" checked={!replace} onChange={() => setReplace(false)} disabled={!hasRows} /> Add to what is there (skips repeats)</label>
        </div>
        <div className="mm-copy-buttons">
          <button className="button" disabled={busy} onClick={() => void pick(shiftDay(date, -1))}>Yesterday<small>{dayLabel(shiftDay(date, -1), { weekday: 'short', day: 'numeric', month: 'short' })}</small></button>
          <button className="button" disabled={busy} onClick={() => void pick(shiftDay(date, -7))}>Same weekday last week<small>{dayLabel(shiftDay(date, -7), { weekday: 'short', day: 'numeric', month: 'short' })}</small></button>
        </div>
        <div className="mm-date-quick">
          <input type="date" value={other} onChange={(event) => setOther(event.target.value)} aria-label="Another date" />
          <button className="button" disabled={busy || !other} onClick={() => void pick(other)}>Copy this date</button>
        </div>
      </div>
    </Modal>
  );
}

function CopyToDialog({ date, today, minDay, items, onClose, onDone }: { date: string; today: string; minDay: string; items: DraftDish[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useKit();
  const [dates, setDates] = useState<string[]>([]);
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await api('/admin/menu/copy', { method: 'POST', body: { items: items.map((item) => toPayload(item)), dates, replace } });
      toast(`Published to ${dates.length} ${dates.length === 1 ? 'day' : 'days'}.`, 'success');
      await onDone();
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title="Copy to other dates" onClose={onClose} wide>
      <div className="form-stack">
        <p className="muted">This puts what is in the editor ({items.length} dishes, saved or not) on the days you choose, straight away. {dayLabel(date)} itself is not changed until you press Save.</p>
        <DatePicks dates={dates} onChange={setDates} from={today > date ? today : shiftDay(date, 1)} anchor={date} minDay={minDay} />
        <div className="mm-radio" role="radiogroup" aria-label="Existing menus on those days">
          <label><input type="radio" checked={replace} onChange={() => setReplace(true)} /> Replace their menus</label>
          <label><input type="radio" checked={!replace} onChange={() => setReplace(false)} /> Add to their menus (skips repeats)</label>
        </div>
        <div className="modal-actions"><button className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || dates.length === 0} onClick={() => void run()}>{busy ? 'Copying…' : `Copy to ${dates.length || ''} ${dates.length === 1 ? 'day' : 'days'}`}</button></div>
      </div>
    </Modal>
  );
}

function TemplatesDialog({ date, today, minDay, items, onClose, onLoad, onApplied }: { date: string; today: string; minDay: string; items: DraftDish[]; onClose: () => void; onLoad: (items: DraftDish[]) => void; onApplied: () => Promise<void> }) {
  const { toast } = useKit();
  const [list, setList] = useState<Template[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const refresh = useCallback(async () => { try { setList((await api<{ templates: Template[] }>('/admin/menu/templates')).templates); } catch (reason) { toast(messageOf(reason), 'error'); setList([]); } }, [toast]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function saveTemplate() {
    setBusy(true);
    try { await api('/admin/menu/templates', { method: 'POST', body: { name, items: items.map((item) => toPayload(item)) } }); setName(''); toast('Template saved.', 'success'); await refresh(); } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }
  async function load(template: Template) {
    try { onLoad(toDraftList((await api<{ items: MenuDish[] }>(`/admin/menu/templates/${template.id}`)).items)); } catch (reason) { toast(messageOf(reason), 'error'); }
  }
  async function remove(template: Template) {
    if (!window.confirm(`Delete the template “${template.name}”?`)) return;
    try { await api(`/admin/menu/templates/${template.id}`, { method: 'DELETE' }); await refresh(); } catch (reason) { toast(messageOf(reason), 'error'); }
  }
  async function applyTo(template: Template) {
    setBusy(true);
    try { await api(`/admin/menu/templates/${template.id}/apply`, { method: 'POST', body: { dates, replace: true } }); toast(`“${template.name}” is now on ${dates.length} ${dates.length === 1 ? 'day' : 'days'}.`, 'success'); setApplying(null); setDates([]); await onApplied(); } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }

  return (
    <Modal title="Menu templates" onClose={onClose} wide>
      <div className="form-stack">
        <p className="muted">Save a day as a template (for example “Monday”) and put it on any dates in one go. Applying a template replaces the menu on those days.</p>
        <form className="mm-template-save" onSubmit={(event) => { event.preventDefault(); void saveTemplate(); }}>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder={`Name for ${dayLabel(date)}'s menu`} aria-label="Template name" />
          <button className="button button-primary" disabled={busy || !name.trim() || items.length === 0}>Save this day as a template</button>
        </form>
        {list === null ? <Spinner /> : list.length === 0 ? <p className="muted">No templates yet.</p> : (
          <ul className="mm-templates">
            {list.map((template) => (
              <li key={template.id}>
                <div className="mm-template-row">
                  <div><strong>{template.name}</strong><small>{template.count} dishes</small></div>
                  <div className="mm-template-actions">
                    <button className="button button-small" onClick={() => void load(template)}>Use in editor</button>
                    <button className="button button-small" onClick={() => { setApplying(applying === template.id ? null : template.id); setDates([]); }}>Apply to dates…</button>
                    <button className="icon-button danger" aria-label={`Delete ${template.name}`} onClick={() => void remove(template)}><Icon name="trash" size={16} /></button>
                  </div>
                </div>
                {applying === template.id && (
                  <div className="mm-apply">
                    <DatePicks dates={dates} onChange={setDates} from={today > date ? today : shiftDay(date, 1)} anchor={date} minDay={minDay} />
                    <button className="button button-primary" disabled={busy || dates.length === 0} onClick={() => void applyTo(template)}>{busy ? 'Applying…' : `Apply to ${dates.length || ''} ${dates.length === 1 ? 'day' : 'days'}`}</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

const toDraftList = (items: MenuDish[]) => items.map(toDraft);
