/** Centralize bearer storage, HTTP errors, and expired-session notification. */
export const TOKEN_KEY = 'portfolio.session';
export const SESSION_EXPIRED = 'portfolio-session-expired';

export class ApiError extends Error {
  /** Retain a safe server message and optional field-level validation errors. */
  constructor(public status: number, message: string, public fields: Record<string, string> = {}) {
    super(message);
  }
}

/** Send a typed request to the versioned API and fail on every non-success status. */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
    response = await fetch(`${base}/api/v1${path}`, { ...options, headers, cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'Unable to connect. Please try again.');
  }
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') {
      localStorage.removeItem(TOKEN_KEY);
      window.dispatchEvent(new Event(SESSION_EXPIRED));
    }
    const body = await response.json().catch(() => ({ detail: 'The request failed. Please try again.' }));
    const fields: Record<string, string> = {};
    if (Array.isArray(body.detail)) {
      for (const item of body.detail) fields[String(item.loc?.at(-1))] = String(item.msg);
    } else if (typeof body.detail === 'object' && body.detail !== null) Object.assign(fields, body.detail);
    throw new ApiError(response.status, typeof body.detail === 'string' ? body.detail : 'Please check the highlighted fields.', fields);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
