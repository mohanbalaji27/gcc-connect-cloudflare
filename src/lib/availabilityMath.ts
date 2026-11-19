// Pure helpers that work out whether a desk or room is free for a chosen window, using one day of busy intervals.
// Times are minutes after local (office) midnight of the chosen date; a window that runs past midnight uses 1440+.
// This file has no imports so it can be unit-tested directly.

export type Interval = [from: number, to: number, mine: number, by?: string];
export interface DayData { date: string; showNames: boolean; busy: Record<string, Interval[]> }
export type SpaceState = 'free' | 'booked' | 'mine' | 'blocked';

export interface SpaceStatus {
  state: SpaceState;
  headline: string;
  detail: string;
  /** Minute (from the date's midnight) when a booked space becomes free again, if that happens within the day. */
  freeFrom: number | null;
  /** Everything booked on the chosen date, for the little timeline. */
  intervals: Interval[];
}

export const DAY = 1440;

export function clock(minute: number): string {
  if (minute >= DAY) return minute === DAY ? 'midnight' : clock(minute - DAY);
  const hour = Math.floor(minute / 60);
  const rest = String(minute % 60).padStart(2, '0');
  return `${hour % 12 === 0 ? 12 : hour % 12}:${rest} ${hour < 12 ? 'am' : 'pm'}`;
}

// Joins the second day's intervals (shifted by 24 h) after the first day's, so a stay across midnight is checked in one pass.
export function combined(first: DayData | undefined, second: DayData | undefined, id: string): Interval[] {
  const a = first?.busy[id] ?? [];
  const b = second?.busy[id] ?? [];
  if (!b.length) return a;
  return [...a, ...b.map(([from, to, mine, by]): Interval => [from + DAY, to + DAY, mine, by])];
}

const who = (interval: Interval) => (interval[3] ? ` by ${interval[3].split(' ')[0]}` : '');

export function statusFor(first: DayData | undefined, second: DayData | undefined, id: string, startMin: number, endMin: number): SpaceStatus {
  const all = combined(first, second, id);
  const overlapping = all.filter(([from, to]) => from < endMin && to > startMin);
  const intervals = first?.busy[id] ?? [];
  if (!overlapping.length) {
    const next = all.find(([from]) => from >= endMin);
    const headline = next ? `Free until ${clock(next[0])}` : intervals.length ? 'Free for the rest of the day' : 'Free all day';
    return { state: 'free', headline, detail: bookingsLine(intervals), freeFrom: null, intervals };
  }
  const mine = overlapping.every((interval) => interval[2] === 1);
  let blockEnd = overlapping[0][1];
  for (const [from, to] of all) if (from <= blockEnd && to > blockEnd) blockEnd = to;
  const freeFrom = blockEnd >= DAY ? null : blockEnd;
  const range = `${clock(overlapping[0][0])} – ${clock(overlapping[0][1])}`;
  const tail = freeFrom === null ? 'booked for the rest of the day' : `free from ${clock(freeFrom)}`;
  return {
    state: mine ? 'mine' : 'booked',
    headline: mine ? `Yours, ${range}` : `Booked${who(overlapping[0])} ${range}`,
    detail: `${mine ? 'Your booking' : 'Booked'} · ${tail}`,
    freeFrom,
    intervals,
  };
}

function bookingsLine(intervals: Interval[]): string {
  if (!intervals.length) return '';
  const shown = intervals.slice(0, 3).map(([from, to]) => `${clock(from)} – ${clock(to)}`).join(', ');
  return `Booked today: ${shown}${intervals.length > 3 ? ` and ${intervals.length - 3} more` : ''}`;
}

// Optimistic update: returns a copy of the day with a booking added (clipped to that day).
export function withBooking(day: DayData, id: string, from: number, to: number, mine: boolean, by?: string): DayData {
  const start = Math.max(0, from);
  const end = Math.min(DAY, to);
  if (end <= start) return day;
  const list = [...(day.busy[id] ?? []), [start, end, mine ? 1 : 0, ...(day.showNames && by ? [by] : [])] as Interval].sort((x, y) => x[0] - y[0]);
  return { ...day, busy: { ...day.busy, [id]: list } };
}

export function withoutBooking(day: DayData, id: string, from: number, to: number): DayData {
  const list = (day.busy[id] ?? []).filter(([a, b, mine]) => !(mine === 1 && a === Math.max(0, from) && b === Math.min(DAY, to)));
  const busy = { ...day.busy };
  if (list.length) busy[id] = list; else delete busy[id];
  return { ...day, busy };
}

// The id of one of my own bookings (among the given spaces) that overlaps the window, used to explain "you already have a desk".
export function myOverlap(first: DayData | undefined, second: DayData | undefined, ids: Iterable<string>, startMin: number, endMin: number): string | null {
  for (const id of ids) {
    const found = combined(first, second, id).some(([from, to, mine]) => mine === 1 && from < endMin && to > startMin);
    if (found) return id;
  }
  return null;
}
