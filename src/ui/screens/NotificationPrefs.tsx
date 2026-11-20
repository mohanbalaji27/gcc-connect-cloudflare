import { useCallback, useEffect, useState } from 'react';
import { api, messageOf } from '../../lib/api';
import type { Ctx } from '../App';
import { Spinner, useKit } from '../kit';
import '../issues.css';

interface Choice { value: boolean; source: 'you' | 'role' | 'default' | 'routing' }
interface Prefs {
  types: { id: string; inapp: Choice; push?: Choice }[];
  categories: { id: string; name: string; emoji: string; subscribed: boolean; source: Choice['source'] }[];
}
const SOURCE: Record<Choice['source'], string> = { you: 'Your choice', role: 'From your role', default: 'Default', routing: 'Because you are assigned to it' };

// A checkbox matrix of what to be told about, per channel. Choices you make win over your role's defaults; “Reset” goes back to them.
export function NotificationPrefs({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const catalog = ctx.config.notificationCatalog;
  const pushConfigEnabled = ctx.config.options?.pushNotificationsEnabled !== false;
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [devicePermission, setDevicePermission] = useState<'default' | 'granted' | 'denied' | 'unsupported'>('default');

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setDevicePermission(Notification.permission);
    } else {
      setDevicePermission('unsupported');
    }
  }, []);

  const load = useCallback(async () => {
    try { setPrefs(await api<Prefs>('/me/notification-prefs')); } catch (reason) { toast(messageOf(reason), 'error'); setPrefs({ types: [], categories: [] }); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function save(body: Record<string, unknown>) {
    try {
      await api('/me/notification-prefs', { method: 'PUT', body });
    } catch (reason) {
      toast(messageOf(reason), 'error');
      void load();
    }
  }

  const requestDevicePush = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      toast('Push notifications are not supported on this browser', 'info');
      return;
    }
    try {
      const res = await Notification.requestPermission();
      setDevicePermission(res);
      if (res === 'granted') {
        toast('Push notifications enabled for this device', 'success');
      } else if (res === 'denied') {
        toast('Notifications blocked in browser settings. Please allow them from browser settings.', 'error');
      }
    } catch {
      toast('Could not request notification permission', 'error');
    }
  };

  const setType = (id: string, channel: 'inapp' | 'push', value: boolean | null) => {
    if (channel === 'push' && value === true && typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      void requestDevicePush();
    }
    setPrefs((current) => current && {
      ...current,
      types: current.types.map((type) => {
        if (type.id !== id) return type;
        const currentChoice = type[channel] ?? { value: false, source: 'default' };
        return {
          ...type,
          [channel]: {
            value: value ?? currentChoice.value,
            source: value === null ? 'role' : 'you',
          },
        };
      }),
    });
    void save({ types: { [id]: { [channel]: value } } });
  };

  const setCategory = (id: string, value: boolean | null) => {
    setPrefs((current) => current && { ...current, categories: current.categories.map((category) => (category.id === id ? { ...category, subscribed: value ?? category.subscribed, source: value === null ? 'role' : 'you' } : category)) });
    void save({ categories: { [id]: value } });
  };

  if (!prefs) return <section className="panel"><h2>Notifications</h2><Spinner /></section>;
  const groups = [...new Set(prefs.types.map((entry) => catalog.types.find((type) => type.id === entry.id)?.group ?? 'Other'))];

  return (
    <section className="panel form-stack">
      <h2>Notifications</h2>
      <p className="muted">Pick what you want to hear about. You only see choices that are relevant to your access.</p>

      {pushConfigEnabled && (
        <div className="device-push-banner">
          <div className="push-info">
            <strong>Device push notifications (mobile & desktop)</strong>
            <p className="muted small">
              {devicePermission === 'granted'
                ? '✓ Active on this device. You will receive notifications when GCC Connect is in the background.'
                : devicePermission === 'denied'
                ? '⚠️ Blocked by browser settings. Click the site settings / lock icon in your address bar to allow.'
                : devicePermission === 'unsupported'
                ? 'ℹ️ Push notifications are not supported by this browser.'
                : 'Get notified instantly on this device when urgent issues or important announcements arrive.'}
            </p>
          </div>
          {devicePermission === 'default' && (
            <button type="button" className="button button-small" onClick={() => void requestDevicePush()}>
              Enable on this device
            </button>
          )}
        </div>
      )}

      {groups.map((group) => (
        <div key={group} className="pref-table">
          <div className="pref-head">
            <span>{group}</span>
            <span className="pref-col-head">In-app</span>
            {pushConfigEnabled && <span className="pref-col-head">Push</span>}
          </div>
          {prefs.types.filter((entry) => (catalog.types.find((type) => type.id === entry.id)?.group ?? 'Other') === group).map((entry) => {
            const type = catalog.types.find((item) => item.id === entry.id);
            const inappModified = entry.inapp.source === 'you';
            const pushModified = entry.push?.source === 'you';
            return (
              <div key={entry.id} className="pref-row">
                <span>
                  <strong>{type?.label ?? entry.id}</strong>
                  <small>
                    {type?.description} · {SOURCE[entry.inapp.source]}
                    {(inappModified || pushModified) && (
                      <> · <button type="button" className="text-link" onClick={() => { if (inappModified) setType(entry.id, 'inapp', null); if (pushModified) setType(entry.id, 'push', null); }}>Reset</button></>
                    )}
                  </small>
                </span>
                <div className="pref-check-wrap">
                  <input
                    type="checkbox"
                    checked={entry.inapp.value}
                    onChange={(event) => setType(entry.id, 'inapp', event.target.checked)}
                    aria-label={`${type?.label}: in-app`}
                    title={`In-app: ${SOURCE[entry.inapp.source]}`}
                  />
                </div>
                {pushConfigEnabled && (
                  <div className="pref-check-wrap">
                    <input
                      type="checkbox"
                      checked={entry.push?.value ?? false}
                      onChange={(event) => setType(entry.id, 'push', event.target.checked)}
                      aria-label={`${type?.label}: push`}
                      title={`Push: ${SOURCE[entry.push?.source ?? 'default']}`}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {prefs.categories.length > 0 && (
        <div className="pref-table">
          <div className="pref-head">
            <span>Tell me about these issue categories</span>
            <span className="pref-col-head">In-app</span>
          </div>
          {prefs.categories.map((category) => (
            <div key={category.id} className="pref-row">
              <span>
                <strong>{category.emoji} {category.name}</strong>
                <small>
                  {SOURCE[category.source]}
                  {category.source === 'you' && <> · <button type="button" className="text-link" onClick={() => setCategory(category.id, null)}>Reset</button></>}
                </small>
              </span>
              <div className="pref-check-wrap">
                <input
                  type="checkbox"
                  checked={category.subscribed}
                  onChange={(event) => setCategory(category.id, event.target.checked)}
                  aria-label={`${category.name} issues`}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
