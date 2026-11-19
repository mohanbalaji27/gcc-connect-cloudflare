import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Resource } from '../lib/types';
import type { FloorPlanImage } from '../lib/floorplan';
import { labelFont, layoutLabels } from '../lib/labelLayout';
import { Icon } from './kit';

export type MapState = 'free' | 'booked' | 'mine' | 'blocked' | 'unknown';
export interface MapTip { headline: string; detail?: string }

interface Props {
  resources: Resource[];
  plan: FloorPlanImage | null;
  planLoading?: boolean;
  selectedIds: string[];
  onSelect: (resource: Resource, additive: boolean) => void;
  mode?: 'book' | 'edit';
  tool?: 'move' | 'select';
  onMove?: (id: string, x: number, y: number) => void;
  onSelectMany?: (ids: string[], additive: boolean) => void;
  highlightTeamId?: string | null;
  showAvailability?: boolean;
  /** Booking mode: how each space looks for the chosen time. Without it, the old resource.available flag is used. */
  stateOf?: (resource: Resource) => MapState;
  /** Booking mode: text for the hover card (desktop). Called only for the hovered space. */
  tipFor?: (resource: Resource) => MapTip | null;
  /** Bring this space into view. `center` also scrolls the map to it (for picks made outside the map, e.g. a QR scan); without it
   *  only the page is nudged so the booking sheet on phones does not cover the space. */
  focus?: { id: string; n: number; center?: boolean } | null;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

export function FloorMap({ resources, plan, planLoading, selectedIds, onSelect, mode = 'book', tool = 'move', onMove, onSelectMany, highlightTeamId, showAvailability = true, stateOf, tipFor, focus }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 700 ? 2.8 : 1));
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const aspect = plan ? plan.width / plan.height : 1684 / 1191;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const zoomRef = useRef(zoom);
  const anchor = useRef<{ fx: number; fy: number; ox: number; oy: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const panCandidate = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [panning, setPanning] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    setViewportWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Zoom keeping the point under (clientX, clientY) fixed on screen.
  const zoomAt = useCallback((next: number, clientX?: number, clientY?: number) => {
    const element = viewport.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (!element || clamped === zoomRef.current) return;
    const rect = element.getBoundingClientRect();
    const ox = clientX === undefined ? element.clientWidth / 2 : clientX - rect.left;
    const oy = clientY === undefined ? element.clientHeight / 2 : clientY - rect.top;
    anchor.current = { fx: (element.scrollLeft + ox) / element.scrollWidth, fy: (element.scrollTop + oy) / element.scrollHeight, ox, oy };
    zoomRef.current = clamped;
    setZoom(clamped);
  }, []);
  const changeZoom = useCallback((next: number) => zoomAt(next), [zoomAt]);

  useLayoutEffect(() => {
    const element = viewport.current;
    const target = anchor.current;
    if (!element || !target) return;
    element.scrollLeft = target.fx * element.scrollWidth - target.ox;
    element.scrollTop = target.fy * element.scrollHeight - target.oy;
    anchor.current = null;
  }, [zoom]);

  // Mouse wheel zooms toward the cursor. At 100% a downward scroll is left alone so the page can still scroll.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey && zoomRef.current <= MIN_ZOOM && event.deltaY > 0) return;
      event.preventDefault();
      const factor = Math.exp(-Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 120) * 0.0022);
      zoomAt(zoomRef.current * factor, event.clientX, event.clientY);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const canPan = !(mode === 'edit' && tool === 'select');
  const onViewportDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('.seat-dot') && mode === 'edit' && tool === 'move') return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: zoomRef.current };
      panCandidate.current = null;
      setBand(null);
      setDrag(null);
    } else if (pointers.current.size === 1 && canPan) {
      const element = viewport.current!;
      panCandidate.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop, moved: false };
    }
  };
  const onViewportMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      suppressClick.current = true;
      zoomAt(pinch.current.zoom * (dist / pinch.current.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const candidate = panCandidate.current;
    if (!candidate) return;
    const dx = event.clientX - candidate.x;
    const dy = event.clientY - candidate.y;
    if (!candidate.moved) {
      if (Math.hypot(dx, dy) < 6) return;
      candidate.moved = true;
      suppressClick.current = true;
      setPanning(true);
      try { viewport.current?.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    }
    const element = viewport.current!;
    element.scrollLeft = candidate.left - dx;
    element.scrollTop = candidate.top - dy;
  };
  const onViewportUp = (event: React.PointerEvent) => {
    const wasPinch = pinch.current !== null;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (wasPinch || pointers.current.size === 0) panCandidate.current = null;
    if (pointers.current.size === 0) {
      setPanning(false);
      if (suppressClick.current) window.setTimeout(() => { suppressClick.current = false; }, 60);
    }
  };

  const pointToPercent = (event: { clientX: number; clientY: number }) => {
    const rect = surface.current!.getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  };

  const beginDrag = (event: React.PointerEvent, resource: Resource) => {
    if (mode !== 'edit' || tool !== 'move' || !onMove || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id: resource.id, x: resource.x ?? 50, y: resource.y ?? 50, moved: false });
  };
  const moveDrag = (event: React.PointerEvent) => {
    if (!drag) return;
    const point = pointToPercent(event);
    setDrag({ ...drag, x: point.x, y: point.y, moved: true });
  };
  const endDrag = (event: React.PointerEvent, resource: Resource) => {
    if (!drag) return;
    const finished = drag;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (finished.moved) onMove?.(resource.id, Math.round(finished.x * 100) / 100, Math.round(finished.y * 100) / 100);
    else onSelect(resource, event.shiftKey || event.ctrlKey || event.metaKey);
  };

  const beginBand = (event: React.PointerEvent) => {
    if (mode !== 'edit' || tool !== 'select' || event.target !== event.currentTarget || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointToPercent(event);
    setBand({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
  };
  const moveBand = (event: React.PointerEvent) => {
    if (!band) return;
    const point = pointToPercent(event);
    setBand({ ...band, x1: point.x, y1: point.y });
  };
  const endBand = (event: React.PointerEvent) => {
    if (!band) return;
    const box = { minX: Math.min(band.x0, band.x1), maxX: Math.max(band.x0, band.x1), minY: Math.min(band.y0, band.y1), maxY: Math.max(band.y0, band.y1) };
    setBand(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const ids = resources.filter((r) => r.x !== null && r.y !== null && r.x >= box.minX && r.x <= box.maxX && r.y >= box.minY && r.y <= box.maxY).map((r) => r.id);
    onSelectMany?.(ids, event.shiftKey || event.ctrlKey || event.metaKey);
  };

  const placed = useMemo(() => resources.filter((resource) => resource.x !== null && resource.y !== null), [resources]);
  const unplaced = resources.length - placed.length;
  const mapWidth = viewportWidth * zoom;
  const seatText = (resource: Resource) => (resource.type === 'room' ? resource.label : resource.label.replace(/^Z/, ''));
  // Where each seat number goes (and from which map width it fits) is worked out once per layout, not per zoom step.
  const labelPlacement = useMemo(
    () => layoutLabels(placed.map((resource) => ({ id: resource.id, x: resource.x!, y: resource.y!, text: seatText(resource), side: resource.labelSide, room: resource.type === 'room' })), aspect),
    [placed, aspect],
  );
  const hovered = hoverId ? placed.find((resource) => resource.id === hoverId) ?? null : null;
  const hoveredTip = hovered && tipFor ? tipFor(hovered) : null;

  useEffect(() => {
    const element = viewport.current;
    const target = focus ? placed.find((resource) => resource.id === focus.id) : null;
    if (!element || !target) return;
    if (focus?.center) {
      const left = (target.x! / 100) * element.scrollWidth;
      const top = (target.y! / 100) * element.scrollHeight;
      const margin = 0.22;
      const inside = left > element.scrollLeft + element.clientWidth * margin && left < element.scrollLeft + element.clientWidth * (1 - margin)
        && top > element.scrollTop + element.clientHeight * margin && top < element.scrollTop + element.clientHeight * (1 - margin);
      if (!inside) element.scrollTo({ left: left - element.clientWidth / 2, top: top - element.clientHeight * 0.4, behavior: 'smooth' });
      element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    // On phones the booking sheet slides up over the bottom of the screen: keep the chosen space clear of it.
    const timer = window.setTimeout(() => {
      const sheet = document.querySelector<HTMLElement>('.selection.open');
      const dot = surface.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(target.id)}"]`);
      if (!sheet || !dot || getComputedStyle(sheet).position !== 'fixed') return;
      const overlap = dot.getBoundingClientRect().bottom - (sheet.getBoundingClientRect().top - 28);
      if (overlap > 0) window.scrollBy({ top: overlap, behavior: 'smooth' });
    }, 380);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);

  // On a phone the map opens zoomed in, centred on the spaces being shown (and again when you switch between desks and rooms).
  const centeredOn = useRef('');
  useEffect(() => {
    const element = viewport.current;
    const key = placed.length ? placed[0].type : '';
    if (centeredOn.current === key || !element || !placed.length || window.innerWidth >= 700) return;
    centeredOn.current = key;
    const cx = placed.reduce((sum, r) => sum + r.x!, 0) / placed.length / 100;
    const cy = placed.reduce((sum, r) => sum + r.y!, 0) / placed.length / 100;
    requestAnimationFrame(() => {
      element.scrollLeft = cx * element.scrollWidth - element.clientWidth / 2;
      element.scrollTop = cy * element.scrollHeight - element.clientHeight / 2;
    });
  }, [placed]);

  return (
    <div className={`floor-map ${mode === 'edit' ? 'is-editing' : ''}`}>
      <div className="map-toolbar">
        <div className="zoom-controls" role="group" aria-label="Map zoom">
          <button className="icon-button" onClick={() => changeZoom(zoom / 1.3)} aria-label="Zoom out" disabled={zoom <= MIN_ZOOM}><Icon name="minus" size={18} /></button>
          <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
          <button className="icon-button" onClick={() => changeZoom(zoom * 1.3)} aria-label="Zoom in" disabled={zoom >= MAX_ZOOM}><Icon name="plus" size={18} /></button>
          <button className="icon-button" onClick={() => { changeZoom(1); viewport.current?.scrollTo({ left: 0, top: 0 }); }} aria-label="Fit to screen"><Icon name="fit" size={18} /></button>
        </div>
        <span className="map-hint">{mode === 'edit' ? (tool === 'move' ? 'Drag a seat to move it, drag empty space to pan, scroll or pinch to zoom' : 'Drag a box to select seats, scroll or pinch to zoom') : 'Tap a seat, scroll or pinch to zoom, drag to move around'}</span>
      </div>
      <div
        className={`map-viewport ${panning ? 'panning' : ''} ${zoom > 1 && canPan ? 'can-pan' : ''} ${zoom <= MIN_ZOOM && mode !== 'edit' ? 'fit' : ''}`}
        ref={viewport}
        onPointerDown={onViewportDown}
        onPointerMove={onViewportMove}
        onPointerUp={onViewportUp}
        onPointerCancel={onViewportUp}
        onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}
      >
        <div
          className={`map-surface ${tool === 'select' && mode === 'edit' ? 'tool-select' : ''}`}
          ref={surface}
          style={{ width: `${zoom * 100}%`, aspectRatio: String(aspect), ['--label-font' as string]: `${labelFont(mapWidth)}px` }}
          onPointerDown={beginBand}
          onPointerMove={moveBand}
          onPointerUp={endBand}
          onPointerCancel={() => setBand(null)}
        >
          {plan ? <img className="map-plan" src={plan.url} alt="Office floor plan" draggable={false} /> : (
            <div className="map-plan map-plan-empty">{planLoading ? <span className="spinner" /> : <span>Floor plan not loaded</span>}</div>
          )}
          {placed.map((resource) => {
            const moving = drag?.id === resource.id ? drag : null;
            const x = moving?.x ?? resource.x!;
            const y = moving?.y ?? resource.y!;
            const color = resource.team?.color ?? '#8f9a94';
            const state: MapState = !showAvailability ? 'unknown' : stateOf ? stateOf(resource) : resource.available === false ? 'booked' : 'unknown';
            const dim = highlightTeamId !== undefined && highlightTeamId !== null && resource.team?.id !== highlightTeamId;
            const placement = labelPlacement.get(resource.id);
            const labelShown = resource.type === 'room' || (placement !== undefined && mapWidth >= placement.minWidth);
            const classes = ['seat-dot', resource.type === 'room' ? 'is-room' : '', state === 'booked' ? 'is-booked' : '', state === 'mine' ? 'is-mine' : '', state === 'blocked' ? 'is-blocked' : '', selected.has(resource.id) ? 'is-selected' : '', dim ? 'is-dim' : '', moving ? 'is-dragging' : ''].filter(Boolean).join(' ');
            const stateWords = state === 'booked' ? ', booked at your time' : state === 'mine' ? ', booked by you' : state === 'blocked' ? ', not available' : '';
            return (
              <button
                key={resource.id}
                data-id={resource.id}
                className={classes}
                style={{ left: `${x}%`, top: `${y}%`, ['--seat' as string]: resource.type === 'room' ? '#5b5bd6' : color }}
                onPointerDown={(event) => beginDrag(event, resource)}
                onPointerMove={moveDrag}
                onPointerUp={(event) => endDrag(event, resource)}
                onPointerCancel={() => setDrag(null)}
                onPointerEnter={(event) => { if (event.pointerType === 'mouse') setHoverId(resource.id); }}
                onPointerLeave={() => setHoverId((current) => (current === resource.id ? null : current))}
                onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) setHoverId(resource.id); }}
                onBlur={() => setHoverId((current) => (current === resource.id ? null : current))}
                onClick={(event) => { if (mode !== 'edit' || tool !== 'move') onSelect(resource, event.shiftKey || event.ctrlKey || event.metaKey); }}
                aria-label={`${resource.label}${resource.team ? `, ${resource.team.name}` : ''}${stateWords}`}
                aria-pressed={selected.has(resource.id)}
              >
                {labelShown && <span className={`seat-label side-${placement?.side ?? 'bottom'}`}>{seatText(resource)}</span>}
              </button>
            );
          })}
          {hovered && (
            <div className={`map-tip ${(hovered.y ?? 50) < 16 ? 'below' : ''} ${(hovered.x ?? 50) < 14 ? 'align-start' : (hovered.x ?? 50) > 86 ? 'align-end' : ''}`} style={{ left: `${hovered.x}%`, top: `${hovered.y}%` }} role="tooltip">
              <strong>{hovered.label}{hovered.team ? ` · ${hovered.team.name}` : ''}</strong>
              {hoveredTip ? <><span>{hoveredTip.headline}</span>{hoveredTip.detail && <small>{hoveredTip.detail}</small>}</> : null}
            </div>
          )}
          {band && <div className="band" style={{ left: `${Math.min(band.x0, band.x1)}%`, top: `${Math.min(band.y0, band.y1)}%`, width: `${Math.abs(band.x1 - band.x0)}%`, height: `${Math.abs(band.y1 - band.y0)}%` }} />}
        </div>
      </div>
      {unplaced > 0 && <p className="map-note">{unplaced} {unplaced === 1 ? 'space has' : 'spaces have'} no position on the plan yet.</p>}
    </div>
  );
}
