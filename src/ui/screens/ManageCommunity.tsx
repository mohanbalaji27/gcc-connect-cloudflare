import { useCallback, useEffect, useState } from 'react';
import type { FeedbackItem, Poll } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { inIndia } from '../../lib/format';
import { Empty, Field, Icon, Modal, Spinner, Tabs, useKit } from '../kit';

type Sub = 'polls' | 'feedback';

export function ManageCommunity() {
  const [sub, setSub] = useState<Sub>('polls');
  return (
    <div>
      <Tabs tabs={[{ id: 'polls' as Sub, label: 'Polls', icon: 'poll' }, { id: 'feedback' as Sub, label: 'Idea box', icon: 'chat' }]} value={sub} onChange={setSub} />
      {sub === 'polls' ? <PollAdmin /> : <FeedbackInbox />}
    </div>
  );
}

function PollAdmin() {
  const { toast } = useKit();
  const [polls, setPolls] = useState<Poll[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try { setPolls((await api<{ polls: Poll[] }>('/polls?manage=1')).polls); } catch (reason) { toast(messageOf(reason), 'error'); setPolls([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (reason) { toast(messageOf(reason), 'error'); } };

  return (
    <section className="panel">
      <div className="panel-head"><h2>Polls</h2><button className="button button-primary button-small" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New poll</button></div>
      {polls === null ? <Spinner /> : polls.length === 0 ? <Empty icon="poll" title="No polls yet">Ask something fun, like the next team lunch.</Empty> : (
        <ul className="plain-list">{polls.map((poll) => (
          <li key={poll.id}><div><strong>{poll.question}</strong><small>{poll.total} votes · {poll.options.map((o, i) => `${o} (${poll.counts[i]})`).join(', ')}</small></div>
            <span className={`pill ${poll.open ? 'pill-ok' : 'pill-off'}`}>{poll.open ? 'Open' : 'Closed'}</span>
            {poll.open && <button className="button button-small" onClick={() => void act(() => api(`/admin/polls/${poll.id}/close`, { method: 'POST' }))}>Close</button>}
            <button className="icon-button danger" aria-label="Delete poll" onClick={() => window.confirm('Delete this poll and its votes?') && void act(() => api(`/admin/polls/${poll.id}`, { method: 'DELETE' }))}><Icon name="trash" size={16} /></button></li>
        ))}</ul>
      )}
      {creating && <PollForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void load(); }} />}
    </section>
  );
}

function PollForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [closes, setCloses] = useState('');
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('/admin/polls', { method: 'POST', body: { question, options: options.map((o) => o.trim()).filter(Boolean), closesAt: closes ? new Date(`${closes}T23:59:00+05:30`).toISOString() : undefined } });
      onSaved();
    } catch (reason) { setError(messageOf(reason)); }
  }
  return (
    <Modal title="New poll" onClose={onClose} wide>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Question"><input value={question} onChange={(e) => setQuestion(e.target.value)} required maxLength={160} autoFocus placeholder="Where should we do team lunch?" /></Field>
        <div className="form-stack">{options.map((option, index) => (
          <div key={index} className="link-row"><input value={option} onChange={(e) => setOptions(options.map((o, i) => i === index ? e.target.value : o))} placeholder={`Option ${index + 1}`} maxLength={80} aria-label={`Option ${index + 1}`} />
            {options.length > 2 && <button type="button" className="icon-button danger" aria-label="Remove option" onClick={() => setOptions(options.filter((_, i) => i !== index))}><Icon name="trash" size={15} /></button>}</div>
        ))}{options.length < 6 && <button type="button" className="button button-small" onClick={() => setOptions([...options, ''])}><Icon name="plus" size={15} /> Add option</button>}</div>
        <Field label="Closes (optional)"><input type="date" value={closes} onChange={(e) => setCloses(e.target.value)} /></Field>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary">Publish poll</button></div>
      </form>
    </Modal>
  );
}

function FeedbackInbox() {
  const { toast } = useKit();
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const load = useCallback(async () => {
    try { setItems((await api<{ feedback: FeedbackItem[] }>('/admin/feedback')).feedback); } catch (reason) { toast(messageOf(reason), 'error'); setItems([]); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  const setStatus = async (item: FeedbackItem, status: string) => { try { await api(`/admin/feedback/${item.id}`, { method: 'PATCH', body: { status } }); await load(); } catch (reason) { toast(messageOf(reason), 'error'); } };
  const remove = async (item: FeedbackItem) => { if (!window.confirm('Delete this note?')) return; try { await api(`/admin/feedback/${item.id}`, { method: 'DELETE' }); await load(); } catch (reason) { toast(messageOf(reason), 'error'); } };
  return (
    <section className="panel">
      <h2>Idea box</h2>
      {items === null ? <Spinner /> : items.length === 0 ? <Empty icon="chat" title="The box is empty">Notes from your colleagues will land here.</Empty> : (
        <ul className="feedback-list">{items.map((item) => (
          <li key={item.id} className={`feedback ${item.status}`}>
            <div className="feedback-top"><span className="pill">{item.category}</span><small>{item.from_name ?? 'Anonymous'} · {inIndia(item.created_at, { day: 'numeric', month: 'short' })}</small><span className={`pill ${item.status === 'new' ? 'pill-hot' : item.status === 'done' ? 'pill-ok' : ''}`}>{item.status}</span></div>
            <p>{item.message}</p>
            <div className="modal-actions left">
              {item.status !== 'seen' && <button className="button button-small" onClick={() => void setStatus(item, 'seen')}>Mark seen</button>}
              {item.status !== 'done' && <button className="button button-small" onClick={() => void setStatus(item, 'done')}><Icon name="check" size={14} /> Done</button>}
              <button className="icon-button danger" aria-label="Delete note" onClick={() => void remove(item)}><Icon name="trash" size={15} /></button>
            </div>
          </li>
        ))}</ul>
      )}
    </section>
  );
}
