export const USER_AGENT = 'JobHunterPersonalAgent/1.0 (personal job-search tool; respects robots.txt)';

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

const TLS_INTERCEPT_CODES = ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED'];

/** Turn low-level network errors into actionable messages. */
export function describeNetworkError(host: string, err: unknown): FetchError {
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = cause?.code ?? (err as { code?: string }).code;
  if (code && TLS_INTERCEPT_CODES.includes(code)) {
    return new FetchError(
      `Blocked by your network: something (a firewall/antivirus doing HTTPS inspection) intercepted the connection to ${host}. This source works on another network (home Wi-Fi / mobile hotspot).`,
      undefined,
      'TLS_INTERCEPTED',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new FetchError(`Cannot resolve ${host} (offline or DNS blocked)`, undefined, code);
  return new FetchError(`Could not fetch ${host}: ${(err as Error).message}`, undefined, code);
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

/** fetch with timeout + response size cap. */
export async function httpFetch(url: string, opts: FetchOptions = {}): Promise<{ status: number; text: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      body: opts.body,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...opts.headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    const max = opts.maxBytes ?? 3_000_000;
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          await reader.cancel();
          throw new FetchError(`Response too large (> ${max} bytes)`);
        }
        chunks.push(value);
      }
    }
    return { status: res.status, text: Buffer.concat(chunks).toString('utf8'), contentType: res.headers.get('content-type') ?? '' };
  } catch (err) {
    if (err instanceof FetchError) throw err;
    if ((err as Error).name === 'AbortError') throw new FetchError(`Timed out fetching ${new URL(url).hostname}`);
    throw describeNetworkError(new URL(url).hostname, err);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const r = await httpFetch(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  if (r.status === 404) throw new FetchError('Not found', 404);
  if (r.status >= 400) throw new FetchError(`HTTP ${r.status} from ${new URL(url).hostname}`, r.status);
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new FetchError(`Invalid JSON from ${new URL(url).hostname}`);
  }
}

// ─── robots.txt ──────────────────────────────────────────────────────────────

const robotsCache = new Map<string, { rules: Array<{ allow: boolean; path: string }>; at: number }>();

export function parseRobots(txt: string): Array<{ allow: boolean; path: string }> {
  const rules: Array<{ allow: boolean; path: string }> = [];
  let applies = false;
  let sawRuleInGroup = false;
  for (const raw of txt.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const key = k.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (sawRuleInGroup) {
        applies = false;
        sawRuleInGroup = false;
      }
      if (value === '*' || USER_AGENT.toLowerCase().includes(value.toLowerCase())) applies = true;
    } else if (key === 'disallow' || key === 'allow') {
      sawRuleInGroup = true;
      if (applies && value) rules.push({ allow: key === 'allow', path: value });
    }
  }
  return rules;
}

export function robotsAllows(rules: Array<{ allow: boolean; path: string }>, pathname: string): boolean {
  let best: { allow: boolean; path: string } | null = null;
  for (const r of rules) {
    const prefix = r.path.replace(/\*.*$/, '').replace(/\$$/, '');
    if (pathname.startsWith(prefix) && (!best || prefix.length > best.path.length)) best = { allow: r.allow, path: prefix };
  }
  return best ? best.allow : true;
}

export async function isAllowedByRobots(url: string): Promise<boolean> {
  const u = new URL(url);
  const cached = robotsCache.get(u.origin);
  let rules = cached && Date.now() - cached.at < 3_600_000 ? cached.rules : null;
  if (!rules) {
    try {
      const r = await httpFetch(`${u.origin}/robots.txt`, { timeoutMs: 5000, maxBytes: 500_000 });
      rules = r.status < 400 ? parseRobots(r.text) : [];
    } catch {
      rules = [];
    }
    robotsCache.set(u.origin, { rules, at: Date.now() });
  }
  return robotsAllows(rules, u.pathname);
}
