import { useState } from 'react';
import type { Branding, FeatureKey, OptionKey } from '../../lib/types';
import type { ReviewVisibility } from '../../lib/menuCatalog';
import { api, messageOf } from '../../lib/api';
import type { Ctx } from '../App';
import { Field, Switch, useKit } from '../kit';

const ACCENT_LABELS: Record<string, string> = { green: 'Forest', ocean: 'Ocean', sunset: 'Sunset', berry: 'Berry', mono: 'Ink' };
const OPTION_HINTS: Partial<Record<OptionKey, string>> = {
  showBookerNames: 'Off by default: people only see that a seat is booked and for when. Managers who can see bookings always see names.',
  eventsRsvpEnabled: 'Turn off to hide the “I’m going” button and the going counts on events.',
  issuePhotosEnabled: 'On by default. People can attach one small photo (shrunk in their browser to about 200 KB) to a problem report. Turn off to stop accepting photos.',
  homeContacts: 'Home shows the contacts marked “Show on Home” (Manage → Content → Contacts). If none are marked, it shows the first emergency contacts. Needs the Important contacts feature to be on.',
  usageAnalytics: 'On by default. Counts how often each screen is opened and how many people sign in each day, to show on the Usage dashboard. See exactly what is collected below. Turning it off stops counting straight away.',
};
const FEATURE_HINTS: Partial<Record<FeatureKey, string>> = {
  issues: 'Report a problem: tiles for the coffee machine, washrooms, lights and more. Managers choose categories and who is notified under Manage → Issue box.',
  feedback: 'The Idea box is only for ideas and suggestions. Broken things go to the issue box.',
  kudos: 'Optional. Off for new installs; existing installs keep what they had.',
  menu: 'The menu card, the quick day editor for the food team, dish likes and meal reviews. Menus and reviews stay saved while it is off. The settings for it are further down.',
};
const VISIBILITY_CHOICES: { id: ReviewVisibility; label: string; hint: string }[] = [
  { id: 'everyone', label: 'Everyone sees everything', hint: 'Average stars and written comments are public to all signed-in people, with the writer’s name unless they chose to post anonymously.' },
  { id: 'summary', label: 'Everyone sees the average, the food team reads comments', hint: 'Default. People see the average stars and how many reviews there are. Comments and names go to the food team only. Each person still sees their own review.' },
  { id: 'managers', label: 'Only the food team sees reviews', hint: 'Nothing is shown to other employees, not even the average. People only see their own review. “Food team” means anyone with the Manage the food menu or Read food menu reviews permission.' },
];

