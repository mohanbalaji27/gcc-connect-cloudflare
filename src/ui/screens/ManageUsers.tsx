import { useCallback, useEffect, useState } from 'react';
import { ALL_PERMISSIONS, PERMISSION_LABELS, type AuditEntry, type CustomRole, type ManagedUser, type Permission, type Role } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia } from '../../lib/format';
import type { Ctx } from '../App';
import { Empty, Field, Icon, Modal, Spinner, useKit } from '../kit';

const ADMIN_DEFAULTS: Permission[] = ALL_PERMISSIONS.filter((permission) => permission !== 'users.manage');
const roleName = (role: Role) => (role === 'super_admin' ? 'Super admin' : role === 'admin' ? 'Admin' : 'Employee');

function PermissionPicker({ value, onChange, disabled }: { value: Permission[]; onChange: (next: Permission[]) => void; disabled?: boolean }) {
  return (
    <fieldset className="perm-grid" disabled={disabled}>
      <legend>Extra permissions</legend>
      {ALL_PERMISSIONS.map((permission) => (
        <label key={permission} className="check">
          <input type="checkbox" checked={value.includes(permission)} onChange={(e) => onChange(e.target.checked ? [...value, permission] : value.filter((p) => p !== permission))} />
          <span>{PERMISSION_LABELS[permission]}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function ManageUsers({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [editing, setEditing] = useState<ManagedUser | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; password: string } | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try { const result = await api<{ users: ManagedUser[]; roles: CustomRole[] }>('/admin/users'); setUsers(result.users); setRoles(result.roles); } catch (reason) { toast(messageOf(reason), 'error'); setUsers([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const term = search.trim().toLowerCase();
  const shown = users?.filter((user) => !term || `${user.name} ${user.email} ${user.team}`.toLowerCase().includes(term)) ?? [];

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>People & permissions</h2>
        <div className="panel-tools">
          <div className="input-icon slim"><Icon name="search" size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people" aria-label="Search people" /></div>
          <button className="button button-primary button-small" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add person</button>
        </div>
      </div>
      {users === null ? <Spinner /> : shown.length === 0 ? <Empty icon="users" title="No one found" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Person</th><th>Role</th><th>Can manage</th><th>Status</th><th /></tr></thead>
            <tbody>{shown.map((user) => (
              <tr key={user.id} className={user.active ? '' : 'muted-row'}>
                <td><strong>{user.name}</strong><small>{user.email}{user.team ? ` · ${user.team}` : ''}</small></td>
                <td><span className={`pill ${user.role === 'super_admin' ? 'pill-hot' : user.role === 'admin' ? 'pill-ok' : ''}`}>{roleName(user.role)}</span></td>
                <td>{user.role === 'super_admin' ? 'Everything' : user.permissions.length ? user.permissions.map((p) => p.replace('.manage', '')).join(', ') : '—'}</td>
                <td>{user.active ? 'Active' : 'Suspended'}</td>
                <td className="right"><button className="icon-button" aria-label={`Edit ${user.name}`} onClick={() => setEditing(user)} disabled={user.id === ctx.user.id && false}><Icon name="edit" /></button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {editing && <UserForm user={editing === 'new' ? null : editing} roles={roles} self={ctx.user.id} onClose={() => setEditing(null)} onSaved={(result) => { setEditing(null); void load(); if (result) setSecret(result); }} />}
      {secret && (
        <Modal title="Temporary password" onClose={() => setSecret(null)}>
          <p>Share this with <strong>{secret.name}</strong> securely. It’s shown once, and they’ll be asked to choose their own at first sign-in.</p>
          <div className="secret-box"><code>{secret.password}</code><button className="button button-small" onClick={() => void navigator.clipboard.writeText(secret.password).then(() => toast('Copied.', 'success'))}><Icon name="copy" size={16} /> Copy</button></div>
          <div className="modal-actions"><button className="button button-primary" onClick={() => setSecret(null)}>Done</button></div>
        </Modal>
      )}
    </section>
  );
}

function UserForm({ user, roles, self, onClose, onSaved }: { user: ManagedUser | null; roles: CustomRole[]; self: string; onClose: () => void; onSaved: (secret?: { name: string; password: string }) => void }) {
  const { toast } = useKit();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [team, setTeam] = useState(user?.team ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'user');
  const [permissions, setPermissions] = useState<Permission[]>(user?.ownPermissions ?? []);
  const [customRoleId, setCustomRoleId] = useState(user?.customRoleId ?? '');
  const [joinedOn, setJoinedOn] = useState(user?.joinedOn ?? '');
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const changeRole = (next: Role) => {
    setRole(next);
    setPermissions(next === 'admin' ? ADMIN_DEFAULTS : next === 'user' ? [] : ALL_PERMISSIONS);
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (user) {
        await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { name, team, role, active, customRoleId: customRoleId || null, joinedOn: joinedOn || undefined, permissions: role === 'super_admin' ? [] : permissions } });
        toast('Saved.', 'success');
        onSaved();
      } else {
        const created = await api<{ temporaryPassword: string }>('/admin/users', { method: 'POST', body: { name, email, team, role, customRoleId: customRoleId || undefined, joinedOn: joinedOn || undefined, permissions: role === 'super_admin' ? [] : permissions, password: password || undefined } });
        toast(`${name} is on board!`, 'success');
        onSaved({ name, password: created.temporaryPassword });
      }
    } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }

  async function reset() {
    if (!user || !window.confirm(`Reset ${user.name}’s password? They’ll be signed out everywhere.`)) return;
    try { const result = await api<{ temporaryPassword: string }>(`/admin/users/${user.id}/reset-password`, { method: 'POST' }); onSaved({ name: user.name, password: result.temporaryPassword }); } catch (reason) { setError(messageOf(reason)); }
  }

  return (
    <Modal title={user ? `Edit ${user.name}` : 'Add a person'} onClose={onClose} wide>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Full name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus /></Field>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={Boolean(user)} /></Field>
        <Field label="Team (label only)"><input value={team} onChange={(e) => setTeam(e.target.value)} maxLength={100} /></Field>
        <Field label="Role"><select value={role} onChange={(e) => changeRole(e.target.value as Role)}><option value="user">Employee</option><option value="admin">Admin</option><option value="super_admin">Super admin (everything)</option></select></Field>
        {role !== 'super_admin' && <Field label="Role template" hint={roles.find((r) => r.id === customRoleId)?.description || 'Adds a ready-made bundle of permissions'}><select value={customRoleId} onChange={(e) => setCustomRoleId(e.target.value)}><option value="">None</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.emoji} {r.name}</option>)}</select></Field>}
        <Field label="Joined on (for anniversaries)"><input type="date" value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} /></Field>
        {role !== 'super_admin' ? <div className="span-2"><PermissionPicker value={permissions} onChange={setPermissions} /></div> : <p className="muted span-2">Super admins can do everything, including managing other people.</p>}
        {!user && <div className="span-2"><Field label="Password (optional)" hint="Leave blank to generate a temporary one. They must change it at first sign-in."><input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} maxLength={128} autoComplete="off" /></Field></div>}
        {user && <label className="check span-2"><input type="checkbox" checked={active} disabled={user.id === self} onChange={(e) => setActive(e.target.checked)} /> <span>Account active {user.id === self && '(you can’t suspend yourself)'}</span></label>}
        {error && <div className="form-error span-2" role="alert">{error}</div>}
        <div className="modal-actions span-2">
          {user && <button type="button" className="button button-small" onClick={() => void reset()}><Icon name="key" size={16} /> Reset password</button>}
          <span className="spacer" />
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : user ? 'Save changes' : 'Create account'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ManageActivity() {
  const { toast } = useKit();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => { api<{ entries: AuditEntry[] }>('/admin/audit').then((r) => setEntries(r.entries)).catch((reason) => { toast(messageOf(reason), 'error'); setEntries([]); }); }, [toast]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const exportUrl = `/api/admin/audit/export?${new URLSearchParams({ ...(from ? { from: new Date(`${from}T00:00:00+05:30`).toISOString() } : {}), ...(to ? { to: new Date(Date.parse(`${to}T00:00:00+05:30`) + 86_400_000).toISOString() } : {}) })}`;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Recent activity</h2>
        <div className="panel-tools"><label className="inline-date">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="inline-date">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <a className="button button-small button-primary" href={exportUrl} download><Icon name="download" size={16} /> Export CSV</a></div></div>
      <p className="muted small-print">The list shows the latest 100 entries. The export includes everything in the chosen dates.</p>
      {entries === null ? <Spinner /> : entries.length === 0 ? <Empty icon="list" title="Nothing yet" /> : (
        <ul className="plain-list">{entries.map((entry) => (
          <li key={entry.id}><div><strong>{entry.action.replace(/[.-]/g, ' ')}</strong><small>{entry.actor_name ?? 'System'}{entry.detail ? ` · ${entry.detail}` : ''}</small></div><small>{inIndia(entry.created_at, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small></li>
        ))}</ul>
      )}
    </section>
  );
}
