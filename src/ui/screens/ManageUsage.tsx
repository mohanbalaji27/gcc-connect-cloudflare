import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UsageSummary } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia, todayInIndia } from '../../lib/format';
import { METRIC_HELP } from '../../lib/metrics';
import { Icon, Spinner, useKit } from '../kit';
import { InfoToggle } from '../Info';

type Preset = '7' | '30' | '90' | 'custom';
const PRESETS: { id: Preset; label: string }[] = [{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '90', label: '90 days' }, { id: 'custom', label: 'Custom' }];

const dayText = (key: string, options: Intl.DateTimeFormatOptions) => inIndia(`${key}T12:00:00+05:30`, options);
const shortDay = (key: string) => dayText(key, { day: 'numeric', month: 'short' });

function Kpi({ icon, tone, value, label, hint, help }: { icon: string; tone: string; value: string | number; label: string; hint?: string; help: string }) {
  return (
    <article className="kpi">
      <span className={`quick-icon ${tone}`}><Icon name={icon} size={22} /></span>
      <div><strong>{value}</strong><span>{label}</span>{hint && <small>{hint}</small>}</div>
      <InfoToggle label={label} text={help} />
    </article>
  );
}
const Title = ({ children, help }: { children: string; help: string }) => <div className="panel-title"><h3>{children}</h3><InfoToggle label={children} text={help} /></div>;

function Trend({ now, before }: { now: number; before: number }) {
  if (before === 0 && now === 0) return <span className="trend flat" aria-label="No change">–</span>;
  if (before === 0) return <span className="trend up" aria-label="New since the previous period">▲ new</span>;
  const change = Math.round(((now - before) * 100) / before);
  if (change === 0) return <span className="trend flat" aria-label="No change">＝ 0%</span>;
  return <span className={`trend ${change > 0 ? 'up' : 'down'}`} aria-label={`${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)} percent from the previous period`}>{change > 0 ? '▲' : '▼'} {Math.abs(change)}%</span>;
}

const niceMax = (value: number) => {
  if (value <= 5) return 5;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
};

