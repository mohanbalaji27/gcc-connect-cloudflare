import type { Ctx, NavItem, Screen } from '../App';
import { Avatar, Icon } from '../kit';

const BLURB: Partial<Record<Screen, string>> = {
  bookings: 'Your upcoming desks and rooms', events: 'Whats on, RSVPs and links', menu: 'Today and the week ahead', community: 'Kudos, polls, birthdays and ideas', issues: 'Coffee machine, tap, lights: tell us fast',
  useful: 'Guides, portals and important contacts', scan: 'Found a QR on a desk? Tap here', manage: 'Dashboard, content, people and settings',
};
const TONES = ['green', 'lilac', 'orange', 'blue', 'pink', 'teal', 'green', 'lilac'];

export function MoreScreen({ ctx, items, onSignOut }: { ctx: Ctx; items: NavItem[]; onSignOut: () => void }) {
  return (
    <div>
      <div className="page-head"><div><span className="eyebrow">EVERYTHING ELSE</span><h1>More fun stuff</h1></div></div>
      <div className="more-grid">
        {items.map(([id, label, icon], index) => (
          <button key={id} className="more-tile" onClick={() => ctx.go(id)} style={{ animationDelay: `${index * 40}ms` }}>
            <span className={`quick-icon ${TONES[index % TONES.length]}`}><Icon name={icon} size={24} /></span>
            <strong>{label}</strong>
            <small>{BLURB[id] ?? ''}</small>
          </button>
        ))}
        <button className="more-tile" onClick={() => ctx.go('account')}>
          <span className="more-avatar"><Avatar name={ctx.user.name} emoji={ctx.user.avatar} size={46} /></span>
          <strong>Me and settings</strong><small>Avatar, theme, birthday, password</small>
        </button>
        <button className="more-tile subtle" onClick={onSignOut}>
          <span className="quick-icon orange"><Icon name="logout" size={24} /></span><strong>Sign out</strong><small>See you soon</small>
        </button>
      </div>
    </div>
  );
}
