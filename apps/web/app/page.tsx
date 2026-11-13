'use client';

import { useEffect, useMemo, useState } from 'react';
import { EMPTY, Filters, isKnownSource, Job, JobStatus, load, matchesFilters, mergeResults, NO_FILTERS, save, setStatus, sourceLabel, State, StoredJob } from '@/lib/store';

interface DiscoverStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  result: { picked: number; qualified: number; alreadyShown: number; bySource: Record<string, number>; report: string; seconds: number } | null;
  error: string | null;
}

interface DayStat {
  day: string;
  total: number;
  bySource: Record<string, number>;
  avgScore: number;
}
interface SkillDemand {
  skill: string;
  jobs: number;
  percent: number;
  status: 'on-resume' | 'not-on-resume' | 'partial' | 'missing';
}
interface Insights {
  generatedAt: string;
  jobsAnalysed: number;
  skills: SkillDemand[];
  missingEvidence: SkillDemand[];
  missingSkills: SkillDemand[];
  experience: { withYears: number; aboveYours: number; percentAboveYours: number; buckets: Record<string, number>; yours: number };
  seniority: Record<string, number>;
}

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
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [stats, setStats] = useState<DayStat[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [panel, setPanel] = useState<'none' | 'stats' | 'gaps'>('none');
  const [disc, setDisc] = useState<DiscoverStatus | null>(null);
  const [emailToo, setEmailToo] = useState(false);

  /** Ask the server how the background discover run is going; keep asking every 3 s while it runs. */
  async function pollDiscover() {
    try {
      const res = await fetch('/api/discover');
      if (!res.ok) return;
      const st = (await res.json()) as DiscoverStatus;
      setDisc(st);
      if (st.running) setTimeout(() => void pollDiscover(), 3000);
      else if (st.finishedAt && st.result) {
        await refresh();
        setTab('new');
        setFilters((f) => ({ ...f, picks: new Date().toISOString().slice(0, 10) }));
      }
    } catch {
      // API not running
    }
  }

  async function startDiscover() {
    setError(null);
    try {
      const res = await fetch(`/api/discover?days=${days}${emailToo ? '&email=1' : ''}`, { method: 'POST' });
      if (res.status !== 202 && res.status !== 409) throw new Error(`HTTP ${res.status}`);
      await pollDiscover();
    } catch (e) {
      setError(`Could not start discover: ${(e as Error).message}. Is the API running (npm start)?`);
    }
  }

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
      const [st, ins] = await Promise.all([fetch('/api/stats'), fetch('/api/insights')]);
      if (st.ok) setStats((await st.json()) as DayStat[]);
      if (ins.ok) setInsights((await ins.json()) as Insights | null);
    } catch {
      // API not running: show what this browser already has.
    }
  }

  // localStorage only exists in the browser, so read it after the first render, then add anything new from the API.
  useEffect(() => {
    setState(load());
    void refresh();
    void pollDiscover(); // picks up a run that is already going (e.g. after a page reload)
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
      .filter((j) => matchesFilters(j, filters))
      .sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? '') || b.score - a.score);
  }, [state, tab, query, startupsOnly, source, filters]);

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
        <button onClick={search} disabled={loading} className="rounded px-4 py-2 text-sm font-medium ring-1 ring-slate-300 disabled:opacity-50" title="Company career sites (the older search)">
          {loading ? 'Searching…' : 'Find jobs'}
        </button>
        <label className="flex items-center gap-1 text-sm text-slate-600" title="Also email the Excel report">
          <input type="checkbox" checked={emailToo} onChange={(e) => setEmailToo(e.target.checked)} />
          email
        </label>
        <button
          onClick={startDiscover}
          disabled={disc?.running}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          title="LinkedIn, Naukri, Instahyre, Wellfound, Hirist → up to 50 new jobs + skill gaps. Never applies. Chrome windows will open; do not close them."
        >
          {disc?.running ? 'Discovering…' : "Discover today's jobs"}
        </button>
      </header>

      {disc && (disc.running || disc.finishedAt) && <DiscoverPanel st={disc} onClose={() => setDisc(null)} />}

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

      <nav className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <select value={filters.picks} onChange={(e) => setFilters({ ...filters, picks: e.target.value })} className="rounded border px-2 py-1" aria-label="Daily picks">
          <option value="all">All found jobs</option>
          <option value="picks">Daily picks (all days)</option>
          {stats.map((d) => (
            <option key={d.day} value={d.day}>
              Picks of {d.day} ({d.total})
            </option>
          ))}
        </select>
        <select value={filters.minScore} onChange={(e) => setFilters({ ...filters, minScore: Number(e.target.value) })} className="rounded border px-2 py-1" aria-label="Minimum score">
          {[0, 60, 70, 80, 90].map((n) => (
            <option key={n} value={n}>
              {n ? `Score ≥ ${n}` : 'Any score'}
            </option>
          ))}
        </select>
        <select value={filters.postedWithinDays} onChange={(e) => setFilters({ ...filters, postedWithinDays: Number(e.target.value) })} className="rounded border px-2 py-1" aria-label="Posted within">
          {[0, 1, 3, 7, 14].map((n) => (
            <option key={n} value={n}>
              {n ? `Posted ≤ ${n} days ago` : 'Any posting date'}
            </option>
          ))}
        </select>
        <button onClick={() => setPanel(panel === 'stats' ? 'none' : 'stats')} className={`ml-auto rounded px-3 py-1 ring-1 ring-slate-200 ${panel === 'stats' ? 'bg-slate-900 text-white' : 'bg-white'}`}>
          Daily stats
        </button>
        <button onClick={() => setPanel(panel === 'gaps' ? 'none' : 'gaps')} className={`rounded px-3 py-1 ring-1 ring-slate-200 ${panel === 'gaps' ? 'bg-slate-900 text-white' : 'bg-white'}`}>
          Skill gaps
        </button>
      </nav>

      {panel === 'stats' && <StatsPanel stats={stats} />}
      {panel === 'gaps' && <GapsPanel insights={insights} />}

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
            {job.shownOn ? ` · picked ${job.shownOn}` : ''}
          </p>
          {job.missingSkills.length > 0 && <p className="text-xs text-amber-700">Missing skills: {job.missingSkills.join(', ')}</p>}
        </div>
        <div className="flex gap-1 text-xs">
          <button onClick={() => setOpen(!open)} className="rounded px-2 py-1 ring-1 ring-slate-200">
            {open ? 'Less' : 'Details'}
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
          {job.flags.length > 0 && <p className="text-xs text-slate-500">Flags: {job.flags.join(', ')}</p>}
          {job.description ? (
            <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs leading-relaxed text-slate-700">{job.description}</div>
          ) : (
            <p className="text-xs text-slate-500">No description saved for this job (open the link).</p>
          )}
        </div>
      )}
    </li>
  );
}

