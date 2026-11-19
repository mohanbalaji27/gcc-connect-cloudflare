import { useCallback, useEffect, useState } from 'react';
import type { Resource } from './types';
import { api } from './api';

// All active desks and rooms (layout data only: no availability). Reused across screens and refetched only when the
// server's config version changes, i.e. when an admin edited spaces, teams or the map.
let cache: { version: number; list: Resource[] } | null = null;
let pending: { version: number; promise: Promise<Resource[]> } | null = null;

export const clearResources = () => { cache = null; pending = null; };

export function loadResources(version: number): Promise<Resource[]> {
  if (cache && cache.version === version) return Promise.resolve(cache.list);
  if (pending && pending.version === version) return pending.promise;
  const promise = api<{ resources: Resource[] }>('/resources')
    .then((result) => { if (!cache || cache.version <= version) cache = { version, list: result.resources }; return result.resources; })
    .finally(() => { if (pending?.promise === promise) pending = null; });
  pending = { version, promise };
  return promise;
}

export function useResources(version: number) {
  const [list, setList] = useState<Resource[] | null>(cache && cache.version === version ? cache.list : null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    loadResources(version).then(setList).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not load the spaces.'));
  }, [version]);
  useEffect(() => { load(); }, [load]);
  return { resources: list, error, reload: load };
}
