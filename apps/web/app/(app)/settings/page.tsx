'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import useSWR from 'swr';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, Field, Input, Select, Spinner, useAction, useToast } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface Settings {
  timezone: string;
  outreach: {
    dailyLimit: number;
    dailyInitialLimit: number;
    companyCooldownDays: number;
    recipientCooldownDays: number;
    minMinutesBetweenSends: number;
    defaultStyle: string;
    sendMode: 'DRY_RUN' | 'DRAFT_ONLY' | 'APPROVAL_REQUIRED' | 'AUTO_SEND';
    hourlyLimit: number;
    perDomainDailyLimit: number;
    maxJitterSeconds: number;
    autoSendMinScore: number;
  };
  followups: { enabled: boolean; delaysDays: number[]; autoSend: boolean; sendWindowStartHour: number; sendWindowEndHour: number; skipWeekends: boolean };
  matching: { minScoreForAi: number; autoAnalyze: boolean; qualifyScore: number };
  automation: { autoPrepare: boolean; dailyPrepareLimit: number; minScoreToPrepare: number; createGmailDrafts: boolean };
  discovery: { enabled: boolean; maxAgeDays: number };
}

/** Stored relative to the previous email; shown as "day N after the first email". */
const toCumulative = (d: number[]) => d.reduce<number[]>((a, x) => [...a, (a[a.length - 1] ?? 0) + x], []);
const toRelative = (c: number[]) => {
  const s = [...c].filter((n) => n > 0).sort((a, b) => a - b);
  return s.map((d, i) => d - (i ? s[i - 1] : 0)).filter((d) => d > 0);
};
interface EmailStatus {
  mode: 'gmail' | 'sandbox';
  gmailOAuthConfigured: boolean;
  accounts: Array<{ id: string; provider: string; email: string; status: string; lastSyncAt: string | null; lastError: string | null }>;
}
interface Source {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  config: { boardToken?: string };
  lastRunAt: string | null;
  lastError: string | null;
  lastCount: number | null;
  lastStats: { fetched: number; afterBasicFilters: number; duplicates: number; created: number; qualified: number } | null;
  isDefault: boolean;
  _count: { jobs: number };
}

function SettingsInner() {
  const params = useSearchParams();
  const toast = useToast();
  useEffect(() => {
    const g = params.get('gmail');
    if (g === 'connected') toast(`Gmail connected: ${params.get('email')}`);
    if (g === 'error') toast(`Gmail connection failed: ${params.get('message')}`, 'error');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <EmailCard />
        <OutreachSettingsCard />
        <SourcesCard />
        <SuppressionCard />
        <SystemCard />
        <PasswordCard />
      </div>
    </>
  );
}

function EmailCard() {
  const { data, mutate } = useSWR<EmailStatus>('/email/status', fetcher);
  const { busy, run } = useAction();
  if (!data) return <Card title="Email">Loading…</Card>;
  const connect = async () => {
    const r = await run('connect', () => api<{ url: string }>('/email/gmail/connect', { method: 'POST' }));
    if (r) window.location.href = r.url;
  };
  return (
    <Card title="Email">
      <p className="text-sm">
        Mode: <Badge tone={data.mode === 'gmail' ? 'green' : 'amber'}>{data.mode}</Badge>
      </p>
      {data.mode === 'sandbox' && <p className="mt-2 text-xs text-ink-muted">Sandbox: emails are stored locally and never sent. Set EMAIL_PROVIDER=gmail to send through Gmail.</p>}
      <ul className="mt-3 space-y-2 text-sm">
        {data.accounts.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2">
            <div>
              <p className="font-medium">{a.email}</p>
              <p className="text-xs text-ink-muted">
                {a.provider} · {a.status} · last sync {formatDateTime(a.lastSyncAt)}
              </p>
              {a.lastError && <p className="text-xs text-red-700">{a.lastError}</p>}
            </div>
            {a.provider === 'GMAIL' && a.status !== 'REVOKED' && (
              <Button size="sm" variant="danger" onClick={async () => { if (confirm('Disconnect Gmail and revoke access?')) { await run('dc', () => api(`/email/accounts/${a.id}`, { method: 'DELETE' }), 'Disconnected'); mutate(); } }}>
                Disconnect
              </Button>
            )}
          </li>
        ))}
      </ul>
      {data.mode === 'gmail' && (
        <div className="mt-3">
          {data.gmailOAuthConfigured ? (
            <Button variant="primary" onClick={connect} loading={busy === 'connect'}>
              {data.accounts.some((a) => a.provider === 'GMAIL' && a.status === 'CONNECTED') ? 'Reconnect Gmail' : 'Connect Gmail'}
            </Button>
          ) : (
            <p className="text-sm text-amber-800">Gmail OAuth isn&apos;t configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI (see README).</p>
          )}
          <p className="mt-2 text-xs text-ink-muted">Uses Google OAuth (gmail.compose + gmail.readonly). Your Gmail password is never requested; tokens are encrypted at rest.</p>
        </div>
      )}
    </Card>
  );
}

