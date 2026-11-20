import { useState, type FormEvent } from 'react';
import type { Branding, LoginConfig, LogoMeta, User } from '../lib/types';
import { api, messageOf, setCsrf } from '../lib/api';
import { LoginView, type LoginFormState } from './Brand';

const DEMO_ACCOUNTS: [string, string][] = [['Employee', 'ava@demo.gcc'], ['Admin', 'noah@demo.gcc'], ['Super admin', 'root@demo.gcc'], ['Facility manager', 'meera@demo.gcc'], ['Facility staff', 'ravi@demo.gcc'], ['Staff (employee ID)', 'emp-1001']];

export function LoginScreen({ branding, login, logo, onSignedIn }: { branding: Branding; login: LoginConfig; logo: LogoMeta; onSignedIn: (user: User) => void }) {
  const [state, setState] = useState<LoginFormState>({ login: '', password: '', busy: false, error: '' });
  const demo = import.meta.env.DEV;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (state.busy) return;
    setState((current) => ({ ...current, busy: true, error: '' }));
    try {
      const result = await api<{ user: User; csrfToken: string }>('/login', { method: 'POST', body: { login: state.login.trim(), password: state.password } });
      setCsrf(result.csrfToken);
      onSignedIn(result.user);
    } catch (reason) {
      // The typed email stays; only the password box is cleared, so a typo is quick to fix.
      setState((current) => ({ ...current, busy: false, error: messageOf(reason), password: '' }));
    }
  }

  return (
    <LoginView
      branding={branding} login={login} logo={logo} state={state} onSubmit={submit}
      onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
      demo={demo ? (
        <div className="demo-box">
          <strong>Local demo accounts</strong>
          <div className="demo-row">
            {DEMO_ACCOUNTS.map(([label, account]) => <button type="button" key={account} className="chip" onClick={() => setState((current) => ({ ...current, login: account, password: 'gccdemo' }))}>{label}</button>)}
          </div>
          <small>Password for all of them: <code>gccdemo</code></small>
        </div>
      ) : null}
    />
  );
}
