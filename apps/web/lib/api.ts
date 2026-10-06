'use client';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

async function getCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const r = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  const j = (await r.json()) as { csrfToken: string };
  csrfToken = j.csrfToken;
  return csrfToken;
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  form?: FormData;
}

/** Same-origin API call (proxied to NestJS). Adds the CSRF header for mutations. */
export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-csrf-token'] = await getCsrf();
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : {};
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth') && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    if (res.status === 403 && /CSRF/i.test(json?.message ?? '')) csrfToken = null;
    const detailMsg = json?.details?.blockers?.join(' ') ?? json?.issues?.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ');
    throw new ApiError([json?.message, detailMsg].filter(Boolean).join(' — ') || `Request failed (${res.status})`, res.status, json);
  }
  return json as T;
}

export const fetcher = <T,>(path: string) => api<T>(path);
