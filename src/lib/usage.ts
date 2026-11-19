import { getCsrf } from './api';

// Privacy-respecting usage counts. The browser only remembers how many times each screen (or tab inside a screen) was
// opened, in memory. Nothing is sent per click: the counts ride on the heartbeat that already runs every few minutes
// (POST /api/pulse), and one last batch goes out with sendBeacon when the page is hidden. If a super admin switches
// usage analytics off, this module stops counting and sends nothing.
export const USAGE_FEATURE_IDS = ['app_open', 'home', 'booking', 'map', 'my_bookings', 'events', 'scan', 'menu', 'menu_reviews', 'links', 'contacts', 'announcements', 'whosin', 'kudos', 'polls', 'celebrations', 'ideas', 'issues', 'notifications', 'account', 'manage', 'more'] as const;
export type UsageFeature = (typeof USAGE_FEATURE_IDS)[number];

const DEDUPE_MS = 10_000;
const MIN_FLUSH_GAP_MS = 2 * 60_000;
const MAX_PENDING_KEYS = 40;

let enabled = false;
let lastFlush = 0;
const pending = new Map<string, number>();
const lastCounted = new Map<string, number>();

export function setUsageEnabled(on: boolean) {
  enabled = on;
  if (!on) { pending.clear(); lastCounted.clear(); }
}

/** Counts one view of a feature. The same feature opened again within a few seconds (a quick back-and-forth) counts once. */
export function track(feature: UsageFeature) {
  if (!enabled) return;
  const now = Date.now();
  if (now - (lastCounted.get(feature) ?? 0) < DEDUPE_MS) return;
  lastCounted.set(feature, now);
  if (!pending.has(feature) && pending.size >= MAX_PENDING_KEYS) return;
  pending.set(feature, (pending.get(feature) ?? 0) + 1);
}

const drain = (): Record<string, number> | null => {
  if (!pending.size) return null;
  const batch = Object.fromEntries(pending);
  pending.clear();
  return batch;
};

/** The counts to attach to the next heartbeat, or null when there is nothing to send (or it is too soon). */
export function takeUsage(now = Date.now()): Record<string, number> | null {
  if (!enabled || now - lastFlush < MIN_FLUSH_GAP_MS) return null;
  const batch = drain();
  if (batch) lastFlush = now;
  return batch;
}

export function restoreUsage(batch: Record<string, number>) {
  if (!enabled) return;
  for (const [feature, count] of Object.entries(batch)) pending.set(feature, (pending.get(feature) ?? 0) + count);
}

/** Looks at the heartbeat's answer: a throttled batch is kept for next time, a refused one (switched off) is dropped. */
export function settleUsage(batch: Record<string, number>, result: unknown) {
  const outcome = result as { throttled?: boolean; enabled?: boolean } | undefined;
  if (outcome?.enabled === false) setUsageEnabled(false);
  else if (outcome?.throttled) restoreUsage(batch);
}

function beaconFlush() {
  if (!enabled || !pending.size) return;
  const csrf = getCsrf();
  const batch = drain();
  if (!batch || !csrf) return;
  const sent = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon('/api/usage', new Blob([JSON.stringify({ csrf, events: batch })], { type: 'application/json' }));
  if (!sent) restoreUsage(batch);
  else lastFlush = Date.now();
}

/** Starts the session: counts the app opening once per browser tab session and sends the last batch when the page is hidden. */
export function startUsage() {
  const onHide = () => { if (document.visibilityState === 'hidden') beaconFlush(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', beaconFlush);
  try {
    if (!sessionStorage.getItem('gcc-usage-session')) { sessionStorage.setItem('gcc-usage-session', '1'); track('app_open'); }
  } catch { track('app_open'); }
  return () => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', beaconFlush);
  };
}

/** Forgets everything (sign-out), so the next person on this browser starts clean. */
export function resetUsage() {
  pending.clear();
  lastCounted.clear();
  lastFlush = 0;
  try { sessionStorage.removeItem('gcc-usage-session'); } catch { /* private mode */ }
}
