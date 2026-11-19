import { useMemo, useState } from 'react';
import type { User } from '../../lib/types';
import type { Ctx } from '../App';
import { Icon } from '../kit';
import { ManageLayout } from './ManageLayout';
import { ManageQr } from './ManageQr';
import { ManageBookings } from './ManageBookings';
import { ManageActivity, ManageUsers } from './ManageUsers';
import { ManageDashboard } from './ManageDashboard';
import { ManageContent } from './ManageContent';
import { ManageMenu } from './ManageMenu';
import { nav } from '../../lib/nav';
import { ManageCommunity } from './ManageCommunity';
import { ManageRoles } from './ManageRoles';
import { ManageSettings } from './ManageSettings';
import { ManageIssues } from './ManageIssues';

const holds = (user: User, ...permissions: string[]) => permissions.some((permission) => user.permissions.includes(permission));

/** The Manage tabs a person may open. The Manage entry only shows up when this list is not empty. */
export function manageTabs(user: User): { id: string; label: string; icon: string }[] {
  const isSuper = user.role === 'super_admin';
  return [
    ...(holds(user, 'insights.view') ? [{ id: 'dashboard', label: 'Dashboard', icon: 'chart' }] : []),
    ...(holds(user, 'spaces.manage', 'teams.manage') ? [{ id: 'layout', label: 'Map & teams', icon: 'map' }] : []),
    ...(holds(user, 'content.links', 'content.contacts', 'content.announcements') ? [{ id: 'content', label: 'Content', icon: 'megaphone' }] : []),
    ...(holds(user, 'menu.edit', 'menu.reviews.view') ? [{ id: 'menu', label: 'Food menu', icon: 'utensils' }] : []),
    ...(holds(user, 'community.polls', 'community.ideas') ? [{ id: 'community', label: 'Community', icon: 'heart' }] : []),
    ...(holds(user, 'issues.manage_categories', 'notifications.route', 'issues.export') ? [{ id: 'issues', label: 'Issue box', icon: 'wrench' }] : []),
    ...(holds(user, 'qr.manage') ? [{ id: 'qr', label: 'QR codes', icon: 'qr' }] : []),
    ...(holds(user, 'bookings.view_all') ? [{ id: 'bookings', label: 'Bookings', icon: 'ticket' }] : []),
    ...(holds(user, 'users.view', 'users.create', 'users.edit', 'users.change_roles', 'users.reset_password') ? [{ id: 'people', label: 'People', icon: 'users' }] : []),
    ...(isSuper ? [{ id: 'roles', label: 'Roles', icon: 'shield' }, { id: 'settings', label: 'Settings', icon: 'settings' }] : []),
    ...(holds(user, 'users.audit') ? [{ id: 'activity', label: 'Activity', icon: 'list' }] : []),
  ];
}

export function ManageScreen({ ctx }: { ctx: Ctx }) {
  const isSuper = ctx.user.role === 'super_admin';
  const tabs = useMemo(() => manageTabs(ctx.user), [ctx.user]);
  const [tab, setTab] = useState(() => { const wanted = nav.manageTab; nav.manageTab = ''; return tabs.some((item) => item.id === wanted) ? wanted : tabs[0]?.id ?? 'layout'; });
  const active = tabs.find((item) => item.id === tab) ? tab : tabs[0]?.id;

  return (
    <div>
      <div className="page-head"><div><span className="eyebrow">{isSuper ? 'SUPER ADMIN' : ctx.user.roleName?.toUpperCase() ?? 'ADMIN'}</span><h1>Manage {ctx.config.branding.appName}</h1></div></div>
      <div className="tabs" role="tablist">
        {tabs.map((item) => <button key={item.id} role="tab" aria-selected={active === item.id} className={active === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><Icon name={item.icon} size={17} /> {item.label}</button>)}
      </div>
      {active === 'dashboard' && <ManageDashboard />}
      {active === 'layout' && <ManageLayout ctx={ctx} />}
      {active === 'content' && <ManageContent ctx={ctx} />}
      {active === 'menu' && <ManageMenu ctx={ctx} />}
      {active === 'community' && <ManageCommunity ctx={ctx} />}
      {active === 'issues' && <ManageIssues ctx={ctx} />}
      {active === 'qr' && <ManageQr ctx={ctx} />}
      {active === 'bookings' && <ManageBookings />}
      {active === 'people' && <ManageUsers ctx={ctx} />}
      {active === 'roles' && <ManageRoles ctx={ctx} />}
      {active === 'settings' && <ManageSettings ctx={ctx} />}
      {active === 'activity' && <ManageActivity />}
    </div>
  );
}
