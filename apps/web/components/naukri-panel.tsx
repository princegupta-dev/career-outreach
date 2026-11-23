'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type Platform = 'naukri' | 'hirist' | 'instahyre' | 'linkedin' | 'wellfound' | 'external';
export const platformNames: Record<Platform, string> = { naukri: 'Naukri', hirist: 'Hirist', instahyre: 'Instahyre', linkedin: 'LinkedIn', wellfound: 'Wellfound', external: 'Company websites' };
interface Options { minScore: number; max: number; days: number }
interface Entry { jobId: string; title: string; company: string; url: string; at: string; status: string; note?: string }
interface RunStatus {
  running: boolean; stopping: boolean; mode: 'discover' | 'dry-run' | 'apply'; total: number; completed: number;
  startedAt: string | null; finishedAt: string | null; current: { id: string; title: string; company: string } | null;
  answers: { id: string; label: string; value: string | null; reason: string; canSave: boolean }[];
  message: string; results: Entry[]; log: string[]; error: string | null;
  handoff?: { token: string; reason: string; message: string; url: string; jobId: string } | null;
}
interface Preview {
  jobs: { id: string; title: string; company: string; url: string; score: number; postedAt: string | null }[];
  qualified: number; excluded: Record<string, number>; remainingToday: number; dailyLimit: number;
  confirmedAnswers: number; token: string; mode: 'off' | 'dry-run' | 'on'; options: Options;
  history: Entry[]; resume: { uploaded: boolean; name: string | null; bytes: number };
}
async function api<T>(url: string, body?: unknown) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}
export function useNaukriRun(platform: Platform = 'naukri') {
  const [status, setStatus] = useState<RunStatus | null>(null);
  const previous = useRef('');
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api<RunStatus>(`/api/${platform}/status`);
        if (!stopped) {
          setStatus(value);
          const fingerprint = `${value.startedAt}:${value.completed}:${value.finishedAt}`;
          if (previous.current && previous.current !== fingerprint) window.dispatchEvent(new Event('naukri-results-changed'));
          previous.current = fingerprint;
          timer = setTimeout(() => void poll(), value.running ? 1000 : 4000);
        }
      } catch { if (!stopped) timer = setTimeout(() => void poll(), 4000); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [platform]);
  return { status, setStatus };
}
const primary = 'rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50';
const secondary = 'rounded border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50';
const input = 'mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm';
const labels: Record<string, string> = { applied: 'Applied', 'already-applied': 'Already applied', 'dry-run': 'Checked — not sent', 'needs-answers': 'Needs answers', 'verification-required': 'Verify on website', external: 'Employer website', 'no-button': 'Closed or unavailable', failed: 'Failed' };

