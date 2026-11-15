import { useCallback, useEffect, useState } from 'react';
import type { Announcement, ContactItem, LinkItem } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia } from '../../lib/format';
import { Empty, Field, Icon, Modal, Spinner, Switch, Tabs, useKit } from '../kit';

type Sub = 'links' | 'contacts' | 'news';

export function ManageContent() {
  const [sub, setSub] = useState<Sub>('links');
  return (
    <div>
      <Tabs tabs={[{ id: 'links' as Sub, label: 'Links', icon: 'link' }, { id: 'contacts' as Sub, label: 'Contacts', icon: 'phone' }, { id: 'news' as Sub, label: 'Announcements', icon: 'megaphone' }]} value={sub} onChange={setSub} />
      {sub === 'links' && <Links />}
      {sub === 'contacts' && <Contacts />}
      {sub === 'news' && <News />}
    </div>
  );
}

function useList<T>(path: string) {
  const { toast } = useKit();
  const [items, setItems] = useState<T[] | null>(null);
  const load = useCallback(async () => {
    try { const result = await api<Record<string, T[]>>(path); setItems(Object.values(result)[0]); } catch (reason) { toast(messageOf(reason), 'error'); setItems([]); }
  }, [path, toast]);
  useEffect(() => { void load(); }, [load]);
  return { items, load };
}

async function remove(path: string, label: string, toast: (m: string, k?: 'success' | 'error' | 'info') => void, reload: () => Promise<void>) {
  if (!window.confirm(`Delete “${label}”?`)) return;
  try { await api(path, { method: 'DELETE' }); await reload(); } catch (reason) { toast(messageOf(reason), 'error'); }
}

function Links() {
  const { toast } = useKit();
  const { items, load } = useList<LinkItem>('/links?manage=1');
  const [editing, setEditing] = useState<LinkItem | 'new' | null>(null);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Useful links</h2><button className="button button-primary button-small" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add link</button></div>
      <p className="muted">User guides, payment or insurance portals, the leave system, anything people keep asking for.</p>
      {items === null ? <Spinner /> : items.length === 0 ? <Empty icon="link" title="No links yet" /> : (
        <ul className="plain-list">{items.map((link) => (
          <li key={link.id}><div><strong>{link.emoji} {link.title}</strong><small>{link.category} · {link.url}</small></div>
            <button className="icon-button" aria-label={`Edit ${link.title}`} onClick={() => setEditing(link)}><Icon name="edit" size={16} /></button>
            <button className="icon-button danger" aria-label={`Delete ${link.title}`} onClick={() => void remove(`/admin/links/${link.id}`, link.title, toast, load)}><Icon name="trash" size={16} /></button></li>
        ))}</ul>
      )}
      {editing && <LinkForm item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </section>
  );
}

function LinkForm({ item, onClose, onSaved }: { item: LinkItem | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [url, setUrl] = useState(item?.url ?? 'https://');
  const [description, setDescription] = useState(item?.description ?? '');
  const [category, setCategory] = useState(item?.category ?? 'General');
  const [emoji, setEmoji] = useState(item?.emoji ?? '🔗');
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const body = { title, url, description, category, emoji };
      if (item) await api(`/admin/links/${item.id}`, { method: 'PATCH', body }); else await api('/admin/links', { method: 'POST', body });
      onSaved();
    } catch (reason) { setError(messageOf(reason)); }
  }
  return (
    <Modal title={item ? 'Edit link' : 'Add a link'} onClose={onClose} wide>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={80} autoFocus /></Field>
        <Field label="Emoji"><input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={8} /></Field>
        <div className="span-2"><Field label="Web address"><input value={url} onChange={(e) => setUrl(e.target.value)} required maxLength={500} /></Field></div>
        <Field label="Group" hint="Links with the same group sit together"><input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={40} list="link-groups" /></Field>
        <Field label="Short description"><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} /></Field>
        <datalist id="link-groups"><option value="Guides" /><option value="Payments" /><option value="Insurance" /><option value="HR" /><option value="IT" /></datalist>
        {error && <div className="form-error span-2" role="alert">{error}</div>}
        <div className="modal-actions span-2"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary">Save</button></div>
      </form>
    </Modal>
  );
}

function Contacts() {
  const { toast } = useKit();
  const { items, load } = useList<ContactItem>('/contacts?manage=1');
  const [editing, setEditing] = useState<ContactItem | 'new' | null>(null);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Important contacts</h2><button className="button button-primary button-small" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add contact</button></div>
      <p className="muted">Reception, security, medical room, insurance desk, IT help. Anything people may need in a hurry.</p>
      {items === null ? <Spinner /> : items.length === 0 ? <Empty icon="phone" title="No contacts yet" /> : (
        <ul className="plain-list">{items.map((c) => (
          <li key={c.id}><div><strong>{c.emoji} {c.name}</strong><small>{c.category}{c.role_title ? ` · ${c.role_title}` : ''}{c.phone ? ` · ${c.phone}` : ''}</small></div>
            <button className="icon-button" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Icon name="edit" size={16} /></button>
            <button className="icon-button danger" aria-label={`Delete ${c.name}`} onClick={() => void remove(`/admin/contacts/${c.id}`, c.name, toast, load)}><Icon name="trash" size={16} /></button></li>
        ))}</ul>
      )}
      {editing && <ContactForm item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </section>
  );
}