function LoginChart({ series }: { series: UsageSummary['series'] }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const [width, setWidth] = useState(640);
  const holder = useRef<HTMLDivElement>(null);
  // Draw at the real pixel width so the labels stay readable on a phone instead of being shrunk with the picture.
  useEffect(() => {
    const element = holder.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(160, Math.round(entries[0].contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const height = 220; const left = 30; const right = 6; const top = 10; const bottom = 26;
  const innerW = width - left - right; const innerH = height - top - bottom;
  const max = niceMax(Math.max(1, ...series.map((row) => Math.max(row.logins, row.active))));
  const slot = innerW / series.length;
  const barW = Math.max(1, Math.min(22, slot * 0.7));
  const x = (index: number) => left + slot * index + slot / 2;
  const y = (value: number) => top + innerH - (value / max) * innerH;
  const index = picked ?? series.length - 1;
  const row = series[index];
  const labelEvery = Math.max(1, Math.ceil(series.length / Math.max(2, Math.floor(innerW / 64))));
  const line = series.map((entry, i) => `${x(i).toFixed(1)},${y(entry.active).toFixed(1)}`).join(' ');

  function onKey(event: React.KeyboardEvent) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); setPicked(Math.max(0, index - 1)); }
    if (event.key === 'ArrowRight') { event.preventDefault(); setPicked(Math.min(series.length - 1, index + 1)); }
  }
  return (
    <div className="login-chart" ref={holder}>
      <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Sign-ins and active people per day, ${series.length} days. Use the left and right arrow keys to move between days.`} tabIndex={0} onKeyDown={onKey}>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line className="lc-grid" x1={left} x2={width - right} y1={y(max * fraction)} y2={y(max * fraction)} />
            <text className="lc-axis" x={left - 6} y={y(max * fraction) + 4} textAnchor="end">{Math.round(max * fraction)}</text>
          </g>
        ))}
        {series.map((entry, i) => (
          <g key={entry.date}>
            <rect className={`lc-bar ${i === index ? 'on' : ''}`} x={x(i) - barW / 2} y={y(entry.logins)} width={barW} height={Math.max(0, top + innerH - y(entry.logins))} rx={Math.min(3, barW / 3)} />
            <rect className="lc-hit" x={left + slot * i} y={top} width={slot} height={innerH} onClick={() => setPicked(i)} onMouseEnter={() => setPicked(i)} />
            {i % labelEvery === 0 && <text className="lc-axis" x={x(i)} y={height - 8} textAnchor="middle">{dayText(entry.date, { day: 'numeric', month: 'short' })}</text>}
          </g>
        ))}
        <polyline className="lc-line" points={line} />
        {series.map((entry, i) => i === index && <circle key={entry.date} className="lc-dot" cx={x(i)} cy={y(entry.active)} r={4} />)}
      </svg>
      <p className="lc-caption" aria-live="polite"><strong>{dayText(row.date, { weekday: 'short', day: 'numeric', month: 'short' })}</strong>: {row.logins} sign-ins by {row.loginPeople} {row.loginPeople === 1 ? 'person' : 'people'} · {row.active} active {row.active === 1 ? 'person' : 'people'}</p>
      <div className="chart-legend"><span><i className="desks" /> Sign-ins</span><span><i className="line" /> Active people</span>
        <button type="button" className="text-link small-link" onClick={() => setTable((open) => !open)} aria-expanded={table}>{table ? 'Hide the numbers' : 'Show the numbers'}</button></div>
      {table && (
        <div className="chart-table"><table><caption className="sr-only">Sign-ins and active people per day</caption><thead><tr><th scope="col">Day</th><th scope="col">Sign-ins</th><th scope="col">People signed in</th><th scope="col">Active people</th></tr></thead>
          <tbody>{series.map((entry) => <tr key={entry.date}><th scope="row">{shortDay(entry.date)}</th><td>{entry.logins}</td><td>{entry.loginPeople}</td><td>{entry.active}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}

const hourName = (hour: number) => `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? ' AM' : ' PM'}`;

function Hours({ hours }: { hours: UsageSummary['hours'] }) {
  const max = Math.max(1, ...hours.map((h) => h.n));
  const total = hours.reduce((sum, h) => sum + h.n, 0);
  const peak = hours.reduce((best, h) => (h.n > best.n ? h : best), hours[0]);
  if (total === 0) return <p className="muted">No screen opens counted in these dates yet.</p>;
  return (
    <>
      <div className="hour-chart" role="img" aria-label={`Screen opens by hour. Busiest hour: ${hourName(peak.hour)} to ${hourName((peak.hour + 1) % 24)}.`}>
        {hours.map((h) => (
          <div key={h.hour} className={`hour-col ${h.hour === peak.hour ? 'peak' : ''}`} title={`${hourName(h.hour)}: ${h.n} opens`}>
            <i style={{ height: `${Math.max(h.n ? 4 : 0, (h.n / max) * 100)}%` }} />
            <small>{h.hour % 6 === 0 ? hourName(h.hour).replace(' ', '').toLowerCase() : ''}</small>
          </div>
        ))}
      </div>
      <p className="muted small-print">Busiest: <strong>{hourName(peak.hour)} to {hourName((peak.hour + 1) % 24)}</strong> ({Math.round((peak.n * 100) / total)}% of all opens).</p>
    </>
  );
}

const csvCell = (value: string | number) => {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
function download(name: string, rows: (string | number)[][]) {
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ManageUsage() {
  const { toast } = useKit();
  const [preset, setPreset] = useState<Preset>('30');
  const [custom, setCustom] = useState({ from: todayInIndia(-29), to: todayInIndia() });
  const [data, setData] = useState<UsageSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [sortBy, setSortBy] = useState<'users' | 'opens'>('users');

  const query = useMemo(() => {
    if (preset !== 'custom') return `days=${preset}`;
    return `from=${custom.from}&to=${custom.to}`;
  }, [preset, custom]);
  const customValid = preset !== 'custom' || (custom.from && custom.to && custom.from <= custom.to && custom.to <= todayInIndia());

  const load = useCallback(async (fresh = false) => {
    if (!customValid) return;
    setBusy(true);
    try { setData(await api<UsageSummary>(`/admin/usage?${query}`, fresh ? { cache: 'reload' } : {})); } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }, [query, customValid, toast]);
  useEffect(() => { void load(); }, [load]);

  const features = useMemo(() => (data ? [...data.features].filter((f) => f.users > 0 || f.opens > 0).sort((a, b) => (sortBy === 'users' ? b.users - a.users || b.opens - a.opens : b.opens - a.opens || b.users - a.users)) : []), [data, sortBy]);

  const exportDaily = () => data && download(`usage-daily-${data.from}-to-${data.to}.csv`, [['Date', 'Sign-ins', 'People who signed in', 'Active people'], ...data.series.map((row) => [row.date, row.logins, row.loginPeople, row.active])]);
  const exportFeatures = () => data && download(`usage-features-${data.from}-to-${data.to}.csv`, [['Feature', 'People', 'Opens', 'People (previous period)', 'Opens (previous period)'], ...data.features.map((f) => [f.label, f.users, f.opens, f.prevUsers, f.prevOpens])]);

  return (
    <div className="usage">
      <div className="panel-head">
        <h2>Usage</h2>
        <div className="panel-tools">
          <div className="range-chips" role="group" aria-label="Date range">
            {PRESETS.map((item) => <button key={item.id} type="button" className={`chip ${preset === item.id ? 'on' : ''}`} aria-pressed={preset === item.id} onClick={() => setPreset(item.id)}>{item.label}</button>)}
          </div>
          <button className="button button-small" onClick={() => void load(true)} disabled={busy || !customValid}>{busy ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>
      {preset === 'custom' && (
        <div className="panel-tools custom-range">
          <label className="inline-date">From <input type="date" value={custom.from} max={custom.to || undefined} onChange={(event) => setCustom({ ...custom, from: event.target.value })} /></label>
          <label className="inline-date">To <input type="date" value={custom.to} max={todayInIndia()} onChange={(event) => setCustom({ ...custom, to: event.target.value })} /></label>
          {!customValid && <small className="field-error" role="alert">Pick dates up to today, with the start before the end (at most 400 days).</small>}
        </div>
      )}
      {!data ? <Spinner label="Counting the opens" /> : (
        <>
          <p className="muted small-print">{shortDay(data.from)} to {shortDay(data.to)} ({data.days} days), compared with the {data.days} days before. Counts are only totals per day: nothing here says who opened what.</p>
          {!data.collecting && <div className="banner" role="status">Screen counting is switched off in Settings, so the feature numbers are not growing. Sign-ins are still recorded.</div>}
          {data.collecting && data.since.features && data.since.features > data.from && <div className="banner" role="status">Screen counts start on {shortDay(data.since.features)}, so earlier days look empty.</div>}

          <div className="kpi-grid">
            <Kpi icon="logout" tone="green" value={data.totals.logins} label="Sign-ins" hint={`${data.days > 1 ? `${Math.round((data.totals.logins / data.days) * 10) / 10} a day` : 'today'}`} help={METRIC_HELP.logins} />
            <Kpi icon="users" tone="blue" value={data.cohort.current} label="Active people" hint={`of ${data.totals.people} · avg ${data.totals.avgDailyActive} a day`} help={METRIC_HELP.active} />
            <Kpi icon="sun" tone="orange" value={data.reach.dau} label={`Daily active (${shortDay(data.to)})`} help={METRIC_HELP.dau} />
            <Kpi icon="calendar" tone="lilac" value={data.reach.wau} label="Weekly active" hint="last 7 days" help={METRIC_HELP.wau} />
            <Kpi icon="calendar" tone="pink" value={data.reach.mau} label="Monthly active" hint="last 30 days" help={METRIC_HELP.mau} />
            <Kpi icon="flame" tone="teal" value={`${data.reach.stickiness}%`} label="Stickiness" hint="daily ÷ monthly" help={METRIC_HELP.stickiness} />
          </div>

          <div className="dash-grid">
            <section className="panel span-all">
              <Title help={METRIC_HELP.logins}>Sign-ins per day</Title>
              <LoginChart series={data.series} />
            </section>

            <section className="panel">
              <div className="panel-head tight-head"><Title help={METRIC_HELP.features}>Most used features</Title>
                <div className="range-chips" role="group" aria-label="Sort features by">
                  <button type="button" className={`chip ${sortBy === 'users' ? 'on' : ''}`} aria-pressed={sortBy === 'users'} onClick={() => setSortBy('users')}>People</button>
                  <button type="button" className={`chip ${sortBy === 'opens' ? 'on' : ''}`} aria-pressed={sortBy === 'opens'} onClick={() => setSortBy('opens')}>Opens</button>
                </div>
              </div>
              {features.length === 0 ? <p className="muted">No screen opens counted in these dates yet.</p> : (
                <ol className="feature-list">
                  {features.map((feature) => {
                    const value = sortBy === 'users' ? feature.users : feature.opens;
                    const best = sortBy === 'users' ? features[0].users : features[0].opens;
                    return (
                      <li key={feature.id}>
                        <div className="feature-row"><strong>{feature.label}</strong><span className="feature-meta">{feature.users} {feature.users === 1 ? 'person' : 'people'} · {feature.opens} opens</span>
                          <Trend now={sortBy === 'users' ? feature.users : feature.opens} before={sortBy === 'users' ? feature.prevUsers : feature.prevOpens} /></div>
                        <div className="feature-bar" aria-hidden="true"><i style={{ width: `${best ? (value / best) * 100 : 0}%` }} /></div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            <section className="panel">
              <Title help={METRIC_HELP.unused}>Nobody opened these</Title>
              {!data.collecting ? <p className="muted">Switch usage analytics on to see this.</p> : data.unused.length === 0 ? <p className="muted">Every feature that is switched on was opened by someone. Nice.</p> : (
                <>
                  <p className="muted small-print">Try promoting these with an announcement or a tip:</p>
                  <div className="chip-row unused-row">{data.unused.map((item) => <span key={item.id} className="chip static">{item.label}</span>)}</div>
                </>
              )}
            </section>

            <section className="panel">
              <Title help={METRIC_HELP.hours}>Peak hours (India time)</Title>
              <Hours hours={data.hours} />
            </section>

            <section className="panel">
              <Title help={METRIC_HELP.newReturning}>New and returning people</Title>
              {data.cohort.newPeople + data.cohort.returningPeople === 0 ? <p className="muted">No sign-ins in these dates.</p> : (
                <>
                  <div className="split-bar" role="img" aria-label={`${data.cohort.newPeople} new and ${data.cohort.returningPeople} returning`}>
                    <i className="new" style={{ flex: data.cohort.newPeople }} /><i className="returning" style={{ flex: data.cohort.returningPeople }} />
                  </div>
                  <div className="chart-legend"><span><i className="new" /> New: {data.cohort.newPeople}</span><span><i className="returning" /> Returning: {data.cohort.returningPeople}</span></div>
                </>
              )}
              <div className="panel-title retention-title"><h4>Coming back</h4><InfoToggle label="Coming back" text={METRIC_HELP.retention} /></div>
              {data.cohort.previous === 0 ? <p className="muted">There is no earlier period to compare with yet.</p> : <p><strong>{data.cohort.retention}%</strong> <span className="muted">of the {data.cohort.previous} people active in the previous {data.days} days were active again ({data.cohort.retained}).</span></p>}
              {data.since.logins && <small>Sign-ins have been recorded since {shortDay(data.since.logins)}.</small>}
            </section>

            <section className="panel">
              <Title help={METRIC_HELP.adoption}>Who is using the app</Title>
              {data.teams.length === 0 ? <p className="muted">No people yet.</p> : (
                <ul className="hbars teams">{data.teams.map((team) => { const share = team.people ? Math.round((team.active * 100) / team.people) : 0; return <li key={team.team}><span title={team.team}>{team.team}</span><div><i style={{ width: `${share}%` }} /></div><small title={`${team.active} of ${team.people} people`}>{share}%</small></li>; })}</ul>
              )}
            </section>
          </div>

          <div className="panel-tools export-row">
            <button className="button button-small" onClick={exportDaily}><Icon name="download" size={16} /> Download daily numbers (CSV)</button>
            <button className="button button-small" onClick={exportFeatures}><Icon name="download" size={16} /> Download feature numbers (CSV)</button>
          </div>
          {data.retentionDays > 0 && <p className="muted small-print">Usage totals are kept for {data.retentionDays} days. You can change that, and switch counting off, in Settings.</p>}
        </>
      )}
    </div>
  );
}
