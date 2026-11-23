'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { StoredJob } from '@/lib/store';
import { NaukriPanel, useNaukriRun } from './naukri-panel';

interface Review {
  running: boolean;
  phase: 'idle' | 'opening' | 'waiting' | 'filling' | 'review' | 'closed' | 'failed';
  kind: 'application' | 'login';
  job: { id: string; title: string; company: string } | null;
  site: string | null;
  answers: { id: string; label: string; value: string | null; source: string | null; reason: string; canSave: boolean }[];
  warning: string | null;
  error: string | null;
  message: string;
  paused: boolean;
}
interface Answer { match: string[]; answer: string; source?: string }
interface Book { answers: Answer[]; questions: { question: string; site: string; job: string }[] }
interface Download { running: boolean; model: string | null; message: string; percent: number | null; error: string | null }
interface Models { selected: string; models: { name: string; size: number | null }[]; download: Download; error: string | null }
type Tab = 'jobs' | 'linkedin' | 'wellfound' | 'hirist' | 'instahyre' | 'external' | 'naukri' | 'applications' | 'answers' | 'setup';
const ApplicationActions = createContext<{ open: (id: string) => void; busy: boolean }>({ open: () => undefined, busy: false });

async function api<T>(url: string, body?: unknown, timeout = 10000): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}
const button = 'rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50';
const secondary = 'rounded border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50';
const input = 'w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm';

export function FillApplicationButton({ job }: { job: StoredJob }) {
  const actions = useContext(ApplicationActions);
  if (!['NAUKRI', 'HIRIST', 'INSTAHYRE'].includes(job.source) || job.flags.includes('apply:company-site') || job.status === 'applied') return null;
  return <button type="button" disabled={actions.busy} onClick={() => actions.open(job.id)} className="mt-2 rounded px-3 py-1 text-sm text-emerald-800 ring-1 ring-emerald-200 disabled:opacity-50">Fill and review application</button>;
}