function ContactForm({ item, onClose, onSaved }: { item: ContactItem | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: item?.name ?? '', roleTitle: item?.role_title ?? '', category: item?.category ?? 'General', phone: item?.phone ?? '', email: item?.email ?? '', hours: item?.hours ?? '', notes: item?.notes ?? '', emoji: item?.emoji ?? '📞' });
  const [error, setError] = useState('');
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [key]: e.target.value });
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      if (item) await api(`/admin/contacts/${item.id}`, { method: 'PATCH', body: form }); else await api('/admin/contacts', { method: 'POST', body: form });
      onSaved();
    } catch (reason) { setError(messageOf(reason)); }
  }
  return (
    <Modal title={item ? 'Edit contact' : 'Add a contact'} onClose={onClose} wide>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Name"><input value={form.name} onChange={set('name')} required maxLength={80} autoFocus placeholder="Reception desk" /></Field>
        <Field label="Emoji"><input value={form.emoji} onChange={set('emoji')} maxLength={8} /></Field>
        <Field label="Role or description"><input value={form.roleTitle} onChange={set('roleTitle')} maxLength={80} /></Field>
        <Field label="Group"><input value={form.category} onChange={set('category')} maxLength={40} list="contact-groups" /></Field>
        <datalist id="contact-groups"><option value="Emergency" /><option value="Insurance" /><option value="HR" /><option value="IT" /><option value="Facilities" /></datalist>
        <Field label="Phone"><input value={form.phone} onChange={set('phone')} maxLength={40} placeholder="+91 …" /></Field>
        <Field label="Email"><input type="email" value={form.email} onChange={set('email')} maxLength={120} pattern="[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}" title="A plain email address like name@example.com" /></Field>
        <div className="span-2"><Field label="Hours"><input value={form.hours} onChange={set('hours')} maxLength={80} placeholder="Mon-Fri, 9am to 6pm" /></Field></div>
        <div className="span-2"><Field label="Notes"><textarea rows={2} value={form.notes} onChange={set('notes')} maxLength={300} /></Field></div>
        {error && <div className="form-error span-2" role="alert">{error}</div>}
        <div className="modal-actions span-2"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary">Save</button></div>
      </form>
    </Modal>
  );
}

function News() {
  const { toast } = useKit();
  const { items, load } = useList<Announcement>('/announcements?all=1&manage=1');
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Announcements</h2><button className="button button-primary button-small" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> New announcement</button></div>
      {items === null ? <Spinner /> : items.length === 0 ? <Empty icon="megaphone" title="Nothing announced yet" /> : (
        <ul className="plain-list">{items.map((n) => {
          const expired = n.expires_at && new Date(n.expires_at).getTime() < Date.now();
          return (
            <li key={n.id}><div><strong>{n.emoji} {n.title} {n.pinned && <span className="pill pill-hot">Pinned</span>} {expired && <span className="pill pill-off">Expired</span>}</strong><small>{n.expires_at ? `Until ${inIndia(n.expires_at, { day: 'numeric', month: 'short' })}` : 'No expiry'}{n.body ? ` · ${n.body.slice(0, 80)}` : ''}</small></div>
              <button className="icon-button" aria-label={`Edit ${n.title}`} onClick={() => setEditing(n)}><Icon name="edit" size={16} /></button>
              <button className="icon-button danger" aria-label={`Delete ${n.title}`} onClick={() => void remove(`/admin/announcements/${n.id}`, n.title, toast, load)}><Icon name="trash" size={16} /></button></li>
          );
        })}</ul>
      )}
      {editing && <NewsForm item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </section>
  );
}

function NewsForm({ item, onClose, onSaved }: { item: Announcement | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [emoji, setEmoji] = useState(item?.emoji ?? '📣');
  const [pinned, setPinned] = useState(item?.pinned ?? false);
  const [expires, setExpires] = useState(item?.expires_at ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(item.expires_at)) : '');
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const payload = { title, body, emoji, pinned, expiresAt: expires ? new Date(`${expires}T23:59:00+05:30`).toISOString() : null };
      if (item) await api(`/admin/announcements/${item.id}`, { method: 'PATCH', body: payload }); else await api('/admin/announcements', { method: 'POST', body: payload });
      onSaved();
    } catch (reason) { setError(messageOf(reason)); }
  }
  return (
    <Modal title={item ? 'Edit announcement' : 'New announcement'} onClose={onClose} wide>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Headline"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={100} autoFocus /></Field>
        <Field label="Emoji"><input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={8} /></Field>
        <div className="span-2"><Field label="Message" hint={`${body.length}/600`}><textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={600} /></Field></div>
        <Field label="Hide after (optional)"><input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        <div className="switch-row"><div><strong>Pin to the top</strong></div><Switch checked={pinned} onChange={setPinned} label="Pin to the top" /></div>
        {error && <div className="form-error span-2" role="alert">{error}</div>}
        <div className="modal-actions span-2"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary">Publish</button></div>
      </form>
    </Modal>
  );
}
