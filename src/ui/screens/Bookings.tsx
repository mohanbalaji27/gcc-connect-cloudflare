import { useCallback, useEffect, useState } from 'react';
import type { Booking } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { applyLocalBooking } from '../../lib/availability';
import { downloadCalendarFile, inIndia, relativeDay, timeRange } from '../../lib/format';
import type { Ctx } from '../App';
import { Empty, Icon, Modal, Spinner, useKit } from '../kit';

export function BookingsScreen({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [cancelling, setCancelling] = useState<Booking | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setBookings((await api<{ bookings: Booking[] }>('/bookings')).bookings); } catch (reason) { toast(messageOf(reason), 'error'); setBookings([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function cancel() {
    if (!cancelling) return;
    setBusy(true);
    try {
      await api(`/bookings/${encodeURIComponent(cancelling.id)}`, { method: 'DELETE' });
      // The map frees the space straight away when you go back to Book.
      applyLocalBooking(cancelling.resource_id, cancelling.starts_at, cancelling.ends_at, true, undefined, false);
      ctx.invalidateSummary();
      toast(`${cancelling.label} released. Someone else will be glad of it!`, 'success');
      setCancelling(null);
      await load();
    } catch (reason) { toast(messageOf(reason), 'error'); setCancelling(null); await load(); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="page-head"><div><span className="eyebrow">MY BOOKINGS</span><h1>Your upcoming plans</h1></div><button className="button button-primary" onClick={() => ctx.startBooking({ kind: 'desk' })}><Icon name="plus" size={18} /> New booking</button></div>
      {bookings === null ? <Spinner /> : bookings.length === 0 ? (
        <Empty icon="ticket" title="Nothing booked — yet">Grab a desk or a room and it will show up here.</Empty>
      ) : (
        <ul className="booking-list">
          {bookings.map((booking) => (
            <li key={booking.id} className="booking-card">
              <div className="date-chip big"><strong>{inIndia(booking.starts_at, { day: '2-digit' })}</strong><span>{inIndia(booking.starts_at, { month: 'short' }).toUpperCase()}</span></div>
              <div className="booking-info">
                <span className="eyebrow">{relativeDay(booking.starts_at).toUpperCase()} · {booking.type === 'desk' ? 'DESK' : 'ROOM'}</span>
                <h3>{booking.label}</h3>
                <small><Icon name="clock" size={14} /> {timeRange(booking.starts_at, booking.ends_at)} · <Icon name="pin" size={14} /> {booking.floor}{booking.zone ? `, ${booking.zone}` : ''}</small>
              </div>
              <div className="booking-actions">
                <button className="button button-small" onClick={() => downloadCalendarFile(`${booking.label} at GCC`, `${booking.building} ${booking.floor}`, booking.starts_at, booking.ends_at)}><Icon name="download" size={16} /> Calendar</button>
                <button className="button button-small button-danger-soft" onClick={() => setCancelling(booking)}><Icon name="trash" size={16} /> Cancel</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {cancelling && (
        <Modal title="Cancel this booking?" onClose={() => setCancelling(null)}>
          <p>{cancelling.label} · {relativeDay(cancelling.starts_at)} {timeRange(cancelling.starts_at, cancelling.ends_at)}</p>
          <p className="muted">It’ll go straight back into the pool for your colleagues.</p>
          <div className="modal-actions"><button className="button" onClick={() => setCancelling(null)}>Keep it</button><button className="button button-danger" disabled={busy} onClick={() => void cancel()}>{busy ? 'Cancelling…' : 'Yes, cancel'}</button></div>
        </Modal>
      )}
    </div>
  );
}
