import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Resource } from '../../lib/types';
import { api, ApiError, messageOf, newKey } from '../../lib/api';
import { downloadCalendarFile, inIndia, nowTimeInIndia, timeRange, todayInIndia, toInstant } from '../../lib/format';
import type { Ctx, QrIntent } from '../App';
import { FloorMap } from '../FloorMap';
import { Empty, Icon, Modal, useKit } from '../kit';

import { isStayCode, rememberStay, rememberedStay, stayEnd, validStays } from '../../lib/stay';

function timeSlots() {
  const slots: string[] = [];
  for (let minutes = 6 * 60; minutes <= 21 * 60; minutes += 30) slots.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  return slots;
}
const SLOTS = timeSlots();

function defaultTime() {
  const now = nowTimeInIndia();
  const [h, m] = now.split(':').map(Number);
  const next = h * 60 + (m < 30 ? 30 : 60);
  const found = SLOTS.find((slot) => { const [sh, sm] = slot.split(':').map(Number); return sh * 60 + sm >= next; });
  return found ?? '09:00';
}

interface Props { ctx: Ctx; intent: QrIntent | { kind: 'desk' | 'room' } | null; clearIntent: () => void; online: boolean }

export function BookScreen({ ctx, intent, clearIntent, online }: Props) {
  const { toast, celebrate } = useKit();
  const [kind, setKind] = useState<'desk' | 'room'>('desk');
  const [date, setDate] = useState(todayInIndia());
  const [time, setTime] = useState(defaultTime());
  const [stay, setStayState] = useState<string>(() => rememberedStay() ?? 'd240');
  const setStay = (code: string) => { setStayState(code); rememberStay(code); };
  const [view, setView] = useState<'map' | 'list'>('map');
  const [search, setSearch] = useState('');
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [token, setToken] = useState<{ value: string; resourceId: string } | null>(null);
  const [highlightTeam, setHighlightTeam] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ resource: Resource; startsAt: string; endsAt: string } | null>(null);
  const attemptKey = useRef(newKey());
  const loadSeq = useRef(0);
  const handledIntent = useRef<unknown>(null);

  const starts = useMemo(() => toInstant(date, time), [date, time]);
  const stayOptions = useMemo(() => validStays(kind, date, time), [kind, date, time]);
  const ends = useMemo(() => stayEnd(date, time, stay), [date, time, stay]);
  const inPast = starts.getTime() < Date.now() - 60_000;
  const selected = resources.find((resource) => resource.id === selectedId) ?? null;
  const activeToken = token && selected && token.resourceId === selected.id ? token.value : null;

  useEffect(() => { attemptKey.current = newKey(); }, [selectedId, date, time, stay, token]);
  // If the chosen stay no longer fits (for example "until 5 pm" after a 6 pm arrival), fall back to a sensible default.
  useEffect(() => {
    if (stayOptions.length && !stayOptions.some((option) => option.code === stay)) setStayState((stayOptions.find((o) => o.code === (kind === 'desk' ? 'd240' : 'd60')) ?? stayOptions[stayOptions.length - 1]).code);
  }, [stayOptions, stay, kind]);

  const load = useCallback(async () => {
    if (Number.isNaN(starts.getTime())) return;
    const sequence = ++loadSeq.current;
    const query = new URLSearchParams({ type: kind, startsAt: starts.toISOString(), endsAt: ends.toISOString() });
    if (search.trim()) query.set('q', search.trim());
    try {
      const result = await api<{ resources: Resource[] }>(`/resources?${query}`);
      if (sequence === loadSeq.current) setResources(result.resources);
    } catch (reason) {
      if (sequence === loadSeq.current) toast(messageOf(reason), 'error');
    } finally {
      if (sequence === loadSeq.current) setLoading(false);
    }
  }, [kind, starts, ends, search, toast]);

  useEffect(() => {
    setLoading(true);
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!intent || handledIntent.current === intent) return;
    handledIntent.current = intent;
    if ('kind' in intent) { setKind(intent.kind); setSelectedId(null); setToken(null); clearIntent(); return; }
    api<{ resource: Resource }>(`/resources/${encodeURIComponent(intent.resourceId)}`)
      .then(({ resource }) => {
        setKind(resource.type);
        setSelectedId(resource.id);
        setToken(intent.token ? { value: intent.token, resourceId: resource.id } : null);
        setSearch('');
        if (isStayCode(intent.stay)) setStayState(intent.stay);
        toast(intent.token ? `Special QR accepted for ${resource.label}.` : `Found ${resource.label}.`, 'success');
      })
      .catch((reason) => toast(messageOf(reason), 'error'))
      .finally(clearIntent);
  }, [intent, clearIntent, toast]);

  async function confirm() {
    if (!selected) return;
    setBusy(true);
    try {
      await api('/bookings', { method: 'POST', headers: { 'Idempotency-Key': attemptKey.current }, body: { resourceId: selected.id, startsAt: starts.toISOString(), endsAt: ends.toISOString(), ...(activeToken ? { token: activeToken } : {}) } });
      celebrate();
      setDone({ resource: selected, startsAt: starts.toISOString(), endsAt: ends.toISOString() });
      if (activeToken) setToken(null);
      setSelectedId(null);
      void load();
    } catch (reason) {
      toast(messageOf(reason), 'error');
      if (reason instanceof ApiError && reason.code === 'TOKEN_UNAVAILABLE') setToken(null);
      if (reason instanceof ApiError && ['BOOKING_CONFLICT', 'TOKEN_UNAVAILABLE'].includes(reason.code)) void load();
    } finally {
      setBusy(false);
    }
  }

  const available = resources.filter((resource) => resource.available).length;
  const myTeam = ctx.user.team.trim().toLowerCase();
  function pickRandom(pool: Resource[], message: string, emptyMessage: string) {
    if (!pool.length) return toast(emptyMessage, 'info');
    const choice = pool[Math.floor(Math.random() * pool.length)];
    setSelectedId(choice.id);
    toast(message.replace('{label}', choice.label), 'success');
  }
  const listItems = useMemo(() => [...resources].sort((a, b) => Number(b.available) - Number(a.available) || a.label.localeCompare(b.label, undefined, { numeric: true })), [resources]);
  const mapResources = resources;
  const teamCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const resource of resources) if (resource.team && resource.available) counts.set(resource.team.id, (counts.get(resource.team.id) ?? 0) + 1);
    return counts;
  }, [resources]);

  return (
    <div className="book">
      <div className="page-head">
        <div><span className="eyebrow">BOOK A SPACE</span><h1>{kind === 'desk' ? 'Pick your perfect desk' : 'Find the right room'}</h1></div>
        <div className="segmented" role="tablist" aria-label="Space type">
          <button role="tab" aria-selected={kind === 'desk'} className={kind === 'desk' ? 'active' : ''} onClick={() => { setKind('desk'); setSelectedId(null); }}><Icon name="desk" size={18} /> Desks</button>
          <button role="tab" aria-selected={kind === 'room'} className={kind === 'room' ? 'active' : ''} onClick={() => { setKind('room'); setSelectedId(null); }}><Icon name="room" size={18} /> Rooms</button>
        </div>
      </div>

      {token && <div className="banner banner-fun"><Icon name="qr" size={18} /> You are booking with a special QR code. Confirm below to use it.<button className="text-link" onClick={() => setToken(null)}>Cancel</button></div>}

      <div className="controls">
        <label className="field"><span>Date</span><input type="date" value={date} min={todayInIndia()} max={todayInIndia(60)} onChange={(event) => event.target.value && setDate(event.target.value)} /></label>
        <label className="field"><span>Arrive</span>
          <select value={time} onChange={(event) => setTime(event.target.value)}>{SLOTS.map((slot) => <option key={slot} value={slot}>{inIndia(toInstant('2026-01-01', slot), { hour: 'numeric', minute: '2-digit' })}</option>)}</select>
        </label>
        <label className="field"><span>Stay</span>
          <select value={stay} onChange={(event) => setStay(event.target.value)}>{stayOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select>
        </label>
        <label className="field grow"><span>Search</span><div className="input-icon"><Icon name="search" size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={kind === 'desk' ? 'Seat number or team' : 'Room name or amenity'} maxLength={80} /></div></label>
      </div>
      {inPast && <div className="form-error">That time has already passed. Choose a later start.</div>}

      <div className="book-grid">
        <section className="book-main">
          <div className="book-toolbar">
            <strong>{loading ? 'Checking availability…' : `${available} of ${resources.length} ${kind === 'desk' ? 'desks' : 'rooms'} free`}</strong>
            {kind === 'desk' && !loading && (
              <div className="lucky-row">
                <button className="button button-small" onClick={() => pickRandom(resources.filter((r) => r.available && r.team && r.team.name.trim().toLowerCase() === myTeam), 'Sit with your team at {label}', 'No free seats in your team area right now. Try Surprise me!')}>👯 Sit with my team</button>
                <button className="button button-small" onClick={() => pickRandom(resources.filter((r) => r.available), 'How about {label}?', 'Everything is taken for that time. Try another slot.')}>🎲 Surprise me</button>
              </div>
            )}
            <div className="segmented small">
              <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}><Icon name="map" size={16} /> Map</button>
              <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><Icon name="list" size={16} /> List</button>
            </div>
          </div>
          {kind === 'desk' && ctx.teams.length > 0 && view === 'map' && (
            <div className="legend" aria-label="Team colours">
              {ctx.teams.filter((team) => team.seatCount > 0).map((team) => (
                <button key={team.id} className={`legend-chip ${highlightTeam === team.id ? 'on' : ''}`} onClick={() => setHighlightTeam(highlightTeam === team.id ? null : team.id)} style={{ ['--c' as string]: team.color }}>
                  <i />{team.name}<span>{teamCounts.get(team.id) ?? 0}</span>
                </button>
              ))}
            </div>
          )}
          {view === 'map' ? (
            ctx.plan || ctx.planLoading ? (
              <FloorMap resources={mapResources} plan={ctx.plan} planLoading={ctx.planLoading} selectedIds={selectedId ? [selectedId] : []} onSelect={(resource) => setSelectedId(resource.id)} highlightTeamId={highlightTeam} />
            ) : (
              <Empty icon="map" title="Floor plan not available">Showing the list instead. Ask an admin to add the floor plan.</Empty>
            )
          ) : (
            <ul className="space-list">
              {listItems.map((resource) => (
                <li key={resource.id}>
                  <button className={`space-row ${selectedId === resource.id ? 'selected' : ''}`} disabled={resource.available === false} onClick={() => setSelectedId(resource.id)}>
                    <span className="space-icon" style={{ background: resource.team?.color ?? '#e8efe9' }}><Icon name={resource.type} size={18} /></span>
                    <span className="space-text"><strong>{resource.label}</strong><small>{resource.team?.name ?? resource.zone ?? resource.floor}{resource.capacity ? ` · up to ${resource.capacity}` : ''}</small></span>
                    <span className={`pill ${resource.available ? 'pill-ok' : 'pill-off'}`}>{resource.available ? 'Free' : 'Booked'}</span>
                  </button>
                </li>
              ))}
              {listItems.length === 0 && !loading && <Empty icon="search" title="Nothing matches that">Try a different name or clear the search.</Empty>}
            </ul>
          )}
        </section>

        <aside className={`selection ${selected ? 'open' : ''}`} aria-live="polite">
          {selected ? (
            <>
              <button className="sheet-close icon-button" onClick={() => setSelectedId(null)} aria-label="Close details"><Icon name="x" /></button>
              <span className="eyebrow">YOUR PICK</span>
              <h2>{selected.label}</h2>
              <div className="badge-row">
                <span className="pill">{selected.type === 'desk' ? 'Desk' : 'Room'}</span>
                {selected.team && <span className="pill" style={{ background: selected.team.color, color: '#fff' }}>{selected.team.name}</span>}
                <span className={`pill ${loading ? '' : selected.available ? 'pill-ok' : 'pill-off'}`}>{loading ? 'Checking\u2026' : selected.available ? 'Free at this time' : 'Already booked'}</span>
              </div>
              {selected.description && <p className="muted">{selected.description}</p>}
              <div className="quick-time">
                <strong className="mini-label">When? Change it and availability updates live</strong>
                <div className="quick-time-row">
                  <input type="date" aria-label="Date" value={date} min={todayInIndia()} max={todayInIndia(60)} onChange={(event) => event.target.value && setDate(event.target.value)} />
                  <select aria-label="Arrive" value={time} onChange={(event) => setTime(event.target.value)}>{SLOTS.map((slot) => <option key={slot} value={slot}>{inIndia(toInstant('2026-01-01', slot), { hour: 'numeric', minute: '2-digit' })}</option>)}</select>
                  <select aria-label="Stay" value={stay} onChange={(event) => setStay(event.target.value)}>{stayOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select>
                </div>
              </div>
              <dl className="facts">
                <div><dt><Icon name="pin" size={16} /></dt><dd>{selected.building} · {selected.floor}{selected.zone ? ` · ${selected.zone}` : ''}</dd></div>
                <div><dt><Icon name="calendar" size={16} /></dt><dd>{inIndia(starts, { weekday: 'long', day: 'numeric', month: 'short' })}</dd></div>
                <div><dt><Icon name="clock" size={16} /></dt><dd>{timeRange(starts.toISOString(), ends.toISOString())}</dd></div>
                {selected.capacity && <div><dt><Icon name="users" size={16} /></dt><dd>Up to {selected.capacity} people</dd></div>}
                {selected.bookedBy && <div><dt><Icon name="eye" size={16} /></dt><dd>Booked by {selected.bookedBy}</dd></div>}
              </dl>
              {selected.amenities.length > 0 && <div className="badge-row">{selected.amenities.map((amenity) => <span className="chip" key={amenity}>{amenity}</span>)}</div>}
              <button className="button button-primary button-block" disabled={busy || loading || !selected.available || inPast || !online} onClick={() => void confirm()}>
                {busy ? 'Booking…' : `Book ${selected.label}`} <Icon name="arrow" size={18} />
              </button>
              {!online && <small className="muted">You’re offline — reconnect to book.</small>}
            </>
          ) : (
            <div className="selection-empty">
              <span className="selection-art"><Icon name={kind === 'desk' ? 'desk' : 'room'} size={34} /></span>
              <h2>Choose your space</h2>
              <p className="muted">Tap a {kind === 'desk' ? 'seat' : 'room'} on the map or pick from the list. Colours show which team sits where.</p>
              <ul className="tips"><li>Green dot = free for your time</li><li>Faded dot = already taken</li><li>Zoom in to read seat numbers</li></ul>
            </div>
          )}
        </aside>
      </div>

      {done && (
        <Modal title="You’re all set! 🎉" onClose={() => setDone(null)}>
          <div className="success-body">
            <span className="success-badge"><Icon name="check" size={34} /></span>
            <h3>{done.resource.label} is yours</h3>
            <p>{inIndia(done.startsAt, { weekday: 'long', day: 'numeric', month: 'long' })} · {timeRange(done.startsAt, done.endsAt)}</p>
            <p className="muted">Pop it in your calendar so future you doesn’t forget.</p>
            <div className="modal-actions">
              <button className="button button-primary" onClick={() => downloadCalendarFile(`${done.resource.label} at GCC`, `${done.resource.building} ${done.resource.floor}`, done.startsAt, done.endsAt)}><Icon name="download" size={18} /> Add to calendar</button>
              <button className="button" onClick={() => { setDone(null); ctx.go('bookings'); }}>View my bookings</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
