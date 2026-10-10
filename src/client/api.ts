// Browser API client. Mutations carry an Idempotency-Key so retries never double-apply.
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

function newKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function parse<T>(res: Response): Promise<T> {
  let body: { ok: boolean; data?: T; error?: { code: string; message: string; details?: Record<string, unknown> } } | null = null;
  try {
    body = await res.json();
  } catch {
    throw new ApiError('network', `Unexpected response (HTTP ${res.status})`, res.status);
  }
  if (!res.ok || !body?.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login') && location.pathname !== '/') {
      location.href = '/';
    }
    throw new ApiError(body?.error?.code ?? 'error', body?.error?.message ?? `Request failed (HTTP ${res.status})`, res.status, body?.error?.details);
  }
  return body.data as T;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('network', 'Network error: could not reach the server', 0);
  }
  return parse<T>(res);
}

/**
 * POST with an idempotency key. Network failures are retried with the same key, so the server
 * either applies the action once or replays the stored result.
 */
export async function apiPost<T>(path: string, body: unknown = {}, opts: { key?: string; retries?: number } = {}): Promise<T> {
  const key = opts.key ?? newKey();
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      });
    } catch {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      throw new ApiError('network', 'Network error: the action may not have completed. Check your connection and try again.', 0);
    }
    return parse<T>(res);
  }
}
