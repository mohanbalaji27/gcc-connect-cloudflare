export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

let csrfToken = '';
export const setCsrf = (token: string) => { csrfToken = token; };

export async function api<T = void>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  } catch {
    throw new ApiError('NETWORK', 'We could not reach the server. Check your connection and try again.', 0);
  }
  if (response.status === 204) return undefined as T;
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    if (response.status === 401 && error?.code === 'AUTH_REQUIRED' && path !== '/login' && path !== '/session' && path !== '/logout') {
      window.dispatchEvent(new Event('gcc-auth-expired'));
    }
    throw new ApiError(error?.code ?? 'ERROR', error?.message ?? 'Something went wrong. Please try again.', response.status);
  }
  return payload as T;
}

export const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : 'Something went wrong. Please try again.');
export const newKey = () => crypto.randomUUID();

export async function uploadBlob(path: string, blob: Blob, contentType: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method: 'PUT', headers: { 'Content-Type': contentType, 'X-CSRF-Token': csrfToken }, credentials: 'same-origin', body: blob });
  } catch {
    throw new ApiError('NETWORK', 'We could not reach the server. Check your connection and try again.', 0);
  }
  if (!response.ok) {
    let message = 'The upload did not go through.';
    try { message = ((await response.json()) as { error?: { message?: string } }).error?.message ?? message; } catch { /* keep default */ }
    throw new ApiError('UPLOAD', message, response.status);
  }
}
