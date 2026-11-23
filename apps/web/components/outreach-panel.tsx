'use client';

import { useEffect, useState } from 'react';

interface Outreach {
  summary: string;
  matches: { requirementQuote: string; explanation: string; evidence: { id: string; source: 'profile' | 'resume'; locator: string; quote: string } }[];
  gaps: { requirementQuote: string; explanation: string }[];
  questions: string[];
  drafts: { email: { subject: string; body: string }; linkedin: string } | null;
  model: string;
  generatedAt: string;
  cached: boolean;
}

export function OllamaStatus() {
  const [status, setStatus] = useState<{ ready: boolean; model: string; error: string | null } | null>(null);
  async function check() {
    setStatus(null);
    try {
      const response = await fetch('/api/ollama', { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error('Status unavailable');
      setStatus(await response.json());
    } catch {
      setStatus({ ready: false, model: '', error: 'Could not check Ollama. Start the API with npm start.' });
    }
  }
  useEffect(() => {
    void check();
    const changed = () => void check();
    window.addEventListener('ollama-settings-changed', changed);
    return () => window.removeEventListener('ollama-settings-changed', changed);
  }, []);
  return (
    <div className="mb-4 rounded bg-white px-3 py-2 text-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${status?.ready ? 'bg-emerald-500' : 'bg-slate-300'}`} aria-hidden="true" />
        <span>{!status ? 'Checking Ollama…' : status.ready ? `Local outreach ready · ${status.model}` : 'Ollama setup needed for outreach'}</span>
        <button type="button" onClick={() => void check()} className="ml-auto text-xs text-blue-700 underline" disabled={!status}>Check again</button>
      </div>
      {status && !status.ready && <p className="mt-1 text-xs text-slate-600">{status.error} <button type="button" onClick={() => window.dispatchEvent(new Event('open-career-setup'))} className="text-blue-700 underline">Open Setup</button> to download or select a model. Job discovery works while Ollama is unavailable.</p>}
    </div>
  );
}

function Draft({ label, initial }: { label: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const [notice, setNotice] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('Copied');
    } catch {
      setNotice('Select the text and copy it manually.');
    }
  }
  return (
    <div className="block">
      <span className="mb-1 block font-medium">{label}</span>
      <textarea aria-label={label} value={value} onChange={(e) => { setValue(e.target.value); setNotice(''); }} rows={label === 'Email' ? 10 : 5} className="w-full rounded border border-slate-300 bg-white p-2 text-sm leading-relaxed" />
      <span className="mt-1 flex items-center gap-2">
        <button type="button" onClick={() => void copy()} className="rounded bg-slate-900 px-3 py-1 text-xs text-white">Copy {label.toLowerCase()}</button>
        <span role="status" className="text-xs text-slate-500">{notice}</span>
      </span>
    </div>
  );
}

export function OutreachPanel({ jobId }: { jobId: string }) {
  const [result, setResult] = useState<Outreach | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function prepare() {
    if (result) { setOpen(!open); return; }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/outreach?jobId=${encodeURIComponent(jobId)}`, { method: 'POST', signal: AbortSignal.timeout(310000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setResult(body as Outreach);
      setOpen(true);
    } catch (e) {
      setError(e instanceof Error && e.name === 'TimeoutError' ? 'Preparing outreach took too long. Check Ollama and try again.' : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-3 border-t border-slate-100 pt-2 text-sm">
      <button type="button" onClick={() => void prepare()} disabled={loading} aria-expanded={open} className="rounded px-3 py-1 text-blue-800 ring-1 ring-blue-200 disabled:opacity-50">
        {loading ? 'Preparing outreach…' : result ? open ? 'Hide outreach' : 'Show outreach' : 'Prepare outreach'}
      </button>
      {loading && <span role="status" className="ml-2 text-xs text-slate-500">The first run may take a couple of minutes while the local model loads.</span>}
      {error && <p role="alert" className="mt-2 rounded bg-amber-50 p-2 text-amber-800">{error}</p>}
      {result && (
        <section hidden={!open} aria-label="Outreach review" className="mt-3 space-y-4 rounded bg-slate-50 p-3">
          <div>
            <h3 className="font-semibold">Review outreach</h3>
            <p className="text-xs text-slate-500">{result.model} · {new Date(result.generatedAt).toLocaleString()}{result.cached ? ' · Saved analysis' : ''}. Review before using. Copying does not send a message.</p>
          </div>
          <div>
            <h4 className="font-medium">Ollama’s assessment</h4>
            <p className="mt-1 text-slate-700">{result.summary}</p>
          </div>
          {result.matches.length > 0 && (
            <div>
              <h4 className="font-medium">Relevant experience and sources</h4>
              <ul className="mt-2 space-y-2">
                {result.matches.map((match) => (
                  <li key={match.evidence.id} className="rounded bg-white p-2 ring-1 ring-slate-200">
                    <p><span className="font-medium">Job asks:</span> “{match.requirementQuote}”</p>
                    <p className="mt-1"><span className="font-medium">Your evidence:</span> {match.evidence.quote}</p>
                    <p className="mt-1 text-xs text-slate-500">{match.evidence.source === 'resume' ? 'Resume' : 'Candidate profile'} · {match.evidence.locator}</p>
                    <p className="mt-1 text-xs text-slate-600">Ollama: {match.explanation}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.gaps.length > 0 && <div><h4 className="font-medium">Gaps to review</h4><ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">{result.gaps.map((gap, i) => <li key={i}>“{gap.requirementQuote}” — {gap.explanation}</li>)}</ul></div>}
          {result.questions.length > 0 && <div><h4 className="font-medium">Details to clarify</h4><ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">{result.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
          {result.drafts ? (
            <div className="space-y-4">
              <p className="text-xs text-slate-600">Drafts use the source text above. Edit the wording for your recipient, keeping claims accurate.</p>
              <Draft label="Email" initial={`Subject: ${result.drafts.email.subject}\n\n${result.drafts.email.body}`} />
              <Draft label="LinkedIn message" initial={result.drafts.linkedin} />
            </div>
          ) : <p className="text-amber-800">No supporting experience was selected. Review the gaps and clarify your experience before drafting a message.</p>}
        </section>
      )}
    </div>
  );
}
