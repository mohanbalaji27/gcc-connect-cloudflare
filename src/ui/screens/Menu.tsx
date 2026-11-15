import { useCallback, useEffect, useState } from 'react';
import { MEALS, type MenuItem } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia, todayInIndia } from '../../lib/format';
import type { Ctx } from '../App';
import { Empty, Icon, Spinner, useKit } from '../kit';
import { DietDot, DishModal } from './ManageMenu';

export function MenuScreen({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const today = todayInIndia();
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [day, setDay] = useState(today);
  const [diet, setDiet] = useState('all');
  const [adding, setAdding] = useState(false);
  const canManage = ctx.user.permissions.includes('menu.manage');
  const days = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.parse(`${today}T12:00:00+05:30`) + i * 86_400_000)));

  const load = useCallback(async () => {
    try { setItems((await api<{ items: MenuItem[] }>(`/menu?from=${today}&days=7`)).items); } catch (reason) { toast(messageOf(reason), 'error'); setItems([]); }
  }, [today, toast]);
  useEffect(() => { void load(); }, [load]);

  async function like(item: MenuItem) {
    setItems((current) => current?.map((entry) => entry.id === item.id ? { ...entry, liked: !entry.liked, likes: entry.likes + (entry.liked ? -1 : 1) } : entry) ?? null);
    try { await api(`/menu/${item.id}/like`, { method: 'POST' }); } catch (reason) { toast(messageOf(reason), 'error'); void load(); }
  }

  const dayItems = (items ?? []).filter((item) => item.date === day && (diet === 'all' || item.diet === diet));
  const meals = Object.keys(MEALS).filter((meal) => dayItems.some((item) => item.meal === meal));
  const top = dayItems.length ? [...dayItems].sort((a, b) => b.likes - a.likes)[0] : null;

  return (
    <div>
      <div className="page-head">
        <div><span className="eyebrow">FOOD MENU</span><h1>What&apos;s cooking?</h1></div>
        {canManage && <button className="button button-primary" onClick={() => setAdding(true)}><Icon name="plus" size={18} /> Add dish</button>}
      </div>
      <div className="day-strip" role="tablist" aria-label="Choose a day">
        {days.map((d, i) => (
          <button key={d} role="tab" aria-selected={day === d} className={`day-chip ${day === d ? 'on' : ''}`} onClick={() => setDay(d)}>
            <span>{i === 0 ? 'Today' : inIndia(`${d}T12:00:00+05:30`, { weekday: 'short' })}</span><strong>{inIndia(`${d}T12:00:00+05:30`, { day: 'numeric' })}</strong>
            {(items ?? []).some((item) => item.date === d) && <i className="dot" />}
          </button>
        ))}
      </div>
      <div className="chip-row" role="group" aria-label="Diet filter">
        {[['all', 'Everything'], ['veg', 'Veg'], ['vegan', 'Vegan'], ['egg', 'Egg'], ['non-veg', 'Non-veg']].map(([id, label]) => <button key={id} className={`chip ${diet === id ? 'on' : ''}`} onClick={() => setDiet(id)}>{label}</button>)}
      </div>
      {items === null ? <Spinner /> : dayItems.length === 0 ? (
        <Empty icon="utensils" title="Nothing on the menu yet">The kitchen hasn&apos;t posted this one. Pack a snack, just in case 🍪</Empty>
      ) : (
        <>
          {top && top.likes > 0 && <div className="banner banner-fun">🏆 Crowd favourite: <strong>{top.emoji} {top.name}</strong> ({top.likes} {top.likes === 1 ? 'like' : 'likes'})</div>}
          {meals.map((meal) => (
            <section key={meal} className="meal-section">
              <h3 className="section-title">{MEALS[meal].emoji} {MEALS[meal].label}</h3>
              <div className="dish-grid">
                {dayItems.filter((item) => item.meal === meal).map((item) => (
                  <article key={item.id} className="dish-card">
                    <span className="dish-emoji">{item.emoji}</span>
                    <div className="dish-text"><strong>{item.name} <DietDot diet={item.diet} /></strong>{item.description && <small>{item.description}</small>}</div>
                    <button className={`like-button ${item.liked ? 'on' : ''}`} aria-pressed={item.liked} aria-label={`${item.liked ? 'Unlike' : 'Like'} ${item.name}`} onClick={() => void like(item)}>
                      <Icon name="heart" size={18} /><span>{item.likes}</span>
                    </button>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
      {adding && <DishModal initialDate={day} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void load(); }} />}
    </div>
  );
}
