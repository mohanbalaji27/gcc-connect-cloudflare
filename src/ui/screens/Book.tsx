import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Resource } from '../../lib/types';
import { api, ApiError, messageOf, newKey } from '../../lib/api';
import { downloadCalendarFile, inIndia, nowTimeInIndia, timeRange, todayInIndia, toInstant } from '../../lib/format';
import { applyLocalBooking, loadDay, refreshLoaded, useAvailability } from '../../lib/availability';
import { clock, myOverlap, statusFor, type SpaceState, type SpaceStatus } from '../../lib/availabilityMath';
import { onWake } from '../../lib/pulse';
import { useResources } from '../../lib/resources';
import type { Ctx, QrIntent } from '../App';
import { DayStrip, StateLegend } from '../AvailabilityBits';
import { FloorMap, type MapState } from '../FloorMap';
import { Empty, Icon, Modal, Spinner, useKit } from '../kit';

import { isStayCode, nextDay, rememberStay, rememberedStay, stayEnd, validStays } from '../../lib/stay';

function timeSlots() {
  const slots: string[] = [];
  for (let minutes = 6 * 60; minutes <= 21 * 60; minutes += 30) slots.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  return slots;
}
const SLOTS = timeSlots();
const SLOT_LABELS = new Map(SLOTS.map((slot) => [slot, inIndia(toInstant('2026-01-01', slot), { hour: 'numeric', minute: '2-digit' })]));
const slotMinutes = (slot: string) => { const [h, m] = slot.split(':').map(Number); return h * 60 + m; };

// The next half hour today; after the last slot of the day, 9:00 tomorrow (instead of a time that has already passed).
function firstSlot() {
  const [h, m] = nowTimeInIndia().split(':').map(Number);
  const next = h * 60 + (m < 30 ? 30 : 60);
  const found = SLOTS.find((slot) => slotMinutes(slot) >= next);
  return found ? { date: todayInIndia(), time: found } : { date: todayInIndia(1), time: '09:00' };
}

const STATE_ORDER: Record<SpaceState, number> = { free: 0, mine: 1, booked: 2, blocked: 3 };
const STATE_PILL: Record<SpaceState, { text: string; className: string }> = {
  free: { text: 'Free', className: 'pill-ok' }, booked: { text: 'Booked at your time', className: 'pill-off' },
  mine: { text: 'Yours', className: 'pill-ok' }, blocked: { text: 'Not available', className: 'pill-warn' },
};

interface Props { ctx: Ctx; intent: QrIntent | { kind: 'desk' | 'room' } | null; clearIntent: () => void; online: boolean }

