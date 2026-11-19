import { useMemo, useState } from 'react';
import type { Permission, PermissionCatalog, User } from '../lib/types';
import { canGrant, diffPermissions, labelOf, summarize } from '../lib/permissions';
import { Icon, Modal } from './kit';
import './permissions.css';

interface MatrixProps {
  catalog: PermissionCatalog;
  value: Permission[];
  onChange: (next: Permission[]) => void;
  actor: User;
  /** Permissions that already come from a role template: shown ticked and locked. */
  inherited?: Permission[];
  disabled?: boolean;
}

// Grouped checkboxes: a header per group with "all / none" and a count, a search box, and a description under every permission.
export function PermissionMatrix({ catalog, value, onChange, actor, inherited = [], disabled = false }: MatrixProps) {
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const own = useMemo(() => new Set(value), [value]);
  const fromRole = useMemo(() => new Set(inherited), [inherited]);
  const groups = useMemo(() => catalog.groups
    .map((group) => ({ ...group, permissions: group.permissions.filter((info) => info.grant !== 'reserved' && (!term || `${info.label} ${info.description} ${group.label}`.toLowerCase().includes(term))) }))
    .filter((group) => group.permissions.length > 0), [catalog, term]);
  const total = value.length + inherited.filter((id) => !own.has(id)).length;

  const toggle = (id: Permission, on: boolean) => onChange(on ? [...value, id] : value.filter((item) => item !== id));
  const setGroup = (ids: Permission[], on: boolean) => {
    const rest = value.filter((id) => !ids.includes(id));
    onChange(on ? [...rest, ...ids] : rest);
  };

  return (
    <div className="pm">
      <div className="pm-toolbar">
        <div className="input-icon slim"><Icon name="search" size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search permissions" aria-label="Search permissions" /></div>
        <span className="pill pm-total" aria-live="polite">{total} selected</span>
      </div>
      {groups.length === 0 && <p className="muted">No permission matches “{search}”.</p>}
      {groups.map((group) => {
        const editable = group.permissions.filter((info) => !fromRole.has(info.id) && (canGrant(actor, info) || own.has(info.id)));
        const addable = group.permissions.filter((info) => !fromRole.has(info.id) && canGrant(actor, info));
        const selected = group.permissions.filter((info) => own.has(info.id) || fromRole.has(info.id)).length;
        return (
          <div key={group.id} role="group" aria-label={group.label} className="pm-group">
            <div className="pm-head">
              <span className="pm-title"><Icon name={group.icon} size={16} /> {group.label}</span>
              <span className={`pill ${selected ? 'pill-ok' : ''}`}>{selected}/{group.permissions.length}</span>
              <span className="pm-bulk">
                <button type="button" className="text-link" disabled={disabled || !addable.length} onClick={() => setGroup(addable.map((info) => info.id), true)}>All</button>
                <button type="button" className="text-link" disabled={disabled || !editable.length} onClick={() => setGroup(editable.map((info) => info.id), false)}>None</button>
              </span>
            </div>
            {group.permissions.map((info) => {
              const locked = fromRole.has(info.id);
              const blocked = !locked && !own.has(info.id) && !canGrant(actor, info);
              return (
                <label key={info.id} className={`pm-row ${locked || blocked ? 'is-locked' : ''}`} title={blocked ? 'Only a super admin can give this one out, or you do not hold it yourself.' : undefined}>
                  <input type="checkbox" checked={locked || own.has(info.id)} disabled={disabled || locked || blocked} onChange={(event) => toggle(info.id, event.target.checked)} />
                  <span className="pm-text">
                    <strong>{info.label}{locked && <em className="pm-tag">from role</em>}{info.grant === 'super' && <em className="pm-tag" title="Only super admins can give this out"><Icon name="lock" size={11} /> super admin gives</em>}</strong>
                    <small>{info.description}</small>
                  </span>
                </label>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** A plain-language list of what a set of permissions allows. */
export function AccessSummary({ catalog, permissions, everything = false, title = 'What can this person do?' }: { catalog: PermissionCatalog; permissions: Permission[]; everything?: boolean; title?: string }) {
  const lines = useMemo(() => summarize(catalog, permissions), [catalog, permissions]);
  return (
    <div className="pm-summary" aria-live="polite">
      <strong>{title}</strong>
      {everything ? <p>Everything, including settings, roles and people.</p> : lines.length === 0 ? <p className="muted">Can book desks and rooms, report problems and use the everyday parts of the app. No management access.</p> : (
        <ul>{lines.map((line) => <li key={line.group}><Icon name={line.icon} size={15} /><span><b>{line.group}:</b> {line.items.join(', ')}</span></li>)}</ul>
      )}
    </div>
  );
}

/** Shown before saving: exactly what is about to be added or removed. */
export function DiffConfirm({ catalog, before, after, subject, busy, onConfirm, onCancel }: {
  catalog: PermissionCatalog; before: Permission[]; after: Permission[]; subject: string; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const { added, removed } = diffPermissions(before, after);
  return (
    <Modal title="Review the changes" onClose={onCancel}>
      <p>You are changing the access of <strong>{subject}</strong>.</p>
      {added.length > 0 && <div className="pm-diff add"><strong>Will be able to</strong><ul>{added.map((id) => <li key={id}><Icon name="plus" size={14} /> {labelOf(catalog, id)}</li>)}</ul></div>}
      {removed.length > 0 && <div className="pm-diff remove"><strong>Will no longer be able to</strong><ul>{removed.map((id) => <li key={id}><Icon name="minus" size={14} /> {labelOf(catalog, id)}</li>)}</ul></div>}
      <div className="modal-actions"><button className="button" onClick={onCancel} disabled={busy}>Back</button><button className="button button-primary" onClick={onConfirm} disabled={busy}>{busy ? 'Saving…' : 'Confirm and save'}</button></div>
    </Modal>
  );
}
