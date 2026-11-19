import { useEffect, useMemo, useState } from 'react';
import type { ContactItem, LinkItem } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { track } from '../../lib/usage';
import type { Ctx } from '../App';
import { Empty, ExternalLink, Icon, Spinner, Tabs, useKit } from '../kit';

function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.entries()];
}

export function UsefulScreen({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const tabs = [...(ctx.flag('links') ? [{ id: 'links' as const, label: 'Links & guides', icon: 'link' }] : []), ...(ctx.flag('contacts') ? [{ id: 'contacts' as const, label: 'Important contacts', icon: 'phone' }] : [])];
  const [tab, setTab] = useState<'links' | 'contacts'>(tabs[0]?.id ?? 'links');
  const [links, setLinks] = useState<LinkItem[] | null>(null);
  const [contacts, setContacts] = useState<ContactItem[] | null>(null);
  const [search, setSearch] = useState('');
  useEffect(() => { if (tabs.some((item) => item.id === tab)) track(tab); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ctx.flag('links')) api<{ links: LinkItem[] }>('/links').then((r) => setLinks(r.links)).catch((e) => { toast(messageOf(e), 'error'); setLinks([]); });
    if (ctx.flag('contacts')) api<{ contacts: ContactItem[] }>('/contacts').then((r) => setContacts(r.contacts)).catch((e) => { toast(messageOf(e), 'error'); setContacts([]); });
  }, [ctx, toast]);

  const term = search.trim().toLowerCase();
  const shownLinks = useMemo(() => (links ?? []).filter((l) => !term || `${l.title} ${l.description} ${l.category}`.toLowerCase().includes(term)), [links, term]);
  const shownContacts = useMemo(() => (contacts ?? []).filter((c) => !term || `${c.name} ${c.role_title} ${c.category} ${c.notes}`.toLowerCase().includes(term)), [contacts, term]);

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast(`Copied ${value}`, 'success'); } catch { toast('Could not copy. Select and copy it manually.', 'error'); }
  }

  return (
    <div>
      <div className="page-head"><div><span className="eyebrow">USEFUL STUFF</span><h1>Handy things, one tap away</h1></div>
        <div className="input-icon"><Icon name="search" size={18} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" aria-label="Search" maxLength={60} /></div>
      </div>
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      {tab === 'links' && (links === null ? <Spinner /> : shownLinks.length === 0 ? <Empty icon="link" title="No links yet">{ctx.user.permissions.includes('content.links') || ctx.user.permissions.includes('content.contacts') ? 'Add some in Manage → Content.' : 'Your admins can add user guides and portals here.'}</Empty> : (
        groupBy(shownLinks, (l) => l.category).map(([category, items]) => (
          <section key={category} className="link-section">
            <h3 className="section-title">{category}</h3>
            <div className="link-grid">
              {items.map((link) => (
                <ExternalLink key={link.id} href={link.url}>
                  <span className="link-emoji">{link.emoji}</span>
                  <span className="link-text"><strong>{link.title}</strong>{link.description && <small>{link.description}</small>}</span>
                  <Icon name="external" size={16} />
                </ExternalLink>
              ))}
            </div>
          </section>
        ))
      ))}
      {tab === 'contacts' && (contacts === null ? <Spinner /> : shownContacts.length === 0 ? <Empty icon="phone" title="No contacts yet">Important numbers like reception, insurance or security will live here.</Empty> : (
        groupBy(shownContacts, (c) => c.category).map(([category, items]) => (
          <section key={category} className="link-section">
            <h3 className="section-title">{category}</h3>
            <div className="contact-grid">
              {items.map((contact) => (
                <article key={contact.id} className="contact-card">
                  <div className="contact-head"><span className="link-emoji">{contact.emoji}</span><div><strong>{contact.name}</strong>{contact.role_title && <small>{contact.role_title}</small>}</div></div>
                  {contact.hours && <p className="muted"><Icon name="clock" size={14} /> {contact.hours}</p>}
                  {contact.notes && <p className="muted">{contact.notes}</p>}
                  <div className="contact-actions">
                    {contact.phone && <><a className="button button-small button-primary" href={`tel:${contact.phone.replace(/[^+\d]/g, '')}`}><Icon name="phone" size={15} /> {contact.phone}</a><button className="icon-button" aria-label={`Copy ${contact.phone}`} onClick={() => void copy(contact.phone)}><Icon name="copy" size={16} /></button></>}
                    {contact.email && <a className="button button-small" href={`mailto:${contact.email}`}><Icon name="mail" size={15} /> Email</a>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))
      ))}
    </div>
  );
}
