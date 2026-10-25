'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import useSWR from 'swr';
import { AddJobModal } from '@/components/jobs';
import { PageHeader } from '@/components/shell';
import { Button, cx, Empty, Input, Notice, ScorePill, Select, Spinner, StageBadge, Tabs } from '@/components/ui';
import { fetcher } from '@/lib/api';
import { formatSalary } from '@/lib/format';
import { JobListItem, SOURCE_LABEL, STAGES, VERDICTS, VerdictKey } from '@/lib/types';

interface ListResponse {
  total: number;
  page: number;
  pageSize: number;
  items: JobListItem[];
}

const VERDICT_TEXT: Record<VerdictKey, string> = {
  STRONG_MATCH: 'text-emerald-700',
  GOOD_MATCH: 'text-blue-700',
  REVIEW_MANUALLY: 'text-amber-700',
  NOT_RECOMMENDED: 'text-slate-500',
};

const SIZES = [
  { id: 'EARLY_STARTUP', label: 'Early startup (≤50)' },
  { id: 'GROWTH_STARTUP', label: 'Growth startup (51–250)' },
  { id: 'MID_MARKET', label: 'Mid-size (251–1000)' },
  { id: 'ENTERPRISE', label: 'Large (1000+)' },
  { id: 'UNKNOWN', label: 'Size unknown' },
];
const FILTER_KEYS = ['verdict', 'stage', 'source', 'location', 'companySize'] as const;

/** The one thing to do next, as a short line. Highlighted when it is waiting for you. */
function NextStep({ job }: { job: JobListItem }) {
  const lc = job.lifecycle;
  if (!lc || lc.label === '—') return <span className="text-ink-muted">—</span>;
  return <span className={cx('text-sm', lc.needsAction ? 'font-medium text-brand' : 'text-ink-muted')}>{lc.needsAction ? `→ ${lc.label}` : lc.label}</span>;
}

function Where({ job }: { job: JobListItem }) {
  const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod);
  const place = job.remote ? 'Remote' : job.location || null;
  const bits = [place, salary].filter(Boolean);
  return <>{bits.length ? bits.join(' · ') : <span className="text-ink-muted">—</span>}</>;
}

function JobsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [adding, setAdding] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const view = params.get('view') === 'all' ? 'all' : 'action';
  const page = Number(params.get('page') ?? 1);
  const activeFilters = FILTER_KEYS.filter((k) => params.get(k)).length;

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    if (k !== 'page') p.delete('page');
    router.replace(`/jobs?${p.toString()}`);
  };
  const clearFilters = () => {
    const p = new URLSearchParams(params.toString());
    for (const k of [...FILTER_KEYS, 'search', 'page']) p.delete(k);
    setSearch('');
    router.replace(`/jobs?${p.toString()}`);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get('search') ?? '') !== search) setParam('search', search);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const qs = new URLSearchParams({ sort: 'priority', page: String(page), pageSize: '25' });
  if (view === 'action') qs.set('needsAction', 'true');
  for (const k of [...FILTER_KEYS, 'search']) if (params.get(k)) qs.set(k, params.get(k)!);
  const { data, error, isLoading, mutate } = useSWR<ListResponse>(`/jobs?${qs}`, fetcher, { keepPreviousData: true });

  const filters = (
    <>
      <Select value={params.get('verdict') ?? ''} onChange={(e) => setParam('verdict', e.target.value)} aria-label="Recommendation">
        <option value="">Any match</option>
        {VERDICTS.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </Select>
      <Select value={params.get('stage') ?? ''} onChange={(e) => setParam('stage', e.target.value)} aria-label="Status">
        <option value="">Any status</option>
        {STAGES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </Select>
      <Select value={params.get('source') ?? ''} onChange={(e) => setParam('source', e.target.value)} aria-label="Source">
        <option value="">Any source</option>
        {Object.entries(SOURCE_LABEL).map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </Select>
      <Select value={params.get('location') ?? ''} onChange={(e) => setParam('location', e.target.value)} aria-label="Location">
        <option value="">Any location</option>
        <option value="remote">Remote</option>
        <option value="india">India</option>
        <option value="other">Elsewhere</option>
      </Select>
      <Select value={params.get('companySize') ?? ''} onChange={(e) => setParam('companySize', e.target.value)} aria-label="Company size">
        <option value="">Any company size</option>
        {SIZES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </Select>
    </>
  );

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle={data ? (view === 'action' ? `${data.total} need${data.total === 1 ? 's' : ''} your attention` : `${data.total} job${data.total === 1 ? '' : 's'}`) : undefined}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add job
          </Button>
        }
      />
      <AddJobModal open={adding} onClose={() => setAdding(false)} onAdded={() => mutate()} />

      <div className="mb-4 space-y-3">
        <Tabs
          tabs={[
            { id: 'action', label: 'Needs action' },
            { id: 'all', label: 'All jobs' },
          ]}
          value={view}
          onChange={(v) => setParam('view', v === 'all' ? 'all' : '')}
        />
        <div className="flex gap-2">
          <Input className="flex-1" placeholder="Search title, company, location…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search jobs" />
          <Button className="md:hidden" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
            Filters{activeFilters ? ` (${activeFilters})` : ''}
          </Button>
        </div>
        <div className={cx('grid-cols-1 gap-2 sm:grid-cols-2 md:grid md:grid-cols-5', showFilters ? 'grid' : 'hidden')}>{filters}</div>
        {(activeFilters > 0 || params.get('search')) && (
          <p className="text-sm">
            <button type="button" className="text-brand hover:underline" onClick={clearFilters}>
              Clear filters
            </button>
          </p>
        )}
      </div>

      {error && !data ? (
        <Notice tone="red" title="Couldn't load your jobs" actions={<Button size="sm" onClick={() => mutate()}>Try again</Button>}>
          {(error as Error).message}
        </Notice>
      ) : isLoading && !data ? (
        <Spinner />
      ) : !data?.items.length ? (
        view === 'action' && !activeFilters && !params.get('search') ? (
          <Empty title="Nothing needs your attention right now">
            <p>New matches and replies will show up here.</p>
            <div className="mt-3">
              <Button onClick={() => setParam('view', 'all')}>See all jobs</Button>
            </div>
          </Empty>
        ) : (
          <Empty title="No jobs match">
            <p>Try clearing the filters, or add a job.</p>
            <div className="mt-3">
              <Button onClick={clearFilters}>Clear filters</Button>
            </div>
          </Empty>
        )
      ) : (
        <>
          {/* Phones: one card per job */}
          <ul className="space-y-3 md:hidden">
            {data.items.map((j) => (
              <li key={j.id}>
                <Link href={`/jobs/${j.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-300">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">{j.title}</p>
                      <p className="text-xs text-ink-muted">{j.company.name}</p>
                    </div>
                    <ScorePill score={j.score} />
                  </div>
                  <p className={cx('mt-2 text-xs font-medium', VERDICT_TEXT[j.verdict.key])}>{j.verdict.label}</p>
                  <p className="mt-1 text-xs text-ink-soft">
                    <Where job={j} />
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    {j.lifecycle && <StageBadge lifecycle={j.lifecycle} />}
                    <NextStep job={j} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Larger screens: compact table */}
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Match</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Location · pay</th>
                  <th className="px-4 py-2.5 font-medium">Status and next step</th>
                  <th className="px-4 py-2.5 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((j) => (
                  <tr key={j.id} className="cursor-pointer hover:bg-slate-50" onClick={() => router.push(`/jobs/${j.id}`)}>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <ScorePill score={j.score} />
                        <span className={cx('text-xs font-medium', VERDICT_TEXT[j.verdict.key])}>{j.verdict.label}</span>
                      </div>
                    </td>
                    <td className="max-w-xs px-4 py-3">
                      <Link href={`/jobs/${j.id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                        {j.title}
                      </Link>
                      <p className="text-xs text-ink-muted">{j.company.name}</p>
                    </td>
                    <td className="px-4 py-3 text-ink-soft">
                      <Where job={j} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        {j.lifecycle && <StageBadge lifecycle={j.lifecycle} />}
                        <NextStep job={j} />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">{SOURCE_LABEL[j.provider] ?? j.provider}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
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