export function NaukriPanel({ run, browserBusy, onAnswer, platform = 'naukri' }: { run: ReturnType<typeof useNaukriRun>; browserBusy: boolean; onAnswer: (question?: string) => void; platform?: Platform }) {
  const label = platformNames[platform];
  const [preview, setPreview] = useState<Preview | null>(null);
  const [options, setOptions] = useState<Options>({ minScore: 70, max: 15, days: 7 });
  const [mode, setMode] = useState<'off' | 'dry-run' | 'on'>('dry-run');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const status = run.status;
  const currentOptions = useRef(options); currentOptions.current = options;
  const running = !!status?.running;
  const dirty = !!preview && (preview.mode !== mode || JSON.stringify(preview.options) !== JSON.stringify(options));

  const act = useCallback(async (work: () => Promise<void>) => { setBusy(true); setError(null); setNotice(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }, []);
  const refresh = useCallback(async (o?: Options) => {
    const query = o ? `?${new URLSearchParams({ minScore: String(o.minScore), max: String(o.max), days: String(o.days) })}` : '';
    const value = await api<Preview>(`/api/${platform}/preview${query}`); setPreview(value); setOptions(value.options); setMode(value.mode);
  }, [platform]);
  useEffect(() => { void act(() => refresh()); }, [act, refresh]);
  useEffect(() => {
    if (status?.finishedAt) void act(() => refresh(currentOptions.current));
    // Reload persisted results after a completed run.
  }, [status?.finishedAt, act, refresh]);

  async function start(kind: 'dry-run' | 'apply') {
    if (!preview) return;
    await act(async () => run.setStatus(await api<RunStatus>(`/api/${platform}/start`, { ...options, mode: kind, token: preview.token })));
  }
  async function upload(file?: File) {
    if (!file) return;
    await act(async () => {
      if (file.size > 8 * 1024 * 1024 || !file.name.toLowerCase().endsWith('.pdf')) throw new Error('Choose a PDF resume no larger than 8 MB.');
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read the selected PDF.')); reader.readAsDataURL(file); });
      await api(`/api/${platform}/resume`, { base64 }); await refresh(options); setNotice('PDF saved for supported application forms across all platforms.');
    });
  }

  return <section className="mx-auto max-w-5xl space-y-5 px-4 py-6">
    <header><h1 className="text-2xl font-semibold">{label} auto-apply</h1><p className="mt-1 text-sm text-slate-600">Apply to jobs matching your current profile and preferences. Screening questions use confirmed facts and verified experience.</p></header>
    {platform === 'external' && <p className="rounded bg-blue-50 p-3 text-sm text-blue-900">Supports Greenhouse, Lever, Ashby, Workday and supported custom career forms. Sign in, complete CAPTCHA, or handle custom steps in Chrome when the run pauses, then continue here. The app never reads passwords or solves CAPTCHA.</p>}
    {platform === 'linkedin' && <p className="rounded bg-blue-50 p-3 text-sm text-blue-900">Uses Easy Apply dialogs in your signed-in Chrome. Employer-site applications belong in Company websites. LinkedIn limits stop the run; follow-company options are left off.</p>}
    {platform === 'wellfound' && <p className="rounded bg-blue-50 p-3 text-sm text-blue-900">Uses your Wellfound profile and supported Send Application forms. Required notes use confirmed text or verified experience; missing information pauses for your input.</p>}
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {notice && <p role="status" className="rounded bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
    <section className="space-y-4 rounded-lg bg-white p-4 ring-1 ring-slate-200">
      <h2 className="font-semibold">Your application rules</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-sm">{label} mode<select aria-label={`${label} mode`} className={input} value={mode} disabled={running || busy || !preview} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="off">Off</option><option value="dry-run">Check jobs only</option><option value="on">Automatic submissions</option></select></label>
        <label className="text-sm">Minimum match score<input aria-label={`${label} minimum score`} className={input} type="number" min={0} max={100} value={options.minScore} disabled={running || busy || !preview} onChange={(e) => setOptions({ ...options, minScore: Number(e.target.value) })} /></label>
        <label className="text-sm">Jobs per run<input aria-label={`${label} jobs per run`} className={input} type="number" min={1} max={30} value={options.max} disabled={running || busy || !preview} onChange={(e) => setOptions({ ...options, max: Number(e.target.value) })} /></label>
        <label className="text-sm">Posted within<select aria-label={`${label} posting window`} className={input} value={options.days} disabled={running || busy || !preview} onChange={(e) => setOptions({ ...options, days: Number(e.target.value) })}>{[1,3,7,14,30].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
      </div>
      <div className="flex flex-wrap items-center gap-3"><button type="button" className={secondary} disabled={busy || running} onClick={() => void act(async () => { const value = await api<Preview>(`/api/${platform}/settings`, { ...options, mode }); setPreview(value); setNotice(`${label} rules saved. Review the matching jobs below.`); })}>Save rules & preview</button><button type="button" className="text-sm text-blue-700 underline disabled:opacity-50" disabled={busy || running} onClick={() => void act(() => refresh(options))}>Refresh preview</button><button type="button" className="text-sm text-blue-700 underline" onClick={() => onAnswer()}>Manage confirmed answers</button></div>
      {dirty && <p className="text-xs text-amber-800">Save or refresh the preview before starting with changed rules.</p>}
      {preview && <p className="text-sm text-slate-600">{preview.confirmedAnswers} confirmed answers · {preview.remainingToday} of {preview.dailyLimit} daily application slots remaining. Applications awaiting verification reserve a slot.</p>}
      <details className="text-sm"><summary className="cursor-pointer text-slate-700">Resume for upload questions</summary><p className="mt-2 text-xs text-slate-500">{platform === 'external' ? 'Company forms usually require a PDF upload.' : `${label} normally uses the resume in your board profile.`} Add a PDF here for forms that explicitly request an upload. This PDF is shared across platforms.</p><label className="mt-2 block">Application resume (PDF, up to 8 MB)<input aria-label={`${label} application resume`} type="file" accept="application/pdf,.pdf" disabled={busy || running} className="mt-1 block max-w-full text-sm" onChange={(e) => void upload(e.target.files?.[0])} /></label>{preview?.resume.uploaded && <p className="mt-2 text-xs text-emerald-800">Resume saved · {(preview.resume.bytes / 1024).toFixed(0)} KB</p>}</details>
    </section>
    <section className="space-y-4 rounded-lg bg-white p-4 ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto font-semibold">Matching jobs in this run</h2><button type="button" className={secondary} disabled={busy || running || browserBusy} onClick={() => void act(async () => run.setStatus(await api<RunStatus>(`/api/${platform}/find`, { days: options.days })))}>Find fresh {platform === 'external' ? 'company' : label} jobs</button>{preview && <span className="text-sm text-slate-500">{preview.jobs.length} selected · {preview.qualified} qualified</span>}</div>
      {!preview ? <p className="text-sm text-slate-500">Preparing your job preview…</p> : !preview.jobs.length ? <p className="text-sm text-slate-600">No eligible jobs in this preview. Find fresh jobs or adjust the posting window. Previously applied jobs are excluded.</p> : <ul className="divide-y divide-slate-100">{preview.jobs.map((job) => <li key={job.id} className="flex gap-3 py-2 text-sm"><span className="h-fit rounded bg-slate-100 px-2 py-1 font-semibold">{job.score}</span><div className="min-w-0"><a className="font-medium text-blue-800 hover:underline" href={job.url} target="_blank" rel="noreferrer">{job.title}</a><p className="text-slate-600">{job.company} · {job.postedAt?.slice(0, 10) ?? 'posting date unknown'}</p></div></li>)}</ul>}
      <div className="flex flex-wrap gap-2"><button type="button" className={secondary} disabled={busy || running || browserBusy || dirty || !preview?.jobs.length} onClick={() => void start('dry-run')}>Check jobs without applying</button><button type="button" className={primary} disabled={busy || running || browserBusy || dirty || mode !== 'on' || !preview?.jobs.length} onClick={() => void start('apply')}>Auto-apply to {preview?.jobs.length ?? 0} matching jobs</button></div>
      {browserBusy && !running && <p className="text-xs text-amber-800">Close the application/login Chrome session or wait for discovery before starting.</p>}
      <p className="text-xs text-slate-500">Automatic submissions click Apply and complete supported screening steps. Login, CAPTCHA, unknown answers and unsupported steps pause for your input in Chrome. Certificate errors stop the run. You can stop the run at any time.</p>
      {preview && Object.keys(preview.excluded).length > 0 && <details className="text-sm"><summary className="cursor-pointer text-slate-600">Why other jobs were excluded</summary><ul className="mt-2 list-disc pl-5 text-slate-500">{Object.entries(preview.excluded).map(([reason, n]) => <li key={reason}>{reason}: {n}</li>)}</ul></details>}
    </section>
    {status?.handoff && <section aria-label="Application needs your input" className="space-y-3 rounded-lg bg-amber-50 p-4 ring-1 ring-amber-300">
      <h2 className="font-semibold text-amber-950">Continue in Chrome</h2>
      <p className="whitespace-pre-wrap text-sm text-amber-950">{status.handoff.message}</p>
      <p className="break-all text-xs text-amber-800">{status.handoff.url}</p>
      <p className="text-xs text-amber-800">Keep the intended job open. Complete login, verification or the requested form step yourself. If you submit manually, continue here so the app can check the confirmation. Skipped or interrupted handoffs need verification before retry.</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={primary} disabled={busy || status.stopping} onClick={() => void act(async () => run.setStatus(await api<RunStatus>(`/api/${platform}/continue`, { token: status.handoff!.token, action: 'resume' })))}>I completed the step — continue</button><button type="button" className={secondary} disabled={busy || status.stopping} onClick={() => void act(async () => run.setStatus(await api<RunStatus>(`/api/${platform}/continue`, { token: status.handoff!.token, action: 'skip' })))}>Skip this job</button><button type="button" className="text-sm text-blue-700 underline" onClick={() => onAnswer()}>Manage saved answers</button></div>
    </section>}
    {status && (running || status.finishedAt) && <section aria-label={`${label} run progress`} className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto font-semibold">{running ? status.mode === 'apply' ? `Applying on ${label}` : status.mode === 'discover' ? `Finding ${label} jobs` : `Checking ${label} jobs` : `${label} run results`}</h2><span className="text-sm">{status.completed}/{status.total}</span>{running && <button type="button" disabled={status.stopping} className="rounded bg-red-700 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={() => void act(async () => run.setStatus(await api<RunStatus>(`/api/${platform}/stop`, {})))}>{status.stopping ? 'Stopping…' : 'Stop run'}</button>}</div>
      <p role="status" className="text-sm text-slate-700">{status.message}</p>{status.error && <p role="alert" className="text-sm text-red-800">{status.error}</p>}
      {status.answers.length > 0 && <details open className="text-sm"><summary className="cursor-pointer font-medium">Current screening answers</summary><ul className="mt-2 space-y-2">{status.answers.map((answer) => <li key={answer.id} className="rounded bg-slate-50 p-2"><p className="font-medium">{answer.label}</p><p className={answer.value === null ? 'text-amber-800' : 'whitespace-pre-wrap text-emerald-800'}>{answer.value ?? answer.reason}</p>{answer.value === null && answer.canSave && <button type="button" className="mt-1 text-blue-700 underline" onClick={() => onAnswer(answer.label)}>Save a confirmed answer</button>}</li>)}</ul></details>}
      <Results entries={status.results} label={label} />
      <details className="text-sm"><summary className="cursor-pointer text-slate-600">Run log</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">{status.log.join('\n')}</pre></details>
    </section>}
    {preview && <section className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200"><div className="flex flex-wrap gap-3"><h2 className="mr-auto font-semibold">{label} application history</h2><button hidden={platform !== 'naukri'} type="button" className="text-sm text-blue-700 underline disabled:opacity-50" disabled={busy || running} onClick={() => void act(async () => { const value = await api<{ corrected: Entry[] }>(`/api/${platform}/reconcile`, {}); await refresh(options); setNotice(`Verified ${value.corrected.length} saved confirmations. Application dates were preserved.`); window.dispatchEvent(new Event('naukri-results-changed')); })}>Verify saved confirmations</button></div><Results label={label} entries={preview.history} retryDisabled={busy || running} retry={(jobId) => void act(async () => { await api(`/api/${platform}/retry`, { jobId, checkedNotApplied: true }); await refresh(options); setNotice('Job released for retry based on your website check. Review the preview before starting.'); })} />{!preview.history.length && <p className="text-sm text-slate-500">Your {label} run results will appear here.</p>}</section>}
  </section>;
}

function Results({ entries, retry, retryDisabled, label }: { label: string; entries: Entry[]; retry?: (id: string) => void; retryDisabled?: boolean }) {
  return <ul className="divide-y divide-slate-100">{entries.map((entry, i) => <li key={`${entry.jobId}:${i}`} className="py-3 text-sm"><div className="flex flex-wrap gap-2"><a href={entry.url} target="_blank" rel="noreferrer" className="mr-auto font-medium text-blue-800 hover:underline">{entry.company} — {entry.title}</a><span className={`rounded px-2 py-0.5 text-xs ${['applied','already-applied'].includes(entry.status) ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>{labels[entry.status] ?? entry.status}</span></div>{entry.note && <p className="mt-1 break-words text-xs text-slate-600">{entry.note}</p>}{retry && (entry.status === 'verification-required' || (entry.status === 'failed' && /clicked apply|no confirmation|locator\.click.*timeout/i.test(entry.note ?? ''))) && <div className="mt-2 text-xs text-amber-800"><p>Open this job on {label} and verify its application status before allowing another attempt.</p><button type="button" disabled={retryDisabled} className="mt-1 underline disabled:opacity-50" onClick={() => retry(entry.jobId)}>I checked {label}: not applied — allow retry</button></div>}<p className="mt-1 text-xs text-slate-400">{new Date(entry.at).toLocaleString()}</p></li>)}</ul>;
}
