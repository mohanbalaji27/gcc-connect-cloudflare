import { useCallback, useEffect, useState } from 'react';
import { api, messageOf } from '../../lib/api';
import type { Ctx } from '../App';
import { Spinner, useKit } from '../kit';
import '../issues.css';

interface Choice { value: boolean; source: 'you' | 'role' | 'default' | 'routing' }
interface Prefs {
  types: { id: string; inapp: Choice }[];
  categories: { id: string; name: string; emoji: string; subscribed: boolean; source: Choice['source'] }[];
}
const SOURCE: Record<Choice['source'], string> = { you: 'Your choice', role: 'From your role', default: 'Default', routing: 'Because you are assigned to it' };

// A checkbox matrix of what to be told about, per channel. Choices you make win over your role's defaults; “Reset” goes back to them.
export function NotificationPrefs({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const catalog = ctx.config.notificationCatalog;
  const channels = catalog.channels.filter((channel) => channel.available);
  const [prefs, setPrefs] = useState<Prefs | null>(null);

  const load = useCallback(async () => {
    try { setPrefs(await api<Prefs>('/me/notification-prefs')); } catch (reason) { toast(messageOf(reason), 'error'); setPrefs({ types: [], categories: [] }); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function save(body: Record<string, unknown>) {
    try { await api('/me/notification-prefs', { method: 'PUT', body }); await load(); } catch (reason) { toast(messageOf(reason), 'error'); void load(); }
  }
  const setType = (id: string, value: boolean | null) => {
    setPrefs((current) => current && { ...current, types: current.types.map((type) => (type.id === id ? { ...type, inapp: { value: value ?? type.inapp.value, source: value === null ? 'role' : 'you' } } : type)) });
    void save({ types: { [id]: { inapp: value } } });
  };
  const setCategory = (id: string, value: boolean | null) => {
    setPrefs((current) => current && { ...current, categories: current.categories.map((category) => (category.id === id ? { ...category, subscribed: value ?? category.subscribed, source: value === null ? 'role' : 'you' } : category)) });
    void save({ categories: { [id]: value } });
  };

  if (!prefs) return <section className="panel"><h2>Notifications</h2><Spinner /></section>;
  const groups = [...new Set(prefs.types.map((entry) => catalog.types.find((type) => type.id === entry.id)?.group ?? 'Other'))];
  return (
    <section className="panel form-stack">
      <h2>Notifications</h2>
      <p className="muted">Pick what you want to hear about. You only see choices that are relevant to your access.</p>
      {groups.map((group) => (
        <div key={group} className="pref-table">
          <div className="pref-head"><span>{group}</span>{channels.map((channel) => <span key={channel.id}>{channel.label}</span>)}</div>
          {prefs.types.filter((entry) => (catalog.types.find((type) => type.id === entry.id)?.group ?? 'Other') === group).map((entry) => {
            const type = catalog.types.find((item) => item.id === entry.id);
            return (
              <label key={entry.id} className="pref-row">
                <span><strong>{type?.label ?? entry.id}</strong><small>{type?.description} · {SOURCE[entry.inapp.source]}{entry.inapp.source === 'you' && <> · <button type="button" className="text-link" onClick={(event) => { event.preventDefault(); setType(entry.id, null); }}>Reset</button></>}</small></span>
                <input type="checkbox" checked={entry.inapp.value} onChange={(event) => setType(entry.id, event.target.checked)} aria-label={`${type?.label}: in-app`} />
              </label>
            );
          })}
        </div>
      ))}
      {prefs.categories.length > 0 && (
        <div className="pref-table">
          <div className="pref-head"><span>Tell me about these issue categories</span><span>In-app</span></div>
          {prefs.categories.map((category) => (
            <label key={category.id} className="pref-row">
              <span><strong>{category.emoji} {category.name}</strong><small>{SOURCE[category.source]}{category.source === 'you' && <> · <button type="button" className="text-link" onClick={(event) => { event.preventDefault(); setCategory(category.id, null); }}>Reset</button></>}</small></span>
              <input type="checkbox" checked={category.subscribed} onChange={(event) => setCategory(category.id, event.target.checked)} aria-label={`${category.name} issues`} />
            </label>
          ))}
        </div>
      )}
      <small className="muted">Browser push notifications are coming soon.</small>
    </section>
  );
}
