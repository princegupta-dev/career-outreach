'use client';

import { useEffect, useMemo, useState } from 'react';
import { EMPTY, isKnownSource, Job, JobStatus, load, mergeResults, save, setStatus, sourceLabel, State, StoredJob } from '@/lib/store';

type Tab = JobStatus | 'all';

export default function JobsPage() {
  const [state, setState] = useState<State>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('new');
  const [days, setDays] = useState(7);
  const [query, setQuery] = useState('');
  const [startupsOnly, setStartupsOnly] = useState(false);
  const [boards, setBoards] = useState(false);
  const [source, setSource] = useState('all');

  const update = (fn: (prev: State) => State) =>
    setState((prev) => {
      const next = fn(prev);
      save(next);
      return next;
    });

  /** Pull every job found so far (terminal runs included) from the API's shared results file. */
  async function refresh() {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) return;
      const body = (await res.json()) as { updatedAt: string | null; jobs: Job[] };
      if (body.updatedAt) update((prev) => mergeResults(prev, body.jobs, body.updatedAt!));
    } catch {
      // API not running: show what this browser already has.
    }
  }

  // localStorage only exists in the browser, so read it after the first render, then add anything new from the API.
  useEffect(() => {
    setState(load());
    void refresh();
    // Run once when the page opens; `refresh` is recreated each render and must not re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function search() {
    setLoading(true);
    setError(null);
    try {
      // Job boards are read through your logged-in Chrome, slowly (about 2–4 minutes). Log in first: npm run login -- wellfound hirist instahyre
      const res = await fetch(`/api/jobs/search?days=${days}${boards ? '&sites=wellfound,hirist,instahyre' : ''}`);
      const body = (await res.json()) as { jobs: Job[]; ranAt: string; sources: { source: string; error?: string }[]; warnings?: string[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      update((prev) => mergeResults(prev, body.jobs, body.ranAt));
      await refresh();
      setFailed([...body.sources.filter((s) => s.error).map((s) => s.source), ...(body.warnings ?? [])]);
    } catch (e) {
      setError(`Search failed: ${(e as Error).message}. Is the API running (npm run dev:api)?`);
    } finally {
      setLoading(false);
    }
  }

  const jobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(state.jobs)
      .filter((j) => isKnownSource(j.source))
      .filter((j) => tab === 'all' || j.status === tab)
      .filter((j) => !q || `${j.title} ${j.company} ${j.location ?? ''}`.toLowerCase().includes(q))
      .filter((j) => !startupsOnly || (j.teamSize != null && j.teamSize <= 100))
      .filter((j) => source === 'all' || sourceLabel(j.source) === source)
      .sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? '') || b.score - a.score);
  }, [state, tab, query, startupsOnly, source]);

  const sources = useMemo(() => {
    const n: Record<string, number> = {};
    for (const j of Object.values(state.jobs).filter((x) => isKnownSource(x.source))) n[sourceLabel(j.source)] = (n[sourceLabel(j.source)] ?? 0) + 1;
    return Object.entries(n).sort((a, b) => b[1] - a[1]);
  }, [state]);

  const count = (s: Tab) => Object.values(state.jobs).filter((j) => isKnownSource(j.source) && (s === 'all' || j.status === s)).length;

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold">Job Hunter</h1>
        <label className="text-sm text-slate-600">
          Posted in last{' '}
          <select className="rounded border px-1 py-0.5" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-sm text-slate-600" title="Reads Wellfound, Hirist and Instahyre through your logged-in Chrome. Slow on purpose.">
          <input type="checkbox" checked={boards} onChange={(e) => setBoards(e.target.checked)} />
          + job boards (slow)
        </label>
        <button onClick={search} disabled={loading} className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {loading ? 'Searching…' : 'Find jobs'}
        </button>
      </header>

      {state.lastRunAt && <p className="mb-3 text-xs text-slate-500">Last search: {new Date(state.lastRunAt).toLocaleString()}</p>}
      {error && <p className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {failed.length > 0 && <p className="mb-3 text-xs text-amber-700">Could not reach: {failed.join(', ')}</p>}

      <nav className="mb-4 flex flex-wrap items-center gap-2">
        {(['new', 'applied', 'skipped', 'all'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1 text-sm capitalize ${tab === t ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}>
            {t} ({count(t)})
          </button>
        ))}
        <select value={source} onChange={(e) => setSource(e.target.value)} className="rounded border px-2 py-1 text-sm" aria-label="Source">
          <option value="all">All sources</option>
          {sources.map(([name, n]) => (
            <option key={name} value={name}>
              {name} ({n})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-sm text-slate-700">
          <input type="checkbox" checked={startupsOnly} onChange={(e) => setStartupsOnly(e.target.checked)} />
          Startups only (≤100 people)
        </label>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by title, company, city" className="ml-auto min-w-0 flex-1 rounded border px-3 py-1 text-sm sm:max-w-xs" />
      </nav>

      {jobs.length === 0 ? (
        <p className="py-12 text-center text-sm text-slate-500">{count('all') === 0 ? 'No jobs yet. Press "Find jobs".' : 'Nothing here.'}</p>
      ) : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} isNew={j.firstSeenAt === state.lastRunAt} onStatus={(s) => update((prev) => setStatus(prev, j.id, s))} />
          ))}
        </ul>
      )}
    </main>
  );
}