function NumberField({ label, value, onChange, min = 0, max = 1000, hint }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <Input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}

function OutreachSettingsCard() {
  const { data, mutate } = useSWR<{ settings: Settings; ai: { provider: string; model: string | null; llm: boolean } }>('/settings', fetcher);
  const [s, setS] = useState<Settings | null>(null);
  const [delays, setDelays] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const { busy, run } = useAction();
  useEffect(() => {
    if (data) {
      setS(structuredClone(data.settings));
      setDelays(toCumulative(data.settings.followups.delaysDays).join(', '));
    }
  }, [data]);
  if (!s || !data) return <Card title="Outreach & follow-ups">Loading…</Card>;
  const up = (fn: (x: Settings) => void) => {
    const n = structuredClone(s);
    fn(n);
    setS(n);
  };
  const enablingAuto = s.outreach.sendMode === 'AUTO_SEND' && data.settings.outreach.sendMode !== 'AUTO_SEND';
  const AUTO_PHRASE = 'I understand emails will be sent without my review';
  const save = async () => {
    const delaysDays = toRelative(delays.split(',').map((d) => Number(d.trim())));
    const body = { ...s, followups: { ...s.followups, delaysDays }, ...(enablingAuto ? { confirmation } : {}) };
    const r = await run('save', () => api('/settings', { method: 'PATCH', body }), 'Settings saved');
    if (r) mutate();
  };
  return (
    <Card title="Outreach, follow-ups & matching" actions={<Button size="sm" variant="primary" onClick={save} loading={busy === 'save'}>Save</Button>}>
      <div className="space-y-5 text-sm">
        <div className="space-y-2">
          <Field label="Send mode" hint="Approval required is the default. Auto-send only approves strong matches whose address is publicly listed or verified; every limit still applies.">
            <Select value={s.outreach.sendMode} onChange={(e) => up((x) => void (x.outreach.sendMode = e.target.value as Settings['outreach']['sendMode']))}>
              <option value="DRY_RUN">Dry run — check everything, send nothing</option>
              <option value="DRAFT_ONLY">Drafts only — prepare drafts, never send</option>
              <option value="APPROVAL_REQUIRED">Approval required — send what I approve</option>
              <option value="AUTO_SEND">Auto-send — strong matches without review</option>
            </Select>
          </Field>
          {enablingAuto && (
            <Field label={`Type "${AUTO_PHRASE}" to enable auto-send`}>
              <Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Daily email limit (all)" value={s.outreach.dailyLimit} min={1} max={100} onChange={(n) => up((x) => void (x.outreach.dailyLimit = n))} />
          <NumberField label="Daily new outreach limit" value={s.outreach.dailyInitialLimit} min={1} max={100} onChange={(n) => up((x) => void (x.outreach.dailyInitialLimit = n))} />
          <NumberField label="Company cooldown (days)" value={s.outreach.companyCooldownDays} onChange={(n) => up((x) => void (x.outreach.companyCooldownDays = n))} />
          <NumberField label="Recipient cooldown (days)" value={s.outreach.recipientCooldownDays} onChange={(n) => up((x) => void (x.outreach.recipientCooldownDays = n))} />
          <NumberField label="Minutes between sends" value={s.outreach.minMinutesBetweenSends} max={240} onChange={(n) => up((x) => void (x.outreach.minMinutesBetweenSends = n))} />
          <NumberField label="Hourly email limit" value={s.outreach.hourlyLimit} min={1} max={30} onChange={(n) => up((x) => void (x.outreach.hourlyLimit = n))} />
          <NumberField label="Per-domain daily limit" value={s.outreach.perDomainDailyLimit} min={1} max={10} onChange={(n) => up((x) => void (x.outreach.perDomainDailyLimit = n))} />
          <NumberField label="Random delay up to (seconds)" value={s.outreach.maxJitterSeconds} max={900} onChange={(n) => up((x) => void (x.outreach.maxJitterSeconds = n))} />
          <NumberField label="Auto-send minimum score" value={s.outreach.autoSendMinScore} min={50} max={100} onChange={(n) => up((x) => void (x.outreach.autoSendMinScore = n))} />
          <Field label="Default email style">
            <Select value={s.outreach.defaultStyle} onChange={(e) => up((x) => void (x.outreach.defaultStyle = e.target.value))}>
              <option value="concise">Concise</option>
              <option value="technical">Technical</option>
              <option value="warm">Warm</option>
            </Select>
          </Field>
        </div>
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.followups.enabled} onChange={(e) => up((x) => void (x.followups.enabled = e.target.checked))} /> Schedule follow-ups
          </label>
          <Field label="Follow-up days (after the first email)" hint="Default 4, 9, 16 → three follow-ups; the last one politely closes the loop. Any reply stops them all.">
            <Input value={delays} onChange={(e) => setDelays(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.followups.autoSend} onChange={(e) => up((x) => void (x.followups.autoSend = e.target.checked))} /> Auto-send follow-ups (only in Auto-send mode; otherwise drafts wait for your approval)
          </label>
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="Send window start (h)" value={s.followups.sendWindowStartHour} max={23} onChange={(n) => up((x) => void (x.followups.sendWindowStartHour = n))} />
            <NumberField label="Send window end (h)" value={s.followups.sendWindowEndHour} min={1} max={24} onChange={(n) => up((x) => void (x.followups.sendWindowEndHour = n))} />
            <Field label="Timezone">
              <Input value={s.timezone} onChange={(e) => up((x) => void (x.timezone = e.target.value))} />
            </Field>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.followups.skipWeekends} onChange={(e) => up((x) => void (x.followups.skipWeekends = e.target.checked))} /> Skip weekends
          </label>
        </div>
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <p className="text-xs font-medium text-ink-soft">Daily automation (never sends anything)</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.discovery.enabled} onChange={(e) => up((x) => void (x.discovery.enabled = e.target.checked))} /> Search for new jobs every morning
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.automation.autoPrepare} onChange={(e) => up((x) => void (x.automation.autoPrepare = e.target.checked))} /> Prepare the best matches automatically (contact + tailored resume + email draft)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.automation.createGmailDrafts} onChange={(e) => up((x) => void (x.automation.createGmailDrafts = e.target.checked))} /> Put email drafts into Gmail Drafts (with the PDF attached)
          </label>
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="Prepare per day" value={s.automation.dailyPrepareLimit} max={30} onChange={(n) => up((x) => void (x.automation.dailyPrepareLimit = n))} />
            <NumberField label="Min score to prepare" value={s.automation.minScoreToPrepare} max={100} onChange={(n) => up((x) => void (x.automation.minScoreToPrepare = n))} />
            <NumberField label="Ignore postings older than (days)" value={s.discovery.maxAgeDays} min={1} max={120} onChange={(n) => up((x) => void (x.discovery.maxAgeDays = n))} />
          </div>
        </div>
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <p className="text-xs text-ink-muted">
            AI provider: <b>{data.ai.provider}</b>
            {data.ai.model && ` (${data.ai.model})`}. Only jobs at or above the AI threshold are sent to the LLM.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="AI analysis threshold (score)" value={s.matching.minScoreForAi} max={100} onChange={(n) => up((x) => void (x.matching.minScoreForAi = n))} />
            <NumberField label="Auto-qualify at score" value={s.matching.qualifyScore} max={100} onChange={(n) => up((x) => void (x.matching.qualifyScore = n))} />
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.matching.autoAnalyze} onChange={(e) => up((x) => void (x.matching.autoAnalyze = e.target.checked))} /> Automatically analyse strong matches with AI
          </label>
        </div>
      </div>
    </Card>
  );
}

