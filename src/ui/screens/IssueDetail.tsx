import { useCallback, useEffect, useState } from 'react';
import type { IssueDetail, IssuePriority } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { ago, describeUpdate, isOpen, PRIORITY_LABEL, STATUS_LABEL } from '../../lib/issues';
import { inIndia } from '../../lib/format';
import type { Ctx } from '../App';
import { Avatar, Empty, Icon, Spinner, useKit } from '../kit';

type Detail = IssueDetail & { released?: boolean };

// One issue: what was reported, the timeline, and the right buttons for who is looking (reporter, worker, assigner).
export function IssueDetailView({ ctx, id, onBack, onChanged }: { ctx: Ctx; id: string; onBack: () => void; onChanged: () => void }) {
  const { toast } = useKit();
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(false);

  const load = useCallback(async () => {
    try { setDetail(await api<IssueDetail>(`/issues/${id}`)); } catch (reason) { setMissing(true); toast(messageOf(reason), 'error'); }
  }, [id, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (detail?.can.assign) void api<{ people: { id: string; name: string }[] }>('/issues/assignees').then((result) => setPeople(result.people)).catch(() => {});
  }, [detail?.can.assign]);

  async function run(task: () => Promise<Detail>, message?: string) {
    setBusy(true);
    try {
      const next = await task();
      if (next.released) { onChanged(); onBack(); return; }
      setDetail(next); setNote(''); onChanged();
      if (message) toast(message, 'success');
    } catch (reason) { toast(messageOf(reason), 'error'); void load(); } finally { setBusy(false); }
  }
  const patch = (body: Record<string, unknown>, message?: string) => run(() => api<Detail>(`/issues/${id}`, { method: 'PATCH', body: { ...body, note: note.trim() || undefined } }), message);
  const post = (path: string, body: Record<string, unknown>, message?: string) => run(() => api<Detail>(`/issues/${id}/${path}`, { method: 'POST', body }), message);

  if (missing) return <div><button className="text-link" onClick={onBack}><Icon name="back" size={16} /> Back</button><Empty icon="search" title="This issue is not available">It may have been removed, or it belongs to someone else.</Empty></div>;
  if (!detail) return <Spinner />;
  const { issue, updates, can } = detail;
  const nameOf = (userId: string | null) => (userId === ctx.user.id ? 'you' : people.find((person) => person.id === userId)?.name ?? (userId && userId === issue.assigneeId ? issue.assigneeName : null) ?? 'someone');
  const open = isOpen(issue.status);
  const iAmAssignee = issue.assigneeId === ctx.user.id;
  const staff = can.work || can.assign;

  return (
    <div className="iss iss-detail">
      <button className="text-link iss-back" onClick={onBack}><Icon name="back" size={16} /> Back</button>
      <section className="panel">
        <div className="iss-detail-head">
          <span className="iss-emoji big" aria-hidden="true">{issue.categoryEmoji}</span>
          <div>
            <span className="eyebrow">ISSUE #{issue.number}</span>
            <h1>{issue.title}</h1>
            <div className="iss-badges inline">
              <span className={`pill st-${issue.status}`}>{STATUS_LABEL[issue.status]}</span>
              <span className={`pill pr-${issue.priority}`}>{PRIORITY_LABEL[issue.priority]}</span>
              {issue.overdue && <span className="pill pill-off">Overdue</span>}
              {issue.plusOnes > 1 && <span className="pill">{issue.plusOnes} people affected</span>}
            </div>
          </div>
        </div>
        <dl className="facts iss-facts">
          <div><dt>Category</dt><dd>{issue.categoryEmoji} {issue.categoryName}</dd></div>
          {issue.locationText && <div><dt>Where</dt><dd>{issue.locationText}</dd></div>}
          <div><dt>Reported</dt><dd>{inIndia(issue.createdAt, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} ({ago(issue.createdAt)}){issue.reporterName && !issue.mine ? ` by ${issue.reporterName}` : ''}</dd></div>
          <div><dt>Assigned to</dt><dd>{issue.assigneeName ?? (open ? 'Nobody yet' : '—')}</dd></div>
        </dl>
        {issue.description && issue.description !== issue.title && <p className="iss-description">{issue.description}</p>}
        {issue.photoVersion && (
          <button className="iss-photo-thumb" onClick={() => setZoom(true)} aria-label="Open the photo"><img src={`/api/issues/${issue.id}/photo?v=${issue.photoVersion}`} alt="Photo of the problem" loading="lazy" /></button>
        )}
        {can.reopen && (
          <div className="iss-reopen"><span>Is it still not fixed?</span><button className="button button-danger-soft" disabled={busy} onClick={() => void post('reopen', {}, 'Reopened. We will take another look.')}><Icon name="alert" size={16} /> Still not fixed</button></div>
        )}
      </section>

      {staff && (
        <section className="panel iss-work">
          <h2>{can.work ? 'Work on it' : 'Assign'}</h2>
          {can.work && (
            <>
              <label className="field"><span>Note for the reporter (optional)</span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="e.g. Part ordered, back tomorrow" /></label>
              <div className="iss-actions">
                {issue.status !== 'in_progress' && issue.status !== 'resolved' && issue.status !== 'closed' && <button className="button iss-big" disabled={busy} onClick={() => void patch({ status: 'in_progress' }, 'Started.')}><Icon name="wrench" size={20} /> Start</button>}
                {open && issue.status !== 'waiting' && <button className="button iss-big" disabled={busy} onClick={() => void patch({ status: 'waiting' })}><Icon name="clock" size={20} /> Waiting</button>}
                {open && <button className="button button-primary iss-big" disabled={busy} onClick={() => void patch({ status: 'resolved' }, 'Marked as fixed.')}><Icon name="check" size={20} /> Fixed</button>}
                {issue.status === 'resolved' && <button className="button iss-big" disabled={busy} onClick={() => void patch({ status: 'closed' })}>Close</button>}
                {!open && <button className="button iss-big" disabled={busy} onClick={() => void patch({ status: 'in_progress' }, 'Reopened.')}>Reopen</button>}
                {(iAmAssignee || can.work) && open && <button className="button iss-big" disabled={busy} onClick={() => void post('help', { note: note.trim() || undefined }, 'The managers have been asked to help.')}><Icon name="alert" size={20} /> Need help</button>}
              </div>
              <div className="form-grid iss-selects">
                <label className="field"><span>Priority</span>
                  <select value={issue.priority} disabled={busy} onChange={(event) => void patch({ priority: event.target.value as IssuePriority })}>{(['low', 'normal', 'high', 'urgent'] as IssuePriority[]).map((level) => <option key={level} value={level}>{PRIORITY_LABEL[level]}</option>)}</select>
                </label>
                {can.assign ? (
                  <label className="field"><span>Assigned to</span>
                    <select value={issue.assigneeId ?? ''} disabled={busy} onChange={(event) => void patch({ assigneeId: event.target.value || null }, event.target.value ? 'Assigned.' : 'Unassigned.')}>
                      <option value="">Nobody</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                    </select>
                  </label>
                ) : !iAmAssignee && (
                  <div className="field"><span>Assigned to</span><button className="button" disabled={busy} onClick={() => void patch({ assigneeId: ctx.user.id }, 'It is yours.')}>Take it</button></div>
                )}
              </div>
            </>
          )}
          {!can.work && can.assign && (
            <label className="field"><span>Assigned to</span>
              <select value={issue.assigneeId ?? ''} disabled={busy} onChange={(event) => void patch({ assigneeId: event.target.value || null }, 'Assigned.')}>
                <option value="">Nobody</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
            </label>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Timeline</h2>
        <ol className="iss-timeline">
          <li className="tl-start"><span className="tl-dot" /><div><strong>{issue.mine ? 'You' : issue.reporterName ?? 'Someone'} reported it</strong><small>{ago(issue.createdAt)}</small></div></li>
          {updates.map((update) => (
            <li key={update.id} className={`${update.internal ? 'tl-internal' : ''} tl-${update.kind}`}>
              <span className="tl-dot" />
              <div>
                <strong>{update.authorId === ctx.user.id ? 'You' : update.authorName ?? 'The team'} {describeUpdate(update, nameOf)}{update.internal && <span className="pill tl-lock"><Icon name="lock" size={11} /> Staff only</span>}</strong>
                {update.body && update.kind !== 'help' && <p>{update.body}</p>}
                {update.body && update.kind === 'help' && <p>{update.body}</p>}
                <small>{ago(update.createdAt)}</small>
              </div>
            </li>
          ))}
        </ol>
        {can.comment && (
          <form className="iss-comment" onSubmit={(event) => { event.preventDefault(); const text = comment.trim(); if (!text) return; void run(async () => { const next = await api<Detail>(`/issues/${id}/comments`, { method: 'POST', body: { body: text, internal } }); setComment(''); return next; }); }}>
            <div className="input-with-button">
              <input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} placeholder={internal ? 'Staff note (only staff can read it)' : 'Add a comment or follow-up'} aria-label="Comment" />
              <button className="button button-primary" disabled={busy || !comment.trim()}>Post</button>
            </div>
            {can.internalNote && <label className="check"><input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} /><span>Staff note: only people working on issues can read it</span></label>}
          </form>
        )}
      </section>
      {zoom && issue.photoVersion && (
        <div className="iss-lightbox" role="dialog" aria-modal="true" aria-label="Photo" onClick={() => setZoom(false)}><img src={`/api/issues/${issue.id}/photo?v=${issue.photoVersion}`} alt="Photo of the problem" /><button className="icon-button" aria-label="Close photo"><Icon name="x" /></button></div>
      )}
      {!staff && issue.assigneeName && <p className="muted small-print"><Avatar name={issue.assigneeName} size={22} /> {issue.assigneeName} is looking after this.</p>}
    </div>
  );
}