export function CareerWorkspace({ jobs, discoveryRunning, children, onNaukriBusy }: { jobs: StoredJob[]; discoveryRunning: boolean; children: ReactNode; onNaukriBusy?: (busy: boolean) => void }) {
  const [tab, setTab] = useState<Tab>('jobs');
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosenJob, setChosenJob] = useState('');
  const [book, setBook] = useState<Book>({ answers: [], questions: [] });
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [notice, setNotice] = useState('');
  const [models, setModels] = useState<Models | null>(null);
  const [modelChoice, setModelChoice] = useState('');
  const [downloadName, setDownloadName] = useState('qwen3:4b');
  const naukri = useNaukriRun();
  const hirist = useNaukriRun('hirist');
  const instahyre = useNaukriRun('instahyre');
  const external = useNaukriRun('external');
  const linkedin = useNaukriRun('linkedin');
  const wellfound = useNaukriRun('wellfound');
  const autoRunning = !!(naukri.status?.running || hirist.status?.running || instahyre.status?.running || external.status?.running || linkedin.status?.running || wellfound.status?.running);
  const runs = { naukri, hirist, instahyre, linkedin, wellfound, external };
  const autoPlatform = tab === 'naukri' || tab === 'hirist' || tab === 'instahyre' || tab === 'external' || tab === 'linkedin' || tab === 'wellfound' ? tab : null;
  useEffect(() => { onNaukriBusy?.(autoRunning); }, [autoRunning, onNaukriBusy]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api<Review>('/api/application');
        if (!stopped) { setReview(value); timer = setTimeout(() => void poll(), value.running ? 1500 : 5000); }
      } catch { if (!stopped) timer = setTimeout(() => void poll(), 5000); }
    }
    void poll();
    const setup = () => setTab('setup');
    window.addEventListener('open-career-setup', setup);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('open-career-setup', setup); };
  }, []);

  useEffect(() => {
    if (tab === 'answers') void api<Book>('/api/application/answers').then(setBook).catch((e: Error) => setError(e.message));
    if (tab === 'setup') void api<Models>('/api/ollama/models').then((m) => { setModels(m); setModelChoice(m.selected); }).catch((e: Error) => setError(e.message));
  }, [tab]);

  useEffect(() => {
    if (!models?.download.running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const download = await api<Download>('/api/ollama/pull');
        if (stopped) return;
        if (download.running) {
          setModels((old) => old ? { ...old, download } : old);
          timer = setTimeout(() => void poll(), 1500);
        }
        else {
          const updated = await api<Models>('/api/ollama/models');
          if (!stopped) { setModels(updated); setModelChoice(updated.selected); window.dispatchEvent(new Event('ollama-settings-changed')); }
        }
      } catch (e) { if (!stopped) { setError((e as Error).message); timer = setTimeout(() => void poll(), 3000); } }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [models?.download.running]);

  async function action(work: () => Promise<void>) {
    setBusy(true); setError(null); setNotice('');
    try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function openApplication(id: string) {
    setTab('applications'); setChosenJob(id);
    void action(async () => setReview(await api<Review>(`/api/application/open?jobId=${encodeURIComponent(id)}`, {})));
  }
  async function reviewAction(kind: 'fill' | 'resume' | 'close') {
    await action(async () => setReview(await api<Review>(`/api/application/${kind}`, {}, kind === 'fill' ? 310000 : 15000)));
  }
  async function saveAnswer(value: string, q: string, replaceMatch?: string[]) {
    await action(async () => {
      setBook(await api<Book>('/api/application/answers', { question: q, answer: value, replaceMatch }));
      setNotice('Answer saved and confirmed.');
      if (!replaceMatch) { setQuestion(''); setAnswer(''); }
    });
  }
  async function removeAnswer(match: string[]) {
    await action(async () => {
      const response = await fetch('/api/application/answers', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ match }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? 'Could not remove the answer.');
      setBook(value as Book); setNotice('Saved answer removed.');
    });
  }
  const available = jobs.filter((j) => ['NAUKRI', 'HIRIST', 'INSTAHYRE'].includes(j.source) && j.status !== 'applied' && !j.flags.includes('apply:company-site'));
  const browserBusy = busy || discoveryRunning || !!review?.running || autoRunning;
  const titles: Record<Tab, string> = { jobs: 'Jobs', naukri: 'Naukri auto-apply', hirist: 'Hirist auto-apply', instahyre: 'Instahyre auto-apply', external: 'Company websites', linkedin: 'LinkedIn Easy Apply', wellfound: 'Wellfound auto-apply', applications: 'Apply & review', answers: 'Saved answers', setup: 'Setup' };

  return (
    <ApplicationActions.Provider value={{ open: openApplication, busy: browserBusy }}>
      <div className="mx-auto max-w-5xl px-4 pt-5">
        <nav aria-label="Career workspace" className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-3">
          {(Object.keys(titles) as Tab[]).map((key) => <button key={key} type="button" onClick={() => { setTab(key); setError(null); setNotice(''); }} aria-current={tab === key ? 'page' : undefined} className={`rounded px-3 py-2 text-sm font-medium ${tab === key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{titles[key]}{key === 'applications' && review?.running ? ' •' : ''}</button>)}
          {review?.running && <button type="button" onClick={() => setTab('applications')} className="ml-auto text-xs text-emerald-800">{review.phase === 'filling' ? 'Filling form…' : review.paused ? 'Form ready for review' : 'Chrome session open'}</button>}
          {autoRunning && <button type="button" onClick={() => setTab((Object.entries(runs).find(([, run]) => run.status?.running)?.[0] ?? 'naukri') as Tab)} className="ml-auto text-xs text-amber-800">{Object.values(runs).some((run) => run.status?.handoff) ? 'Application needs your input' : 'Application run in progress'}</button>}
        </nav>
      </div>
      <div hidden={tab !== 'jobs'}>{children}</div>
      {autoPlatform && <NaukriPanel key={autoPlatform} platform={autoPlatform} run={runs[autoPlatform]} browserBusy={discoveryRunning || !!review?.running || autoRunning && !runs[autoPlatform].status?.running} onAnswer={(q) => { setQuestion(q ?? ''); setAnswer(''); setTab('answers'); }} />}
      {tab !== 'jobs' && !autoPlatform && (
        <main className="mx-auto max-w-5xl space-y-5 px-4 py-6">
          <header><h1 className="text-2xl font-semibold">{titles[tab]}</h1><p className="mt-1 text-sm text-slate-600">{tab === 'applications' ? 'Fill one application step at a time and review it in your own Chrome.' : tab === 'answers' ? 'Confirm the facts you want reused in application forms.' : 'Connect your local model and log in to your job boards.'}</p></header>
          {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          {notice && <p role="status" className="rounded bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
          {tab === 'applications' && <>
            <section className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200">
              <h2 className="font-semibold">Choose an application</h2>
              <label className="block text-sm">Saved job<select aria-label="Application job" value={chosenJob} onChange={(e) => setChosenJob(e.target.value)} className={`${input} mt-1`}><option value="">Select a job</option>{available.map((j) => <option key={j.id} value={j.id}>{j.company} — {j.title} ({j.score})</option>)}</select></label>
              {!available.length && <p className="text-sm text-slate-500">Find jobs from Naukri, Hirist or Instahyre first. Employer-site applications currently need manual completion.</p>}
              <button type="button" disabled={!chosenJob || browserBusy} onClick={() => openApplication(chosenJob)} className={button}>Open application in Chrome</button>
              {discoveryRunning && <p className="text-xs text-amber-800">Wait for discovery to finish before opening Chrome here.</p>}
            </section>
            {review && review.phase !== 'idle' && <section aria-label="Application session" className="space-y-4 rounded-lg bg-white p-4 ring-1 ring-slate-200">
              <div><h2 className="font-semibold">{review.job ? `${review.job.company} — ${review.job.title}` : `Job board login · ${review.site}`}</h2><p role="status" className="mt-2 text-sm text-slate-700">{review.message}</p></div>
              {review.error && <p role="alert" className="rounded bg-amber-50 p-3 text-sm text-amber-800">{review.error}</p>}
              {review.warning && <p className="text-sm text-amber-800">Ollama: {review.warning} Saved facts were still considered.</p>}
              {review.running && <div className="flex flex-wrap gap-2">
                {review.kind === 'application' && <button type="button" disabled={busy || review.paused || !['waiting', 'review'].includes(review.phase)} onClick={() => void reviewAction('fill')} className={button}>{review.phase === 'filling' ? 'Filling…' : 'Fill visible form'}</button>}
                {review.paused && <button type="button" disabled={busy || review.phase === 'filling'} onClick={() => void reviewAction('resume')} className={secondary}>Enable page controls</button>}
                <button type="button" disabled={busy && review.phase !== 'filling'} onClick={() => void reviewAction('close')} className={secondary}>Close Chrome session</button>
              </div>}
              {review.answers.length > 0 && <ul className="divide-y divide-slate-100">{review.answers.map((row) => <li key={row.id} className="py-3 text-sm"><p className="font-medium">{row.label}</p>{row.value !== null ? <p className="mt-1 whitespace-pre-wrap break-words text-emerald-800">{row.value}</p> : <p className="mt-1 text-amber-800">Needs your review</p>}<p className="mt-1 text-xs text-slate-500">{row.reason}</p>{row.value === null && row.canSave && <button type="button" onClick={() => { setQuestion(row.label); setAnswer(''); setTab('answers'); }} className="mt-1 text-xs text-blue-700 underline">Save an answer</button>}</li>)}</ul>}
            </section>}
            <p className="text-sm text-slate-500">Open the form yourself, fill the visible step here, then review the values in Chrome. Enable page controls to use Next or Submit yourself. Passwords, uploads, consent boxes and sensitive questions stay under your control.</p>
          </>}
          {tab === 'answers' && <>
            <section className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200">
              <h2 className="font-semibold">Add a confirmed answer</h2>
              <div className="flex flex-wrap gap-2">{['Current CTC (LPA)', 'Expected CTC (LPA)', 'Notice period (days)', 'Total years of experience', 'Years of experience in Node.js', 'Are you legally authorized to work in India?'].map((q) => <button key={q} type="button" className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700" onClick={() => setQuestion(q)}>{q}</button>)}</div>
              <label className="block text-sm">Question<input aria-label="Application question" className={`${input} mt-1`} value={question} maxLength={600} onChange={(e) => setQuestion(e.target.value)} placeholder="What is your notice period in days?" /></label>
              <label className="block text-sm">Your answer<textarea aria-label="Your confirmed answer" className={`${input} mt-1`} rows={3} value={answer} maxLength={6000} onChange={(e) => setAnswer(e.target.value)} placeholder="Use the exact value, including units where relevant." /></label>
              <button type="button" disabled={busy || !question.trim() || !answer.trim()} onClick={() => void saveAnswer(answer, question)} className={button}>Save confirmed answer</button>
            </section>
            {book.questions.length > 0 && <section className="space-y-2 rounded-lg bg-white p-4 ring-1 ring-slate-200"><h2 className="font-semibold">Questions found in applications</h2>{book.questions.map((q, i) => <button key={i} type="button" onClick={() => { setQuestion(q.question); setAnswer(''); }} className="block w-full rounded border border-slate-200 p-3 text-left text-sm hover:bg-slate-50">{q.question}<span className="mt-1 block text-xs text-slate-500">{q.site} · {q.job}</span></button>)}</section>}
            <section className="space-y-4 rounded-lg bg-white p-4 ring-1 ring-slate-200"><h2 className="font-semibold">Saved facts</h2><p className="text-sm text-slate-600">Name, contact details and education come from your candidate profile. Salary, notice period, work authorization and exact years require your confirmation here.</p>{!book.answers.length && <p className="text-sm text-slate-500">No saved answers yet.</p>}{book.answers.map((a) => <AnswerRow key={`${a.match.join('|')}:${a.answer}`} item={a} busy={busy} save={(value) => void saveAnswer(value, a.match.join(' '), a.match)} remove={() => void removeAnswer(a.match)} />)}</section>
          </>}
          {tab === 'setup' && <>
            <section className="space-y-4 rounded-lg bg-white p-4 ring-1 ring-slate-200">
              <div className="flex items-center gap-3"><h2 className="mr-auto font-semibold">Local Ollama model</h2><button type="button" className="text-sm text-blue-700 underline" onClick={() => void action(async () => { const m = await api<Models>('/api/ollama/models'); setModels(m); setModelChoice(m.selected); })}>Refresh</button></div>
              {!models && <p className="text-sm text-slate-500">Checking Ollama…</p>}
              {models?.error && <p className="text-sm text-amber-800">{models.error} <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="underline">Install Ollama</a> and open its desktop app once. Then manage models here.</p>}
              <label className="block text-sm">Installed model<select aria-label="Installed Ollama model" value={modelChoice} onChange={(e) => setModelChoice(e.target.value)} className={`${input} mt-1`}>{!models?.models.some((m) => m.name === modelChoice) && <option value={modelChoice}>{modelChoice || 'No installed models'}{modelChoice ? ' (not installed)' : ''}</option>}{models?.models.map((m) => <option key={m.name} value={m.name}>{m.name}{m.size ? ` · ${(m.size / 1e9).toFixed(1)} GB` : ''}</option>)}</select></label>
              <button type="button" disabled={busy || !models?.models.some((m) => m.name === modelChoice)} className={button} onClick={() => void action(async () => { setModels(await api<Models>('/api/ollama/models', { model: modelChoice })); setNotice('Model selected for outreach and autofill.'); window.dispatchEvent(new Event('ollama-settings-changed')); })}>Use selected model</button>
              <div className="border-t border-slate-100 pt-4"><label className="block text-sm">Download a local model<input aria-label="Model to download" className={`${input} mt-1`} value={downloadName} maxLength={150} onChange={(e) => setDownloadName(e.target.value)} /></label><p className="mt-1 text-xs text-slate-500">The default qwen3:4b is a starting point. Downloads can use several gigabytes of disk space; choose a model that fits your available memory.</p><button type="button" disabled={busy || !!models?.download.running || !downloadName.trim()} className={`${secondary} mt-3`} onClick={() => void action(async () => { const download = await api<Download>('/api/ollama/pull', { model: downloadName.trim() }); setModels((old) => old ? { ...old, download } : { selected: '', models: [], download, error: null }); })}>Download and use model</button></div>
              {models?.download.model && <div role="status" className="rounded bg-slate-50 p-3 text-sm"><p>{models.download.model}: {models.download.message}{models.download.percent !== null ? ` · ${models.download.percent}%` : ''}</p>{models.download.running && <button type="button" className="mt-2 text-blue-700 underline" onClick={() => void action(async () => { await api('/api/ollama/pull/cancel', {}); })}>Cancel download</button>}{models.download.error && <p className="mt-2 text-amber-800">{models.download.error}</p>}</div>}
            </section>
            <section className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200"><h2 className="font-semibold">Job board logins</h2><p className="text-sm text-slate-600">Log in directly in Chrome. The app keeps the session on your machine and does not read your password.</p>{['naukri', 'hirist', 'instahyre', 'linkedin', 'wellfound'].map((site) => <div key={site} className="flex flex-wrap items-center gap-2 rounded border border-slate-200 p-3"><span className="mr-auto capitalize">{site}</span><button type="button" disabled={browserBusy} className={secondary} onClick={() => { setTab('applications'); void action(async () => setReview(await api<Review>(`/api/application/login?site=${site}`, {}))); }}>Open login in Chrome</button></div>)}</section>
          </>}
        </main>
      )}
    </ApplicationActions.Provider>
  );
}

function AnswerRow({ item, busy, save, remove }: { item: Answer; busy: boolean; save: (answer: string) => void; remove: () => void }) {
  const [value, setValue] = useState(item.answer);
  const confirmed = item.source === 'you' || item.source === undefined;
  return <div className="space-y-2 border-t border-slate-100 pt-3"><label className="block text-sm font-medium">{item.match.join(' + ')}<input aria-label={`Answer for ${item.match.join(' ')}`} className={`${input} mt-1 font-normal`} value={value} onChange={(e) => setValue(e.target.value)} maxLength={6000} /></label><div className="flex flex-wrap items-center gap-3"><span className={`text-xs ${confirmed ? 'text-emerald-700' : 'text-amber-700'}`}>{confirmed ? 'Confirmed by you' : 'Needs confirmation before autofill'}</span><button type="button" className={secondary} disabled={busy || !value.trim()} onClick={() => save(value)}>{confirmed ? 'Save changes' : 'Confirm answer'}</button><button type="button" className="text-xs text-red-700 underline disabled:opacity-50" disabled={busy} onClick={remove}>Remove answer</button></div></div>;
}