export function BookScreen({ ctx, intent, clearIntent, online }: Props) {
  const { toast, celebrate } = useKit();
  const initial = useRef(firstSlot());
  const [kind, setKind] = useState<'desk' | 'room'>('desk');
  const [date, setDate] = useState(initial.current.date);
  const [time, setTime] = useState(initial.current.time);
  const [stay, setStayState] = useState<string>(() => rememberedStay() ?? 'd240');
  const setStay = (code: string) => { setStayState(code); rememberStay(code); };
  const [view, setView] = useState<'map' | 'list'>('map');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [typing, setTyping] = useState(false);
  const [focus, setFocus] = useState<{ id: string; n: number; center?: boolean } | null>(null);
  const [token, setToken] = useState<{ value: string; resourceId: string } | null>(null);
  const [highlightTeam, setHighlightTeam] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setWakes] = useState(0);
  const [done, setDone] = useState<{ resource: Resource; startsAt: string; endsAt: string } | null>(null);
  const attemptKey = useRef(newKey());
  const handledIntent = useRef<unknown>(null);

  const { resources: all, error: loadError, reload } = useResources(ctx.configVersion);
  const starts = useMemo(() => toInstant(date, time), [date, time]);
  const stayOptions = useMemo(() => validStays(kind, date, time), [kind, date, time]);
  const ends = useMemo(() => stayEnd(date, time, stay), [date, time, stay]);
  const startMin = slotMinutes(time);
  const endMin = startMin + Math.round((ends.getTime() - starts.getTime()) / 60_000);
  const crossesMidnight = endMin > 1440;
  const avail = useAvailability(date, crossesMidnight);
  const inPast = starts.getTime() < Date.now() - 60_000;
  const selected = all?.find((resource) => resource.id === selectedId) ?? null;
  const activeToken = token && selected && token.resourceId === selected.id ? token.value : null;

  useEffect(() => { attemptKey.current = newKey(); }, [selectedId, date, time, stay, token]);
  // If the chosen stay no longer fits (for example "until 5 pm" after a 6 pm arrival), fall back to a sensible default.
  useEffect(() => {
    if (stayOptions.length && !stayOptions.some((option) => option.code === stay)) setStayState((stayOptions.find((o) => o.code === (kind === 'desk' ? 'd240' : 'd60')) ?? stayOptions[stayOptions.length - 1]).code);
  }, [stayOptions, stay, kind]);

  // Coming back to the tab (or the periodic pulse) re-checks only the date on screen; the server answers 304 when nothing changed.
  useEffect(() => onWake(() => {
    setWakes((count) => count + 1);
    void refreshLoaded(crossesMidnight ? [date, nextDay(date)] : [date]);
  }), [date, crossesMidnight]);

  const kindList = useMemo(() => (all ?? []).filter((resource) => resource.type === kind), [all, kind]);
  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return kindList;
    return kindList.filter((resource) => [resource.label, resource.zone, resource.floor, resource.team?.name ?? '', resource.amenities.join(' ')].some((value) => value.toLowerCase().includes(query)));
  }, [kindList, search]);

  const deskIds = useMemo(() => new Set((all ?? []).filter((resource) => resource.type === 'desk').map((resource) => resource.id)), [all]);
  const myDesk = useMemo(() => {
    if (kind !== 'desk' || !avail.first) return null;
    return myOverlap(avail.first, avail.second, Object.keys(avail.first.busy).filter((id) => deskIds.has(id)), startMin, endMin);
  }, [kind, avail.first, avail.second, deskIds, startMin, endMin]);
  const myDeskLabel = myDesk ? all?.find((resource) => resource.id === myDesk)?.label ?? 'a desk' : '';

  // Free / booked / yours for the chosen arrival time and stay, worked out here from the day's data: no server call.
  const known = Boolean(avail.first) && (!crossesMidnight || Boolean(avail.second));
  const statuses = useMemo(() => {
    const map = new Map<string, SpaceStatus>();
    if (inPast) {
      for (const resource of kindList) map.set(resource.id, { state: 'blocked', headline: 'That time has already passed', detail: 'Choose a later start.', freeFrom: null, intervals: [] });
      return map;
    }
    if (!known) return map;
    for (const resource of kindList) {
      let status = statusFor(avail.first, avail.second, resource.id, startMin, endMin);
      if (status.state === 'free' && myDesk && myDesk !== resource.id && resource.type === 'desk') {
        status = { ...status, state: 'blocked', headline: `You already have ${myDeskLabel} then`, detail: 'One desk at a time. Cancel it first to book this one.' };
      }
      map.set(resource.id, status);
    }
    return map;
  }, [kindList, inPast, known, avail.first, avail.second, startMin, endMin, myDesk, myDeskLabel]);

  const stateOf = useCallback((resource: Resource): MapState => statuses.get(resource.id)?.state ?? 'unknown', [statuses]);
  const tipFor = useCallback((resource: Resource) => {
    const status = statuses.get(resource.id);
    return status ? { headline: status.headline, detail: status.detail } : { headline: avail.unavailable ? 'Availability is not available right now' : 'Checking availability…' };
  }, [statuses, avail.unavailable]);

  useEffect(() => {
    if (!intent || handledIntent.current === intent) return;
    if ('kind' in intent) { handledIntent.current = intent; setKind(intent.kind); setSelectedId(null); setToken(null); clearIntent(); return; }
    if (!all) return;
    handledIntent.current = intent;
    const resource = all.find((item) => item.id === intent.resourceId);
    if (!resource) { toast('That space is not available any more. Ask an admin for a fresh QR code.', 'error'); clearIntent(); return; }
    setKind(resource.type);
    setSelectedId(resource.id);
    setFocus({ id: resource.id, n: Date.now(), center: true });
    setToken(intent.token ? { value: intent.token, resourceId: resource.id } : null);
    setSearch('');
    if (isStayCode(intent.stay)) setStayState(intent.stay);
    toast(intent.token ? `Special QR accepted for ${resource.label}.` : `Found ${resource.label}.`, 'success');
    clearIntent();
  }, [intent, all, clearIntent, toast]);

  const selectedStatus = selected ? statuses.get(selected.id) ?? null : null;
  const suggestion = useMemo(() => {
    if (selectedStatus?.state !== 'booked' || selectedStatus.freeFrom === null || crossesMidnight) return null;
    const slot = SLOTS.find((candidate) => slotMinutes(candidate) >= selectedStatus.freeFrom!);
    return slot ? { slot, label: SLOT_LABELS.get(slot) ?? slot } : null;
  }, [selectedStatus, crossesMidnight]);

  async function confirm() {
    if (!selected) return;
    if (starts.getTime() < Date.now() - 60_000) { setWakes((count) => count + 1); return toast('That time has already passed. Choose a later start.', 'error'); }
    setBusy(true);
    const startsAt = starts.toISOString();
    const endsAt = ends.toISOString();
    try {
      await api('/bookings', { method: 'POST', headers: { 'Idempotency-Key': attemptKey.current }, body: { resourceId: selected.id, startsAt, endsAt, ...(activeToken ? { token: activeToken } : {}) } });
      // The map changes straight away; no need to ask the server again.
      applyLocalBooking(selected.id, startsAt, endsAt, true, ctx.user.name);
      ctx.invalidateSummary();
      celebrate();
      setDone({ resource: selected, startsAt, endsAt });
      if (activeToken) setToken(null);
      setSelectedId(null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code !== 'NETWORK') attemptKey.current = newKey();
      if (reason instanceof ApiError && reason.code === 'TOKEN_UNAVAILABLE') setToken(null);
      if (reason instanceof ApiError && ['BOOKING_CONFLICT', 'TOKEN_UNAVAILABLE', 'ALREADY_BOOKED'].includes(reason.code)) {
        // Someone got there first (or you already hold a desk then): re-check the day and say when it is free again.
        const [first, second] = await Promise.all([loadDay(date, { force: true }), crossesMidnight ? loadDay(nextDay(date), { force: true }) : Promise.resolve(undefined)]);
        const fresh = first ? statusFor(first, second ?? undefined, selected.id, startMin, endMin) : null;
        if (reason.code === 'BOOKING_CONFLICT' && fresh?.state === 'booked') {
          toast(`${selected.label} was just booked by someone else${fresh.freeFrom !== null ? `. It is free from ${clock(fresh.freeFrom)}.` : '.'}`, 'error');
        } else toast(messageOf(reason), 'error');
      } else toast(messageOf(reason), 'error');
    } finally {
      setBusy(false);
    }
  }

  const freeCount = matches.filter((resource) => statuses.get(resource.id)?.state === 'free').length;
  const myTeam = ctx.user.team.trim().toLowerCase();
  const isFree = (resource: Resource) => statuses.get(resource.id)?.state === 'free';
  function pickRandom(pool: Resource[], message: string, emptyMessage: string) {
    if (!pool.length) return toast(emptyMessage, 'info');
    const choice = pool[Math.floor(Math.random() * pool.length)];
    setSelectedId(choice.id);
    setView('map');
    setFocus({ id: choice.id, n: Date.now(), center: true });
    toast(message.replace('{label}', choice.label), 'success');
  }
  const listItems = useMemo(() => [...matches].sort((a, b) => STATE_ORDER[statuses.get(a.id)?.state ?? 'free'] - STATE_ORDER[statuses.get(b.id)?.state ?? 'free'] || a.label.localeCompare(b.label, undefined, { numeric: true })), [matches, statuses]);
  const teamCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const resource of kindList) if (resource.team && statuses.get(resource.id)?.state === 'free') counts.set(resource.team.id, (counts.get(resource.team.id) ?? 0) + 1);
    return counts;
  }, [kindList, statuses]);

  const pill = selectedStatus ? STATE_PILL[selectedStatus.state] : null;
  const canBook = Boolean(selected && selectedStatus?.state === 'free' && !inPast && online && !busy);
  const dateLabel = inIndia(starts, { weekday: 'short', day: 'numeric', month: 'short' });
  const timeControls = (
    <>
      <input type="date" aria-label="Date" value={date} min={todayInIndia()} max={todayInIndia(60)} onChange={(event) => event.target.value && setDate(event.target.value)} />
      <select aria-label="Arrive" value={time} onChange={(event) => setTime(event.target.value)}>{SLOTS.map((slot) => <option key={slot} value={slot}>{SLOT_LABELS.get(slot)}</option>)}</select>
      <select aria-label="Stay" value={stay} onChange={(event) => setStay(event.target.value)}>{stayOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select>
    </>
  );

  return (
    <div className={`book ${selected ? 'has-sheet' : ''} ${typing ? 'is-typing' : ''}`}>
      <div className="page-head">
        <div><span className="eyebrow">BOOK A SPACE</span><h1>{kind === 'desk' ? 'Pick your perfect desk' : 'Find the right room'}</h1></div>
        <div className="segmented" role="tablist" aria-label="Space type">
          <button role="tab" aria-selected={kind === 'desk'} className={kind === 'desk' ? 'active' : ''} onClick={() => { setKind('desk'); setSelectedId(null); }}><Icon name="desk" size={18} /> Desks</button>
          <button role="tab" aria-selected={kind === 'room'} className={kind === 'room' ? 'active' : ''} onClick={() => { setKind('room'); setSelectedId(null); }}><Icon name="room" size={18} /> Rooms</button>
        </div>
      </div>

      {token && <div className="banner banner-fun"><Icon name="qr" size={18} /> <span>You are booking with a special QR code. Confirm below to use it.</span><button className="text-link" onClick={() => setToken(null)}>Not now</button></div>}

      <div className="controls">
        <label className="field"><span>Date</span><input type="date" value={date} min={todayInIndia()} max={todayInIndia(60)} onChange={(event) => event.target.value && setDate(event.target.value)} /></label>
        <label className="field"><span>Arrive</span>
          <select value={time} onChange={(event) => setTime(event.target.value)}>{SLOTS.map((slot) => <option key={slot} value={slot}>{SLOT_LABELS.get(slot)}</option>)}</select>
        </label>
        <label className="field"><span>Stay</span>
          <select value={stay} onChange={(event) => setStay(event.target.value)}>{stayOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select>
        </label>
        <label className="field grow"><span>Search</span><div className="input-icon"><Icon name="search" size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} onFocus={() => setTyping(true)} onBlur={() => setTyping(false)} placeholder={kind === 'desk' ? 'Find a seat' : 'Find a room'} maxLength={80} enterKeyHint="search" /></div></label>
      </div>
      {inPast && <div className="form-error">That time has already passed. Choose a later start.</div>}
      {myDesk && kind === 'desk' && !inPast && (
        <div className="banner banner-fun" role="status"><Icon name="check" size={18} /> <span>You already have <strong>{myDeskLabel}</strong> at this time, so the other desks are greyed out. Pick another time, or cancel it to switch desks.</span><button className="text-link" onClick={() => ctx.go('bookings')}>My bookings</button></div>
      )}
      {avail.unavailable && <div className="banner" role="status"><span>Live availability could not be loaded. You can still book; we check again when you confirm.</span><button className="button button-small" onClick={() => void refreshLoaded()}>Retry</button></div>}

      <div className="book-grid">
        <section className="book-main">
          <div className="book-toolbar">
            <div className="toolbar-top">
              <strong>{inPast ? `${matches.length} ${kind === 'desk' ? 'desks' : 'rooms'}` : known ? `${freeCount} of ${matches.length} ${kind === 'desk' ? 'desks' : 'rooms'} free` : 'Checking availability…'}</strong>
              <div className="segmented small">
                <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}><Icon name="map" size={16} /> Map</button>
                <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><Icon name="list" size={16} /> List</button>
              </div>
            </div>
            {kind === 'desk' && known && (
              <div className="lucky-row">
                <button className="button button-small" onClick={() => pickRandom(kindList.filter((r) => isFree(r) && r.team && r.team.name.trim().toLowerCase() === myTeam), 'Sit with your team at {label}', 'No free seats in your team area right now. Try Surprise me!')}>👯 Sit with my team</button>
                <button className="button button-small" onClick={() => pickRandom(kindList.filter(isFree), 'How about {label}?', 'Everything is taken for that time. Try another slot.')}>🎲 Surprise me</button>
              </div>
            )}
          </div>
          <StateLegend />
          {kind === 'desk' && ctx.teams.length > 0 && view === 'map' && (
            <div className="legend" aria-label="Team colours">
              {ctx.teams.filter((team) => team.seatCount > 0).map((team) => (
                <button key={team.id} className={`legend-chip ${highlightTeam === team.id ? 'on' : ''}`} onClick={() => setHighlightTeam(highlightTeam === team.id ? null : team.id)} style={{ ['--c' as string]: team.color }}>
                  <i />{team.name}<span>{teamCounts.get(team.id) ?? 0}</span>
                </button>
              ))}
            </div>
          )}
          {all === null ? (loadError ? <Empty icon="map" title="Could not load the spaces"><button className="button button-small" onClick={reload}>Try again</button></Empty> : <Spinner label="Loading the office" />) : view === 'map' ? (
            ctx.plan || ctx.planLoading ? (
              <FloorMap resources={kindList} plan={ctx.plan} planLoading={ctx.planLoading} selectedIds={selectedId ? [selectedId] : []} onSelect={(resource) => { setSelectedId(resource.id); setExpanded(false); setFocus({ id: resource.id, n: Date.now() }); }} highlightTeamId={highlightTeam} stateOf={stateOf} tipFor={tipFor} focus={focus} />
            ) : (
              <Empty icon="map" title="Floor plan not available">Showing the list instead. Ask an admin to add the floor plan.</Empty>
            )
          ) : (
            <ul className="space-list">
              {listItems.map((resource) => {
                const status = statuses.get(resource.id);
                const tag = status ? STATE_PILL[status.state] : null;
                return (
                  <li key={resource.id}>
                    <button className={`space-row ${selectedId === resource.id ? 'selected' : ''}`} onClick={() => { setSelectedId(resource.id); setExpanded(false); }}>
                      <span className="space-icon" style={{ background: resource.team?.color ?? '#e8efe9' }}><Icon name={resource.type} size={18} /></span>
                      <span className="space-text"><strong>{resource.label}</strong><small>{status ? status.headline : resource.team?.name ?? resource.zone ?? resource.floor}{resource.capacity ? ` · up to ${resource.capacity}` : ''}</small></span>
                      {tag && <span className={`pill ${tag.className}`}>{tag.text}</span>}
                    </button>
                  </li>
                );
              })}
              {listItems.length === 0 && <Empty icon="search" title="Nothing matches that">Try a different name or clear the search.</Empty>}
            </ul>
          )}
        </section>

        <aside className={`selection ${selected ? 'open' : ''} ${expanded ? 'expanded' : ''}`} aria-live="polite">
          {selected ? (
            <>
              <div className="sheet-head">
                <div><span className="eyebrow">YOUR PICK</span><h2>{selected.label}</h2></div>
                <button className="sheet-close icon-button" onClick={() => setSelectedId(null)} aria-label="Close details"><Icon name="x" /></button>
              </div>
              <div className="sheet-body">
                <div className="badge-row">
                  <span className="pill">{selected.type === 'desk' ? 'Desk' : 'Room'}</span>
                  {selected.team && <span className="pill" style={{ background: selected.team.color, color: '#fff' }}>{selected.team.name}</span>}
                  <span className={`pill ${pill?.className ?? ''}`}>{pill ? (pill.text === 'Free' ? 'Free at your time' : pill.text) : avail.unavailable ? 'Unknown' : 'Checking…'}</span>
                </div>
                <div className={`avail-card is-${selectedStatus?.state ?? 'unknown'}`}>
                  <strong>{selectedStatus ? selectedStatus.headline : avail.unavailable ? 'We could not check this time' : 'Checking availability…'}</strong>
                  {selectedStatus?.detail && <small>{selectedStatus.detail}</small>}
                  {(selected.type === 'room' || (selectedStatus?.intervals.length ?? 0) > 0) && avail.first && <DayStrip intervals={selectedStatus?.intervals ?? []} startMin={startMin} endMin={endMin} />}
                  {suggestion && <button className="button button-small" onClick={() => setTime(suggestion.slot)}><Icon name="clock" size={15} /> Switch to {suggestion.label}</button>}
                </div>
                <div className="sheet-extra">
                  {selected.description && <p className="muted">{selected.description}</p>}
                  <div className="quick-time">
                    <strong className="mini-label">When? Changing this updates the colours instantly</strong>
                    <div className="quick-time-row">{timeControls}</div>
                  </div>
                  <dl className="facts">
                    <div><dt><Icon name="pin" size={16} /></dt><dd>{selected.building} · {selected.floor}{selected.zone ? ` · ${selected.zone}` : ''}</dd></div>
                    {selected.capacity && <div><dt><Icon name="users" size={16} /></dt><dd>Up to {selected.capacity} people</dd></div>}
                  </dl>
                  {selected.amenities.length > 0 && <div className="badge-row">{selected.amenities.map((amenity) => <span className="chip" key={amenity}>{amenity}</span>)}</div>}
                </div>
              </div>
              <div className="sheet-foot">
                <button type="button" className="sheet-when" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
                  <span className="sheet-when-text"><Icon name="calendar" size={15} /> {dateLabel} · {timeRange(starts.toISOString(), ends.toISOString())}</span>
                  <span className="sheet-toggle">{expanded ? 'Hide' : 'Change'}</span>
                </button>
                <button className="button button-primary button-block" disabled={!canBook} onClick={() => void confirm()}>
                  {busy ? 'Booking…' : selectedStatus?.state === 'mine' ? 'Already yours' : selectedStatus && selectedStatus.state !== 'free' ? 'Not available at this time' : `Book ${selected.label}`} {canBook && <Icon name="arrow" size={18} />}
                </button>
                {!online && <small className="muted">You’re offline — reconnect to book.</small>}
              </div>
            </>
          ) : (
            <div className="selection-empty">
              <span className="selection-art"><Icon name={kind === 'desk' ? 'desk' : 'room'} size={34} /></span>
              <h2>Choose your space</h2>
              <p className="muted">Tap a {kind === 'desk' ? 'seat' : 'room'} on the map or pick from the list. Hover or tap to see when it is booked and when it is free.</p>
              <ul className="tips"><li>Colours follow the time you chose above</li><li>Change the time and the map updates instantly</li><li>Zoom in to read seat numbers</li></ul>
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
