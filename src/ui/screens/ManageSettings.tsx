import { useState } from 'react';
import type { Branding, FeatureKey } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import type { Ctx } from '../App';
import { Field, Switch, useKit } from '../kit';

const ACCENT_LABELS: Record<string, string> = { green: 'Forest', ocean: 'Ocean', sunset: 'Sunset', berry: 'Berry', mono: 'Ink' };

export function ManageSettings({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const [features, setFeatures] = useState(ctx.config.features);
  const [branding, setBranding] = useState<Branding>(ctx.config.branding);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api('/admin/settings', { method: 'PUT', body: { features, branding } });
      await ctx.reloadConfig();
      toast('Settings saved. Everyone will see the changes on their next refresh.', 'success');
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="two-col">
      <section className="panel form-stack">
        <h2>Features</h2>
        <p className="muted">Turn parts of the app on or off for everyone. Content stays saved while a feature is off.</p>
        <ul className="switch-list">
          {(Object.keys(ctx.config.featureCatalog) as FeatureKey[]).map((key) => (
            <li key={key}><div><strong>{ctx.config.featureCatalog[key]}</strong></div><Switch checked={features[key]} label={ctx.config.featureCatalog[key]} onChange={(value) => setFeatures({ ...features, [key]: value })} /></li>
          ))}
        </ul>
      </section>
      <section className="panel form-stack">
        <h2>Look and voice</h2>
        <Field label="App name"><input value={branding.appName} onChange={(e) => setBranding({ ...branding, appName: e.target.value })} maxLength={40} required /></Field>
        <Field label="Tagline" hint="A comma splits it into two lines on the sign-in page."><input value={branding.tagline} onChange={(e) => setBranding({ ...branding, tagline: e.target.value })} maxLength={80} /></Field>
        <Field label="Welcome note" hint="Shown on the home hero and the sign-in page."><textarea rows={2} value={branding.welcome} onChange={(e) => setBranding({ ...branding, welcome: e.target.value })} maxLength={200} /></Field>
        <div>
          <strong className="mini-label">Default colour theme</strong>
          <div className="accent-row" role="group" aria-label="Default colour theme">
            {ctx.config.accents.map((id) => <button type="button" key={id} className={`accent-swatch ${branding.accent === id ? 'on' : ''}`} data-accent={id} aria-label={ACCENT_LABELS[id] ?? id} title={ACCENT_LABELS[id] ?? id} onClick={() => setBranding({ ...branding, accent: id })}><i /></button>)}
          </div>
          <small className="muted">People can still pick their own colours in Me and settings.</small>
        </div>
        <button className="button button-primary" disabled={busy || !branding.appName.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button>
      </section>
    </div>
  );
}
