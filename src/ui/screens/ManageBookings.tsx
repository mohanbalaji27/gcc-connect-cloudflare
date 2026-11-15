import { useCallback, useEffect, useState } from 'react';
import type { AdminBooking } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { relativeDay, timeRange } from '../../lib/format';
import { Empty, Icon, Spinner, useKit } from '../kit';

export function ManageBookings() {
  const { toast } = useKit();
  const [rows, setRows] = useState<AdminBooking[] | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try { setRows((await api<{ bookings: AdminBooking[] }>('/admin/bookings')).bookings); } catch (reason) { toast(messageOf(reason), 'error'); setRows([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function cancel(booking: AdminBooking) {
    if (!window.confirm(`Cancel ${booking.label} for ${booking.employee_name}?`)) return;
    try { await api(`/bookings/${booking.id}`, { method: 'DELETE' }); toast('Booking cancelled.', 'success'); await load(); } catch (reason) { toast(messageOf(reason), 'error'); }
  }

  const term = search.trim().toLowerCase();
  const shown = rows?.filter((row) => !term || `${row.label} ${row.employee_name} ${row.employee_email}`.toLowerCase().includes(term)) ?? [];
  return (
    <section className="panel">
      <div className="panel-head"><h2>Upcoming bookings</h2><a className="button button-small" href="/api/admin/bookings/export" download><Icon name="download" size={16} /> Export all (CSV)</a><div className="input-icon slim"><Icon name="search" size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search person or space" aria-label="Search bookings" /></div></div>
      {rows === null ? <Spinner /> : shown.length === 0 ? <Empty icon="ticket" title="No upcoming bookings" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Space</th><th>Person</th><th>When</th><th /></tr></thead>
            <tbody>{shown.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.label}</strong><small>{row.type}</small></td>
                <td>{row.employee_name}<small>{row.employee_email}</small></td>
                <td>{relativeDay(row.starts_at)}<small>{timeRange(row.starts_at, row.ends_at)}</small></td>
                <td className="right"><button className="button button-small button-danger-soft" onClick={() => void cancel(row)}><Icon name="trash" size={16} /> Cancel</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
