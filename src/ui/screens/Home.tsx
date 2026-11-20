import { useEffect, useState } from 'react';
import type { Announcement, Booking, Celebration, FeatureKey, LinkItem, MenuItem, OfficeEvent, Summary, Vibes, WhosIn } from '../../lib/types';
import { MEALS } from '../../lib/types';
import { api } from '../../lib/api';
import { track } from '../../lib/usage';
import { currentMeal } from '../../lib/menuCatalog';
import { loadMenu } from '../../lib/menuData';
import { greeting, inIndia, relativeDay, timeRange, todayInIndia } from '../../lib/format';
import type { Ctx } from '../App';
import { Avatar, ExternalLink, Icon, Spinner, useKit } from '../kit';
import { DietDot } from '../MenuBits';
import { getDailyTip } from '../../lib/tips';

function useCountUp(target: number) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 700);
      setValue(Math.round(target * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

function Ring({ value, total }: { value: number; total: number }) {
  const ratio = total ? value / total : 0;
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg className="ring" viewBox="0 0 80 80" role="img" aria-label={`${value} of ${total} desks free`}>
      <circle cx="40" cy="40" r={radius} className="ring-track" />
      <circle cx="40" cy="40" r={radius} className="ring-fill" style={{ strokeDasharray: circumference, strokeDashoffset: circumference * (1 - ratio) }} />
    </svg>
  );
}

const quiet = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);

