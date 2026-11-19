import { useState } from 'react';
import type { Ctx } from '../App';
import { Tabs } from '../kit';
import { MenuEditor } from './MenuEditor';
import { MenuReviews } from './MenuReviews';

// Food team workspace: the whole-day editor and the reviews view. Reading reviews has its own permission.
export function ManageMenu({ ctx }: { ctx: Ctx }) {
  const can = (permission: string) => ctx.user.permissions.includes(permission as never);
  const canEdit = can('menu.edit');
  const canReviews = canEdit || can('menu.reviews.view');
  const tabs = [
    ...(canEdit ? [{ id: 'edit' as const, label: 'Edit menu', icon: 'edit' }] : []),
    ...(canReviews ? [{ id: 'reviews' as const, label: 'Reviews', icon: 'chat' }] : []),
  ];
  const [tab, setTab] = useState<'edit' | 'reviews'>(tabs[0]?.id ?? 'reviews');
  const active = tabs.some((item) => item.id === tab) ? tab : tabs[0]?.id;
  return (
    <section className="panel mm-panel">
      <Tabs tabs={tabs} value={active ?? 'reviews'} onChange={setTab} />
      {active === 'edit' && <MenuEditor ctx={ctx} />}
      {active === 'reviews' && <MenuReviews ctx={ctx} />}
    </section>
  );
}
