export function formatSalary(min: number | null, max: number | null, currency: string | null, period?: string | null): string | null {
  if (min == null && max == null) return null;
  if (currency === 'INR') {
    const mult = period === 'month' ? 12 : 1;
    const l = (n: number | null) => (n == null ? '' : `${Math.round((n * mult) / 100_000)}`);
    return min === max || max == null ? `₹${l(min)} LPA` : `₹${l(min)}–${l(max)} LPA`;
  }
  const sym: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };
  const k = (n: number | null) => (n == null ? '' : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
  const s = sym[currency ?? ''] ?? `${currency ?? ''} `;
  const per = period && period !== 'year' ? `/${period}` : '';
  return min === max || max == null ? `${s}${k(min)}${per}` : `${s}${k(min)}–${k(max)}${per}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

export function humanize(s: string | null | undefined): string {
  if (!s) return '—';
  return s
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}
