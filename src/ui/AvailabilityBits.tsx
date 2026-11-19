import { clock, type Interval, type SpaceState } from '../lib/availabilityMath';

const FROM = 6 * 60;
const TO = 22 * 60;
const pct = (minute: number) => `${((Math.min(TO, Math.max(FROM, minute)) - FROM) / (TO - FROM)) * 100}%`;

/** A small bar for one day (6 am to 10 pm): booked blocks, plus the time you are looking at. */
export function DayStrip({ intervals, startMin, endMin }: { intervals: Interval[]; startMin: number; endMin: number }) {
  return (
    <div className="day-strip" role="img" aria-label={intervals.length ? `Booked ${intervals.map(([from, to]) => `${clock(from)} to ${clock(to)}`).join(', ')}` : 'No bookings today'}>
      <div className="day-strip-track">
        {intervals.filter(([from, to]) => to > FROM && from < TO).map(([from, to, mine], index) => (
          <i key={index} className={mine ? 'is-mine' : ''} style={{ left: pct(from), width: `calc(${pct(to)} - ${pct(from)})` }} />
        ))}
        <b style={{ left: pct(startMin), width: `max(4px, calc(${pct(endMin)} - ${pct(startMin)}))` }} />
      </div>
      <div className="day-strip-scale" aria-hidden="true"><span>6 am</span><span>12 pm</span><span>6 pm</span><span>10 pm</span></div>
    </div>
  );
}

const LEGEND: { state: SpaceState; label: string }[] = [
  { state: 'free', label: 'Free' }, { state: 'booked', label: 'Booked at your time' }, { state: 'mine', label: 'Yours' }, { state: 'blocked', label: 'Not available' },
];

export function StateLegend() {
  return (
    <ul className="state-legend" aria-label="What the colours mean">
      {LEGEND.map((item) => <li key={item.state}><i className={`swatch-dot is-${item.state}`} />{item.label}</li>)}
    </ul>
  );
}