function SourcesCard() {
  const { data, mutate } = useSWR<Source[]>('/job-sources', fetcher);
  const { busy, run } = useAction();
  const toast = useToast();
  const [f, setF] = useState({ provider: 'GREENHOUSE', name: '', boardToken: '' });
  const add = async () => {
    const r = await run('add', () => api('/job-sources', { body: { ...f, name: f.name || f.boardToken, companyName: f.name || undefined } }), 'Source added');
    if (r) {
      setF({ ...f, name: '', boardToken: '' });
      mutate();
    }
  };
  const runNow = async (id: string) => {
    const r = await run(`run-${id}`, () => api<{ fetched: number; afterBasicFilters: number; duplicates: number; created: number; qualified: number; queuedForAi: number }>(`/job-sources/${id}/run`, { method: 'POST' }));
    if (r) toast(`Fetched ${r.fetched} → ${r.afterBasicFilters} after title/location filters → ${r.created} new (${r.duplicates} duplicates) → ${r.qualified} qualified → ${r.queuedForAi} sent to AI`);
    mutate();
  };
  return (
    <Card title="Job discovery sources" actions={<Button size="sm" onClick={async () => { await run('all', () => api('/job-sources/run-all', { method: 'POST' }), 'Discovery queued'); }}>Run all</Button>}>
      <p className="mb-3 text-xs text-ink-muted">
        Public job feeds and company career boards, searched every morning (and when you click &quot;Find jobs now&quot;). Postings are filtered by title, region and age, de-duplicated and scored deterministically before any AI is used.
      </p>
      <ul className="max-h-[28rem] space-y-2 overflow-y-auto pr-1 text-sm">
        {data?.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2">
            <div>
              <p className="font-medium">
                {s.name} <span className="text-xs text-ink-muted">({s.provider.toLowerCase().replace('_', ' ')}{s.config.boardToken ? `: ${s.config.boardToken}` : ''})</span>
              </p>
              <p className="text-xs text-ink-muted">
                {s._count.jobs} jobs · last run {formatDateTime(s.lastRunAt)}
                {s.lastStats && ` · ${s.lastStats.fetched} listed → ${s.lastStats.afterBasicFilters} matched filters → ${s.lastStats.created} new`}
              </p>
              {s.lastError && <p className="text-xs text-red-700">{s.lastError}</p>}
            </div>
            <div className="flex gap-1">
              <Button size="sm" onClick={() => runNow(s.id)} loading={busy === `run-${s.id}`}>
                Run now
              </Button>
              <Button size="sm" variant="ghost" onClick={async () => { await api(`/job-sources/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }); mutate(); }}>
                {s.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="sm" variant="ghost" onClick={async () => { if (confirm('Delete source?')) { await api(`/job-sources/${s.id}`, { method: 'DELETE' }); mutate(); } }}>
                ✕
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid grid-cols-[auto_1fr_1fr_auto] gap-2">
        <Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} className="!w-auto">
          <option value="GREENHOUSE">Greenhouse</option>
          <option value="LEVER">Lever</option>
          <option value="ASHBY">Ashby</option>
        </Select>
        <Input placeholder="Board token (e.g. stripe)" value={f.boardToken} onChange={(e) => setF({ ...f, boardToken: e.target.value })} />
        <Input placeholder="Company name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Button onClick={add} loading={busy === 'add'} disabled={!f.boardToken}>
          Add
        </Button>
      </div>
    </Card>
  );
}

function SuppressionCard() {
  const { data, mutate } = useSWR<Array<{ id: string; value: string; reason: string; createdAt: string }>>('/suppressions', fetcher);
  const [value, setValue] = useState('');
  const { run } = useAction();
  return (
    <Card title="Do-not-contact list">
      <p className="mb-3 text-xs text-ink-muted">Addresses or domains that will never be emailed. Bounces and &quot;please stop&quot; replies are added automatically.</p>
      <div className="flex gap-2">
        <Input placeholder="person@company.com or company.com" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button onClick={async () => { await run('add', () => api('/suppressions', { body: { value, reason: 'Manual' } })); setValue(''); mutate(); }} disabled={value.length < 3}>
          Add
        </Button>
      </div>
      <ul className="mt-3 space-y-1 text-sm">
        {data?.map((s) => (
          <li key={s.id} className="flex items-center justify-between">
            <span>
              {s.value} <span className="text-xs text-ink-muted">— {s.reason}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={async () => { await api(`/suppressions/${s.id}/delete`, { method: 'POST' }); mutate(); }}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface HealthMetrics {
  ai: { provider: string; model: string | null; llm: boolean; last7Days: { calls: number; avgLatencyMs: number; inputTokens: number; outputTokens: number } };
  queues: Record<string, Record<string, number>>;
  metrics: Record<string, Record<string, number>>;
  recentFailures: { ai: Array<{ kind: string; error: string; createdAt: string }>; email: Array<{ outreachId: string; metadata: { reason?: string }; occurredAt: string }> };
}

function SystemCard() {
  const { data } = useSWR<HealthMetrics>('/health/metrics', fetcher, { refreshInterval: 15_000 });
  if (!data) return <Card title="System">Loading…</Card>;
  const today = Object.values(data.metrics)[0] ?? {};
  return (
    <Card title="System health">
      <div className="space-y-4 text-sm">
        <p>
          AI: <b>{data.ai.provider}</b> {data.ai.model && `(${data.ai.model})`} · last 7 days: {data.ai.last7Days.calls} LLM calls, avg {data.ai.last7Days.avgLatencyMs} ms, {data.ai.last7Days.inputTokens + data.ai.last7Days.outputTokens} tokens
        </p>
        <table className="w-full text-xs">
          <thead className="text-left text-ink-muted">
            <tr>
              <th className="font-medium">Queue</th>
              <th className="text-right font-medium">Waiting</th>
              <th className="text-right font-medium">Active</th>
              <th className="text-right font-medium">Delayed</th>
              <th className="text-right font-medium">Failed</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.queues).map(([q, c]) => (
              <tr key={q} className="border-t border-slate-100">
                <td className="py-1">{q}</td>
                <td className="text-right tabular-nums">{c.waiting}</td>
                <td className="text-right tabular-nums">{c.active}</td>
                <td className="text-right tabular-nums">{c.delayed}</td>
                <td className={`text-right tabular-nums ${c.failed ? 'text-red-700' : ''}`}>{c.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(today)
            .filter(([k]) => !k.includes('latency'))
            .map(([k, v]) => (
              <Badge key={k} tone={k.includes('failure') ? 'red' : 'slate'}>
                {k}: {v}
              </Badge>
            ))}
        </div>
        {(data.recentFailures.ai.length > 0 || data.recentFailures.email.length > 0) && (
          <div>
            <p className="text-xs font-medium text-ink-muted">Recent failures</p>
            <ul className="mt-1 space-y-0.5 text-xs text-red-700">
              {data.recentFailures.ai.map((f, i) => (
                <li key={`ai-${i}`}>
                  {formatDateTime(f.createdAt)} AI {f.kind}: {f.error}
                </li>
              ))}
              {data.recentFailures.email.map((f, i) => (
                <li key={`em-${i}`}>
                  {formatDateTime(f.occurredAt)} email: {f.metadata.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function PasswordCard() {
  const [f, setF] = useState({ current: '', next: '' });
  const { busy, run } = useAction();
  return (
    <Card title="App password">
      <div className="space-y-3">
        <Field label="Current password">
          <Input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
        </Field>
        <Field label="New password (min 10 characters)">
          <Input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
        </Field>
        <Button onClick={async () => { const r = await run('pw', () => api('/auth/password', { body: f }), 'Password changed'); if (r) setF({ current: '', next: '' }); }} loading={busy === 'pw'} disabled={!f.current || f.next.length < 10}>
          Change password
        </Button>
      </div>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <SettingsInner />
    </Suspense>
  );
}
