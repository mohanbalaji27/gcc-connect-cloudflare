import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Issue, IssueCategory, IssueCounts, IssuePriority, Resource } from '../../lib/types';
import { api, messageOf, newKey, uploadBlob } from '../../lib/api';
import { ago, isOpen, PRIORITY_LABEL, QUICK_PHRASES, shrinkPhoto, STATUS_LABEL } from '../../lib/issues';
import { loadResources } from '../../lib/resources';
import { nav } from '../../lib/nav';
import type { Ctx } from '../App';
import { FloorMap } from '../FloorMap';
import { Empty, Field, Icon, Modal, Spinner, Tabs, useKit } from '../kit';
import { IssueDetailView } from './IssueDetail';
import '../issues.css';

export interface IssueFocus { resourceId?: string; issueId?: string }
type Tab = 'report' | 'mine' | 'tasks' | 'queue';

export function IssuesScreen({ ctx, focus, clearFocus }: { ctx: Ctx; focus: IssueFocus | null; clearFocus: () => void }) {
  const can = (permission: string) => ctx.user.permissions.includes(permission);
  const works = can('issues.update');
  const queue = can('issues.view_all');
  const [tab, setTab] = useState<Tab>(ctx.user.simpleUi && works ? 'tasks' : 'report');
  const [openId, setOpenId] = useState<string | null>(focus?.issueId ?? null);
  const [resourceId, setResourceId] = useState<string | null>(focus?.resourceId ?? null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!focus) return;
    if (focus.issueId) setOpenId(focus.issueId);
    if (focus.resourceId) { setResourceId(focus.resourceId); setTab('report'); setOpenId(null); }
    clearFocus();
  }, [focus, clearFocus]);

  const tabs = [
    { id: 'report' as Tab, label: 'Report', icon: 'wrench' },
    { id: 'mine' as Tab, label: 'My reports', icon: 'list' },
    ...(works ? [{ id: 'tasks' as Tab, label: 'My tasks', icon: 'tasks' }] : []),
    ...(queue ? [{ id: 'queue' as Tab, label: 'Queue', icon: 'inbox' }] : []),
  ];
  const changed = useCallback(() => setVersion((value) => value + 1), []);

  if (openId) return <IssueDetailView ctx={ctx} id={openId} onBack={() => { setOpenId(null); changed(); }} onChanged={changed} />;
  return (
    <div className="iss">
      <div className="page-head"><div><span className="eyebrow">FACILITIES</span><h1>Report a problem</h1></div></div>
      <Tabs tabs={tabs} value={tab} onChange={(next) => { setTab(next); }} />
      {tab === 'report' && <ReportIssue ctx={ctx} resourceId={resourceId} clearResource={() => setResourceId(null)} onOpenMine={() => setTab('mine')} />}
      {tab === 'mine' && <IssueList key={`mine-${version}`} scope="mine" onOpen={setOpenId} empty={{ title: 'You have not reported anything', text: 'Spotted something broken? Tell us in under a minute.' }} />}
      {tab === 'tasks' && <IssueList key={`tasks-${version}`} scope="assigned" onOpen={setOpenId} empty={{ title: 'No tasks for you right now', text: 'Issues that are given to you show up here.' }} />}
      {tab === 'queue' && <IssueQueue key={`queue-${version}`} ctx={ctx} onOpen={setOpenId} />}
    </div>
  );
}

