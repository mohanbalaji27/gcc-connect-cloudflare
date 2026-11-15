import { useCallback, useEffect, useState } from 'react';
import { MEALS, type MenuItem } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia, todayInIndia } from '../../lib/format';
import { Empty, Field, Icon, Modal, Spinner, useKit } from '../kit';

const DIET_DOT: Record<string, string> = { veg: '#2f9e3f', 'non-veg': '#d64545', vegan: '#0a8f6a', egg: '#d6a300' };
export const DietDot = ({ diet }: { diet: string }) => <i className="diet-dot" style={{ borderColor: DIET_DOT[diet], color: DIET_DOT[diet] }} title={diet} aria-label={diet} />;

export function DishModal({ onClose, onSaved, initialDate }: { onClose: () => void; onSaved: () => void; initialDate?: string }) {
  const { toast } = useKit();
  const [date, setDate] = useState(initialDate ?? todayInIndia());
  const [repeat, setRepeat] = useState(1);
  const [meal, setMeal] = useState('lunch');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [diet, setDiet] = useState('veg');
  const [emoji, setEmoji] = useState('🍛');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const dates = Array.from({ length: repeat }, (_, i) => new Date(Date.parse(`${date}T12:00:00+05:30`) + i * 86_400_000)).map((d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d));
      const result = await api<{ added: number }>('/admin/menu', { method: 'POST', body: { dates, meal, name, description, diet, emoji } });
      toast(`${name} added on ${result.added} ${result.added === 1 ? 'day' : 'days'}.`, 'success');
      onSaved();
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title="Add a dish" onClose={onClose} wide>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Dish name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus placeholder="Paneer butter masala" /></Field>
        <Field label="Emoji"><input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={8} /></Field>
        <Field label="Meal"><select value={meal} onChange={(e) => setMeal(e.target.value)}>{Object.entries(MEALS).map(([id, m]) => <option key={id} value={id}>{m.emoji} {m.label}</option>)}</select></Field>
        <Field label="Diet"><select value={diet} onChange={(e) => setDiet(e.target.value)}><option value="veg">Veg</option><option value="non-veg">Non-veg</option><option value="vegan">Vegan</option><option value="egg">Egg</option></select></Field>
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <Field label="Repeat for" hint="Add the same dish on consecutive days"><select value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}><option value={1}>Just this day</option><option value={5}>5 days</option><option value={7}>7 days</option><option value={14}>14 days</option></select></Field>
        <div className="span-2"><Field label="Description (optional)"><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="With jeera rice and salad" /></Field></div>
        <div className="modal-actions span-2"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Adding…' : 'Add dish'}</button></div>
      </form>
    </Modal>
  );
}

export function ManageMenu() {
  const { toast } = useKit();
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [adding, setAdding] = useState(false);
  const from = todayInIndia();

  const load = useCallback(async () => {
    try { setItems((await api<{ items: MenuItem[] }>(`/menu?from=${from}&days=14&manage=1`)).items); } catch (reason) { toast(messageOf(reason), 'error'); setItems([]); }
  }, [from, toast]);
  useEffect(() => { void load(); }, [load]);

  async function remove(item: MenuItem) {
    try { await api(`/admin/menu/${item.id}`, { method: 'DELETE' }); await load(); } catch (reason) { toast(messageOf(reason), 'error'); }
  }
  const days = [...new Set((items ?? []).map((item) => item.date))];

  return (
    <section className="panel">
      <div className="panel-head"><h2>Food menu · next 14 days</h2><button className="button button-primary button-small" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add dish</button></div>
      {items === null ? <Spinner /> : items.length === 0 ? <Empty icon="utensils" title="No dishes yet">Add today&apos;s lunch and watch the likes roll in.</Empty> : days.map((day) => (
        <div key={day} className="menu-day-admin">
          <h3 className="section-title">{inIndia(`${day}T12:00:00+05:30`, { weekday: 'long', day: 'numeric', month: 'short' })}</h3>
          <ul className="plain-list">
            {items.filter((item) => item.date === day).map((item) => (
              <li key={item.id}><div><strong>{item.emoji} {item.name} <DietDot diet={item.diet} /></strong><small>{MEALS[item.meal].label} · {item.likes} likes{item.description ? ` · ${item.description}` : ''}</small></div><button className="icon-button danger" aria-label={`Remove ${item.name}`} onClick={() => void remove(item)}><Icon name="trash" size={16} /></button></li>
            ))}
          </ul>
        </div>
      ))}
      {adding && <DishModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void load(); }} />}
    </section>
  );
}