function JobRow({ job, isNew, onStatus }: { job: StoredJob; isNew: boolean; onStatus: (s: JobStatus) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="w-9 shrink-0 rounded bg-slate-100 py-0.5 text-center text-sm font-semibold" title={job.recommendation}>
          {job.score}
        </span>
        <div className="min-w-0 flex-1">
          <a href={job.url ?? '#'} target="_blank" rel="noreferrer" className="font-medium hover:underline">
            {job.title}
          </a>
          {isNew && <span className="ml-2 rounded bg-emerald-100 px-1.5 text-xs text-emerald-800">new</span>}
          <p className="text-sm text-slate-600">
            {job.company}
            {job.teamSize ? ` (${job.teamSize} people)` : ''} · {job.location ?? 'Location not stated'} · {job.postedAt ? job.postedAt.slice(0, 10) : 'date unknown'} · {sourceLabel(job.source)}
            {job.salaryText ? ` · ${job.salaryText}` : ''}
          </p>
        </div>
        <div className="flex gap-1 text-xs">
          <button onClick={() => setOpen(!open)} className="rounded px-2 py-1 ring-1 ring-slate-200">
            {open ? 'Less' : 'Why'}
          </button>
          {job.status !== 'applied' && (
            <button onClick={() => onStatus('applied')} className="rounded bg-emerald-600 px-2 py-1 text-white">
              Applied
            </button>
          )}
          {job.status !== 'skipped' && (
            <button onClick={() => onStatus('skipped')} className="rounded px-2 py-1 ring-1 ring-slate-200">
              Skip
            </button>
          )}
          {job.status !== 'new' && (
            <button onClick={() => onStatus('new')} className="rounded px-2 py-1 ring-1 ring-slate-200">
              Undo
            </button>
          )}
        </div>
      </div>
      {job.contacts.length > 0 && (
        <p className="mt-2 text-sm">
          Contacts:{' '}
          {job.contacts.map((c, i) => (
            <span key={i} className="mr-3">
              {c.name}
              {c.email && (
                <a className="ml-1 text-blue-700" href={`mailto:${c.email}`}>
                  {c.email}
                </a>
              )}
              {c.linkedinUrl && (
                <a className="ml-1 text-blue-700" href={c.linkedinUrl} target="_blank" rel="noreferrer">
                  LinkedIn
                </a>
              )}
            </span>
          ))}
        </p>
      )}
      {open && (
        <div className="mt-2 space-y-1 text-sm text-slate-700">
          {job.reasons.length > 0 && <p>{job.reasons.join(' · ')}</p>}
          {job.missingSkills.length > 0 && <p>Missing: {job.missingSkills.join(', ')}</p>}
          {job.flags.length > 0 && <p className="text-xs text-slate-500">Flags: {job.flags.join(', ')}</p>}
        </div>
      )}
    </li>
  );
}
