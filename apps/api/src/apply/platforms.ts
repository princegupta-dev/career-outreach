import type { FoundJob } from '../search';

export type ApplicationPlatform = 'naukri' | 'hirist' | 'instahyre' | 'linkedin' | 'wellfound' | 'external';
export type BoardPlatform = Exclude<ApplicationPlatform, 'naukri' | 'external'>;
export const PLATFORM_NAMES: Record<ApplicationPlatform, string> = { naukri: 'Naukri', hirist: 'Hirist', instahyre: 'Instahyre', linkedin: 'LinkedIn', wellfound: 'Wellfound', external: 'Company websites' };
export function publicHttps(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /^(localhost|.*\.localhost|.*\.local)$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return null;
    return url;
  } catch { return null; }
}
export function boardJobId(value: string, board: BoardPlatform): string | null {
  const url = publicHttps(value);
  const domain = { hirist: 'hirist.tech', instahyre: 'instahyre.com', linkedin: 'linkedin.com', wellfound: 'wellfound.com' }[board];
  if (!url || ![domain, `www.${domain}`].includes(url.hostname)) return null;
  if (board === 'linkedin') return url.pathname.match(/^\/jobs\/view\/(\d+)(?:\/|$)/)?.[1] ?? (url.pathname.startsWith('/jobs/search') && /^\d+$/.test(url.searchParams.get('currentJobId') ?? '') ? url.searchParams.get('currentJobId') : null);
  if (board === 'wellfound') return url.pathname.match(/^\/jobs\/(\d+)(?:-|\/|$)/)?.[1] ?? null;
  return (board === 'hirist' ? url.pathname.match(/^\/j\/.+-(\d+)\/?$/) : url.pathname.match(/^\/job-(\d+)(?:-|\/|$)/))?.[1] ?? null;
}
export function atsTarget(value: string): { kind: 'greenhouse' | 'lever' | 'ashby' | 'workday'; key: string } | null {
  const url = publicHttps(value); if (!url) return null;
  let match: RegExpMatchArray | null;
  if (/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(url.hostname) && (match = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)(?:\/|$)/))) return { kind: 'greenhouse', key: `${match[1]}/${match[2]}` };
  if (/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(url.hostname) && url.pathname === '/embed/job_app' && url.searchParams.get('token') && /^\d+$/.test(url.searchParams.get('for') ?? '')) return { kind: 'greenhouse', key: `${url.searchParams.get('token')}/${url.searchParams.get('for')}` };
  if (/^jobs\.(?:eu\.)?lever\.co$/.test(url.hostname) && (match = url.pathname.match(/^\/([^/]+)\/([a-f\d-]{36})(?:\/|$)/i))) return { kind: 'lever', key: `${match[1]}/${match[2]}` };
  if (url.hostname === 'jobs.ashbyhq.com' && (match = url.pathname.match(/^\/([^/]+)\/([a-f\d-]{36})(?:\/|$)/i))) return { kind: 'ashby', key: `${match[1]}/${match[2]}` };
  if (/^[a-z0-9-]+\.(?:wd\d+\.)?myworkdayjobs\.com$/.test(url.hostname) && (match = url.pathname.match(/^(?:\/[a-z]{2}-[A-Z]{2})?\/([^/]+)\/job\/(.+?)(?:\/apply(?:\/.*)?|\/$|$)/))) return { kind: 'workday', key: `${url.hostname.split('.')[0]}/${match[1]}/${match[2]}` };
  if (/^wd\d+\.myworkdaysite\.com$/.test(url.hostname) && (match = url.pathname.match(/^\/recruiting\/([^/]+)\/([^/]+)\/job\/(.+?)(?:\/apply(?:\/.*)?|\/$|$)/))) return { kind: 'workday', key: `${match[1]}/${match[2]}/${match[3]}` };
  return null;
}
export function externalCandidate(job: Pick<FoundJob, 'source' | 'url' | 'flags'>) {
  return !!job.url && !!publicHttps(job.url) && (!!atsTarget(job.url) || ['GREENHOUSE', 'LEVER', 'ASHBY', 'WORKDAY', 'LINKEDIN'].includes(job.source) || job.flags.includes('apply:company-site') || job.source === 'CUSTOM');
}
export function applicationUrlKey(value: string) {
  const ats = atsTarget(value);
  if (ats) return `${ats.kind}:${ats.key}`;
  for (const board of ['hirist', 'instahyre', 'linkedin', 'wellfound'] as const) { const id = boardJobId(value, board); if (id) return `${board}:${id}`; }
  // Custom portals may use a query parameter as their only posting identifier.
  const url = publicHttps(value);
  if (!url) return value;
  for (const param of [...url.searchParams.keys()]) if (/^(utm_|trk$|tracking|source$|ref$)/i.test(param)) url.searchParams.delete(param);
  url.hash = ''; url.searchParams.sort(); return url.href.replace(/\/$/, '');
}
export function belongsToPlatform(job: Pick<FoundJob, 'source' | 'url' | 'flags'>, platform: ApplicationPlatform) {
  if (platform === 'external') return externalCandidate(job);
  return job.source === platform.toUpperCase();
}
