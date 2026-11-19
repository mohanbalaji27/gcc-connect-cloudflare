import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppNotification } from '../lib/types';
import { api, messageOf } from '../lib/api';
import { ago } from '../lib/issues';
import { Empty, Icon, Spinner, useKit } from './kit';

export function NotificationBell({ unread, onClick, label = 'Notifications' }: { unread: number; onClick: () => void; label?: string }) {
  return (
    <button className="bell" onClick={onClick} aria-label={unread > 0 ? `${label}, ${unread} unread` : label}>
      <Icon name="bell" size={20} />
      {unread > 0 && <span className="bell-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}

const ICONS: Record<string, string> = { issue_new: '🛠️', issue_urgent: '🚨', issue_assigned: '📌', issue_update: '💬', idea_new: '💡', announcement: '📣' };

// The bell's list. The unread count already arrives with the pulse; this list is only fetched when the sheet is opened.
export function NotificationSheet({ onClose, onOpenLink, onUnread, onSettings }: {
  onClose: () => void; onOpenLink: (link: string) => void; onUnread: (count: number) => void; onSettings: () => void;
}) {
  const { toast } = useKit();
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (before?: string) => {
    try {
      const result = await api<{ notifications: AppNotification[]; hasMore: boolean; unread: number }>(`/notifications?limit=30${before ? `&before=${before}` : ''}`);
      setItems((current) => (before && current ? [...current, ...result.notifications] : result.notifications));
      setMore(result.hasMore);
      onUnread(result.unread);
    } catch (reason) { toast(messageOf(reason), 'error'); setItems((current) => current ?? []); }
  }, [onUnread, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function open(item: AppNotification) {
    if (!item.readAt) {
      setItems((current) => current?.map((entry) => (entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry)) ?? current);
      void api<{ unread: number }>('/notifications/read', { method: 'POST', body: { ids: [item.id] } }).then((result) => onUnread(result.unread)).catch(() => {});
    }
    onOpenLink(item.link);
    onClose();
  }
  async function readAll() {
    setBusy(true);
    try {
      const result = await api<{ unread: number }>('/notifications/read', { method: 'POST', body: { all: true } });
      onUnread(result.unread);
      setItems((current) => current?.map((entry) => ({ ...entry, readAt: entry.readAt ?? new Date().toISOString() })) ?? current);
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }

  const unreadHere = items?.filter((item) => !item.readAt).length ?? 0;
  return (
    <>
      <div className="notif-backdrop" onClick={onClose} />
      <aside className="notif-sheet" role="dialog" aria-modal="true" aria-label="Notifications">
        <div className="notif-head">
          <h2>Notifications</h2>
          <button className="button button-small" disabled={busy || unreadHere === 0} onClick={() => void readAll()}><Icon name="check" size={15} /> Mark all read</button>
          <button ref={closeButton} className="icon-button" onClick={onClose} aria-label="Close notifications"><Icon name="x" /></button>
        </div>
        {items === null ? <Spinner /> : items.length === 0 ? <Empty icon="bell" title="You are all caught up">News about your reports and tasks will show up here.</Empty> : (
          <ul className="notif-list">
            {items.map((item) => (
              <li key={item.id}>
                <button className={`notif-item ${item.readAt ? '' : 'unread'}`} onClick={() => void open(item)}>
                  <i className="notif-dot" aria-label={item.readAt ? undefined : 'Unread'} />
                  <span aria-hidden="true">{ICONS[item.type] ?? '🔔'}</span>
                  <span className="notif-text"><strong>{item.title}</strong>{item.body && <span>{item.body}</span>}<small>{ago(item.createdAt)}</small></span>
                </button>
              </li>
            ))}
            {more && items.length > 0 && <li><div className="modal-actions"><button className="button" onClick={() => void load(items[items.length - 1].id)}>Show older</button></div></li>}
          </ul>
        )}
        <div className="notif-foot"><button className="text-link" onClick={() => { onSettings(); onClose(); }}><Icon name="settings" size={16} /> Notification settings</button><small>Kept for 30 days</small></div>
      </aside>
    </>
  );
}
