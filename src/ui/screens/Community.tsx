import { useCallback, useEffect, useMemo, useState } from 'react';
import { KUDOS_BADGES, type Celebration, type Kudos, type Person, type Poll } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia } from '../../lib/format';
import type { Ctx } from '../App';
import { Avatar, Empty, Field, Icon, Modal, Spinner, Tabs, useKit } from '../kit';

type Tab = 'kudos' | 'polls' | 'celebrations' | 'feedback';

export function CommunityScreen({ ctx }: { ctx: Ctx }) {
  const tabs = [
    ...(ctx.flag('kudos') ? [{ id: 'kudos' as Tab, label: 'Kudos wall', icon: 'heart' }] : []),
    ...(ctx.flag('polls') ? [{ id: 'polls' as Tab, label: 'Polls', icon: 'poll' }] : []),
    ...(ctx.flag('celebrations') ? [{ id: 'celebrations' as Tab, label: 'Celebrations', icon: 'cake' }] : []),
    ...(ctx.flag('feedback') ? [{ id: 'feedback' as Tab, label: 'Idea box', icon: 'chat' }] : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs[0].id);
  return (
    <div>
      <div className="page-head"><div><span className="eyebrow">COMMUNITY</span><h1>The good stuff</h1></div></div>
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      {tab === 'kudos' && <KudosWall ctx={ctx} />}
      {tab === 'polls' && <Polls />}
      {tab === 'celebrations' && <Celebrations ctx={ctx} />}
      {tab === 'feedback' && <IdeaBox />}
    </div>
  );
}

function KudosWall({ ctx }: { ctx: Ctx }) {
  const { toast, celebrate } = useKit();
  const [data, setData] = useState<{ kudos: Kudos[]; leaders: { id: string; name: string; avatar: string; received: number }[] } | null>(null);
  const [writing, setWriting] = useState(false);
  const canModerate = ctx.user.permissions.includes('community.manage');

  const load = useCallback(async () => {
    try { setData(await api('/kudos')); } catch (reason) { toast(messageOf(reason), 'error'); setData({ kudos: [], leaders: [] }); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function cheer(item: Kudos) {
    setData((current) => current && { ...current, kudos: current.kudos.map((k) => k.id === item.id ? { ...k, cheered: !k.cheered, cheers: k.cheers + (k.cheered ? -1 : 1) } : k) });
    try { await api(`/kudos/${item.id}/cheer`, { method: 'POST' }); } catch (reason) { toast(messageOf(reason), 'error'); void load(); }
  }
  async function remove(item: Kudos) {
    if (!window.confirm('Remove this shout-out?')) return;
    try { await api(`/kudos/${item.id}`, { method: 'DELETE' }); await load(); } catch (reason) { toast(messageOf(reason), 'error'); }
  }

  if (!data) return <Spinner />;
  return (
    <div className="kudos-layout">
      <div>
        <button className="button button-primary kudos-cta" onClick={() => setWriting(true)}><Icon name="heart" size={18} /> Give someone a shout-out</button>
        {data.kudos.length === 0 ? <Empty icon="heart" title="Be the first to spread some love">A quick thank-you makes someone&apos;s whole day.</Empty> : (
          <ul className="kudos-list">
            {data.kudos.map((item) => (
              <li key={item.id} className="kudos-card">
                <div className="kudos-badge" title={KUDOS_BADGES[item.badge]?.label}>{KUDOS_BADGES[item.badge]?.emoji ?? '🌟'}</div>
                <div className="kudos-body">
                  <p className="kudos-line"><Avatar name={item.from_name} emoji={item.from_avatar} size={26} /> <strong>{item.from_name}</strong> <span className="muted">thanked</span> <Avatar name={item.to_name} emoji={item.to_avatar} size={26} /> <strong>{item.to_name}</strong></p>
                  <p className="kudos-message">{item.message}</p>
                  <div className="kudos-foot">
                    <button className={`like-button ${item.cheered ? 'on' : ''}`} aria-pressed={item.cheered} onClick={() => void cheer(item)}>🎉 <span>{item.cheers}</span></button>
                    <small>{inIndia(item.created_at, { day: 'numeric', month: 'short' })}</small>
                    {(item.from_id === ctx.user.id || canModerate) && <button className="icon-button danger" aria-label="Remove shout-out" onClick={() => void remove(item)}><Icon name="trash" size={15} /></button>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <aside className="panel leaders">
        <h3>Most loved this month</h3>
        {data.leaders.length === 0 ? <p className="muted">No shout-outs yet.</p> : (
          <ol>{data.leaders.map((leader, index) => <li key={leader.id}><span className="rank">{['🥇', '🥈', '🥉'][index] ?? index + 1}</span><Avatar name={leader.name} emoji={leader.avatar} size={30} /><strong>{leader.name}</strong><small>{leader.received}</small></li>)}</ol>
        )}
      </aside>
      {writing && <KudosForm me={ctx.user.id} onClose={() => setWriting(false)} onSent={() => { setWriting(false); celebrate(); toast('Shout-out sent. Someone is smiling right now!', 'success'); void load(); }} />}
    </div>
  );
}

function KudosForm({ me, onClose, onSent }: { me: string; onClose: () => void; onSent: () => void }) {
  const { toast } = useKit();
  const [people, setPeople] = useState<Person[]>([]);
  const [search, setSearch] = useState('');
  const [toId, setToId] = useState('');
  const [badge, setBadge] = useState('star');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ people: Person[] }>('/people').then((r) => setPeople(r.people.filter((p) => p.id !== me))).catch(() => {}); }, [me]);
  const matches = useMemo(() => people.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase())).slice(0, 8), [people, search]);
  const chosen = people.find((p) => p.id === toId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!toId) return toast('Pick who you want to thank.', 'info');
    setBusy(true);
    try { await api('/kudos', { method: 'POST', body: { toId, badge, message } }); onSent(); } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title="Say thanks" onClose={onClose} wide>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Who made your day?">
          {chosen ? <div className="chosen-person"><Avatar name={chosen.name} emoji={chosen.avatar} size={30} /> <strong>{chosen.name}</strong><button type="button" className="text-link" onClick={() => setToId('')}>Change</button></div> : (
            <>
              <div className="input-icon"><Icon name="search" size={18} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a name" autoFocus /></div>
              <ul className="space-list compact">{matches.map((p) => <li key={p.id}><button type="button" className="space-row" onClick={() => setToId(p.id)}><Avatar name={p.name} emoji={p.avatar} size={30} /><span className="space-text"><strong>{p.name}</strong><small>{p.team}</small></span></button></li>)}</ul>
            </>
          )}
        </Field>
        <fieldset className="badge-picker"><legend>Pick a badge</legend>
          {Object.entries(KUDOS_BADGES).map(([id, b]) => <button type="button" key={id} className={`badge-option ${badge === id ? 'on' : ''}`} onClick={() => setBadge(id)}><span>{b.emoji}</span><small>{b.label}</small></button>)}
        </fieldset>
        <Field label="What did they do?" hint={`${message.length}/280`}><textarea value={message} onChange={(e) => setMessage(e.target.value)} required maxLength={280} rows={3} placeholder="Thanks for staying late to help us ship!" /></Field>
        <div className="modal-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Sending…' : 'Send the love'}</button></div>
      </form>
    </Modal>
  );
}

function Polls() {
  const { toast } = useKit();
  const [polls, setPolls] = useState<Poll[] | null>(null);
  const load = useCallback(async () => {
    try { setPolls((await api<{ polls: Poll[] }>('/polls')).polls); } catch (reason) { toast(messageOf(reason), 'error'); setPolls([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function vote(poll: Poll, option: number) {
    try { await api(`/polls/${poll.id}/vote`, { method: 'POST', body: { option } }); await load(); } catch (reason) { toast(messageOf(reason), 'error'); void load(); }
  }
  if (!polls) return <Spinner />;
  if (!polls.length) return <Empty icon="poll" title="No polls right now">When someone asks a question, it will pop up here.</Empty>;
  return (
    <div className="poll-grid">
      {polls.map((poll) => (
        <article key={poll.id} className="panel poll-card">
          <div className="poll-head"><h3>{poll.question}</h3><span className={`pill ${poll.open ? 'pill-ok' : 'pill-off'}`}>{poll.open ? 'Open' : 'Closed'}</span></div>
          <ul>
            {poll.options.map((option, index) => {
              const pct = poll.total ? Math.round((poll.counts[index] / poll.total) * 100) : 0;
              const showResults = poll.myVote !== null || !poll.open;
              return (
                <li key={option}>
                  <button className={`poll-option ${poll.myVote === index ? 'mine' : ''}`} disabled={!poll.open} onClick={() => void vote(poll, index)}>
                    {showResults && <i className="poll-bar" style={{ width: `${pct}%` }} />}
                    <span className="poll-label">{poll.myVote === index && <Icon name="check" size={16} />} {option}</span>
                    {showResults && <span className="poll-pct">{pct}%</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <small className="muted">{poll.total} {poll.total === 1 ? 'vote' : 'votes'}{poll.open && poll.myVote !== null ? ' · tap another option to change yours' : ''}</small>
        </article>
      ))}
    </div>
  );
}

function Celebrations({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const [items, setItems] = useState<Celebration[] | null>(null);
  useEffect(() => { api<{ celebrations: Celebration[] }>('/celebrations').then((r) => setItems(r.celebrations)).catch((e) => { toast(messageOf(e), 'error'); setItems([]); }); }, [toast]);
  if (!items) return <Spinner />;
  const when = (days: number) => (days === 0 ? 'Today! 🎉' : days === 1 ? 'Tomorrow' : `In ${days} days`);
  return (
    <div>
      {items.length === 0 ? <Empty icon="cake" title="No celebrations in the next 30 days">{ctx.user.birthMonth ? 'Nothing coming up. Check back soon!' : 'Add your birthday in Me and settings so friends can cheer for you.'}</Empty> : (
        <ul className="celebration-list">
          {items.map((item) => (
            <li key={item.id} className={`celebration ${item.daysAway === 0 ? 'today' : ''}`}>
              <span className="celebration-icon">{item.kind === 'birthday' ? '🎂' : '🏅'}</span>
              <Avatar name={item.name} emoji={item.avatar} size={40} />
              <div><strong>{item.name}</strong><small>{item.kind === 'birthday' ? 'Birthday' : `${item.years} ${item.years === 1 ? 'year' : 'years'} with us`} · {item.label}</small></div>
              <span className="pill">{when(item.daysAway)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small-print">Birthdays only show up if people add them themselves.</p>
    </div>
  );
}

function IdeaBox() {
  const { toast, celebrate } = useKit();
  const [category, setCategory] = useState('Idea');
  const [message, setMessage] = useState('');
  const [anonymous, setAnonymous] = useState(true);
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try { await api('/feedback', { method: 'POST', body: { category, message, anonymous } }); setMessage(''); celebrate(); toast('Thank you! Your note is in the box.', 'success'); } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }
  return (
    <form className="panel form-stack idea-box" onSubmit={submit}>
      <h2>Got an idea, or something bugging you?</h2>
      <p className="muted">Drop it in the box. Only people who run the community can read it.</p>
      <div className="chip-row">{['Idea', 'Issue', 'Kudos', 'Other'].map((c) => <button type="button" key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => setCategory(c)}>{c}</button>)}</div>
      <Field label="Your note" hint={`${message.length}/1000`}><textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} maxLength={1000} required placeholder="It would be great if…" /></Field>
      <label className="check"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /><span>Send anonymously (we don&apos;t store who you are)</span></label>
      <button className="button button-primary" disabled={busy}>{busy ? 'Sending…' : 'Drop it in the box'}</button>
    </form>
  );
}
