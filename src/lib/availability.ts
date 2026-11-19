import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from './api';
import { nextDay } from './stay';
import { DAY, withBooking, withoutBooking, type DayData } from './availabilityMath';

// One in-memory copy of each office day's busy intervals. Changing the arrival time or stay never calls the server;
// only the first look at a date does, plus a refresh when the tab comes back to the front or after a conflict.
const days = new Map<string, DayData>();
const failed = new Set<string>();
const fetchedAt = new Map<string, number>();
/** A held day older than this is shown straight away and quietly re-checked (the server answers 304 if nothing changed). */
const STALE_MS = 3 * 60_000;
const inflight = new Map<string, Promise<DayData | null>>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => { version += 1; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const getDay = (date: string) => days.get(date);

export function loadDay(date: string, { force = false }: { force?: boolean } = {}): Promise<DayData | null> {
  if (!force && days.has(date)) return Promise.resolve(days.get(date)!);
  const running = inflight.get(date);
  if (running) return running;
  const request = api<DayData>(`/availability?date=${date}`)
    .then((data) => { failed.delete(date); days.set(date, data); fetchedAt.set(date, Date.now()); emit(); return data; })
    .catch(() => { failed.add(date); emit(); return null; })
    .finally(() => { inflight.delete(date); });
  inflight.set(date, request);
  return request;
}

/** Re-checks every date that is currently held (cheap: the server answers 304 when nothing changed). */
export const refreshLoaded = (only?: string[]) => Promise.all([...days.keys()].filter((date) => !only || only.includes(date)).map((date) => loadDay(date, { force: true })));

export function dropDay(date: string) {
  if (days.delete(date)) emit();
}

export function clearAvailability() {
  days.clear();
  failed.clear();
  fetchedAt.clear();
  inflight.clear();
  emit();
}

const minutesFrom = (date: string, iso: string) => Math.round((Date.parse(iso) - Date.parse(`${date}T00:00:00+05:30`)) / 60_000);

/** Marks (or unmarks) a booking on every loaded day it touches, so the map changes before the server is asked again. */
export function applyLocalBooking(resourceId: string, startsAt: string, endsAt: string, mine: boolean, by?: string, add = true) {
  const dateOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));
  let date = dateOf(startsAt);
  const last = dateOf(new Date(Date.parse(endsAt) - 1).toISOString());
  for (let guard = 0; guard < 3; guard += 1) {
    const day = days.get(date);
    if (day) {
      const from = minutesFrom(date, startsAt);
      const to = minutesFrom(date, endsAt);
      days.set(date, add ? withBooking(day, resourceId, from, Math.min(to, DAY), mine, by) : withoutBooking(day, resourceId, from, Math.min(to, DAY)));
    }
    if (date >= last) break;
    date = nextDay(date);
  }
  emit();
}

/** The hook the booking screen uses: makes sure the day (and the next one, if the stay crosses midnight) is loaded. */
export function useAvailability(date: string, crossesMidnight: boolean) {
  useSyncExternalStore(subscribe, () => version);
  const next = crossesMidnight ? nextDay(date) : null;
  useEffect(() => {
    for (const wanted of next ? [date, next] : [date]) {
      if (!days.has(wanted)) void loadDay(wanted);
      else if (Date.now() - (fetchedAt.get(wanted) ?? 0) > STALE_MS) void loadDay(wanted, { force: true });
    }
  }, [date, next]);
  const first = days.get(date);
  const second = next ? days.get(next) : undefined;
  const unavailable = failed.has(date) || (next !== null && failed.has(next));
  const loading = !unavailable && (!first || (next !== null && !second));
  return useMemo(() => ({ first, second, loading, unavailable }), [first, second, loading, unavailable]);
}
