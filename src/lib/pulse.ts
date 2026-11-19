import { api } from './api';
import { restoreUsage, settleUsage, takeUsage } from './usage';

// The app's heartbeat. While the tab is visible it asks the server a tiny question (GET /api/pulse) when the tab comes
// back to the front and every few minutes after that. Nothing is sent while the tab is hidden.
// The reply already carries `configVersion`; later features can add fields to it on the server and read them in onPulse.
export const PULSE_INTERVAL_MS = 3 * 60_000;
const MIN_GAP_MS = 15_000;

export interface PulseReply { configVersion: number; serverTime: string; [extra: string]: unknown }
type WakeReason = 'visible' | 'interval';
const wakeListeners = new Set<(reason: WakeReason) => void>();

/** Called whenever the tab returns to the front or the periodic pulse fires (for example to refresh availability). */
export function onWake(listener: (reason: WakeReason) => void) {
  wakeListeners.add(listener);
  return () => { wakeListeners.delete(listener); };
}

export function startPulse(handlers: { onPulse: (reply: PulseReply) => void }) {
  let last = 0;
  let timer: number | undefined;
  let stopped = false;

  async function beat(reason: WakeReason) {
    if (stopped || document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (reason === 'visible' && now - last < MIN_GAP_MS) return;
    last = now;
    // Batched "screen opened" counts (usage analytics) ride on this same request, but only when there are any.
    const batch = takeUsage(now);
    let reply: PulseReply | null = null;
    try { reply = await (batch ? api<PulseReply>('/pulse', { method: 'POST', body: { usage: batch } }) : api<PulseReply>('/pulse')); } catch { if (batch) restoreUsage(batch); /* offline or signed out: the next beat tries again */ }
    if (reply) {
      if (batch) settleUsage(batch, reply.usage);
      handlers.onPulse(reply);
    }
    wakeListeners.forEach((listener) => listener(reason));
  }
  const arm = () => { window.clearInterval(timer); timer = window.setInterval(() => void beat('interval'), PULSE_INTERVAL_MS); };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') { void beat('visible'); arm(); } else window.clearInterval(timer);
  };
  const onFocus = () => void beat('visible');

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onFocus);
  if (document.visibilityState === 'visible') arm();
  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onFocus);
  };
}
