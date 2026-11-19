import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEntry, AuditPage } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia, todayInIndia } from '../../lib/format';
import { Empty, Icon, Spinner, useKit } from '../kit';

type Range = 'all' | 'today' | '7' | '30' | 'custom';
const RANGES: { id: Range; label: string }[] = [{ id: 'all', label: 'All time' }, { id: 'today', label: 'Today' }, { id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: 'custom', label: 'Custom' }];
interface Person { id: string; name: string; email: string; active: boolean }

const istStart = (key: string) => new Date(`${key}T00:00:00+05:30`);
const nextDay = (key: string) => new Date(istStart(key).getTime() + 86_400_000);

function PersonPicker({ value, onChange }: { value: Person | null; onChange: (person: Person | null) => void }) {
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<Person[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const text = term.trim();
    if (text.length < 2) { setFound([]); return undefined; }
    let alive = true;
    const timer = window.setTimeout(() => {
      api<{ people: Person[] }>(`/admin/audit/people?q=${encodeURIComponent(text)}`).then((result) => { if (alive) setFound(result.people); }).catch(() => { if (alive) setFound([]); });
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [term]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (value) {
    return (
      <div className="filter-field"><span className="filter-label">Person</span>
        <span className="person-chip"><strong>{value.name}</strong><button type="button" className="icon-button" aria-label={`Remove the filter for ${value.name}`} onClick={() => { onChange(null); setTerm(''); }}><Icon name="x" size={14} /></button></span></div>
    );
  }
  return (
    <div className="filter-field person-picker" ref={box}>
      <label className="filter-label" htmlFor="audit-person">Person</label>
      <input id="audit-person" type="search" autoComplete="off" placeholder="Name or email" value={term} maxLength={60} role="combobox" aria-expanded={open && found.length > 0} aria-controls="audit-person-list"
        onChange={(event) => { setTerm(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }} />
      {open && found.length > 0 && (
        <ul id="audit-person-list" className="person-list" role="listbox">
          {found.map((person) => (
            <li key={person.id} role="option" aria-selected="false"><button type="button" onClick={() => { onChange(person); setOpen(false); }}><strong>{person.name}</strong><small>{person.email}{person.active ? '' : ' · suspended'}</small></button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ManageActivity() {
  const { toast } = useKit();
  const [person, setPerson] = useState<Person | null>(null);
  const [area, setArea] = useState('all');
  const [range, setRange] = useState<Range>('all');
  const [custom, setCustom] = useState({ from: todayInIndia(-6), to: todayInIndia() });
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [areas, setAreas] = useState<{ id: string; label: string }[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef(0);

  useEffect(() => { const timer = window.setTimeout(() => setQuery(typed.trim()), 300); return () => window.clearTimeout(timer); }, [typed]);

  const dates = useMemo(() => {
    if (range === 'all') return {};
    if (range === 'today') return { from: istStart(todayInIndia()).toISOString() };
    if (range === '7' || range === '30') return { from: istStart(todayInIndia(-(Number(range) - 1))).toISOString() };
    const out: { from?: string; to?: string } = {};
    if (custom.from) out.from = istStart(custom.from).toISOString();
    if (custom.to) out.to = nextDay(custom.to).toISOString();
    return out;
  }, [range, custom]);
  const customInvalid = range === 'custom' && Boolean(custom.from && custom.to && custom.from > custom.to);

  const filters = useMemo(() => {
    const params = new URLSearchParams();
    if (person) params.set('user', person.id);
    if (area !== 'all') params.set('area', area);
    if (query) params.set('q', query);
    if (dates.from) params.set('from', dates.from);
    if (dates.to) params.set('to', dates.to);
    return params;
  }, [person, area, query, dates]);
  const active = Boolean(person || area !== 'all' || query || range !== 'all');

  const loadFirst = useCallback(async () => {
    if (customInvalid) return;
    const mine = ++request.current;
    setEntries(null);
    try {
      const page = await api<AuditPage>(`/admin/audit?${filters}`);
      if (mine !== request.current) return;
      setEntries(page.entries); setNext(page.next); setTotal(page.total ?? null);
      if (page.areas) setAreas(page.areas);
    } catch (reason) { if (mine === request.current) { toast(messageOf(reason), 'error'); setEntries([]); setNext(null); setTotal(0); } }
  }, [filters, customInvalid, toast]);
  useEffect(() => { void loadFirst(); }, [loadFirst]);

  async function loadMore() {
    if (!next) return;
    const mine = request.current;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams(filters);
      params.set('before', next);
      const page = await api<AuditPage>(`/admin/audit?${params}`);
      if (mine !== request.current) return;
      setEntries((current) => [...(current ?? []), ...page.entries]);
      setNext(page.next);
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setLoadingMore(false); }
  }

  function clear() { setPerson(null); setArea('all'); setRange('all'); setTyped(''); setQuery(''); }
  const exportUrl = `/api/admin/audit/export?${filters}`;

  return (
    <section className="panel activity">
      <div className="panel-head"><h2>Recent activity</h2>
        <div className="panel-tools"><a className="button button-small button-primary" href={exportUrl} download><Icon name="download" size={16} /> Export CSV</a></div></div>

      <div className="filter-bar">
        <PersonPicker value={person} onChange={setPerson} />
        <div className="filter-field"><label className="filter-label" htmlFor="audit-area">Area</label>
          <select id="audit-area" value={area} onChange={(event) => setArea(event.target.value)}>
            <option value="all">Everything</option>
            {areas.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></div>
        <div className="filter-field"><label className="filter-label" htmlFor="audit-search">Search</label>
          <input id="audit-search" type="search" placeholder="What happened, or a detail" value={typed} maxLength={80} onChange={(event) => setTyped(event.target.value)} /></div>
        <div className="filter-field filter-dates"><span className="filter-label" id="audit-range-label">When</span>
          <div className="range-chips" role="group" aria-labelledby="audit-range-label">
            {RANGES.map((item) => <button key={item.id} type="button" className={`chip ${range === item.id ? 'on' : ''}`} aria-pressed={range === item.id} onClick={() => setRange(item.id)}>{item.label}</button>)}
          </div>
          {range === 'custom' && (
            <div className="custom-range">
              <label className="inline-date">From <input type="date" value={custom.from} max={custom.to || undefined} onChange={(event) => setCustom({ ...custom, from: event.target.value })} /></label>
              <label className="inline-date">To <input type="date" value={custom.to} onChange={(event) => setCustom({ ...custom, to: event.target.value })} /></label>
              {customInvalid && <small className="field-error" role="alert">The start date is after the end date.</small>}
            </div>
          )}
        </div>
      </div>
      <div className="filter-summary" aria-live="polite">
        <small>{entries === null ? 'Loading…' : total === null ? '' : `${entries.length < total ? `Showing ${entries.length} of ${total}` : `${total}`} ${total === 1 ? 'entry' : 'entries'}${active ? ' match your filters' : ''}`}</small>
        {active && <button type="button" className="text-link" onClick={clear}>Clear filters</button>}
      </div>

      {entries === null ? <Spinner /> : entries.length === 0 ? <Empty icon="list" title={active ? 'Nothing matches these filters' : 'Nothing yet'}>{active ? 'Try a wider date range or clear a filter.' : undefined}</Empty> : (
        <>
          <ul className="activity-list">{entries.map((entry) => (
            <li key={entry.id} className={`activity-item area-${entry.area}`}>
              <div className="activity-main">
                <span className="activity-title"><span className="pill">{entry.areaLabel}</span> <strong>{entry.title}</strong></span>
                <span className="activity-text">{entry.text}</span>
              </div>
              <time className="activity-time" dateTime={entry.at}>{inIndia(entry.at, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</time>
            </li>
          ))}</ul>
          {next && <div className="load-more"><button className="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show older entries'}</button></div>}
        </>
      )}
      <p className="muted small-print">The export follows the filters above (up to 5,000 rows). Sign-ins are shown here too but are kept separately from the activity log.</p>
    </section>
  );
}
