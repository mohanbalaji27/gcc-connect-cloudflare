import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuditEntry, CustomRole, ManagedUser, Permission, Role } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia } from '../../lib/format';
import { canGrant, allInfos } from '../../lib/permissions';
import type { Ctx } from '../App';
import { Empty, Field, Icon, Modal, Spinner, useKit } from '../kit';
import { AccessSummary, DiffConfirm, PermissionMatrix } from '../PermissionMatrix';

const roleName = (role: Role) => (role === 'super_admin' ? 'Super admin' : role === 'admin' ? 'Admin' : 'Employee');
type TemplateRole = CustomRole & { systemKey?: string | null };

export function ManageUsers({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [roles, setRoles] = useState<TemplateRole[]>([]);
  const [editing, setEditing] = useState<ManagedUser | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; password: string } | null>(null);
  const [search, setSearch] = useState('');
  const can = (permission: Permission) => ctx.user.permissions.includes(permission);

  const load = useCallback(async () => {
    try { const result = await api<{ users: ManagedUser[]; roles: TemplateRole[] }>('/admin/users'); setUsers(result.users); setRoles(result.roles); } catch (reason) { toast(messageOf(reason), 'error'); setUsers([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const term = search.trim().toLowerCase();
  const shown = users?.filter((user) => !term || `${user.name} ${user.email} ${user.username ?? ''} ${user.team}`.toLowerCase().includes(term)) ?? [];
  const templateOf = (user: ManagedUser) => roles.find((role) => role.id === user.customRoleId);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>People & access</h2>
        <div className="panel-tools">
          <div className="input-icon slim"><Icon name="search" size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people" aria-label="Search people" /></div>
          {can('users.create') && <button className="button button-primary button-small" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add person</button>}
        </div>
      </div>
      {users === null ? <Spinner /> : shown.length === 0 ? <Empty icon="users" title="No one found" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Person</th><th>Role</th><th>Access</th><th>Status</th><th /></tr></thead>
            <tbody>{shown.map((user) => {
              const template = templateOf(user);
              return (
                <tr key={user.id} className={user.active ? '' : 'muted-row'}>
                  <td><strong>{user.name}</strong><small>{user.email || `@${user.username}`}{user.email && user.username ? ` · @${user.username}` : ''}{user.team ? ` · ${user.team}` : ''}</small></td>
                  <td><span className={`pill ${user.role === 'super_admin' ? 'pill-hot' : user.role === 'admin' ? 'pill-ok' : ''}`}>{roleName(user.role)}</span>{template && <small>{template.emoji} {template.name}</small>}</td>
                  <td>{user.role === 'super_admin' ? 'Everything' : user.permissions.length ? `${user.permissions.length} permission${user.permissions.length === 1 ? '' : 's'}` : '—'}</td>
                  <td>{user.active ? 'Active' : 'Suspended'}</td>
                  <td className="right"><button className="icon-button" aria-label={`Edit ${user.name}`} onClick={() => setEditing(user)}><Icon name="edit" /></button></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {editing && <UserForm ctx={ctx} user={editing === 'new' ? null : editing} roles={roles} onClose={() => setEditing(null)} onSaved={(result) => { setEditing(null); void load(); if (result) setSecret(result); }} />}
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

function UserForm({ ctx, user, roles, onClose, onSaved }: { ctx: Ctx; user: ManagedUser | null; roles: TemplateRole[]; onClose: () => void; onSaved: (secret?: { name: string; password: string }) => void }) {
  const { toast } = useKit();
  const catalog = ctx.config.permissionCatalog;
  const isSuper = ctx.user.role === 'super_admin';
  const can = (permission: Permission) => ctx.user.permissions.includes(permission);
  const mayEdit = user ? can('users.edit') : can('users.create');
  const mayRoles = can('users.change_roles');
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [team, setTeam] = useState(user?.team ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'user');
  const [permissions, setPermissions] = useState<Permission[]>(user?.ownPermissions ?? []);
  const [customRoleId, setCustomRoleId] = useState(user?.customRoleId ?? '');
  const [joinedOn, setJoinedOn] = useState(user?.joinedOn ?? '');
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const template = roles.find((item) => item.id === customRoleId);
  const inherited = role === 'super_admin' ? [] : template?.permissions ?? [];
  const effective = useMemo(() => (role === 'super_admin' ? allInfos(catalog).map((info) => info.id) : [...new Set([...permissions, ...inherited])]), [role, permissions, inherited, catalog]);
  const before = user ? (user.role === 'super_admin' ? allInfos(catalog).map((info) => info.id) : user.permissions) : [];
  const changed = Boolean(user) && (effective.length !== before.length || effective.some((id) => !before.includes(id)));

  const changeRole = (next: Role) => {
    setRole(next);
    const infos = allInfos(catalog);
    setPermissions(next === 'admin' ? catalog.adminDefaults.filter((id) => { const info = infos.find((i) => i.id === id); return info ? canGrant(ctx.user, info) : false; }) : []);
  };

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (user) {
        const body: Record<string, unknown> = { name, team, active, joinedOn: joinedOn || undefined, username: username.trim() || null };
        if (mayRoles) Object.assign(body, { role, customRoleId: customRoleId || null, permissions: role === 'super_admin' ? [] : permissions });
        await api(`/admin/users/${user.id}`, { method: 'PATCH', body });
        toast('Saved.', 'success');
        onSaved();
      } else {
        const body: Record<string, unknown> = { name, email: email.trim() || undefined, username: username.trim() || undefined, team, joinedOn: joinedOn || undefined, password: password || undefined };
        if (mayRoles) Object.assign(body, { role, customRoleId: customRoleId || undefined, permissions: role === 'super_admin' ? [] : permissions });
        const created = await api<{ temporaryPassword: string }>('/admin/users', { method: 'POST', body });
        toast(`${name} is on board!`, 'success');
        onSaved({ name, password: created.temporaryPassword });
      }
    } catch (reason) { setError(messageOf(reason)); setReviewing(false); } finally { setBusy(false); }
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user && !email.trim() && !username.trim()) return setError('Give the person a work email, a username (employee ID), or both.');
    if (user && mayRoles && changed) setReviewing(true); else void save();
  }

  async function reset() {
    if (!user || !window.confirm(`Reset ${user.name}’s password? They’ll be signed out everywhere.`)) return;
    try { const result = await api<{ temporaryPassword: string }>(`/admin/users/${user.id}/reset-password`, { method: 'POST' }); onSaved({ name: user.name, password: result.temporaryPassword }); } catch (reason) { setError(messageOf(reason)); }
  }

  return (
    <Modal title={user ? `Edit ${user.name}` : 'Add a person'} onClose={onClose} wide>
      <form className="form-stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Full name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus disabled={!mayEdit} /></Field>
          <Field label="Team (label only)"><input value={team} onChange={(e) => setTeam(e.target.value)} maxLength={100} disabled={!mayEdit} /></Field>
          <Field label="Work email" hint={user ? 'The email cannot be changed here.' : 'Optional if you give a username.'}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={Boolean(user) || !mayEdit} placeholder="name@company.com" /></Field>
          <Field label="Username / employee ID" hint="For people without a work email. They can sign in with either. 3 to 32 letters, numbers, dots, dashes or underscores."><input value={username} onChange={(e) => setUsername(e.target.value)} disabled={!mayEdit} maxLength={32} autoCapitalize="off" autoComplete="off" placeholder="emp-0042" /></Field>
          <Field label="Joined on (for anniversaries)"><input type="date" value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} disabled={!mayEdit} /></Field>
          {!user && <Field label="Password (optional)" hint="Leave blank to generate a temporary one. They must change it at first sign-in."><input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} maxLength={128} autoComplete="off" /></Field>}
        </div>

        {mayRoles ? (
          <section className="role-section">
            <h3>Role and access</h3>
            <div className="form-grid">
              <Field label="Role">
                <select value={role} onChange={(e) => changeRole(e.target.value as Role)} disabled={user?.role === 'super_admin' && !isSuper}>
                  <option value="user">Employee</option><option value="admin">Admin</option>{(isSuper || role === 'super_admin') && <option value="super_admin">Super admin (everything)</option>}
                </select>
              </Field>
              {role !== 'super_admin' && (
                <Field label="Role template" hint={template?.description || 'A ready-made bundle of permissions, notifications and home screen.'}>
                  <select value={customRoleId} onChange={(e) => setCustomRoleId(e.target.value)}>
                    <option value="">None</option>
                    {roles.map((item) => <option key={item.id} value={item.id}>{item.emoji} {item.name}{item.simpleUi ? ' (simple home)' : ''}</option>)}
                  </select>
                </Field>
              )}
            </div>
            {role !== 'super_admin' ? (
              <>
                <strong className="mini-label">Extra permissions on top of the template</strong>
                <PermissionMatrix catalog={catalog} value={permissions.filter((id) => !inherited.includes(id))} inherited={inherited} onChange={(next) => setPermissions([...next, ...permissions.filter((id) => inherited.includes(id))])} actor={ctx.user} />
              </>
            ) : <p className="muted">Super admins can do everything, including managing people, roles and settings.</p>}
            <AccessSummary catalog={catalog} permissions={effective} everything={role === 'super_admin'} />
          </section>
        ) : <p className="muted">You can add and edit people. Choosing roles and permissions needs the “Change roles and permissions” permission.</p>}

        {user && <label className="check"><input type="checkbox" checked={active} disabled={user.id === ctx.user.id || !mayEdit} onChange={(e) => setActive(e.target.checked)} /> <span>Account active {user.id === ctx.user.id && '(you can’t suspend yourself)'}</span></label>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions">
          {user && can('users.reset_password') && <button type="button" className="button button-small" onClick={() => void reset()}><Icon name="key" size={16} /> Reset password</button>}
          <span className="spacer" />
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : user ? 'Save changes' : 'Create account'}</button>
        </div>
      </form>
      {reviewing && user && <DiffConfirm catalog={catalog} before={before} after={effective} subject={user.name} busy={busy} onConfirm={() => void save()} onCancel={() => setReviewing(false)} />}
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
