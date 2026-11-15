import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Resource } from '../../lib/types';
import { api, messageOf, uploadBlob } from '../../lib/api';
import type { Ctx } from '../App';
import { FloorMap } from '../FloorMap';
import { Field, Icon, Modal, Spinner, useKit } from '../kit';

const SWATCHES = ['#2f9e6f', '#e8772e', '#6c5ce7', '#0984e3', '#d63384', '#c9a100', '#00a8a8', '#8d5524', '#5b8c00', '#364fc7'];

function parseSeatRange(input: string, resources: Resource[]): string[] {
  const wanted = new Set<string>();
  const byLabel = new Map(resources.filter((r) => r.type === 'desk').map((r) => [r.label.toUpperCase(), r.id]));
  for (const part of input.split(/[,;\s]+/).filter(Boolean)) {
    const range = /^([A-Za-z]*)(\d+)\s*[-–]\s*[A-Za-z]*(\d+)$/.exec(part);
    if (range) {
      const [, prefix, from, to] = range;
      const width = from.length;
      for (let n = Number(from); n <= Number(to) && n - Number(from) < 600; n += 1) {
        const id = byLabel.get(`${prefix.toUpperCase()}${String(n).padStart(width, '0')}`);
        if (id) wanted.add(id);
      }
    } else if (byLabel.has(part.toUpperCase())) wanted.add(byLabel.get(part.toUpperCase())!);
  }
  return [...wanted];
}

