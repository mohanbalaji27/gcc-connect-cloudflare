import { useCallback, useEffect, useState } from 'react';
import type { IssuePriority } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { PRIORITY_LABEL } from '../../lib/issues';
import type { Ctx } from '../App';
import { Empty, Field, Icon, Modal, Spinner, Switch, useKit } from '../kit';
import '../issues.css';

interface Route { employeeId?: string; roleId?: string; name: string; emoji?: string }
interface Category {
  id: string; name: string; emoji: string; description: string; sortOrder: number; active: boolean; defaultPriority: IssuePriority; slaHours: number | null; openIssues: number;
  routes: { notify: Route[]; escalate: Route[]; assign: Route[] };
}
interface Data { categories: Category[]; roles: { id: string; name: string; emoji: string }[] }
type Kind = 'notify' | 'escalate' | 'assign';
const KIND_LABEL: Record<Kind, { title: string; hint: string }> = {
  notify: { title: 'Tell about new issues', hint: 'People and roles who get a notification for every new issue here. Facility managers are always included.' },
  escalate: { title: 'Escalate urgent ones to', hint: 'Told about urgent issues, and when someone asks for help. Facility managers are always included.' },
  assign: { title: 'Default assignee', hint: 'New issues are given to the one with the fewest open issues. Only people who can work on issues are used.' },
};

