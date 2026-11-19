import type { IssuePriority, IssueStatus, IssueUpdate } from './types';

export const STATUS_LABEL: Record<IssueStatus, string> = { new: 'New', acknowledged: 'Seen', in_progress: 'In progress', waiting: 'Waiting', resolved: 'Fixed', closed: 'Closed' };
export const PRIORITY_LABEL: Record<IssuePriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const OPEN_STATUSES: IssueStatus[] = ['new', 'acknowledged', 'in_progress', 'waiting'];
export const isOpen = (status: IssueStatus) => OPEN_STATUSES.includes(status);

// Short phrases that fill in the description with one tap, so a report takes seconds.
export const QUICK_PHRASES = ['Not working', 'Leaking', 'Broken', 'Dirty', 'Out of stock', 'Too hot', 'Too cold', 'Noisy', 'Smells bad'];

export function ago(value: string | Date, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** One readable line per timeline entry; `who` resolves an id to a name when the entry only carries ids. */
export function describeUpdate(update: IssueUpdate, who: (id: string | null) => string): string {
  switch (update.kind) {
    case 'status': return `changed the status from ${STATUS_LABEL[update.from as IssueStatus] ?? update.from} to ${STATUS_LABEL[update.to as IssueStatus] ?? update.to}`;
    case 'priority': return `changed the priority from ${PRIORITY_LABEL[update.from as IssuePriority] ?? update.from} to ${PRIORITY_LABEL[update.to as IssuePriority] ?? update.to}`;
    case 'assign': return update.to ? `gave this to ${who(update.to)}` : 'took the assignment off';
    case 'reopen': return 'said it is still not fixed';
    case 'help': return 'asked the managers for help';
    default: return update.internal ? 'left a staff note' : 'commented';
  }
}

// Photos are shrunk in the browser first: the longest side is at most 1280 px and the file is aimed at about 200 KB.
export async function shrinkPhoto(file: File, targetBytes = 200 * 1024): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  let edge = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  let quality = 0.82;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * edge));
    canvas.height = Math.max(1, Math.round(bitmap.height * edge));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare photos.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && (blob.size <= targetBytes || attempt === 7)) { bitmap.close?.(); return blob; }
    if (quality > 0.5) quality -= 0.12; else edge *= 0.8;
  }
  bitmap.close?.();
  throw new Error('That photo could not be shrunk. Try another one.');
}
