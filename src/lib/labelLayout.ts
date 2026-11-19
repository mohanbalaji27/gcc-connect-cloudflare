// Decides where each seat's number goes on the map so labels do not sit on top of seats or of each other.
// For every seat we try the four sides (top, bottom, left, right) at a ladder of map widths and keep the side that
// stays clear at the smallest width; the result also says from which map width the label can be shown at all.
// Pure and cheap (computed once per layout), so it has no imports and can be unit-tested directly.

export type LabelSide = 'top' | 'bottom' | 'left' | 'right';
export interface LabelItem { id: string; x: number; y: number; text: string; side?: LabelSide | null; room?: boolean }
export interface LabelPlacement { side: LabelSide; minWidth: number }

const WIDTHS = [650, 800, 1000, 1250, 1550, 1900, 2350, 2900, 3600, 4500, 5600, 7000, 9000, 12000, 16000];
const PREFERENCE: LabelSide[] = ['bottom', 'right', 'top', 'left'];
const GAP = 2;
const PRUNE = 0.16; // neighbours farther than this (as a fraction of the map width) can never touch a label

export const labelFont = (width: number) => (width < 2900 ? 10 : width < 5600 ? 11 : 12);
const dotHalf = (width: number) => Math.max(0.00625 * width, 4) + 1.5;
const textWidth = (text: string, font: number) => text.length * font * 0.62 + 4;

export interface Rect { x0: number; y0: number; x1: number; y1: number }
const overlap = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

// Exported so the tests can verify the geometry independently of the placement search.
export function labelRect(side: LabelSide, text: string, width: number): Rect {
  const font = labelFont(width);
  const half = dotHalf(width);
  const w = textWidth(text, font);
  const h = font * 1.3;
  if (side === 'bottom') return { x0: -w / 2, x1: w / 2, y0: half + GAP, y1: half + GAP + h };
  if (side === 'top') return { x0: -w / 2, x1: w / 2, y0: -(half + GAP + h), y1: -(half + GAP) };
  if (side === 'right') return { x0: half + GAP, x1: half + GAP + w, y0: -h / 2, y1: h / 2 };
  return { x0: -(half + GAP + w), x1: -(half + GAP), y0: -h / 2, y1: h / 2 };
}

export const markerRect = (item: LabelItem, width: number): Rect => {
  if (!item.room) { const half = dotHalf(width); return { x0: -half, x1: half, y0: -half, y1: half }; }
  const w = item.text.length * 6.4 + 16;
  return { x0: -w / 2, x1: w / 2, y0: -9, y1: 9 };
};

export function layoutLabels(items: LabelItem[], aspect: number): Map<string, LabelPlacement> {
  const result = new Map<string, LabelPlacement>();
  const points = items.map((item) => ({ item, ux: item.x / 100, uy: (item.y / 100) / aspect }));
  // Spatial buckets keep the neighbour search cheap even for a thousand spaces.
  const cell = PRUNE;
  const buckets = new Map<string, number[]>();
  points.forEach((point, index) => {
    const key = `${Math.floor(point.ux / cell)}:${Math.floor(point.uy / cell)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), index]);
  });
  const neighbours = points.map((point, index) => {
    const found: number[] = [];
    const cx = Math.floor(point.ux / cell);
    const cy = Math.floor(point.uy / cell);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const other of buckets.get(`${cx + dx}:${cy + dy}`) ?? []) {
        if (other !== index && Math.hypot(points[other].ux - point.ux, points[other].uy - point.uy) <= PRUNE) found.push(other);
      }
    }
    return found;
  });

  const order = points.map((_, index) => index).sort((a, b) => points[a].uy - points[b].uy || points[a].ux - points[b].ux);
  for (const index of order) {
    const { item, ux, uy } = points[index];
    if (item.room) continue;
    const sides = item.side ? [item.side] : PREFERENCE;
    let best: LabelPlacement = { side: sides[0], minWidth: Infinity };
    for (const side of sides) {
      // A label must stay clear at its smallest width AND every larger one, because neighbours' labels appear as the map grows.
      const clearAt = WIDTHS.map((width) => {
        const mine = labelRect(side, item.text, width);
        for (const other of neighbours[index]) {
          const target = points[other];
          const shiftX = (target.ux - ux) * width;
          const shiftY = (target.uy - uy) * width;
          const box = markerRect(target.item, width);
          if (overlap(mine, { x0: box.x0 + shiftX, x1: box.x1 + shiftX, y0: box.y0 + shiftY, y1: box.y1 + shiftY })) return false;
          const placed = result.get(target.item.id);
          if (placed && width >= placed.minWidth) {
            const theirs = labelRect(placed.side, target.item.text, width);
            if (overlap(mine, { x0: theirs.x0 + shiftX, x1: theirs.x1 + shiftX, y0: theirs.y0 + shiftY, y1: theirs.y1 + shiftY })) return false;
          }
        }
        return true;
      });
      const lastBlocked = clearAt.lastIndexOf(false);
      const minWidth = lastBlocked === WIDTHS.length - 1 ? Infinity : WIDTHS[lastBlocked + 1];
      if (minWidth < best.minWidth) best = { side, minWidth };
    }
    result.set(item.id, best);
  }
  return result;
}
