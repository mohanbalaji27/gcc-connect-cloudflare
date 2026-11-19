import { useMemo, useState } from 'react';
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

export function ManageScreen({ ctx }: { ctx: Ctx }) {
  const has = (permission: string) => ctx.user.permissions.includes(permission as never);
  const isSuper = ctx.user.role === 'super_admin';
  const tabs = useMemo(() => [
    ...(has('insights.view') ? [{ id: 'dashboard', label: 'Dashboard', icon: 'chart' }] : []),
    ...(has('spaces.manage') || has('teams.manage') ? [{ id: 'layout', label: 'Map & teams', icon: 'map' }] : []),
    ...(has('content.manage') ? [{ id: 'content', label: 'Content', icon: 'megaphone' }] : []),
    ...(has('menu.manage') || has('menu.reviews.view') ? [{ id: 'menu', label: 'Food menu', icon: 'utensils' }] : []),
    ...(has('community.manage') ? [{ id: 'community', label: 'Community', icon: 'heart' }] : []),
    ...(has('qr.manage') ? [{ id: 'qr', label: 'QR codes', icon: 'qr' }] : []),
    ...(has('bookings.manage') ? [{ id: 'bookings', label: 'Bookings', icon: 'ticket' }] : []),
    ...(has('users.manage') ? [{ id: 'people', label: 'People', icon: 'users' }] : []),
    ...(isSuper ? [{ id: 'roles', label: 'Roles', icon: 'shield' }, { id: 'settings', label: 'Settings', icon: 'settings' }] : []),
    ...(has('users.manage') ? [{ id: 'activity', label: 'Activity', icon: 'list' }] : []),
  ], [ctx.user.permissions, isSuper]); // eslint-disable-line react-hooks/exhaustive-deps
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
      {active === 'content' && <ManageContent />}
      {active === 'menu' && <ManageMenu ctx={ctx} />}
      {active === 'community' && <ManageCommunity />}
      {active === 'qr' && <ManageQr />}
      {active === 'bookings' && <ManageBookings />}
      {active === 'people' && <ManageUsers ctx={ctx} />}
      {active === 'roles' && <ManageRoles />}
      {active === 'settings' && <ManageSettings ctx={ctx} />}
      {active === 'activity' && <ManageActivity />}
    </div>
  );
}
