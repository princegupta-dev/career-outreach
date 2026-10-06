'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import useSWR from 'swr';
import { AddJobModal } from '@/components/jobs';
import { PageHeader } from '@/components/shell';
import { Button, Empty, Input, RecommendationBadge, ScorePill, Select, Spinner, StatusBadge } from '@/components/ui';
import { fetcher } from '@/lib/api';
import { formatDate, formatSalary, humanize } from '@/lib/format';
import { JobListItem, STATUSES } from '@/lib/types';

interface ListResponse {
  total: number;
  page: number;
  pageSize: number;
  items: JobListItem[];
}

function JobsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [adding, setAdding] = useState(false);
  const status = params.get('status') ?? '';
  const recommendation = params.get('recommendation') ?? '';
  const sort = params.get('sort') ?? 'score';
  const page = Number(params.get('page') ?? 1);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    if (k !== 'page') p.delete('page');
    router.replace(`/jobs?${p.toString()}`);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get('search') ?? '') !== search) setParam('search', search);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const qs = new URLSearchParams({ sort, page: String(page), pageSize: '25', ...(status && { status }), ...(recommendation && { recommendation }), ...(params.get('search') && { search: params.get('search')! }) });
  const { data, isLoading, mutate } = useSWR<ListResponse>(`/jobs?${qs}`, fetcher, { keepPreviousData: true });

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle={data ? `${data.total} job${data.total === 1 ? '' : 's'}` : undefined}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add job
          </Button>
        }
      />
      <AddJobModal open={adding} onClose={() => setAdding(false)} onAdded={() => mutate()} />

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <Input placeholder="Search title, company, location, description…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select value={status} onChange={(e) => setParam('status', e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </Select>
        <Select value={recommendation} onChange={(e) => setParam('recommendation', e.target.value)}>
          <option value="">Any recommendation</option>
          {['STRONG_APPLY', 'APPLY', 'CONSIDER', 'LOW_PRIORITY', 'SKIP'].map((r) => (
            <option key={r} value={r}>
              {r.replace('_', ' ')}
            </option>
          ))}
        </Select>
        <Select value={sort} onChange={(e) => setParam('sort', e.target.value)}>
          <option value="score">Best match first</option>
          <option value="recent">Newest first</option>
        </Select>
      </div>

      {isLoading && !data ? (
        <Spinner />
      ) : !data?.items.length ? (
        <Empty title="No jobs match">Try clearing filters, or add a job.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Match</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Location</th>
                <th className="px-4 py-2.5 font-medium">Salary</th>
                <th className="px-4 py-2.5 font-medium">Contact</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Next action</th>
                <th className="px-4 py-2.5 font-medium">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((j) => (
                <tr key={j.id} className="cursor-pointer hover:bg-slate-50" onClick={() => router.push(`/jobs/${j.id}`)}>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1">
                      <ScorePill score={j.score} />
                      <RecommendationBadge rec={j.recommendation} />
                    </div>
                  </td>
                  <td className="max-w-xs px-4 py-3">
                    <Link href={`/jobs/${j.id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                      {j.title}
                    </Link>
                    <p className="text-xs text-ink-muted">{j.company.name}</p>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{j.remote ? 'Remote' : j.location || '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-ink-soft">{formatSalary(j.salaryMin, j.salaryMax, j.salaryCurrency, j.salaryPeriod) ?? '—'}</td>
                  <td className="px-4 py-3 text-ink-soft">{j.application?.contact?.name ?? '—'}</td>
                  <td className="px-4 py-3">{j.application && <StatusBadge status={j.application.status} />}</td>
                  <td className="px-4 py-3 font-medium">{j.nextAction ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-ink-muted">{formatDate(j.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > data.pageSize && (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm">
          <Button size="sm" disabled={page <= 1} onClick={() => setParam('page', String(page - 1))}>
            Previous
          </Button>
          <span className="text-ink-muted">
            Page {page} of {Math.ceil(data.total / data.pageSize)}
          </span>
          <Button size="sm" disabled={page * data.pageSize >= data.total} onClick={() => setParam('page', String(page + 1))}>
            Next
          </Button>
        </div>
      )}
    </>
  );
}

export default function JobsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <JobsInner />
    </Suspense>
  );
}
