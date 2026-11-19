import { useCallback, useEffect, useState } from 'react';
import { EVENT_CATEGORIES, type OfficeEvent } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { dateKeyInIndia, inIndia, timeKeyInIndia, timeRange, toInstant, todayInIndia } from '../../lib/format';
import { normalizeUrl, urlProblem } from '../../lib/url';
import type { Ctx } from '../App';
import { Empty, ExternalLink, Field, Icon, Modal, Spinner, UrlInput, useKit } from '../kit';

const CATEGORY_TONE: Record<string, string> = { Learning: 'blue', Community: 'green', Company: 'lilac', Social: 'orange', Wellness: 'teal', Team: 'pink' };

export function EventsScreen({ ctx }: { ctx: Ctx }) {
  const { toast, celebrate } = useKit();
  const [events, setEvents] = useState<OfficeEvent[] | null>(null);
  const [editing, setEditing] = useState<OfficeEvent | 'new' | null>(null);
  const [deleting, setDeleting] = useState<OfficeEvent | null>(null);
  const [filter, setFilter] = useState('All');
  const canCreate = ctx.user.permissions.includes('events.create');
  const canEdit = ctx.user.permissions.includes('events.edit');
  const canDelete = ctx.user.permissions.includes('events.delete');
  const rsvpOn = ctx.config.options.eventsRsvpEnabled;

  const load = useCallback(async () => {
    try { setEvents((await api<{ events: OfficeEvent[] }>('/events')).events); } catch (reason) { toast(messageOf(reason), 'error'); setEvents([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function toggle(event: OfficeEvent) {
    setEvents((current) => current?.map((item) => item.id === event.id ? { ...item, going: !item.going, going_count: item.going_count + (item.going ? -1 : 1) } : item) ?? null);
    try {
      await api(`/events/${event.id}/rsvp`, { method: event.going ? 'DELETE' : 'PUT' });
      if (!event.going) { celebrate(); toast(`You’re in for “${event.title}”!`, 'success'); }
    } catch (reason) { toast(messageOf(reason), 'error'); void load(); }
  }

  async function remove() {
    if (!deleting) return;
    try { await api(`/events/${deleting.id}`, { method: 'DELETE' }); toast('Event deleted.', 'success'); setDeleting(null); await load(); } catch (reason) { toast(messageOf(reason), 'error'); }
  }

  const shown = events?.filter((event) => filter === 'All' || event.category === filter) ?? [];

  return (
    <div>
      <div className="page-head">
        <div><span className="eyebrow">COMMUNITY</span><h1>What’s happening</h1></div>
        {canCreate && <button className="button button-primary" onClick={() => setEditing('new')}><Icon name="plus" size={18} /> Create event</button>}
      </div>
      <div className="chip-row" role="group" aria-label="Filter events">
        {['All', ...EVENT_CATEGORIES].map((category) => <button key={category} className={`chip ${filter === category ? 'on' : ''}`} onClick={() => setFilter(category)}>{category}</button>)}
      </div>
      {events === null ? <Spinner /> : shown.length === 0 ? (
        <Empty icon="party" title="No events here yet">{canCreate ? 'Be the first — create one and get people together.' : 'Check back soon, something fun is always brewing.'}</Empty>
      ) : (
        <div className="event-grid">
          {shown.map((event) => (
            <article key={event.id} className={`event-card tone-${CATEGORY_TONE[event.category] ?? 'green'}`}>
              <div className="event-top">
                <div className="date-chip big"><strong>{inIndia(event.starts_at, { day: '2-digit' })}</strong><span>{inIndia(event.starts_at, { month: 'short' }).toUpperCase()}</span></div>
                <span className="pill tone-pill">{event.category}</span>
              </div>
              <h3>{event.title}</h3>
              {event.description && <p className="muted">{event.description}</p>}
              <ul className="event-meta">
                <li><Icon name="calendar" size={15} /> {inIndia(event.starts_at, { weekday: 'long' })}</li>
                <li><Icon name="clock" size={15} /> {timeRange(event.starts_at, event.ends_at)}</li>
                <li><Icon name="pin" size={15} /> {event.venue}</li>
                <li><Icon name="users" size={15} /> {rsvpOn ? `${event.going_count} going · ` : ''}{event.audience}</li>
              </ul>
              {event.links.length > 0 && <div className="event-links">{event.links.map((link) => <ExternalLink key={link.url + link.label} href={link.url}><Icon name="link" size={14} /> {link.label}</ExternalLink>)}</div>}
              <div className="event-actions">
                {rsvpOn && (
                  <button className={`button ${event.going ? 'button-primary' : ''}`} aria-pressed={event.going} onClick={() => void toggle(event)}>
                    <Icon name={event.going ? 'check' : 'heart'} size={18} /> {event.going ? 'You’re going' : 'I’m going'}
                  </button>
                )}
                {canEdit && <button className="icon-button" aria-label={`Edit ${event.title}`} onClick={() => setEditing(event)}><Icon name="edit" /></button>}
                {canDelete && <button className="icon-button danger" aria-label={`Delete ${event.title}`} onClick={() => setDeleting(event)}><Icon name="trash" /></button>}
              </div>
            </article>
          ))}
        </div>
      )}
      {editing && <EventForm event={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {deleting && (
        <Modal title="Delete this event?" onClose={() => setDeleting(null)}>
          <p><strong>{deleting.title}</strong> and its RSVPs will be removed for everyone.</p>
          <div className="modal-actions"><button className="button" onClick={() => setDeleting(null)}>Keep it</button><button className="button button-danger" onClick={() => void remove()}>Delete event</button></div>
        </Modal>
      )}
    </div>
  );
}

function EventForm({ event, onClose, onSaved }: { event: OfficeEvent | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useKit();
  const [title, setTitle] = useState(event?.title ?? '');
  const [category, setCategory] = useState(event?.category ?? 'Community');
  const [date, setDate] = useState(event ? dateKeyInIndia(event.starts_at) : todayInIndia(1));
  const [start, setStart] = useState(event ? timeKeyInIndia(event.starts_at) : '16:00');
  const [end, setEnd] = useState(event ? timeKeyInIndia(event.ends_at) : '17:00');
  const [venue, setVenue] = useState(event?.venue ?? '');
  const [audience, setAudience] = useState(event?.audience ?? 'All employees');
  const [description, setDescription] = useState(event?.description ?? '');
  const [links, setLinks] = useState<{ label: string; url: string }[]>(event?.links ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(submitEvent: React.FormEvent) {
    submitEvent.preventDefault();
    setError('');
    const startsAt = toInstant(date, start);
    const endsAt = toInstant(date, end);
    if (endsAt <= startsAt) return setError('The event needs to end after it starts.');
    const cleanLinks = links.filter((link) => link.label.trim() || link.url.trim()).map((link) => ({ label: link.label.trim(), url: normalizeUrl(link.url) }));
    const badLink = cleanLinks.map((link) => urlProblem(link.url) ?? (link.url ? null : 'Each link needs a web address.')).find(Boolean);
    if (badLink) return setError(badLink);
    setBusy(true);
    try {
      const body = { title, category, venue, audience, description, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), links: cleanLinks };
      if (event) await api(`/events/${event.id}`, { method: 'PATCH', body });
      else await api('/events', { method: 'POST', body });
      toast(event ? 'Event updated.' : 'Event created — time to spread the word!', 'success');
      onSaved();
    } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }

  return (
    <Modal title={event ? 'Edit event' : 'Create an event'} onClose={onClose} wide>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} placeholder="Friday coffee & chat" autoFocus /></Field>
        <Field label="Category"><select value={category} onChange={(e) => setCategory(e.target.value)}>{EVENT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <div className="two"><Field label="Starts"><input type="time" value={start} onChange={(e) => setStart(e.target.value)} required /></Field><Field label="Ends"><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required /></Field></div>
        <Field label="Venue"><input value={venue} onChange={(e) => setVenue(e.target.value)} required maxLength={120} placeholder="Cafeteria" /></Field>
        <Field label="Who’s it for?"><input value={audience} onChange={(e) => setAudience(e.target.value)} maxLength={100} /></Field>
        <div className="span-2"><Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} placeholder="What should people expect?" /></Field></div>
        <div className="span-2 link-editor">
          <strong className="mini-label">Links (agenda, RSVP form, meeting call…)</strong>
          {links.map((link, index) => (
            <div key={index} className="link-row">
              <input value={link.label} onChange={(e) => setLinks(links.map((l, i) => i === index ? { ...l, label: e.target.value } : l))} placeholder="Label" maxLength={60} aria-label="Link label" />
              <UrlInput value={link.url} onChange={(value) => setLinks(links.map((l, i) => i === index ? { ...l, url: value } : l))} ariaLabel="Link address" />
              <button type="button" className="icon-button danger" aria-label="Remove link" onClick={() => setLinks(links.filter((_, i) => i !== index))}><Icon name="trash" size={15} /></button>
            </div>
          ))}
          {links.length < 6 && <button type="button" className="button button-small" onClick={() => setLinks([...links, { label: '', url: '' }])}><Icon name="plus" size={15} /> Add a link</button>}
        </div>
        {error && <div className="form-error span-2" role="alert">{error}</div>}
        <div className="modal-actions span-2"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : event ? 'Save changes' : 'Publish event'}</button></div>
      </form>
    </Modal>
  );
}
