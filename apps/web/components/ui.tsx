'use client';

import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import type { ApplicationStatus, Recommendation } from '@/lib/types';
import { humanize } from '@/lib/format';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  children,
  variant = 'secondary',
  loading,
  className,
  size = 'md',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; size?: 'sm' | 'md' }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-brand text-white hover:bg-brand-dark border-transparent',
    secondary: 'bg-white text-ink border-slate-300 hover:bg-slate-50',
    danger: 'bg-white text-red-700 border-red-300 hover:bg-red-50',
    ghost: 'bg-transparent text-ink-soft border-transparent hover:bg-slate-100',
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        styles[variant],
        className,
      )}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={cx('inline-block animate-spin rounded-full border-2 border-current border-r-transparent', small ? 'h-3 w-3' : 'h-5 w-5')} aria-label="Loading" />;
}

export function Badge({ children, tone = 'slate', title }: { children: ReactNode; tone?: 'slate' | 'green' | 'blue' | 'amber' | 'red' | 'violet'; title?: string }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    blue: 'bg-blue-50 text-blue-700 ring-blue-200',
    amber: 'bg-amber-50 text-amber-800 ring-amber-200',
    red: 'bg-red-50 text-red-700 ring-red-200',
    violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  };
  return (
    <span title={title} className={cx('inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent', tones[tone])}>
      {children}
    </span>
  );
}

const STATUS_TONE: Partial<Record<ApplicationStatus, 'slate' | 'green' | 'blue' | 'amber' | 'red' | 'violet'>> = {
  QUALIFIED: 'blue',
  SHORTLISTED: 'blue',
  CONTACT_FOUND: 'violet',
  RESUME_READY: 'violet',
  EMAIL_READY: 'violet',
  APPLIED: 'blue',
  EMAIL_SENT: 'amber',
  WAITING_FOR_REPLY: 'amber',
  FOLLOWUP_SCHEDULED: 'amber',
  REPLIED: 'green',
  INTERVIEW: 'green',
  OFFER: 'green',
  REJECTED: 'red',
};

export function StatusBadge({ status }: { status: ApplicationStatus | string }) {
  return <Badge tone={STATUS_TONE[status as ApplicationStatus] ?? 'slate'}>{humanize(status)}</Badge>;
}

const REC_TONE: Record<Recommendation, 'green' | 'blue' | 'amber' | 'slate' | 'red'> = {
  STRONG_APPLY: 'green',
  APPLY: 'blue',
  CONSIDER: 'amber',
  LOW_PRIORITY: 'slate',
  SKIP: 'red',
};

export function RecommendationBadge({ rec }: { rec: Recommendation | null }) {
  if (!rec) return <Badge>Unscored</Badge>;
  return <Badge tone={REC_TONE[rec]}>{rec.replace('_', ' ')}</Badge>;
}

export function ScorePill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-sm text-ink-muted">—</span>;
  const tone = score >= 80 ? 'text-emerald-700 bg-emerald-50' : score >= 65 ? 'text-blue-700 bg-blue-50' : score >= 50 ? 'text-amber-800 bg-amber-50' : 'text-slate-600 bg-slate-100';
  return <span className={cx('inline-flex min-w-[3rem] justify-center rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums', tone)}>{score}%</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-2 text-sm text-ink-muted">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputClass, 'font-[inherit]', props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputClass, 'pr-8', props.className)} />;
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16" onMouseDown={onClose}>
      <div className={cx('w-full rounded-lg bg-white shadow-xl', wide ? 'max-w-3xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-sm', value === t.id ? 'border-brand font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

// ─── Toasts ──────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'error';
}

const ToastCtx = createContext<(message: string, tone?: 'ok' | 'error') => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cx('rounded-md px-4 py-3 text-sm shadow-lg', t.tone === 'error' ? 'bg-red-600 text-white' : 'bg-slate-900 text-white')} role="status">
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Wrap an async action with loading state + toast on error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (e) {
        toast((e as Error).message, 'error');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}
