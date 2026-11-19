import { useCallback, useEffect, useState } from 'react';
import type { Insights } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia } from '../../lib/format';
import { METRIC_HELP } from '../../lib/metrics';
import { Icon, Spinner, Tabs, useKit } from '../kit';
import { InfoToggle } from '../Info';
import { ManageUsage } from './ManageUsage';

const Kpi = ({ icon, tone, value, label, hint, help }: { icon: string; tone: string; value: string | number; label: string; hint?: string; help: string }) => (
  <article className="kpi">
    <span className={`quick-icon ${tone}`}><Icon name={icon} size={22} /></span>
    <div><strong>{value}</strong><span>{label}</span>{hint && <small>{hint}</small>}</div>
    <InfoToggle label={label} text={help} />
  </article>
);

const Title = ({ children, help }: { children: string; help: string }) => (
  <div className="panel-title"><h3>{children}</h3><InfoToggle label={children} text={help} /></div>
);

const dayText = (key: string, options: Intl.DateTimeFormatOptions) => inIndia(`${key}T12:00:00+05:30`, options);

function Office() {
  const { toast } = useKit();
  const [data, setData] = useState<Insights | null>(null);
  const [updated, setUpdated] = useState(() => new Date());
  const load = useCallback(async (fresh = false) => {
    try { setData(await api<Insights>('/admin/insights', fresh ? { cache: 'no-cache' } : {})); setUpdated(new Date()); } catch (reason) { toast(messageOf(reason), 'error'); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  if (!data) return <Spinner label="Crunching the numbers" />;

  const { totals, trend, byTeam, topSpaces, weekdays, officeHours } = data;
  const maxTrend = Math.max(1, ...trend.map((d) => d.desks + d.rooms));
  const maxDay = Math.max(0.1, ...weekdays.map((d) => d.avgDesks));
  const busiest = [...weekdays].sort((a, b) => b.avgDesks - a.avgDesks)[0];
  const quietest = [...weekdays.filter((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(d.name))].sort((a, b) => a.avgDesks - b.avgDesks)[0];
  const teams = byTeam.filter((t) => t.seats > 0);
  const perSeat = (t: { bookings: number; seats: number }) => t.bookings / Math.max(1, t.seats);
  const hottest = [...teams].sort((a, b) => perSeat(b) - perSeat(a))[0];
  const maxTeam = Math.max(0.01, ...teams.map(perSeat));
  const hours = `${officeHours.from}:00 to ${officeHours.to}:00`;
  const notes: string[] = [];
  if (busiest && busiest.avgDesks > 0) notes.push(`📈 ${busiest.name} is your busiest day (about ${busiest.avgDesks} desk bookings on an average ${busiest.name}). ${quietest && quietest.avgDesks < busiest.avgDesks ? `${quietest.name} is the quietest weekday.` : ''}`);
  if (totals.desks > 0) notes.push(`🪑 ${totals.deskCoverage30d}% of desks were used at least once in the last 30 days.${totals.deskCoverage30d < 50 ? ' Some seats are going spare.' : ''}`);
  if (hottest && hottest.bookings > 0) notes.push(`🔥 ${hottest.name} gets the most use per seat.`);
  if (totals.cancelled30d > 0) notes.push(`↩️ ${totals.cancelled30d} bookings were cancelled in the last 30 days.`);
  if (totals.feedbackNew) notes.push(`💬 ${totals.feedbackNew} new notes are waiting in the idea box.`);

  return (
    <div className="dashboard">
      <div className="panel-head"><h2>Office at a glance</h2><div className="panel-tools"><small>Updated {inIndia(updated, { hour: 'numeric', minute: '2-digit' })}</small><button className="button button-small" onClick={() => void load(true)}>Refresh</button></div></div>
      <div className="kpi-grid">
        <Kpi icon="desk" tone="green" value={`${totals.deskUtilisationToday}%`} label="Desk use today" hint={`${totals.desksToday} of ${totals.desks} desks booked at some point`} help={`${METRIC_HELP.deskUse} Office hours: ${hours}.`} />
        <Kpi icon="room" tone="lilac" value={`${totals.roomUtilisationToday}%`} label="Room use today" hint={`${totals.roomsToday} of ${totals.rooms} rooms booked at some point`} help={`${METRIC_HELP.roomUse} Office hours: ${hours}.`} />
        <Kpi icon="users" tone="blue" value={totals.activeBookers30d} label="People who booked (30 days)" hint={`of ${totals.people} people`} help={METRIC_HELP.bookers} />
        <Kpi icon="ticket" tone="orange" value={totals.bookings30d} label="Bookings (30 days)" hint={`${totals.deskBookings30d} desk · ${totals.roomBookings30d} room`} help={METRIC_HELP.bookings} />
        <Kpi icon="x" tone="pink" value={totals.cancelled30d} label="Cancellations (30 days)" help={METRIC_HELP.cancelled} />
        <Kpi icon="party" tone="pink" value={totals.eventsUpcoming} label="Upcoming events" hint={totals.rsvpsUpcoming === null ? undefined : `${totals.rsvpsUpcoming} RSVPs`} help={METRIC_HELP.events} />
        {totals.kudos30d !== null && <Kpi icon="heart" tone="teal" value={totals.kudos30d} label="Kudos sent (30 days)" help={METRIC_HELP.kudos} />}
        {totals.votes30d !== null && <Kpi icon="poll" tone="teal" value={totals.votes30d} label="Poll votes (30 days)" help={METRIC_HELP.votes} />}
        {totals.feedbackNew !== null && <Kpi icon="chat" tone="blue" value={totals.feedbackNew} label="New ideas waiting" help={METRIC_HELP.ideas} />}
      </div>

      {notes.length > 0 && <div className="insight-notes">{notes.map((note) => <p key={note}>{note}</p>)}</div>}

      <div className="dash-grid">
        <section className="panel">
          <Title help={METRIC_HELP.trend}>Bookings per day</Title>
          <div className="bar-chart" role="img" aria-label="Bookings per day for the last two weeks and the next week">
            {trend.map((day) => (
              <div key={day.date} className={`bar-col ${day.future ? 'future' : ''} ${day.date === data.today ? 'today' : ''}`} title={`${dayText(day.date, { day: 'numeric', month: 'short' })}: ${day.desks} desk, ${day.rooms} room`}>
                <div className="bar-stack" style={{ height: `${((day.desks + day.rooms) / maxTrend) * 100}%` }}><i className="rooms" style={{ flex: day.rooms }} /><i className="desks" style={{ flex: day.desks }} /></div>
                <small>{dayText(day.date, { day: 'numeric' })}</small>
              </div>
            ))}
          </div>
          <div className="chart-legend"><span><i className="desks" /> Desks</span><span><i className="rooms" /> Rooms</span><span><i className="future" /> Upcoming</span></div>
        </section>
        <section className="panel">
          <Title help={METRIC_HELP.weekdays}>Busiest weekdays (60 days)</Title>
          <ul className="hbars">{weekdays.map((d) => <li key={d.name}><span>{d.name}</span><div><i style={{ width: `${(d.avgDesks / maxDay) * 100}%` }} /></div><small title={`${d.desks} desk bookings over ${d.days} ${d.name}s`}>{d.avgDesks}/day</small></li>)}</ul>
        </section>
        <section className="panel">
          <Title help={METRIC_HELP.teams}>Team seat use (30 days)</Title>
          {teams.length === 0 ? <p className="muted">Assign seats to teams to see this.</p> : (
            <ul className="hbars teams">{teams.map((t) => <li key={t.name}><span title={t.name}>{t.name}</span><div><i style={{ width: `${(perSeat(t) / maxTeam) * 100}%`, background: t.color }} /></div><small>{perSeat(t).toFixed(1)}/seat</small></li>)}</ul>
          )}
        </section>
        <section className="panel">
          <Title help={METRIC_HELP.spaces}>Most booked spaces (30 days)</Title>
          {topSpaces.length === 0 ? <p className="muted">No bookings yet.</p> : <ol className="top-list">{topSpaces.map((s, i) => <li key={`${s.label}-${i}`}><span className="rank">{['🥇', '🥈', '🥉'][i] ?? i + 1}</span><strong>{s.label}</strong><small>{s.type}</small><span className="pill">{s.n}</span></li>)}</ol>}
        </section>
      </div>
    </div>
  );
}

export function ManageDashboard() {
  const [tab, setTab] = useState<'office' | 'usage'>('office');
  return (
    <div className="dashboard-wrap">
      <Tabs tabs={[{ id: 'office' as const, label: 'Bookings and office', icon: 'desk' }, { id: 'usage' as const, label: 'Usage', icon: 'chart' }]} value={tab} onChange={setTab} />
      {tab === 'office' ? <Office /> : <ManageUsage />}
    </div>
  );
}
