'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect } from 'react';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';
import { cx, Spinner } from './ui';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/outreach', label: 'Outreach' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/resume', label: 'Resume' },
  { href: '/profile', label: 'Profile' },
  { href: '/settings', label: 'Settings' },
];

interface Me {
  id: string;
  email: string;
  name: string;
}

/** Authenticated application chrome: sidebar + content. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me, error, isLoading } = useSWR<Me>('/auth/me', fetcher, { shouldRetryOnError: false });

  useEffect(() => {
    if (error) router.replace('/login');
  }, [error, router]);

  if (isLoading || !me) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-muted">
        <Spinner />
      </div>
    );
  }

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    router.replace('/login');
  };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="px-5 py-5">
          <p className="text-sm font-semibold tracking-tight text-ink">Career Outreach</p>
          <p className="text-xs text-ink-muted">{me.name}</p>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map((n) => {
            const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className={cx('block rounded-md px-3 py-2 text-sm', active ? 'bg-slate-100 font-medium text-ink' : 'text-ink-soft hover:bg-slate-50 hover:text-ink')}>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-100 px-5 py-4">
          <p className="truncate text-xs text-ink-muted">{me.email}</p>
          <button onClick={logout} className="mt-1 text-xs text-ink-soft hover:text-ink">
            Sign out
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 md:hidden">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="whitespace-nowrap rounded px-2 py-1 text-sm text-ink-soft">
              {n.label}
            </Link>
          ))}
        </nav>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