export function HomeScreen({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [events, setEvents] = useState<OfficeEvent[]>([]);
  const [news, setNews] = useState<Announcement[]>([]);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [whos, setWhos] = useState<WhosIn | null>(null);
  const [celebrations, setCelebrations] = useState<Celebration[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [vibes, setVibes] = useState<Vibes | null>(null);
  const [dismissed, setDismissed] = useState<string[]>(() => JSON.parse(sessionStorage.getItem('gcc-dismissed-news') ?? '[]') as string[]);
  const today = todayInIndia();

  useEffect(() => {
    let alive = true;
    const flag = (key: FeatureKey) => ctx.config.features[key] !== false;
    void Promise.all([
      ctx.getSummary(), api<{ bookings: Booking[] }>('/bookings'), api<{ events: OfficeEvent[] }>('/events'),
      flag('announcements') ? quiet(api<{ announcements: Announcement[] }>('/announcements'), { announcements: [] }) : Promise.resolve({ announcements: [] }),
      flag('menu') ? quiet(loadMenu().then((window) => ({ items: window.items.filter((item) => item.date === window.today) })), { items: [] as MenuItem[] }) : Promise.resolve({ items: [] as MenuItem[] }),
      flag('whosin') ? quiet(api<WhosIn>('/whosin'), null) : Promise.resolve(null),
      flag('celebrations') ? quiet(api<{ celebrations: Celebration[] }>('/celebrations'), { celebrations: [] }) : Promise.resolve({ celebrations: [] }),
      flag('links') ? quiet(api<{ links: LinkItem[] }>('/links'), { links: [] }) : Promise.resolve({ links: [] }),
      flag('vibes') ? quiet(api<Vibes>('/me/vibes'), null) : Promise.resolve(null),
    ]).then(([s, b, e, n, m, w, c, l, v]) => {
      if (!alive) return;
      setSummary(s); setBookings(b.bookings); setEvents(e.events); setNews(n.announcements); setMenu(m.items); setWhos(w); setCelebrations(c.celebrations); setLinks(l.links); setVibes(v);
      // Usage analytics: these two cards are only "seen on Home" when they have something to show.
      if (n.announcements.length) track('announcements');
      if (w) track('whosin');
    }).catch(() => { toast('Some of your dashboard could not load. Pull to refresh in a moment.', 'error'); setBookings([]); });
    return () => { alive = false; };
  }, [ctx.config, ctx.getSummary, today, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const free = useCountUp(summary?.desksLeftToday ?? 0);
  const streak = useCountUp(summary?.streak ?? 0);
  const next = bookings?.[0];
  const hour = Number(inIndia(new Date(), { hour: '2-digit', hour12: false })) % 24;
  const nowMeal = currentMeal(hour, Number(inIndia(new Date(), { minute: '2-digit' })));
  const mealNow = menu.filter((item) => item.meal === nowMeal);
  const tip = getDailyTip();
  const visibleNews = news.filter((item) => !dismissed.includes(item.id)).slice(0, 3);
  const nextCelebrations = celebrations.slice(0, 4);

  function dismiss(id: string) {
    const nextList = [...dismissed, id];
    setDismissed(nextList);
    sessionStorage.setItem('gcc-dismissed-news', JSON.stringify(nextList));
  }

  return (
    <div className="home">
      <section className="hero">
        <div>
          <span className="eyebrow light">{inIndia(new Date(), { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()}</span>
          <h1>{greeting(ctx.user.name)} <span className="wave" aria-hidden="true">👋</span></h1>
          <p>{ctx.config.branding.welcome || (hour < 12 ? 'Plan a great day. A good seat makes everything easier.' : hour < 17 ? 'Still time to grab a spot or a room for later.' : 'Planning tomorrow already? Future you says thanks.')}</p>
          <div className="hero-actions">
            <button className="button button-lime" onClick={() => ctx.startBooking({ kind: 'desk' })}>Find me a desk <Icon name="arrow" size={18} /></button>
            <button className="button button-ghost-light" onClick={() => ctx.startBooking({ kind: 'room' })}>Book a room</button>
          </div>
        </div>
        <div className="hero-card" aria-live="polite">
          {bookings === null ? <Spinner label="Checking your plans" /> : next ? (
            <>
              <span className="eyebrow light">YOUR NEXT BOOKING</span>
              <strong className="hero-card-title">{next.label}</strong>
              <span>{relativeDay(next.starts_at)} · {timeRange(next.starts_at, next.ends_at)}</span>
              <small>{next.type === 'desk' ? 'Desk' : 'Room'} · {next.zone || next.floor}</small>
              <button className="text-link light" onClick={() => ctx.go('bookings')}>See details <Icon name="arrow" size={16} /></button>
            </>
          ) : (
            <>
              <span className="eyebrow light">NOTHING BOOKED YET</span>
              <strong className="hero-card-title">Your calendar is wide open</strong>
              <span>Book a desk and your neighbours will thank you for the company.</span>
            </>
          )}
        </div>
      </section>

      {visibleNews.length > 0 && (
        <section className="news-stack" aria-label="Announcements">
          {visibleNews.map((item) => (
            <article key={item.id} className={`news-card ${item.pinned ? 'pinned' : ''}`}>
              <span className="news-emoji">{item.emoji}</span>
              <div><strong>{item.title}</strong>{item.body && <p>{item.body}</p>}</div>
              <button className="icon-button" aria-label="Dismiss" onClick={() => dismiss(item.id)}><Icon name="x" size={16} /></button>
            </article>
          ))}
        </section>
      )}

      <section className="stat-grid">
        <article className="stat-card stat-ring">
          <Ring value={summary?.desksLeftToday ?? 0} total={summary?.desksTotal ?? 0} />
          <div><strong>{free}</strong><span>desks free today</span><small>of {summary?.desksTotal ?? '–'} total</small></div>
        </article>
        <article className="stat-card stat-streak">
          <span className="stat-icon flame"><Icon name="flame" size={26} /></span>
          <div><strong>{streak}</strong><span>day streak</span><small>{summary && summary.streak > 0 ? 'Keep it going. See you tomorrow!' : 'Book today to start a streak'}</small></div>
        </article>
        {vibes ? (
          <article className="stat-card stat-level">
            <span className="level-emoji">{vibes.level.emoji}</span>
            <div className="level-body">
              <strong>{vibes.level.name}</strong><span>{vibes.points} points</span>
              {vibes.next ? <><div className="progress"><i style={{ width: `${Math.round(vibes.next.progress * 100)}%` }} /></div><small>{vibes.next.remaining} to {vibes.next.emoji} {vibes.next.name}</small></> : <small>Top level reached. Legendary!</small>}
            </div>
          </article>
        ) : (
          <article className="stat-card"><span className="stat-icon calm"><Icon name="calendar" size={24} /></span><div><strong>{summary?.monthCount ?? 0}</strong><span>office days this month</span><small>{summary?.totalVisits ?? 0} all-time visits</small></div></article>
        )}
      </section>

      {vibes && (
        <section className="badge-strip" aria-label="Your badges">
          {vibes.badges.map((badge) => (
            <span key={badge.id} className={`badge-pill ${badge.earned ? 'earned' : ''}`} title={badge.earned ? badge.name : `${badge.name}: ${badge.hint}`}><span>{badge.emoji}</span>{badge.name}</span>
          ))}
        </section>
      )}

      <section className="quick-grid">
        {([
          ['desk', 'Book a desk', 'Pick your spot on the real floor plan', () => ctx.startBooking({ kind: 'desk' }), 'green'],
          ['room', 'Book a room', 'Meetings, cabins and collab zones', () => ctx.startBooking({ kind: 'room' }), 'lilac'],
          ['scan', 'Scan a QR', 'Found a code on a desk? Tap to book', () => ctx.go('scan'), 'orange'],
          ['party', 'What is on', 'Events and community moments', () => ctx.go('events'), 'blue'],
          ...(ctx.flag('issues') ? [['wrench', 'Report a problem', 'Coffee machine, tap, lights… tell us fast', () => ctx.go('issues'), 'pink'] as [string, string, string, () => void, string]] : []),
        ] as [string, string, string, () => void, string][]).map(([icon, title, subtitle, action, tone]) => (
          <button key={title} className="quick-card" onClick={action}>
            <span className={`quick-icon ${tone}`}><Icon name={icon} size={24} /></span>
            <span><strong>{title}</strong><small>{subtitle}</small></span>
            <Icon name="arrow" size={18} />
          </button>
        ))}
      </section>

      <div className="home-columns">
        {ctx.flag('menu') && (
          <section className="panel">
            <div className="panel-head"><h2>{mealNow.length ? `Today's ${MEALS[nowMeal].label.toLowerCase()}` : 'Today\'s menu'}</h2><button className="text-link" onClick={() => ctx.go('menu')}>Full menu <Icon name="arrow" size={16} /></button></div>
            {menu.length === 0 ? <p className="muted">Nothing posted yet. Check back near lunchtime 🍛</p> : (
              <ul className="mini-menu">{(mealNow.length ? mealNow : menu).slice(0, 6).map((item) => <li key={item.id}><span>{item.emoji && item.emoji !== '🍽️' ? item.emoji : MEALS[item.meal].emoji}</span><div><strong>{item.name} <DietDot diet={item.diet} /></strong><small>{MEALS[item.meal].label}</small></div>{item.likes > 0 && <small>❤️ {item.likes}</small>}</li>)}</ul>
            )}
          </section>
        )}
        {ctx.flag('whosin') && whos && (
          <section className="panel">
            <div className="panel-head"><h2>Who&apos;s in today</h2><span className="pill">{whos.total}</span></div>
            {whos.people.length === 0 ? <p className="muted">{whos.total ? 'Everyone in today prefers to stay a mystery.' : 'Nobody has booked a desk yet. Be the trendsetter!'}</p> : (
              <>
                <div className="avatar-stack">{whos.people.slice(0, 12).map((person) => <span key={person.id} title={`${person.name} · ${person.desk}`}><Avatar name={person.name} emoji={person.avatar} size={38} /></span>)}{whos.people.length > 12 && <span className="more-count">+{whos.people.length - 12}</span>}</div>
                <p className="muted small-print">{whos.people.slice(0, 3).map((p) => p.name.split(' ')[0]).join(', ')}{whos.people.length > 3 ? ` and ${whos.total - 3} more` : ''} {whos.total === 1 ? 'is' : 'are'} in.</p>
              </>
            )}
          </section>
        )}
        {ctx.flag('celebrations') && nextCelebrations.length > 0 && (
          <section className="panel">
            <div className="panel-head"><h2>Celebrate</h2><button className="text-link" onClick={() => ctx.go('community')}>All <Icon name="arrow" size={16} /></button></div>
            <ul className="mini-menu">{nextCelebrations.map((c) => <li key={c.id}><span>{c.kind === 'birthday' ? '🎂' : '🏅'}</span><div><strong>{c.name}</strong><small>{c.kind === 'birthday' ? 'Birthday' : `${c.years} yr anniversary`}</small></div><small>{c.daysAway === 0 ? 'Today!' : c.daysAway === 1 ? 'Tomorrow' : `${c.daysAway}d`}</small></li>)}</ul>
          </section>
        )}
      </div>

      {ctx.flag('contacts') && ctx.config.options.homeContacts !== false && ctx.homeContacts.length > 0 && (
        <section className="panel home-contacts" aria-labelledby="home-contacts-title">
          <div className="panel-head"><h2 id="home-contacts-title">Important contacts</h2><button className="text-link" onClick={() => ctx.go('useful')}>All contacts <Icon name="arrow" size={16} /></button></div>
          <ul className="hc-list">
            {ctx.homeContacts.map((contact) => (
              <li key={contact.id} className="hc-item">
                <span className="hc-emoji" aria-hidden="true">{contact.emoji}</span>
                <div className="hc-text"><strong>{contact.name}</strong><small>{[contact.role_title, contact.phone, contact.hours].filter(Boolean).join(' · ')}</small></div>
                <div className="hc-actions">
                  {contact.phone && <a className="button button-small button-primary" href={`tel:${contact.phone.replace(/[^+\d]/g, '')}`} aria-label={`Call ${contact.name} on ${contact.phone}`}><Icon name="phone" size={15} /> Call</a>}
                  {contact.email && <a className="button button-small" href={`mailto:${contact.email}`} aria-label={`Email ${contact.name}`}><Icon name="mail" size={15} /> Email</a>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ctx.flag('links') && links.length > 0 && (
        <section className="panel">
          <div className="panel-head"><h2>Quick links</h2><button className="text-link" onClick={() => ctx.go('useful')}>All <Icon name="arrow" size={16} /></button></div>
          <div className="link-chips">{links.slice(0, 8).map((link) => <ExternalLink key={link.id} href={link.url}><span>{link.emoji}</span>{link.title}</ExternalLink>)}</div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head"><h2>Coming up</h2><button className="text-link" onClick={() => ctx.go('events')}>All events <Icon name="arrow" size={16} /></button></div>
        {events.length === 0 ? <p className="muted">No events yet. Check back soon.</p> : (
          <div className="event-strip">
            {events.slice(0, 4).map((event) => (
              <article key={event.id} className="mini-event">
                <div className="date-chip"><strong>{inIndia(event.starts_at, { day: '2-digit' })}</strong><span>{inIndia(event.starts_at, { month: 'short' }).toUpperCase()}</span></div>
                <div><strong>{event.title}</strong><small>{timeRange(event.starts_at, event.ends_at)} · {event.venue}</small></div>
              </article>
            ))}
          </div>
        )}
      </section>
      <p className="tip-line">💡 {tip}</p>
    </div>
  );
}
