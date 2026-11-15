import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Resource } from '../lib/types';
import type { FloorPlanImage } from '../lib/floorplan';
import { Icon } from './kit';

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
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

export function FloorMap({ resources, plan, planLoading, selectedIds, onSelect, mode = 'book', tool = 'move', onMove, onSelectMany, highlightTeamId, showAvailability = true }: Props) {
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

  const placed = resources.filter((resource) => resource.x !== null && resource.y !== null);
  const unplaced = resources.length - placed.length;
  const labelsVisible = zoom >= 3.4;

  const centered = useRef(false);
  useEffect(() => {
    const element = viewport.current;
    if (centered.current || !element || !placed.length || window.innerWidth >= 700) return;
    centered.current = true;
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
        className={`map-viewport ${panning ? 'panning' : ''} ${zoom > 1 && canPan ? 'can-pan' : ''}`}
        ref={viewport}
        onPointerDown={onViewportDown}
        onPointerMove={onViewportMove}
        onPointerUp={onViewportUp}
        onPointerCancel={onViewportUp}
        onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}
      >
        <div
          className={`map-surface ${labelsVisible ? 'show-labels' : ''} ${tool === 'select' && mode === 'edit' ? 'tool-select' : ''}`}
          ref={surface}
          style={{ width: `${zoom * 100}%`, aspectRatio: String(aspect) }}
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
            const booked = showAvailability && resource.available === false;
            const dim = highlightTeamId !== undefined && highlightTeamId !== null && resource.team?.id !== highlightTeamId;
            const classes = ['seat-dot', resource.type === 'room' ? 'is-room' : '', booked ? 'is-booked' : '', selected.has(resource.id) ? 'is-selected' : '', dim ? 'is-dim' : '', moving ? 'is-dragging' : ''].filter(Boolean).join(' ');
            return (
              <button
                key={resource.id}
                className={classes}
                style={{ left: `${x}%`, top: `${y}%`, ['--seat' as string]: resource.type === 'room' ? '#5b5bd6' : color }}
                onPointerDown={(event) => beginDrag(event, resource)}
                onPointerMove={moveDrag}
                onPointerUp={(event) => endDrag(event, resource)}
                onPointerCancel={() => setDrag(null)}
                onClick={(event) => { if (mode !== 'edit' || tool !== 'move') onSelect(resource, event.shiftKey || event.ctrlKey || event.metaKey); }}
                aria-label={`${resource.label}${resource.team ? `, ${resource.team.name}` : ''}${booked ? ', booked' : ''}`}
                aria-pressed={selected.has(resource.id)}
              >
                <span className="seat-label">{resource.type === 'room' ? resource.label : resource.label.replace(/^Z/, '')}</span>
                <span className="seat-tip">{resource.label}{resource.team ? ` · ${resource.team.name}` : ''}{booked ? ' · booked' : ''}</span>
              </button>
            );
          })}
          {band && <div className="band" style={{ left: `${Math.min(band.x0, band.x1)}%`, top: `${Math.min(band.y0, band.y1)}%`, width: `${Math.abs(band.x1 - band.x0)}%`, height: `${Math.abs(band.y1 - band.y0)}%` }} />}
        </div>
      </div>
      {unplaced > 0 && <p className="map-note">{unplaced} {unplaced === 1 ? 'space has' : 'spaces have'} no position on the plan yet.</p>}
    </div>
  );
}
