import type { Permission, PermissionCatalog, PermissionInfo, User } from './types';

export const allInfos = (catalog: PermissionCatalog): PermissionInfo[] => catalog.groups.flatMap((group) => group.permissions);

/** Mirrors the server rule: reserved permissions never; "super" ones only for super admins; the rest only if you hold them. */
export function canGrant(actor: Pick<User, 'role' | 'permissions'>, info: PermissionInfo): boolean {
  if (info.grant === 'reserved') return false;
  if (actor.role === 'super_admin') return true;
  return info.grant === 'any' && actor.permissions.includes(info.id);
}

export function labelOf(catalog: PermissionCatalog, id: Permission): string {
  return allInfos(catalog).find((info) => info.id === id)?.label ?? id;
}

/** "What can this person do", grouped, in the catalogue's order. */
export function summarize(catalog: PermissionCatalog, ids: Permission[]): { group: string; icon: string; items: string[] }[] {
  const held = new Set(ids);
  return catalog.groups
    .map((group) => ({ group: group.label, icon: group.icon, items: group.permissions.filter((info) => held.has(info.id)).map((info) => info.label) }))
    .filter((entry) => entry.items.length > 0);
}

export function diffPermissions(before: Permission[], after: Permission[]): { added: Permission[]; removed: Permission[] } {
  const was = new Set(before);
  const now = new Set(after);
  return { added: after.filter((id) => !was.has(id)), removed: before.filter((id) => !now.has(id)) };
}