// ---------- Report ----------
function ReportIssue({ ctx, resourceId, clearResource, onOpenMine }: { ctx: Ctx; resourceId: string | null; clearResource: () => void; onOpenMine: () => void }) {
  const { toast, celebrate } = useKit();
  const [categories, setCategories] = useState<IssueCategory[] | null>(null);
  const [photosEnabled, setPhotosEnabled] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [resource, setResource] = useState<Resource | null>(null);
  const [place, setPlace] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<IssuePriority>('normal');
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ number: number } | null>(null);
  const [similar, setSimilar] = useState<{ id: string; number: number; people: number; locationText: string; mine: boolean; plusOned: boolean; status: string }[]>([]);
  const [error, setError] = useState('');
  const key = useRef(newKey());
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    api<{ categories: IssueCategory[]; photosEnabled: boolean }>('/issues/categories').then((result) => { setCategories(result.categories); setPhotosEnabled(result.photosEnabled); }).catch((reason) => { toast(messageOf(reason), 'error'); setCategories([]); });
  }, [toast]);

  // A seat or room QR (?report=...) opens the form already pointing at that place.
  useEffect(() => {
    if (!resourceId) return;
    api<{ resource: Resource }>(`/resources/${encodeURIComponent(resourceId)}`).then((result) => setResource(result.resource)).catch(() => toast('That seat or room is not available any more.', 'info'));
  }, [resourceId, toast]);

  const category = categories?.find((item) => item.id === categoryId);
  useEffect(() => {
    if (!categoryId) { setSimilar([]); return undefined; }
    let alive = true;
    const timer = window.setTimeout(() => {
      api<{ similar: typeof similar }>(`/issues/similar?${new URLSearchParams({ categoryId, ...(resource ? { resourceId: resource.id } : {}) })}`).then((result) => { if (alive) setSimilar(result.similar); }).catch(() => {});
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [categoryId, resource]);

  function pick(id: string) {
    setCategoryId(id);
    const next = categories?.find((item) => item.id === id);
    if (next) setPriority(next.defaultPriority === 'low' ? 'normal' : next.defaultPriority === 'urgent' ? 'urgent' : 'normal');
    window.setTimeout(() => form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
  async function plusOne(item: { id: string }) {
    try {
      const result = await api<{ people: number }>(`/issues/${item.id}/plus-one`, { method: 'PUT' });
      setSimilar((list) => list.map((entry) => (entry.id === item.id ? { ...entry, plusOned: true, people: result.people } : entry)));
      toast('Added your +1. We will let you know when it is fixed.', 'success');
    } catch (reason) { toast(messageOf(reason), 'error'); }
  }
  async function choosePhoto(file: File | undefined) {
    if (!file) return;
    try {
      const blob = await shrinkPhoto(file);
      setPhoto((current) => { if (current) URL.revokeObjectURL(current.url); return { blob, url: URL.createObjectURL(blob) }; });
    } catch (reason) { toast(messageOf(reason), 'error'); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!category) return;
    setBusy(true);
    setError('');
    try {
      const created = await api<{ id: string; number: number }>('/issues', {
        method: 'POST', headers: { 'Idempotency-Key': key.current },
        body: { categoryId, description, priority, resourceId: resource?.id, locationText: place.trim() || undefined },
      });
      if (photo) {
        try { await uploadBlob(`/issues/${created.id}/photo`, photo.blob, 'image/jpeg'); } catch { toast('Your report is in, but the photo did not upload. You can mention it in a comment.', 'info'); }
      }
      celebrate();
      setDone({ number: created.number });
    } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }
  function again() {
    key.current = newKey();
    setDone(null); setCategoryId(''); setDescription(''); setPlace(''); setPhoto(null); setResource(null); setPriority('normal'); clearResource();
  }

  if (categories === null) return <Spinner />;
  if (done) {
    return (
      <section className="panel iss-done">
        <span className="iss-done-icon"><Icon name="check" size={34} /></span>
        <h2>Thank you! Issue #{done.number} is logged.</h2>
        <p className="muted">The right people have been told. You will get a notification when it moves, and you can follow it under My reports.</p>
        <div className="modal-actions"><button className="button" onClick={again}>Report another</button><button className="button button-primary" onClick={onOpenMine}>See my reports</button></div>
      </section>
    );
  }
  if (categories.length === 0) return <Empty icon="wrench" title="Nothing to report here yet">An admin needs to switch on at least one category.</Empty>;

  return (
    <div className="iss-report">
      <section className="panel">
        <h2>What is the problem about?</h2>
        <div className="iss-tiles" role="radiogroup" aria-label="Category">
          {categories.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={categoryId === item.id} className={`iss-tile ${categoryId === item.id ? 'on' : ''}`} onClick={() => pick(item.id)}>
              <span className="iss-tile-emoji" aria-hidden="true">{item.emoji}</span><strong>{item.name}</strong>
            </button>
          ))}
        </div>
      </section>

      {category && (
        <form ref={form} className="panel form-stack iss-form" onSubmit={submit}>
          <h2><span aria-hidden="true">{category.emoji}</span> {category.name}</h2>
          {category.description && <p className="muted">{category.description}</p>}

          {similar.filter((item) => !item.mine).length > 0 && (
            <div className="iss-similar" role="status">
              <strong><Icon name="users" size={16} /> Someone already reported this</strong>
              {similar.filter((item) => !item.mine).map((item) => (
                <div key={item.id} className="iss-similar-row">
                  <span>#{item.number} · {item.people} {item.people === 1 ? 'person' : 'people'} · {STATUS_LABEL[item.status as keyof typeof STATUS_LABEL] ?? item.status}{item.locationText ? ` · ${item.locationText}` : ''}</span>
                  {item.plusOned ? <span className="pill pill-ok"><Icon name="check" size={13} /> You added +1</span> : <button type="button" className="button button-small" onClick={() => void plusOne(item)}>+1 me too</button>}
                </div>
              ))}
              <small>Add a +1 if it is the same problem. Otherwise carry on and report it below.</small>
            </div>
          )}

          <div className="iss-where">
            <span className="mini-label">Where?</span>
            {resource ? (
              <div className="iss-place"><Icon name="pin" size={16} /> <strong>{resource.type === 'room' ? 'Room' : 'Seat'} {resource.label}</strong><button type="button" className="text-link" onClick={() => { setResource(null); clearResource(); }}>Remove</button></div>
            ) : (
              <div className="iss-where-actions">
                <button type="button" className="button" onClick={() => setPicking(true)}><Icon name="map" size={18} /> Pick a seat or room</button>
                <button type="button" className="button" onClick={() => { nav.scanMode = 'report'; ctx.go('scan'); }}><Icon name="scan" size={18} /> Scan its QR</button>
              </div>
            )}
            <input value={place} onChange={(event) => setPlace(event.target.value)} maxLength={120} placeholder="Or say where: 3rd floor pantry, near the lifts…" aria-label="Where is it" />
          </div>

          <Field label="What is wrong?" hint={`${description.length}/1000`}>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={1000} required minLength={3} placeholder="A few words are enough" />
          </Field>
          <div className="iss-phrases" aria-label="Quick words">
            {QUICK_PHRASES.map((phrase) => <button key={phrase} type="button" className="chip" onClick={() => setDescription((text) => (text.trim() ? `${text.trim()}. ${phrase}` : phrase))}>{phrase}</button>)}
          </div>

          <fieldset className="iss-urgency">
            <legend className="mini-label">How urgent?</legend>
            <div className="segmented" role="radiogroup" aria-label="Urgency">
              {(['low', 'normal', 'urgent'] as IssuePriority[]).map((level) => (
                <button key={level} type="button" role="radio" aria-checked={priority === level} className={priority === level ? 'active' : ''} onClick={() => setPriority(level)}>
                  {level === 'urgent' && <Icon name="alert" size={15} />} {level === 'low' ? 'Can wait' : level === 'normal' ? 'Normal' : 'Urgent'}
                </button>
              ))}
            </div>
            {priority === 'urgent' && <small>Use urgent for safety risks, leaks and anything that stops people working.</small>}
          </fieldset>

          {photosEnabled && (
            <div className="iss-photo">
              <span className="mini-label">Photo (optional)</span>
              {photo ? (
                <div className="iss-photo-preview"><img src={photo.url} alt="Your photo" /><button type="button" className="button button-small" onClick={() => setPhoto(null)}><Icon name="trash" size={14} /> Remove</button></div>
              ) : (
                <label className="button file-button"><Icon name="camera" size={18} /> Add a photo<input type="file" accept="image/*" capture="environment" onChange={(event) => { void choosePhoto(event.target.files?.[0]); event.target.value = ''; }} /></label>
              )}
            </div>
          )}

          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button button-primary button-block iss-submit" disabled={busy || description.trim().length < 3}>{busy ? 'Sending…' : 'Send report'} <Icon name="arrow" size={18} /></button>
        </form>
      )}
      {picking && <LocationPicker ctx={ctx} onClose={() => setPicking(false)} onPick={(item) => { setResource(item); setPicking(false); }} />}
    </div>
  );
}

function LocationPicker({ ctx, onClose, onPick }: { ctx: Ctx; onClose: () => void; onPick: (resource: Resource) => void }) {
  const [list, setList] = useState<Resource[] | null>(null);
  const [view, setView] = useState<'search' | 'map'>('search');
  const [search, setSearch] = useState('');
  useEffect(() => { loadResources(ctx.configVersion).then(setList).catch(() => setList([])); }, [ctx.configVersion]);
  const term = search.trim().toLowerCase();
  const matches = useMemo(() => (list ?? []).filter((item) => !term || `${item.label} ${item.zone} ${item.team?.name ?? ''}`.toLowerCase().includes(term)).slice(0, 40), [list, term]);
  return (
    <Modal title="Where is it?" onClose={onClose} wide>
      <div className="segmented small" role="tablist"><button className={view === 'search' ? 'active' : ''} onClick={() => setView('search')}><Icon name="search" size={15} /> Search</button><button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}><Icon name="map" size={15} /> Map</button></div>
      {list === null ? <Spinner /> : view === 'search' ? (
        <>
          <div className="input-icon iss-search"><Icon name="search" size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Seat number or room name" autoFocus aria-label="Seat or room" /></div>
          {matches.length === 0 ? <Empty icon="search" title="No match">Check the number on the desk sticker.</Empty> : (
            <ul className="space-list compact iss-picker-list">{matches.map((item) => <li key={item.id}><button type="button" className="space-row" onClick={() => onPick(item)}><span className="space-icon"><Icon name={item.type} size={18} /></span><span className="space-text"><strong>{item.label}</strong><small>{item.team?.name ?? item.zone}</small></span><Icon name="arrow" size={16} /></button></li>)}</ul>
          )}
        </>
      ) : (
        <div className="iss-picker-map"><FloorMap resources={list} plan={ctx.plan} planLoading={ctx.planLoading} selectedIds={[]} onSelect={onPick} showAvailability={false} /></div>
      )}
    </Modal>
  );
}

// ---------- Lists ----------
export function IssueRow({ issue, onOpen, showReporter = false }: { issue: Issue; onOpen: (id: string) => void; showReporter?: boolean }) {
  return (
    <li>
      <button className={`iss-row ${isOpen(issue.status) ? '' : 'is-closed'}`} onClick={() => onOpen(issue.id)}>
        <span className="iss-emoji" aria-hidden="true">{issue.categoryEmoji}</span>
        <span className="iss-main">
          <strong>#{issue.number} · {issue.title}</strong>
          <small>{[issue.categoryName, issue.locationText, showReporter && issue.reporterName ? `by ${issue.reporterName}` : '', issue.assigneeName ? `→ ${issue.assigneeName}` : isOpen(issue.status) ? 'Unassigned' : ''].filter(Boolean).join(' · ')}</small>
        </span>
        <span className="iss-badges">
          <span className={`pill st-${issue.status}`}>{STATUS_LABEL[issue.status]}</span>
          {issue.priority !== 'normal' && isOpen(issue.status) && <span className={`pill pr-${issue.priority}`}>{PRIORITY_LABEL[issue.priority]}</span>}
          {issue.overdue && <span className="pill pill-off">Overdue</span>}
          {issue.plusOnes > 1 && <span className="pill">+{issue.plusOnes - 1}</span>}
          <small>{ago(issue.updatedAt)}</small>
        </span>
      </button>
    </li>
  );
}

function IssueList({ scope, onOpen, empty }: { scope: 'mine' | 'assigned'; onOpen: (id: string) => void; empty: { title: string; text: string } }) {
  const { toast } = useKit();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  useEffect(() => {
    api<{ issues: Issue[] }>(`/issues?scope=${scope}`).then((result) => setIssues(result.issues)).catch((reason) => { toast(messageOf(reason), 'error'); setIssues([]); });
  }, [scope, toast]);
  if (!issues) return <Spinner />;
  if (!issues.length) return <Empty icon="check" title={empty.title}>{empty.text}</Empty>;
  return <ul className="iss-list">{issues.map((issue) => <IssueRow key={issue.id} issue={issue} onOpen={onOpen} />)}</ul>;
}

// ---------- Staff queue ----------
const AGES = [['', 'Any age'], ['1', 'Older than a day'], ['3', 'Older than 3 days'], ['7', 'Older than a week']];

function IssueQueue({ ctx, onOpen }: { ctx: Ctx; onOpen: (id: string) => void }) {
  const { toast } = useKit();
  const [categories, setCategories] = useState<IssueCategory[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [filters, setFilters] = useState({ status: 'open', categoryId: '', priority: '', assignee: '', age: '', overdue: false, q: '', sort: 'newest' });
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [counts, setCounts] = useState<IssueCounts | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const canExport = ctx.user.permissions.includes('issues.export');

  useEffect(() => {
    api<{ categories: IssueCategory[] }>('/issues/categories').then((result) => setCategories(result.categories)).catch(() => {});
    api<{ people: { id: string; name: string }[] }>('/issues/assignees').then((result) => setPeople(result.people)).catch(() => {});
  }, []);

  const query = useCallback((offset: number) => new URLSearchParams({
    scope: 'all', status: filters.status, sort: filters.sort, offset: String(offset),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}), ...(filters.priority ? { priority: filters.priority } : {}),
    ...(filters.assignee ? { assignee: filters.assignee } : {}), ...(filters.age ? { olderThanDays: filters.age } : {}),
    ...(filters.overdue ? { overdue: '1' } : {}), ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
  }), [filters]);

  useEffect(() => {
    let alive = true;
    setIssues(null);
    const timer = window.setTimeout(() => {
      api<{ issues: Issue[]; hasMore: boolean; counts?: IssueCounts }>(`/issues?${query(0)}`).then((result) => {
        if (!alive) return;
        setIssues(result.issues); setMore(result.hasMore); if (result.counts) setCounts(result.counts);
      }).catch((reason) => { if (alive) { toast(messageOf(reason), 'error'); setIssues([]); } });
    }, filters.q ? 300 : 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query, filters.q, toast]);

  async function loadMore() {
    if (!issues) return;
    setBusy(true);
    try {
      const result = await api<{ issues: Issue[]; hasMore: boolean }>(`/issues?${query(issues.length)}`);
      setIssues([...issues, ...result.issues]); setMore(result.hasMore);
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }
  const set = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch }));
  const quick = (patch: Partial<typeof filters>) => setFilters({ status: 'open', categoryId: '', priority: '', assignee: '', age: '', overdue: false, q: '', sort: 'newest', ...patch });

  return (
    <div className="iss-queue">
      {counts && (
        <div className="iss-counts" role="group" aria-label="Quick filters">
          <button className={`iss-count ${filters.status === 'open' && !filters.assignee && !filters.overdue ? 'on' : ''}`} onClick={() => quick({})}><strong>{counts.open}</strong><span>Open</span></button>
          <button className={`iss-count ${filters.status === 'new' ? 'on' : ''}`} onClick={() => quick({ status: 'new' })}><strong>{counts.new}</strong><span>New</span></button>
          <button className={`iss-count ${filters.assignee === 'none' ? 'on' : ''}`} onClick={() => quick({ assignee: 'none' })}><strong>{counts.unassigned}</strong><span>Unassigned</span></button>
          <button className={`iss-count ${filters.assignee === 'me' ? 'on' : ''}`} onClick={() => quick({ assignee: 'me' })}><strong>{counts.mine}</strong><span>Mine</span></button>
          <button className={`iss-count warn ${filters.overdue ? 'on' : ''}`} onClick={() => quick({ overdue: true })}><strong>{counts.overdue}</strong><span>Overdue</span></button>
          <button className={`iss-count ${filters.status === 'resolved,closed' ? 'on' : ''}`} onClick={() => quick({ status: 'resolved,closed' })}><strong>{counts.closed ?? 0}</strong><span>Closed</span></button>
        </div>
      )}
      <section className="panel tight iss-filters">
        <div className="input-icon"><Icon name="search" size={18} /><input value={filters.q} onChange={(event) => set({ q: event.target.value })} placeholder="Search text, place or #number" aria-label="Search issues" /></div>
        <div className="iss-filter-grid">
          <select value={filters.status} onChange={(event) => set({ status: event.target.value })} aria-label="Status">
            <option value="open">Open</option><option value="resolved,closed">Closed & Resolved</option><option value="any">Any status</option>{(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
          </select>
          <select value={filters.categoryId} onChange={(event) => set({ categoryId: event.target.value })} aria-label="Category"><option value="">All categories</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.emoji} {item.name}</option>)}</select>
          <select value={filters.priority} onChange={(event) => set({ priority: event.target.value })} aria-label="Priority"><option value="">Any priority</option>{(['urgent', 'high', 'normal', 'low'] as IssuePriority[]).map((level) => <option key={level} value={level}>{PRIORITY_LABEL[level]}</option>)}</select>
          <select value={filters.assignee} onChange={(event) => set({ assignee: event.target.value })} aria-label="Assigned to"><option value="">Anyone</option><option value="me">Me</option><option value="none">Unassigned</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
          <select value={filters.age} onChange={(event) => set({ age: event.target.value })} aria-label="Age">{AGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select value={filters.sort} onChange={(event) => set({ sort: event.target.value })} aria-label="Sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="priority">Most urgent first</option></select>
        </div>
        {canExport && <a className="button button-small iss-export" href={`/api/admin/issues/export`} download><Icon name="download" size={15} /> Export all as CSV</a>}
      </section>
      {issues === null ? <Spinner /> : issues.length === 0 ? <Empty icon="check" title="Nothing here">No issues match these filters.</Empty> : (
        <>
          <ul className="iss-list">{issues.map((issue) => <IssueRow key={issue.id} issue={issue} onOpen={onOpen} showReporter />)}</ul>
          {more && <div className="modal-actions"><button className="button" onClick={() => void loadMore()} disabled={busy}>{busy ? 'Loading…' : 'Load more'}</button></div>}
        </>
      )}
    </div>
  );
}
