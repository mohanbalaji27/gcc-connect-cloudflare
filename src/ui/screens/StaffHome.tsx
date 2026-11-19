import { useCallback, useEffect, useState } from 'react';
import type { Issue, IssueCounts } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { ago, PRIORITY_LABEL } from '../../lib/issues';
import type { Ctx } from '../App';
import { Empty, Icon, Spinner, useKit } from '../kit';
import '../issues.css';

// The simple big-button home for hands-on teams: tasks first, big buttons, nothing else to learn.
export function StaffHome({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const canQueue = ctx.user.permissions.includes('issues.view_all');
  const canWork = ctx.user.permissions.includes('issues.update');
  const [tasks, setTasks] = useState<Issue[] | null>(null);
  const [counts, setCounts] = useState<IssueCounts | null>(null);
  const [waiting, setWaiting] = useState<Issue[]>([]);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const mine = await api<{ issues: Issue[]; counts?: IssueCounts }>('/issues?scope=assigned');
      setTasks(mine.issues); if (mine.counts) setCounts(mine.counts);
      if (canQueue) setWaiting((await api<{ issues: Issue[]; counts?: IssueCounts }>('/issues?scope=all&status=open&assignee=none&sort=priority&limit=8')).issues);
    } catch (reason) { toast(messageOf(reason), 'error'); setTasks((current) => current ?? []); }
  }, [canQueue, toast]);
  useEffect(() => { void load(); }, [load]);

  async function act(issue: Issue, what: 'start' | 'done' | 'help' | 'take') {
    setBusy(issue.id);
    try {
      if (what === 'help') await api(`/issues/${issue.id}/help`, { method: 'POST', body: {} });
      else if (what === 'take') await api(`/issues/${issue.id}`, { method: 'PATCH', body: { assigneeId: ctx.user.id, status: 'in_progress' } });
      else await api(`/issues/${issue.id}`, { method: 'PATCH', body: { status: what === 'start' ? 'in_progress' : 'resolved' } });
      toast(what === 'done' ? 'Great, marked as fixed.' : what === 'help' ? 'The managers have been told.' : what === 'take' ? 'It is yours.' : 'Started.', 'success');
      await load();
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(''); }
  }

  const first = ctx.user.name.split(' ')[0];
  const flag = ctx.flag;
  return (
    <div className="staff-home">
      <div className="staff-hello"><span className="eyebrow">TODAY</span><h1>Hi {first} <span aria-hidden="true">👋</span></h1></div>
      <div className="staff-big">
        {canWork && <button className="staff-btn primary" onClick={() => ctx.go('issues')}><span className="quick-icon green"><Icon name="tasks" size={28} /></span><span>My tasks<small>{counts ? `${counts.mine} open` : 'Open your list'}</small></span>{counts && counts.mine > 0 && <span className="count">{counts.mine}</span>}</button>}
        {canQueue && <button className="staff-btn" onClick={() => ctx.go('issues')}><span className="quick-icon orange"><Icon name="inbox" size={28} /></span><span>Unassigned<small>Pick one up</small></span>{counts && counts.unassigned > 0 && <span className="count">{counts.unassigned}</span>}</button>}
        <button className="staff-btn" onClick={() => ctx.go('issues')}><span className="quick-icon lilac"><Icon name="wrench" size={28} /></span><span>Report a problem<small>Found something broken?</small></span></button>
        <button className="staff-btn" onClick={() => ctx.go('scan')}><span className="quick-icon blue"><Icon name="scan" size={28} /></span><span>Scan a QR<small>Open or report from a sticker</small></span></button>
        {(flag('contacts') || flag('links')) && <button className="staff-btn" onClick={() => ctx.go('useful')}><span className="quick-icon teal"><Icon name="phone" size={28} /></span><span>Contacts<small>Who to call</small></span></button>}
        {flag('menu') && <button className="staff-btn" onClick={() => ctx.go('menu')}><span className="quick-icon pink"><Icon name="utensils" size={28} /></span><span>Food menu<small>Today’s meals</small></span></button>}
      </div>

      {canWork && (
        <section className="staff-section">
          <h2>My tasks</h2>
          {tasks === null ? <Spinner /> : tasks.length === 0 ? <Empty icon="check" title="Nothing on your plate">New tasks show up here and in your notifications.</Empty> : (
            <div className="staff-tasks">{tasks.map((task) => (
              <article key={task.id} className={`task-card ${task.priority === 'urgent' ? 'urgent' : ''}`}>
                <button className="task-head" onClick={() => ctx.openIssue(task.id)}>
                  <span className="iss-emoji big" aria-hidden="true">{task.categoryEmoji}</span>
                  <span><strong>#{task.number} · {task.title}</strong><small>{[task.locationText, PRIORITY_LABEL[task.priority] + (task.priority === 'normal' ? '' : ' priority'), ago(task.createdAt)].filter(Boolean).join(' · ')}</small></span>
                </button>
                <div className="task-actions">
                  <button className="button" disabled={busy === task.id || task.status === 'in_progress'} onClick={() => void act(task, 'start')}><Icon name="wrench" size={20} /> {task.status === 'in_progress' ? 'Started' : 'Start'}</button>
                  <button className="button button-primary" disabled={busy === task.id} onClick={() => void act(task, 'done')}><Icon name="check" size={20} /> Done</button>
                  <button className="button button-danger-soft" disabled={busy === task.id} onClick={() => void act(task, 'help')}><Icon name="alert" size={20} /> Need help</button>
                </div>
              </article>
            ))}</div>
          )}
        </section>
      )}

      {canQueue && waiting.length > 0 && (
        <section className="staff-section">
          <h2>Waiting for someone</h2>
          <div className="staff-tasks">{waiting.map((task) => (
            <article key={task.id} className={`task-card ${task.priority === 'urgent' ? 'urgent' : ''}`}>
              <button className="task-head" onClick={() => ctx.openIssue(task.id)}>
                <span className="iss-emoji big" aria-hidden="true">{task.categoryEmoji}</span>
                <span><strong>#{task.number} · {task.title}</strong><small>{[task.locationText, PRIORITY_LABEL[task.priority], ago(task.createdAt)].filter(Boolean).join(' · ')}</small></span>
              </button>
              {canWork && <button className="button button-primary iss-big" disabled={busy === task.id} onClick={() => void act(task, 'take')}><Icon name="check" size={20} /> I will take it</button>}
            </article>
          ))}</div>
        </section>
      )}
    </div>
  );
}