function StatsPanel({ stats }: { stats: DayStat[] }) {
  if (!stats.length) return <p className="mb-4 rounded bg-white p-3 text-sm text-slate-500 ring-1 ring-slate-200">No daily picks yet. Run: npm run discover</p>;
  const sources = [...new Set(stats.flatMap((d) => Object.keys(d.bySource)))].sort();
  return (
    <div className="mb-4 overflow-x-auto rounded bg-white p-3 ring-1 ring-slate-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="py-1 pr-3">Day</th>
            <th className="pr-3">Jobs</th>
            <th className="pr-3">Avg score</th>
            {sources.map((s) => (
              <th key={s} className="pr-3">
                {sourceLabel(s)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stats.map((d) => (
            <tr key={d.day} className="border-t border-slate-100">
              <td className="py-1 pr-3">{d.day}</td>
              <td className="pr-3 font-medium">{d.total}</td>
              <td className="pr-3">{d.avgScore}</td>
              {sources.map((s) => (
                <td key={s} className="pr-3">
                  {d.bySource[s] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_LABEL: Record<SkillDemand['status'], string> = { 'on-resume': 'You have it', 'not-on-resume': 'Have it, not on resume', partial: 'Partial', missing: 'Missing' };
const STATUS_CLASS: Record<SkillDemand['status'], string> = { 'on-resume': 'text-emerald-700', 'not-on-resume': 'text-amber-700', partial: 'text-sky-700', missing: 'text-red-700' };

function GapsPanel({ insights }: { insights: Insights | null }) {
  if (!insights || !insights.jobsAnalysed) return <p className="mb-4 rounded bg-white p-3 text-sm text-slate-500 ring-1 ring-slate-200">No analysis yet. Run: npm run discover</p>;
  const e = insights.experience;
  return (
    <div className="mb-4 space-y-3 rounded bg-white p-3 text-sm ring-1 ring-slate-200">
      <p className="text-slate-600">
        From {insights.jobsAnalysed} qualified jobs · {new Date(insights.generatedAt).toLocaleString()}. {e.withYears} state a minimum experience; {e.aboveYours} ({e.percentAboveYours}%) ask
        for more than your {e.yours} years.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <h3 className="font-medium text-red-700">Most demanded, missing</h3>
          <p>{insights.missingSkills.slice(0, 10).map((s) => `${s.skill} ${s.percent}%`).join(' · ') || '—'}</p>
        </div>
        <div>
          <h3 className="font-medium text-amber-700">You have these, but your resume does not show them</h3>
          <p>{insights.missingEvidence.slice(0, 10).map((s) => `${s.skill} ${s.percent}%`).join(' · ') || '—'}</p>
        </div>
      </div>
      <div className="max-h-80 overflow-y-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 pr-3">Skill</th>
              <th className="pr-3">Jobs</th>
              <th className="pr-3">%</th>
              <th>You</th>
            </tr>
          </thead>
          <tbody>
            {insights.skills.map((s) => (
              <tr key={s.skill} className="border-t border-slate-100">
                <td className="py-1 pr-3">{s.skill}</td>
                <td className="pr-3">{s.jobs}</td>
                <td className="pr-3">{s.percent}%</td>
                <td className={STATUS_CLASS[s.status]}>{STATUS_LABEL[s.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiscoverPanel({ st, onClose }: { st: DiscoverStatus; onClose: () => void }) {
  const r = st.result;
  return (
    <div className="mb-4 rounded bg-white p-3 text-sm ring-1 ring-slate-200">
      <div className="mb-2 flex items-center gap-2">
        <strong>{st.running ? 'Discovering… (Chrome windows will open and close by themselves — do not close them)' : st.error ? 'Discover failed' : 'Discover finished'}</strong>
        {!st.running && (
          <button onClick={onClose} className="ml-auto rounded px-2 py-0.5 text-xs ring-1 ring-slate-200">
            Close
          </button>
        )}
      </div>
      {r && (
        <p className="mb-2 text-emerald-800">
          {r.picked} new jobs today ({r.qualified} qualified, {r.alreadyShown} already shown before) ·{' '}
          {Object.entries(r.bySource)
            .map(([k, v]) => `${sourceLabel(k)} ${v}`)
            .join(', ') || 'none'}{' '}
          · {r.seconds}s · Excel: {r.report}
        </p>
      )}
      {st.error && <p className="mb-2 text-red-700">{st.error}</p>}
      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-700">{st.log.slice(-40).join('\n') || 'Starting…'}</pre>
    </div>
  );
}
