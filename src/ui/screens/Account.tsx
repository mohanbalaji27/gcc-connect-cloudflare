import { useState } from 'react';
import { AVATARS, type User } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { getMode, setMode, type ThemeMode } from '../../lib/theme';
import { summarize } from '../../lib/permissions';
import type { Ctx } from '../App';
import { Avatar, Field, Icon, Switch, useKit } from '../kit';
import { NotificationPrefs } from './NotificationPrefs';

interface Props { ctx?: Ctx; user?: User; forced?: boolean; minLength?: number; onChanged: () => void; onSignOut: () => void }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function AccountScreen({ ctx, user: userProp, forced = false, minLength: forcedMin, onChanged, onSignOut }: Props) {
  const { toast, celebrate } = useKit();
  const user = (ctx?.user ?? userProp) as User;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setModeState] = useState<ThemeMode>(getMode());
  const minLength = Number(ctx?.config.settings['security.passwordMinLength'] ?? forcedMin ?? 10);
  const [month, setMonth] = useState(user.birthMonth ?? 0);
  const [day, setDay] = useState(user.birthDay ?? 0);

  async function saveProfile(body: Record<string, unknown>, message: string) {
    try {
      const result = await api<{ user: User }>('/me/profile', { method: 'PATCH', body });
      ctx?.updateUser(result.user);
      toast(message, 'success');
    } catch (reason) { toast(messageOf(reason), 'error'); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (next.length < minLength) return setError(`Use at least ${minLength} characters.`);
    if (next !== confirm) return setError('The new passwords don’t match.');
    setBusy(true);
    try {
      await api('/me/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent(''); setNext(''); setConfirm('');
      onChanged();
    } catch (reason) {
      setError(messageOf(reason));
    } finally { setBusy(false); }
  }

  const form = (
    <form className="panel account-form" onSubmit={submit}>
      {forced && <div className="banner banner-fun"><Icon name="key" size={18} /> Welcome, {user.name.split(' ')[0]}! Pick a new password to continue.</div>}
      <h2>{forced ? 'Set your password' : 'Change password'}</h2>
      <Field label="Current password"><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
      <Field label="New password" hint={`At least ${minLength} characters.`}><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={minLength} /></Field>
      <Field label="Repeat new password"><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Update password'}</button>
    </form>
  );

  if (forced || !ctx) return <div className="login"><div className="login-card wide">{form}<button className="text-link" onClick={onSignOut}>Sign out</button></div></div>;

  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(month || 1) - 1];

  return (
    <div>
      <div className="page-head"><div><span className="eyebrow">ME</span><h1>{user.name}</h1></div></div>
      <div className="two-col">
        <section className="panel form-stack">
          <h2>Make it yours</h2>
          <div>
            <strong className="mini-label">Your avatar</strong>
            <div className="avatar-grid">
              <button className={`avatar-pick ${!user.avatar ? 'on' : ''}`} onClick={() => void saveProfile({ avatar: '' }, 'Back to initials.')} aria-label="Use my initials"><Avatar name={user.name} size={42} /></button>
              {AVATARS.map((emoji) => <button key={emoji} className={`avatar-pick ${user.avatar === emoji ? 'on' : ''}`} onClick={() => { void saveProfile({ avatar: emoji }, `${emoji} looks great on you.`); celebrate(); }} aria-label={`Use ${emoji}`}><Avatar name={user.name} emoji={emoji} size={42} /></button>)}
            </div>
          </div>
          <div>
            <strong className="mini-label">Look and feel</strong>
            <div className="segmented">
              {([['auto', 'Auto', 'sun'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']] as [ThemeMode, string, string][]).map(([id, label, icon]) => (
                <button key={id} className={mode === id ? 'active' : ''} onClick={() => { setMode(id); setModeState(id); }}><Icon name={icon} size={16} /> {label}</button>
              ))}
            </div>
            <small className="muted">Colours are chosen for everyone by the app owner. You pick light, dark or follow your device.</small>
          </div>
          {ctx.flag('celebrations') && (
            <div>
              <strong className="mini-label">Birthday (optional, shows on the celebrations list)</strong>
              <div className="two">
                <select value={month} onChange={(e) => { setMonth(Number(e.target.value)); setDay(0); }} aria-label="Birth month"><option value={0}>Month</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
                <select value={day} onChange={(e) => setDay(Number(e.target.value))} aria-label="Birth day"><option value={0}>Day</option>{Array.from({ length: maxDay }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select>
              </div>
              <div className="modal-actions left">
                <button className="button button-small" disabled={!month || !day} onClick={() => void saveProfile({ birthMonth: month, birthDay: day }, 'Birthday saved. Cake incoming 🎂')}>Save birthday</button>
                {user.birthMonth && <button className="button button-small" onClick={() => { setMonth(0); setDay(0); void saveProfile({ birthMonth: null, birthDay: null }, 'Birthday removed.'); }}>Remove</button>}
              </div>
            </div>
          )}
          {ctx.flag('whosin') && (
            <div className="switch-row"><div><strong>Show me in “Who&apos;s in today”</strong><small>Colleagues can see you booked a desk. Turn off to stay private.</small></div>
              <Switch checked={user.showInWhosin} label="Show me in who is in today" onChange={(value) => void saveProfile({ showInWhosin: value }, value ? 'You are visible in Who\'s in.' : 'You are hidden from Who\'s in.')} /></div>
          )}
        </section>
        <div className="form-stack">
          <section className="panel">
            <h2>Your profile</h2>
            <dl className="facts">
              <div><dt>{user.email ? 'Email' : 'Username'}</dt><dd>{user.email || user.username || '—'}</dd></div>
              {user.email && user.username && <div><dt>Username</dt><dd>{user.username}</dd></div>}
              <div><dt>Team</dt><dd>{user.team || '—'}</dd></div>
              <div><dt>Role</dt><dd>{user.role === 'super_admin' ? 'Super admin' : user.roleName ?? (user.role === 'admin' ? 'Admin' : 'Employee')}</dd></div>
              {user.permissions.length > 0 && <div><dt>Can</dt><dd>{user.role === 'super_admin' ? 'Everything' : summarize(ctx.config.permissionCatalog, user.permissions).map((line) => line.group).join(', ')}</dd></div>}
            </dl>
            <button className="button" onClick={onSignOut}><Icon name="logout" size={18} /> Sign out</button>
          </section>
          <NotificationPrefs ctx={ctx} />
          {form}
        </div>
      </div>
    </div>
  );
}