export function ManageSettings({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const [features, setFeatures] = useState(ctx.config.features);
  const [branding, setBranding] = useState<Branding>(ctx.config.branding);
  const [options, setOptions] = useState(ctx.config.options);
  const [visibility, setVisibility] = useState<ReviewVisibility>(ctx.config.menuReviewsVisibility);
  const [historyDays, setHistoryDays] = useState(String(ctx.config.menuHistoryDays));
  const [retentionDays, setRetentionDays] = useState(String(ctx.config.usageRetentionDays));
  const [homeCount, setHomeCount] = useState(String(ctx.config.homeContactsCount));
  const [busy, setBusy] = useState(false);
  const historyValid = /^\d+$/.test(historyDays) && Number(historyDays) >= 1 && Number(historyDays) <= 90;
  const retentionValid = /^\d+$/.test(retentionDays) && Number(retentionDays) >= 30 && Number(retentionDays) <= 1095;
  const homeCountValid = /^\d+$/.test(homeCount) && Number(homeCount) >= 1 && Number(homeCount) <= 6;

  async function save() {
    setBusy(true);
    try {
      await api('/admin/settings', { method: 'PUT', body: { features, branding, options, menuReviewsVisibility: visibility, menuHistoryDays: Number(historyDays), usageRetentionDays: Number(retentionDays), homeContactsCount: Number(homeCount) } });
      // Your own screen updates right now; everyone else's picks the change up within a few minutes (see pulse).
      await ctx.reloadConfig();
      toast('Saved. It is live for you now, and reaches everyone else within a few minutes, or as soon as they return to the app.', 'success');
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="two-col">
      <section className="panel form-stack">
        <h2>Features</h2>
        <p className="muted">Turn parts of the app on or off for everyone. Content stays saved while a feature is off. Changes reach other people within a few minutes, or as soon as they come back to the app.</p>
        <ul className="switch-list">
          {(Object.keys(ctx.config.featureCatalog) as FeatureKey[]).map((key) => (
            <li key={key}><div><strong>{ctx.config.featureCatalog[key]}</strong>{FEATURE_HINTS[key] && <small>{FEATURE_HINTS[key]}</small>}</div><Switch checked={features[key]} label={ctx.config.featureCatalog[key]} onChange={(value) => setFeatures({ ...features, [key]: value })} /></li>
          ))}
        </ul>
        <h2>Food menu</h2>
        <fieldset className="settings-choice">
          <legend><strong>Who can read menu reviews</strong></legend>
          {VISIBILITY_CHOICES.map((choice) => (
            <label key={choice.id} className={visibility === choice.id ? 'on' : ''}>
              <input type="radio" name="menu-visibility" checked={visibility === choice.id} onChange={() => setVisibility(choice.id)} />
              <span><strong>{choice.label}</strong><small>{choice.hint}</small></span>
            </label>
          ))}
        </fieldset>
        <Field label="Days of menu history to keep" hint="1 to 90. Menus and their reviews older than this are removed automatically (once a day). Seven keeps the last week visible on the menu card.">
          <input type="number" inputMode="numeric" min={1} max={90} value={historyDays} onChange={(event) => setHistoryDays(event.target.value)} aria-invalid={!historyValid} />
        </Field>
        {!historyValid && <small className="field-error" role="alert">Enter a whole number from 1 to 90.</small>}
        <h2>Options</h2>
        <ul className="switch-list">
          {(Object.keys(ctx.config.optionCatalog) as OptionKey[]).map((key) => (
            <li key={key}><div><strong>{ctx.config.optionCatalog[key]}</strong>{OPTION_HINTS[key] && <small>{OPTION_HINTS[key]}</small>}</div><Switch checked={options[key]} label={ctx.config.optionCatalog[key]} onChange={(value) => setOptions({ ...options, [key]: value })} /></li>
          ))}
        </ul>
        <Field label="Contacts shown on Home" hint="1 to 6. How many Important contacts the Home card shows (only when the Home contacts option above is on).">
          <input type="number" inputMode="numeric" min={1} max={6} value={homeCount} onChange={(event) => setHomeCount(event.target.value)} aria-invalid={!homeCountValid} />
        </Field>
        {!homeCountValid && <small className="field-error" role="alert">Enter a whole number from 1 to 6.</small>}
        <h2>Usage analytics and privacy</h2>
        <div className="privacy-note" role="note">
          <strong>What is collected, exactly</strong>
          <ul>
            <li><b>Screen opens:</b> for each person, each day, how many times a screen or tab was opened (Home, Book, Events, Menu, Links, and so on). A total per day, never a list of clicks.</li>
            <li><b>Sign-ins:</b> who signed in and when, kept in the sign-in history (always on; it is part of the security log).</li>
            <li><b>Busiest hours:</b> opens per hour with nobody attached.</li>
            <li><b>Never collected:</b> what anyone typed or read, what they booked or searched, IP addresses, devices or locations.</li>
            <li>The dashboard only shows totals. Teams with fewer than three people are grouped so nobody can be singled out.</li>
          </ul>
        </div>
        <Field label="Days to keep usage data" hint="30 to 1095 (400 by default). Older usage counts and sign-in history are removed automatically, once a day.">
          <input type="number" inputMode="numeric" min={30} max={1095} value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} aria-invalid={!retentionValid} />
        </Field>
        {!retentionValid && <small className="field-error" role="alert">Enter a whole number from 30 to 1095.</small>}
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
        <button className="button button-primary" disabled={busy || !branding.appName.trim() || !historyValid || !retentionValid || !homeCountValid} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button>
      </section>
    </div>
  );
}
