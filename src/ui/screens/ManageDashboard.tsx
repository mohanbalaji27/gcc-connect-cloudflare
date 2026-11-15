import { useCallback, useEffect, useState } from 'react';
import type { Insights } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia } from '../../lib/format';
import { Icon, Spinner, useKit } from '../kit';

const Kpi = ({ icon, tone, value, label, hint }: { icon: string; tone: string; value: string | number; label: string; hint?: string }) => (
  <article className="kpi"><span className={`quick-icon ${tone}`}><Icon name={icon} size={22} /></span><div><strong>{value}</strong><span>{label}</span>{hint && <small>{hint}</small>}</div></article>
);

export function ManageDashboard() {
  const { toast } = useKit();
  const [data, setData] = useState<Insights | null>(null);
  const load = useCallback(async () => {
    try { setData(await api<Insights>('/admin/insights')); } catch (reason) { toast(messageOf(reason), 'error'); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  if (!data) return <Spinner label="Crunching the numbers" />;

  const { totals, trend, byTeam, topSpaces, weekdays } = data;
  const maxTrend = Math.max(1, ...trend.map((d) => d.desks + d.rooms));
  const maxDay = Math.max(1, ...weekdays.map((d) => d.n));
  const busiest = [...weekdays].sort((a, b) => b.n - a.n)[0];
  const quietest = [...weekdays.filter((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(d.name))].sort((a, b) => a.n - b.n)[0];
  const teams = byTeam.filter((t) => t.seats > 0);
  const hottest = [...teams].sort((a, b) => b.bookings / b.seats - a.bookings / a.seats)[0];
  const notes: string[] = [];
  if (busiest && busiest.n > 0) notes.push(`📈 ${busiest.name} is your busiest day. ${quietest && quietest.n < busiest.n ? `${quietest.name} is the quietest weekday.` : ''}`);
  notes.push(`🪑 ${totals.deskCoverage30d}% of desks were used at least once in the last 30 days.${totals.deskCoverage30d < 50 ? ' Some seats are going spare.' : ''}`);
  if (hottest && hottest.bookings > 0) notes.push(`🔥 ${hottest.name} gets the most use per seat.`);
  if (totals.cancelled30d > 0) notes.push(`↩️ ${totals.cancelled30d} bookings were cancelled in 30 days.`);
  if (totals.feedbackNew > 0) notes.push(`💬 ${totals.feedbackNew} new notes are waiting in the idea box.`);

  return (
    <div className="dashboard">
      <div className="panel-head"><h2>Office at a glance</h2><div className="panel-tools"><small>Updated {inIndia(new Date(), { hour: 'numeric', minute: '2-digit' })}</small><button className="button button-small" onClick={() => void load()}>Refresh</button></div></div>
      <div className="kpi-grid">
        <Kpi icon="desk" tone="green" value={`${totals.deskUtilisationToday}%`} label="Desk use today" hint={`${totals.desksToday} of ${totals.desks} desks`} />
        <Kpi icon="room" tone="lilac" value={`${totals.roomsToday}/${totals.rooms}`} label="Rooms in use today" />
        <Kpi icon="users" tone="blue" value={totals.activeBookers30d} label="People who booked (30 days)" hint={`of ${totals.people} people`} />
        <Kpi icon="ticket" tone="orange" value={totals.bookings30d} label="Bookings (30 days)" hint={`${totals.cancelled30d} cancelled`} />
        <Kpi icon="party" tone="pink" value={totals.eventsUpcoming} label="Upcoming events" hint={`${totals.rsvpsUpcoming} RSVPs`} />
        <Kpi icon="heart" tone="teal" value={totals.kudos30d} label="Kudos sent (30 days)" hint={`${totals.votes30d} poll votes`} />
      </div>

      <div className="insight-notes">{notes.map((note) => <p key={note}>{note}</p>)}</div>

      <div className="dash-grid">
        <section className="panel">
          <h3>Bookings per day</h3>
          <div className="bar-chart" role="img" aria-label="Bookings per day for the last two weeks and the next week">
            {trend.map((day) => (
              <div key={day.date} className={`bar-col ${day.future ? 'future' : ''} ${day.date === data.today ? 'today' : ''}`} title={`${inIndia(`${day.date}T12:00:00+05:30`, { day: 'numeric', month: 'short' })}: ${day.desks} desk, ${day.rooms} room`}>
                <div className="bar-stack" style={{ height: `${((day.desks + day.rooms) / maxTrend) * 100}%` }}><i className="rooms" style={{ flex: day.rooms }} /><i className="desks" style={{ flex: day.desks }} /></div>
                <small>{inIndia(`${day.date}T12:00:00+05:30`, { day: 'numeric' })}</small>
              </div>
            ))}
          </div>
          <div className="chart-legend"><span><i className="desks" /> Desks</span><span><i className="rooms" /> Rooms</span><span><i className="future" /> Upcoming</span></div>
        </section>
        <section className="panel">
          <h3>Busiest weekdays (60 days)</h3>
          <ul className="hbars">{weekdays.map((d) => <li key={d.name}><span>{d.name}</span><div><i style={{ width: `${(d.n / maxDay) * 100}%` }} /></div><small>{d.n}</small></li>)}</ul>
        </section>
        <section className="panel">
          <h3>Team seat use (30 days)</h3>
          {teams.length === 0 ? <p className="muted">Assign seats to teams to see this.</p> : (
            <ul className="hbars teams">{teams.map((t) => { const ratio = t.bookings / Math.max(1, t.seats); const max = Math.max(...teams.map((x) => x.bookings / Math.max(1, x.seats)), 0.01); return <li key={t.name}><span title={t.name}>{t.name}</span><div><i style={{ width: `${(ratio / max) * 100}%`, background: t.color }} /></div><small>{ratio.toFixed(1)}/seat</small></li>; })}</ul>
          )}
        </section>
        <section className="panel">
          <h3>Most booked spaces</h3>
          {topSpaces.length === 0 ? <p className="muted">No bookings yet.</p> : <ol className="top-list">{topSpaces.map((s, i) => <li key={s.label}><span className="rank">{['🥇', '🥈', '🥉'][i] ?? i + 1}</span><strong>{s.label}</strong><small>{s.type}</small><span className="pill">{s.n}</span></li>)}</ol>}
        </section>
      </div>
    </div>
  );
}
