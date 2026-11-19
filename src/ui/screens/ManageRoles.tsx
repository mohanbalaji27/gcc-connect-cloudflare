import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomRole, NotifyDefaults, Permission } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import type { Ctx } from '../App';
import { Empty, Field, Icon, Modal, Spinner, Switch, useKit } from '../kit';
import { AccessSummary, DiffConfirm, PermissionMatrix } from '../PermissionMatrix';

interface CategoryRef { id: string; name: string; emoji: string }

export function ManageRoles({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const [roles, setRoles] = useState<CustomRole[] | null>(null);
  const [categories, setCategories] = useState<CategoryRef[]>([]);
  const [editing, setEditing] = useState<{ role: CustomRole | null; seed?: CustomRole } | null>(null);
  const load = useCallback(async () => {
    try { setRoles((await api<{ roles: CustomRole[] }>('/admin/roles')).roles); } catch (reason) { toast(messageOf(reason), 'error'); setRoles([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (ctx.flag('issues')) void api<{ categories: CategoryRef[] }>('/admin/issue-categories').then((result) => setCategories(result.categories)).catch(() => {});
  }, [ctx]);

  async function remove(role: CustomRole) {
    if (!window.confirm(`Delete “${role.name}”?`)) return;
    try { await api(`/admin/roles/${role.id}`, { method: 'DELETE' }); toast('Role deleted.', 'success'); await load(); } catch (reason) { toast(messageOf(reason), 'error'); }
  }

  const catalog = ctx.config.permissionCatalog;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Roles</h2><button className="button button-primary button-small" onClick={() => setEditing({ role: null })}><Icon name="plus" size={16} /> New role</button></div>
      <p className="muted">A role is what a person can do, which notifications they get by default, and what they see when they open the app. Give one to people under Manage → People. Built-in roles can be edited; roles that people hold cannot be deleted.</p>
      {roles === null ? <Spinner /> : roles.length === 0 ? <Empty icon="shield" title="No roles yet">Create one to hand out access in one click.</Empty> : (
        <div className="role-grid">
          {roles.map((role) => {
            const inUse = (role.people ?? 0) > 0;
            const why = role.systemKey ? 'Built-in roles cannot be deleted.' : inUse ? 'Move the people who hold this role to another role first.' : undefined;
            return (
              <article key={role.id} className="role-card">
                <div className="role-head"><span className="link-emoji">{role.emoji}</span><div><strong>{role.name}</strong><small>{role.people ?? 0} {role.people === 1 ? 'person' : 'people'}{role.systemKey ? ' · built in' : ''}</small></div></div>
                {role.description && <p className="muted">{role.description}</p>}
                <div className="role-flags">
                  <span className="pill">{role.permissions.length} {role.permissions.length === 1 ? 'permission' : 'permissions'}</span>
                  {role.simpleUi && <span className="pill pill-ok">Simple big-button home</span>}
                </div>
                <div className="modal-actions left">
                  <button className="button button-small" onClick={() => setEditing({ role })}><Icon name="edit" size={15} /> Edit</button>
                  <button className="button button-small" onClick={() => setEditing({ role: null, seed: { ...role, name: `Copy of ${role.name}`.slice(0, 40), systemKey: null } })}><Icon name="copy" size={15} /> Clone</button>
                  <button className="button button-small button-danger-soft" disabled={Boolean(why)} title={why} onClick={() => void remove(role)}><Icon name="trash" size={15} /> Delete</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {editing && <RoleForm ctx={ctx} catalog={catalog} role={editing.role} seed={editing.seed} categories={categories} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </section>
  );
}

function RoleForm({ ctx, catalog, role, seed, categories, onClose, onSaved }: {
  ctx: Ctx; catalog: Ctx['config']['permissionCatalog']; role: CustomRole | null; seed?: CustomRole; categories: CategoryRef[]; onClose: () => void; onSaved: () => void;
}) {
  const start = role ?? seed ?? null;
  const types = ctx.config.notificationCatalog.types;
  const [name, setName] = useState(start?.name ?? '');
  const [emoji, setEmoji] = useState(start?.emoji ?? '⭐');
  const [description, setDescription] = useState(start?.description ?? '');
  const [permissions, setPermissions] = useState<Permission[]>(start?.permissions ?? []);
  const [simpleUi, setSimpleUi] = useState(start?.simpleUi ?? false);
  const [notify, setNotify] = useState<Record<string, boolean>>(() => Object.fromEntries(types.map((type) => [type.id, start?.notifyDefaults?.types?.[type.id]?.inapp ?? type.default])));
  const [followed, setFollowed] = useState<string[]>(start?.notifyDefaults?.categories ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const permissionsChanged = role !== null && (permissions.length !== role.permissions.length || permissions.some((id) => !role.permissions.includes(id)));
  const summaryPermissions = useMemo(() => permissions, [permissions]);

  async function save() {
    setBusy(true);
    setError('');
    try {
      const notifyDefaults: NotifyDefaults = { types: Object.fromEntries(types.map((type) => [type.id, { inapp: notify[type.id] }])), categories: followed };
      const body = { name, emoji, description, permissions, simpleUi, landing: simpleUi ? 'tasks' : '', notifyDefaults };
      if (role) await api(`/admin/roles/${role.id}`, { method: 'PATCH', body }); else await api('/admin/roles', { method: 'POST', body });
      onSaved();
    } catch (reason) { setError(messageOf(reason)); setReviewing(false); } finally { setBusy(false); }
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (permissionsChanged) setReviewing(true); else void save();
  }
  const groups = [...new Set(types.map((type) => type.group))];

  return (
    <Modal title={role ? `Edit ${role.name}` : seed ? `Clone ${seed.name.replace(/^Copy of /, '')}` : 'New role'} onClose={onClose} wide>
      <form className="form-stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Role name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} autoFocus /></Field>
          <Field label="Emoji"><input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={8} /></Field>
          <div className="span-2"><Field label="What is it for?"><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={160} /></Field></div>
        </div>

        <section className="role-section">
          <h3>Landing experience</h3>
          <div className="switch-row"><div><strong>Simple big-button home</strong><small>For hands-on teams: a home with “My tasks”, the unassigned queue, big Start / Done / Need help buttons, scan, contacts and menu. Everything else is hidden from their navigation.</small></div>
            <Switch checked={simpleUi} label="Simple big-button home" onChange={setSimpleUi} /></div>
        </section>

        <section className="role-section">
          <h3>What people with this role can do</h3>
          <PermissionMatrix catalog={catalog} value={permissions} onChange={setPermissions} actor={ctx.user} />
          <AccessSummary catalog={catalog} permissions={summaryPermissions} title="In short" />
        </section>

        <section className="role-section">
          <h3>Default notifications</h3>
          <p className="muted small-print">What people with this role get unless they change it themselves under Me and settings. Nobody is notified about something their permissions do not let them open.</p>
          {groups.map((group) => (
            <div key={group} className="notify-matrix">
              <div className="notify-head"><span style={{ marginRight: 'auto' }}>{group}</span><span>In-app</span></div>
              {types.filter((type) => type.group === group).map((type) => (
                <label key={type.id} className="notify-row">
                  <span><strong>{type.label}</strong><small>{type.description}{type.requires && !permissions.includes(type.requires) ? ' Needs a permission this role does not have yet.' : ''}</small></span>
                  <input type="checkbox" checked={notify[type.id] ?? false} onChange={(e) => setNotify({ ...notify, [type.id]: e.target.checked })} aria-label={`${type.label}: in-app`} />
                </label>
              ))}
            </div>
          ))}
          {categories.length > 0 && (
            <div>
              <strong className="mini-label">Issue categories this role follows</strong>
              <div className="chip-row">{categories.map((category) => (
                <button type="button" key={category.id} className={`chip ${followed.includes(category.id) ? 'on' : ''}`} aria-pressed={followed.includes(category.id)} onClick={() => setFollowed(followed.includes(category.id) ? followed.filter((id) => id !== category.id) : [...followed, category.id])}>{category.emoji} {category.name}</button>
              ))}</div>
            </div>
          )}
        </section>

        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save role'}</button></div>
      </form>
      {reviewing && role && <DiffConfirm catalog={catalog} before={role.permissions} after={permissions} subject={`the ${role.name} role${(role.people ?? 0) > 0 ? ` (${role.people} ${role.people === 1 ? 'person' : 'people'})` : ''}`} busy={busy} onConfirm={() => void save()} onCancel={() => setReviewing(false)} />}
    </Modal>
  );
}
