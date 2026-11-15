import { useCallback, useEffect, useState } from 'react';
import { ALL_PERMISSIONS, PERMISSION_LABELS, type CustomRole, type Permission } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { Empty, Field, Icon, Modal, Spinner, useKit } from '../kit';

export function ManageRoles() {
  const { toast } = useKit();
  const [roles, setRoles] = useState<CustomRole[] | null>(null);
  const [editing, setEditing] = useState<CustomRole | 'new' | null>(null);
  const load = useCallback(async () => {
    try { setRoles((await api<{ roles: CustomRole[] }>('/admin/roles')).roles); } catch (reason) { toast(messageOf(reason), 'error'); setRoles([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function remove(role: CustomRole) {
    if (!window.confirm(`Delete “${role.name}”? People with this role keep their other access but lose what it granted.`)) return;
    try { await api(`/admin/roles/${role.id}`, { method: 'DELETE' }); toast('Role deleted.', 'success'); await load(); } catch (reason) { toast(messageOf(reason), 'error'); }
  }

  return (
    <section className="panel">
      <div className="panel-head"><h2>Roles</h2><button className="button button-primary button-small" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> New role</button></div>
      <p className="muted">A role is a reusable bundle of permissions, like “HR partner” or “Facilities”. Give it to people under Manage → People.</p>
      {roles === null ? <Spinner /> : roles.length === 0 ? <Empty icon="shield" title="No roles yet">Create one to hand out access in one click.</Empty> : (
        <div className="role-grid">
          {roles.map((role) => (
            <article key={role.id} className="role-card">
              <div className="role-head"><span className="link-emoji">{role.emoji}</span><div><strong>{role.name}</strong><small>{role.people ?? 0} {role.people === 1 ? 'person' : 'people'}</small></div></div>
              {role.description && <p className="muted">{role.description}</p>}
              <div className="chip-row">{role.permissions.length ? role.permissions.map((p) => <span key={p} className="chip static">{PERMISSION_LABELS[p]}</span>) : <span className="muted">No permissions</span>}</div>
              <div className="modal-actions left"><button className="button button-small" onClick={() => setEditing(role)}><Icon name="edit" size={15} /> Edit</button><button className="button button-small button-danger-soft" onClick={() => void remove(role)}><Icon name="trash" size={15} /> Delete</button></div>
            </article>
          ))}
        </div>
      )}
      {editing && <RoleForm role={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </section>
  );
}

function RoleForm({ role, onClose, onSaved }: { role: CustomRole | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(role?.name ?? '');
  const [emoji, setEmoji] = useState(role?.emoji ?? '⭐');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<Permission[]>(role?.permissions ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { name, emoji, description, permissions };
      if (role) await api(`/admin/roles/${role.id}`, { method: 'PATCH', body }); else await api('/admin/roles', { method: 'POST', body });
      onSaved();
    } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }
  return (
    <Modal title={role ? `Edit ${role.name}` : 'New role'} onClose={onClose} wide>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Role name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} autoFocus /></Field>
        <Field label="Emoji"><input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={8} /></Field>
        <div className="span-2"><Field label="What is it for?"><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={160} /></Field></div>
        <fieldset className="perm-grid span-2"><legend>Permissions</legend>
          {ALL_PERMISSIONS.map((p) => <label key={p} className="check"><input type="checkbox" checked={permissions.includes(p)} onChange={(e) => setPermissions(e.target.checked ? [...permissions, p] : permissions.filter((x) => x !== p))} /><span>{PERMISSION_LABELS[p]}</span></label>)}
        </fieldset>
        {error && <div className="form-error span-2" role="alert">{error}</div>}
        <div className="modal-actions span-2"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save role'}</button></div>
      </form>
    </Modal>
  );
}