export function ManageLayout({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const canSpaces = ctx.user.permissions.includes('spaces.manage');
  const canTeams = ctx.user.permissions.includes('teams.manage');
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [kind, setKind] = useState<'desk' | 'room'>('desk');
  const [tool, setTool] = useState<'move' | 'select'>(canSpaces ? 'move' : 'select');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [rangeText, setRangeText] = useState('');
  const [newTeam, setNewTeam] = useState({ name: '', color: SWATCHES[0] });
  const [showAdd, setShowAdd] = useState(false);
  const [showFit, setShowFit] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [pendingMoves, setPendingMoves] = useState<Record<string, { x: number; y: number }>>({});
  const [pendingTeams, setPendingTeams] = useState<Record<string, string | null>>({});
  const [saving, setSaving] = useState(false);
  const dirtyCount = Object.keys(pendingMoves).length + Object.keys(pendingTeams).length;
  const dirty = dirtyCount > 0;

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const load = useCallback(async () => {
    try { setResources((await api<{ resources: Resource[] }>('/resources')).resources); } catch (reason) { toast(messageOf(reason), 'error'); setResources([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  // What you see on the map: saved data with your unsaved changes laid on top.
  const shown = useMemo(() => (resources ?? []).map((resource) => {
    const move = pendingMoves[resource.id];
    const hasTeam = resource.id in pendingTeams;
    if (!move && !hasTeam) return resource;
    const teamId = pendingTeams[resource.id];
    const team = hasTeam ? (teamId ? ctx.teams.find((t) => t.id === teamId) : null) : resource.team;
    return { ...resource, x: move?.x ?? resource.x, y: move?.y ?? resource.y, team: team ? { id: team.id, name: team.name, color: team.color } : null };
  }), [resources, pendingMoves, pendingTeams, ctx.teams]);
  const visible = useMemo(() => shown.filter((resource) => resource.type === kind), [shown, kind]);
  const selection = useMemo(() => shown.filter((resource) => selectedIds.includes(resource.id)), [shown, selectedIds]);
  const single = selection.length === 1 ? selection[0] : null;

  const assign = (teamId: string | null) => {
    const ids = selection.filter((resource) => resource.type === 'desk').map((resource) => resource.id);
    if (!ids.length) return toast('Select some desks first.', 'info');
    setPendingTeams((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, teamId])) }));
    toast(`${ids.length} ${ids.length === 1 ? 'desk' : 'desks'} staged. Press Save changes to apply.`, 'info');
  };

  async function saveLayout() {
    setSaving(true);
    try {
      const byTeam = new Map<string | null, string[]>();
      for (const [id, teamId] of Object.entries(pendingTeams)) byTeam.set(teamId, [...(byTeam.get(teamId) ?? []), id]);
      const result = await api<{ moved: number; assigned: number }>('/admin/map/layout', { method: 'PUT', body: {
        moves: Object.entries(pendingMoves).map(([id, point]) => ({ id, ...point })),
        assignments: [...byTeam.entries()].map(([teamId, resourceIds]) => ({ teamId, resourceIds })),
      } });
      setPendingMoves({});
      setPendingTeams({});
      await Promise.all([load(), ctx.reloadTeams()]);
      toast(`Saved: ${result.moved} seats moved, ${result.assigned} team assignments.`, 'success');
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setSaving(false); }
  }
  function discardLayout() {
    if (!window.confirm(`Discard ${dirtyCount} unsaved ${dirtyCount === 1 ? 'change' : 'changes'}?`)) return;
    setPendingMoves({});
    setPendingTeams({});
  }

  const exportPdf = async () => {
    try {
      const { exportTeamLayoutPdf } = await import('../../lib/exportPdf');
      exportTeamLayoutPdf(ctx.plan, shown, ctx.teams);
      toast('Your PDF is downloading.', 'success');
    } catch (reason) { toast(messageOf(reason), 'error'); }
  };

  const moveSeat = (id: string, x: number, y: number) => setPendingMoves((current) => ({ ...current, [id]: { x, y } }));

  const select = (resource: Resource, additive: boolean) => {
    setSelectedIds((current) => (additive || tool === 'select') ? (current.includes(resource.id) ? current.filter((id) => id !== resource.id) : [...current, resource.id]) : [resource.id]);
  };

  async function addTeam(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api('/admin/teams', { method: 'POST', body: newTeam });
      toast(`Team “${newTeam.name}” created.`, 'success');
      setNewTeam({ name: '', color: SWATCHES[(ctx.teams.length + 1) % SWATCHES.length] });
      await ctx.reloadTeams();
    } catch (reason) { toast(messageOf(reason), 'error'); }
  }
  async function updateTeam(id: string, body: { name?: string; color?: string }) {
    try { await api(`/admin/teams/${id}`, { method: 'PATCH', body }); await Promise.all([ctx.reloadTeams(), load()]); } catch (reason) { toast(messageOf(reason), 'error'); }
  }
  async function deleteTeam(id: string, name: string) {
    if (!window.confirm(`Delete the team “${name}”? Its seats will become unassigned.`)) return;
    try { await api(`/admin/teams/${id}`, { method: 'DELETE' }); toast('Team deleted.', 'success'); await Promise.all([ctx.reloadTeams(), load()]); } catch (reason) { toast(messageOf(reason), 'error'); }
  }
  async function retire() {
    if (!single) return;
    try { await api(`/admin/resources/${single.id}`, { method: 'DELETE' }); toast(`${single.label} retired.`, 'success'); setSelectedIds([]); setConfirmRetire(false); await Promise.all([load(), ctx.reloadTeams()]); } catch (reason) { toast(messageOf(reason), 'error'); }
  }
  async function saveSingle(body: Record<string, unknown>) {
    if (!single) return;
    try { await api(`/admin/resources/${single.id}`, { method: 'PATCH', body }); await load(); } catch (reason) { toast(messageOf(reason), 'error'); }
  }

  if (resources === null) return <Spinner />;

  return (
    <div className="layout-editor">
      <div className="editor-main">
        <div className="editor-bar">
          <div className="segmented small">
            <button className={kind === 'desk' ? 'active' : ''} onClick={() => { setKind('desk'); setSelectedIds([]); }}><Icon name="desk" size={16} /> Desks ({(resources ?? []).filter((r) => r.type === 'desk').length})</button>
            <button className={kind === 'room' ? 'active' : ''} onClick={() => { setKind('room'); setSelectedIds([]); }}><Icon name="room" size={16} /> Rooms</button>
          </div>
          <div className="segmented small">
            <button className={tool === 'move' ? 'active' : ''} disabled={!canSpaces} onClick={() => setTool('move')}><Icon name="move" size={16} /> Move</button>
            <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}><Icon name="select" size={16} /> Select</button>
          </div>
          <div className="editor-actions">
            {canSpaces && <button className="button button-small" disabled={dirty} title={dirty ? 'Save or discard your changes first' : undefined} onClick={() => setShowAdd(true)}><Icon name="plus" size={16} /> Add space</button>}
            {canSpaces && <button className="button button-small" disabled={dirty} title={dirty ? 'Save or discard your changes first' : undefined} onClick={() => setShowFit(true)}><Icon name="layers" size={16} /> Auto-fit grid</button>}
            {canSpaces && <button className="button button-small" disabled={dirty} title={dirty ? 'Save or discard your changes first' : undefined} onClick={() => setShowFiles(true)}><Icon name="download" size={16} /> Plan & seats</button>}
            <button className="button button-small button-primary" onClick={() => void exportPdf()}><Icon name="download" size={16} /> Export PDF</button>
          </div>
        </div>
        {dirty && (
          <div className="save-bar" role="status">
            <span><strong>{dirtyCount}</strong> unsaved {dirtyCount === 1 ? 'change' : 'changes'}</span>
            <div><button className="button button-small" onClick={discardLayout} disabled={saving}>Discard</button><button className="button button-small button-primary" onClick={() => void saveLayout()} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button></div>
          </div>
        )}
        <FloorMap resources={visible} plan={ctx.plan} planLoading={ctx.planLoading} selectedIds={selectedIds} onSelect={select} mode="edit" tool={tool} onMove={moveSeat} onSelectMany={(ids, additive) => setSelectedIds((current) => additive ? [...new Set([...current, ...ids])] : ids)} highlightTeamId={highlight} showAvailability={false} />
        <p className="muted small-print">{tool === 'move' ? 'Drag any seat to where it really sits on the plan, then press Save changes. Nothing is applied until you save.' : 'Drag a box around seats (hold Shift to add) or click seats to pick them, then give them a team.'}</p>
      </div>

      <aside className="editor-side">
        <section className="panel tight">
          <div className="panel-head"><h3>Selection</h3><span className="pill">{selectedIds.length}</span></div>
          <form className="range-row" onSubmit={(event) => { event.preventDefault(); const ids = parseSeatRange(rangeText, resources); setSelectedIds(ids); toast(ids.length ? `Selected ${ids.length} seats.` : 'No seats matched that range.', ids.length ? 'success' : 'info'); }}>
            <input value={rangeText} onChange={(e) => setRangeText(e.target.value)} placeholder="Range: Z001-Z020, Z045" aria-label="Select seats by range" />
            <button className="button button-small">Select</button>
          </form>
          {selection.length > 0 && <button className="text-link" onClick={() => setSelectedIds([])}>Clear selection</button>}
          {canTeams && selection.some((r) => r.type === 'desk') && (
            <div className="assign-box">
              <strong>Assign {selection.filter((r) => r.type === 'desk').length} desks to…</strong>
              <div className="chip-row">
                {ctx.teams.map((team) => <button key={team.id} className="legend-chip on" style={{ ['--c' as string]: team.color }} onClick={() => void assign(team.id)}><i />{team.name}</button>)}
                <button className="chip" onClick={() => void assign(null)}>No team</button>
              </div>
            </div>
          )}
          {single && canSpaces && (
            <div className="single-edit">
              <Field label="Label"><input defaultValue={single.label} key={single.id + single.label} maxLength={40} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== single.label && void saveSingle({ label: e.target.value.trim() })} /></Field>
              {single.type === 'room' && <Field label="Capacity"><input type="number" min={1} max={500} defaultValue={single.capacity ?? ''} key={`${single.id}-cap`} onBlur={(e) => void saveSingle({ capacity: e.target.value ? Number(e.target.value) : null })} /></Field>}
              <small className="muted">Position: {single.x?.toFixed(1)}%, {single.y?.toFixed(1)}%</small>
              <button className="button button-small button-danger-soft" onClick={() => setConfirmRetire(true)}><Icon name="trash" size={16} /> Retire {single.type}</button>
            </div>
          )}
        </section>

        <section className="panel tight">
          <div className="panel-head"><h3>Teams</h3><span className="pill">{ctx.unassignedSeats} unassigned</span></div>
          <ul className="team-list">
            {ctx.teams.map((team) => (
              <li key={team.id} className={highlight === team.id ? 'on' : ''}>
                {canTeams ? <input type="color" value={team.color} aria-label={`${team.name} colour`} onChange={(e) => void updateTeam(team.id, { color: e.target.value })} /> : <i className="swatch" style={{ background: team.color }} />}
                {canTeams ? <input className="team-name" defaultValue={team.name} key={team.id + team.name} maxLength={100} aria-label="Team name" onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== team.name && void updateTeam(team.id, { name: e.target.value.trim() })} /> : <span className="team-name">{team.name}</span>}
                <button className="chip" onClick={() => setHighlight(highlight === team.id ? null : team.id)} title="Highlight on map">{team.seatCount}</button>
                {canTeams && <button className="icon-button danger" aria-label={`Delete ${team.name}`} onClick={() => void deleteTeam(team.id, team.name)}><Icon name="trash" size={16} /></button>}
              </li>
            ))}
          </ul>
          {canTeams && (
            <form className="add-team" onSubmit={addTeam}>
              <input type="color" value={newTeam.color} onChange={(e) => setNewTeam({ ...newTeam, color: e.target.value })} aria-label="New team colour" />
              <input value={newTeam.name} onChange={(e) => setNewTeam({ ...newTeam, name: e.target.value })} placeholder="New team name" required maxLength={100} />
              <button className="button button-small button-primary"><Icon name="plus" size={16} /></button>
            </form>
          )}
        </section>
      </aside>

      {showAdd && <AddSpace kind={kind} onClose={() => setShowAdd(false)} onAdded={async (id) => { setShowAdd(false); await Promise.all([load(), ctx.reloadTeams()]); setSelectedIds([id]); toast('Added — drag it to the right spot.', 'success'); }} />}
      {showFit && <FitGrid ctx={ctx} onClose={() => setShowFit(false)} onApplied={async () => { setShowFit(false); await load(); }} />}
      {showFiles && <PlanAndSeats ctx={ctx} canTeams={canTeams} onClose={() => setShowFiles(false)} onChanged={async () => { await Promise.all([load(), ctx.reloadTeams(), ctx.reloadMap()]); }} />}
      {confirmRetire && single && (
        <Modal title={`Retire ${single.label}?`} onClose={() => setConfirmRetire(false)}>
          <p>It disappears from the map and its upcoming bookings are cancelled. History is kept.</p>
          <div className="modal-actions"><button className="button" onClick={() => setConfirmRetire(false)}>Keep it</button><button className="button button-danger" onClick={() => void retire()}>Retire</button></div>
        </Modal>
      )}
    </div>
  );
}