// Categories for the issue box: add, edit, reorder, switch off, and choose who is notified, escalated to and assigned.
export function ManageIssues({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const canCategories = ctx.user.permissions.includes('issues.manage_categories');
  const canRouting = ctx.user.permissions.includes('notifications.route');
  const [data, setData] = useState<Data | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string; email: string }[]>([]);
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [routing, setRouting] = useState<Category | null>(null);

  const load = useCallback(async () => {
    try { setData(await api<Data>('/admin/issue-categories')); } catch (reason) { toast(messageOf(reason), 'error'); setData({ categories: [], roles: [] }); }
  }, [toast]);
  useEffect(() => { void load(); void api<{ employees: { id: string; name: string; email: string }[] }>('/admin/employee-options').then((result) => setPeople(result.employees)).catch(() => {}); }, [load]);

  async function move(index: number, delta: number) {
    if (!data) return;
    const list = [...data.categories];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    setData({ ...data, categories: list });
    try { await api('/admin/issue-categories-order', { method: 'PUT', body: { ids: list.map((item) => item.id) } }); } catch (reason) { toast(messageOf(reason), 'error'); void load(); }
  }
  async function toggle(category: Category, active: boolean) {
    setData((current) => current && { ...current, categories: current.categories.map((item) => (item.id === category.id ? { ...item, active } : item)) });
    try { await api(`/admin/issue-categories/${category.id}`, { method: 'PATCH', body: { active } }); } catch (reason) { toast(messageOf(reason), 'error'); void load(); }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Issue categories</h2>
        <div className="panel-tools">
          {ctx.user.permissions.includes('issues.export') && <a className="button button-small" href="/api/admin/issues/export" download><Icon name="download" size={15} /> Export issues</a>}
          {canCategories && <button className="button button-primary button-small" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> New category</button>}
        </div>
      </div>
      <p className="muted">These are the tiles people tap to report a problem. Set who is told, who gets urgent ones and who gets new issues by default. The order here is the order people see.</p>
      {data === null ? <Spinner /> : data.categories.length === 0 ? <Empty icon="wrench" title="No categories yet">Add the first one.</Empty> : (
        <div>
          {data.categories.map((category, index) => (
            <div key={category.id} className={`cat-row ${category.active ? '' : 'off'}`}>
              {canCategories && <span className="iss-reorder"><button className="icon-button" aria-label={`Move ${category.name} up`} disabled={index === 0} onClick={() => void move(index, -1)}><Icon name="arrow" size={14} /></button></span>}
              <span className="iss-emoji" aria-hidden="true">{category.emoji}</span>
              <span className="cat-main"><strong>{category.name}</strong>
                <small>{PRIORITY_LABEL[category.defaultPriority]} by default{category.slaHours ? ` · target ${category.slaHours} h` : ''} · {category.openIssues} open · {category.routes.notify.length + category.routes.escalate.length + category.routes.assign.length} routing rules</small></span>
              {canCategories && <Switch checked={category.active} label={`${category.name} is shown to people`} onChange={(value) => void toggle(category, value)} />}
              {canCategories && <button className="icon-button" aria-label={`Move ${category.name} down`} disabled={index === data.categories.length - 1} onClick={() => void move(index, 1)}><Icon name="back" size={14} /></button>}
              {canCategories && <button className="button button-small" onClick={() => setEditing(category)}><Icon name="edit" size={15} /> Edit</button>}
              {canRouting && <button className="button button-small" onClick={() => setRouting(category)}><Icon name="users" size={15} /> Who is told</button>}
            </div>
          ))}
        </div>
      )}
      {editing && <CategoryForm category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {routing && data && <RoutingForm category={routing} people={people} roles={data.roles} onClose={() => setRouting(null)} onSaved={() => { setRouting(null); void load(); }} />}
    </section>
  );
}

function CategoryForm({ category, onClose, onSaved }: { category: Category | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(category?.name ?? '');
  const [emoji, setEmoji] = useState(category?.emoji ?? '🔧');
  const [description, setDescription] = useState(category?.description ?? '');
  const [priority, setPriority] = useState<IssuePriority>(category?.defaultPriority ?? 'normal');
  const [sla, setSla] = useState(category?.slaHours ? String(category.slaHours) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const hours = sla.trim() ? Number(sla) : null;
    try {
      const body = { name, emoji, description, defaultPriority: priority, slaHours: hours };
      if (category) await api(`/admin/issue-categories/${category.id}`, { method: 'PATCH', body }); else await api('/admin/issue-categories', { method: 'POST', body });
      onSaved();
    } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }
  return (
    <Modal title={category ? `Edit ${category.name}` : 'New category'} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} autoFocus /></Field>
          <Field label="Emoji"><input value={emoji} onChange={(event) => setEmoji(event.target.value)} maxLength={8} /></Field>
          <div className="span-2"><Field label="Examples shown to people"><input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={160} placeholder="Coffee machine, water dispenser, fridge" /></Field></div>
          <Field label="Default priority"><select value={priority} onChange={(event) => setPriority(event.target.value as IssuePriority)}>{(['low', 'normal', 'high', 'urgent'] as IssuePriority[]).map((level) => <option key={level} value={level}>{PRIORITY_LABEL[level]}</option>)}</select></Field>
          <Field label="Target time to fix (hours)" hint="Optional. Open issues past it get an “Overdue” badge."><input type="number" inputMode="numeric" min={1} max={2160} value={sla} onChange={(event) => setSla(event.target.value)} /></Field>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </Modal>
  );
}

function RoutingForm({ category, people, roles, onClose, onSaved }: {
  category: Category; people: { id: string; name: string; email: string }[]; roles: Data['roles']; onClose: () => void; onSaved: () => void;
}) {
  const [routes, setRoutes] = useState(category.routes);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const has = (kind: Kind, route: Route) => routes[kind].some((item) => (route.employeeId ? item.employeeId === route.employeeId : item.roleId === route.roleId));
  const add = (kind: Kind, route: Route) => { if (!has(kind, route)) setRoutes({ ...routes, [kind]: [...routes[kind], route] }); };
  const remove = (kind: Kind, index: number) => setRoutes({ ...routes, [kind]: routes[kind].filter((_, i) => i !== index) });
  async function save() {
    setBusy(true);
    setError('');
    const body = Object.fromEntries((['notify', 'escalate', 'assign'] as Kind[]).map((kind) => [kind, routes[kind].map((route) => (route.employeeId ? { employeeId: route.employeeId } : { roleId: route.roleId }))]));
    try { await api(`/admin/issue-categories/${category.id}/routes`, { method: 'PUT', body }); onSaved(); } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Who is told: ${category.name}`} onClose={onClose} wide>
      <div className="route-grid">
        {(['notify', 'escalate', 'assign'] as Kind[]).map((kind) => (
          <div key={kind} className="route-box">
            <h4>{KIND_LABEL[kind].title}</h4>
            <small>{KIND_LABEL[kind].hint}</small>
            <div className="route-chips">
              {routes[kind].length === 0 && <span className="muted">Nobody added</span>}
              {routes[kind].map((route, index) => <span key={route.employeeId ?? route.roleId} className="chip static">{route.employeeId ? '👤' : route.emoji ?? '🛡️'} {route.name}<button type="button" aria-label={`Remove ${route.name}`} onClick={() => remove(kind, index)}>×</button></span>)}
            </div>
            <select value="" aria-label={`Add a person to ${KIND_LABEL[kind].title}`} onChange={(event) => { const person = people.find((item) => item.id === event.target.value); if (person) add(kind, { employeeId: person.id, name: person.name }); }}>
              <option value="">Add a person…</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}{person.email ? ` · ${person.email}` : ''}</option>)}
            </select>
            {kind !== 'assign' && (
              <select value="" aria-label={`Add a role to ${KIND_LABEL[kind].title}`} onChange={(event) => { const role = roles.find((item) => item.id === event.target.value); if (role) add(kind, { roleId: role.id, name: role.name, emoji: role.emoji }); }}>
                <option value="">Add everyone with a role…</option>{roles.map((role) => <option key={role.id} value={role.id}>{role.emoji} {role.name}</option>)}
              </select>
            )}
          </div>
        ))}
      </div>
      <p className="muted small-print">People only get notified if their role allows them to see the issue queue and they have not switched these notifications off.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save routing'}</button></div>
    </Modal>
  );
}