function AddSpace({ kind, onClose, onAdded }: { kind: 'desk' | 'room'; onClose: () => void; onAdded: (id: string) => void }) {
  const { toast } = useKit();
  const [type, setType] = useState(kind);
  const [label, setLabel] = useState('');
  const [capacity, setCapacity] = useState('6');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = { type, label };
      if (type === 'room') body.capacity = Number(capacity);
      const { id } = await api<{ id: string }>('/admin/resources', { method: 'POST', body });
      onAdded(id);
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title="Add a space" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <div className="segmented"><button type="button" className={type === 'desk' ? 'active' : ''} onClick={() => setType('desk')}>Desk</button><button type="button" className={type === 'room' ? 'active' : ''} onClick={() => setType('room')}>Room</button></div>
        <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={40} placeholder={type === 'desk' ? 'Z185' : 'Brainstorm Room'} autoFocus /></Field>
        {type === 'room' && <Field label="Capacity"><input type="number" min={1} max={500} value={capacity} onChange={(e) => setCapacity(e.target.value)} /></Field>}
        <div className="modal-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>Add to map</button></div>
      </form>
    </Modal>
  );
}

function FitGrid({ ctx, onClose, onApplied }: { ctx: Ctx; onClose: () => void; onApplied: () => void }) {
  const { toast } = useKit();
  const [cal, setCal] = useState(ctx.mapInfo?.calibration ?? { x0: 8, y0: 8, x1: 92, y1: 92 });
  const [includeManual, setIncludeManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const slider = (key: keyof typeof cal, label: string) => (
    <Field label={`${label}: ${cal[key]}%`}><input type="range" min={0} max={100} step={0.5} value={cal[key]} onChange={(e) => setCal({ ...cal, [key]: Number(e.target.value) })} /></Field>
  );
  async function apply() {
    setBusy(true);
    try {
      const result = await api<{ updated: number }>('/admin/map/calibration', { method: 'PUT', body: { calibration: cal, includeManual } });
      await ctx.reloadMap();
      toast(`Re-laid out ${result.updated} seats from the workbook grid.`, 'success');
      onApplied();
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title="Auto-fit seat grid" onClose={onClose}>
      <p className="muted">Stretch the workbook’s seat grid over the part of the plan where the desks are. Seats you’ve dragged by hand stay put unless you tick the box.</p>
      <div className="form-grid">{slider('x0', 'Left edge')}{slider('x1', 'Right edge')}{slider('y0', 'Top edge')}{slider('y1', 'Bottom edge')}</div>
      <label className="check"><input type="checkbox" checked={includeManual} onChange={(e) => setIncludeManual(e.target.checked)} /> Also reset seats I moved manually</label>
      <div className="modal-actions"><button className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy} onClick={() => void apply()}>Apply layout</button></div>
    </Modal>
  );
}

function PlanAndSeats({ ctx, canTeams, onClose, onChanged }: { ctx: Ctx; canTeams: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const { toast } = useKit();
  const [busy, setBusy] = useState(false);
  const [seats, setSeats] = useState<unknown[] | null>(null);
  const [rooms, setRooms] = useState<unknown[]>([]);
  const [fileName, setFileName] = useState('');
  const [replace, setReplace] = useState(false);

  async function uploadPlan(file: File | undefined) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return toast('Please choose a PDF under 25 MB.', 'error');
    setBusy(true);
    try {
      await uploadBlob('/admin/floor-plan', file, 'application/pdf');
      await Promise.all([ctx.reloadPlan(), onChanged()]);
      toast('Floor plan updated for everyone.', 'success');
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }

  async function readSeats(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as { seats?: unknown[] };
      if (!Array.isArray(parsed.seats) || !parsed.seats.length) throw new Error('That file has no seats.');
      setSeats(parsed.seats);
      setRooms(Array.isArray((parsed as { rooms?: unknown[] }).rooms) ? (parsed as { rooms: unknown[] }).rooms : []);
      setFileName(file.name);
    } catch { toast('That does not look like a seat inventory JSON file.', 'error'); setSeats(null); }
  }

  async function importSeats() {
    if (!seats) return;
    setBusy(true);
    try {
      const result = await api<{ created: number; updated: number; retired: number; teamsCreated: number; roomsImported: number }>('/admin/inventory/import', { method: 'POST', body: { seats, rooms, replace } });
      await onChanged();
      toast(`Imported: ${result.created} new, ${result.updated} updated, ${result.retired} retired, ${result.teamsCreated} new teams, ${result.roomsImported} rooms.`, 'success');
      setSeats(null);
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }

  return (
    <Modal title="Floor plan & seat list" onClose={onClose} wide>
      <div className="form-stack">
        <section>
          <h3>Floor plan PDF</h3>
          <p className="muted">Shown behind the seats for everyone. Stored privately in the database, only visible after sign-in.</p>
          <label className="button button-small file-button"><Icon name="download" size={16} /> {busy ? 'Working\u2026' : 'Choose PDF'}<input type="file" accept="application/pdf" disabled={busy} onChange={(e) => { void uploadPlan(e.target.files?.[0]); e.target.value = ''; }} /></label>
        </section>
        <section>
          <h3>Seat list (JSON)</h3>
          <p className="muted">The file made by the workbook importer: seat numbers, teams and positions. Existing seats with the same number are updated.</p>
          <label className="button button-small file-button"><Icon name="list" size={16} /> Choose JSON<input type="file" accept="application/json,.json" disabled={busy || !canTeams} onChange={(e) => { void readSeats(e.target.files?.[0]); e.target.value = ''; }} /></label>
          {!canTeams && <small className="muted"> Needs the team management permission.</small>}
          {seats && (
            <div className="assign-box">
              <strong>{fileName}: {seats.length} seats{rooms.length ? ` and ${rooms.length} rooms` : ''} ready</strong>
              <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /><span>Retire desks that are not in this file (cancels their upcoming bookings)</span></label>
              <button className="button button-primary button-small" disabled={busy} onClick={() => void importSeats()}>Import seats</button>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
