'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import useSWR from 'swr';
import { FollowupItem } from '@/components/followup-item';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, cx, Field, Input, Modal, RecommendationBadge, ScorePill, Select, Spinner, StatusBadge, Textarea, useAction, useToast } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { formatDateTime, formatSalary, humanize } from '@/lib/format';
import { Contact, JobAnalysis, JobDetail, Outreach, STATUSES } from '@/lib/types';

const ALLOWED_STATUS_HINT = 'Moves are validated by the pipeline state machine.';

function JobDetailInner() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { data: job, mutate } = useSWR<JobDetail>(`/jobs/${id}`, fetcher, { refreshInterval: (j) => (j?.application?.outreach.some((o) => ['APPROVED', 'SENDING'].includes(o.status)) ? 3000 : 0) });
  const { data: contacts, mutate: mutateContacts } = useSWR<Contact[]>(`/jobs/${id}/contacts`, fetcher);
  const { busy, run } = useAction();

  useEffect(() => {
    if (params.get('duplicate')) toast('This job was already in your pipeline — showing the existing entry.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!job) return <Spinner />;
  const app = job.application;
  const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod);
  const refresh = () => Promise.all([mutate(), mutateContacts()]);

  const changeStatus = async (status: string) => {
    if (!app || status === app.status) return;
    await run('status', () => api(`/applications/${app.id}/status`, { body: { status } }), `Moved to ${humanize(status)}`);
    refresh();
  };

  return (
    <>
      <PageHeader
        title={job.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium text-ink-soft">{job.company.name}</span>
            <span>{job.remote ? 'Remote' : job.location || 'Location not stated'}</span>
            {salary && <span>{salary}</span>}
            {job.url && (
              <a href={job.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                Posting ↗
              </a>
            )}
          </span>
        }
        actions={
          <>
            <ScorePill score={job.score} />
            <RecommendationBadge rec={job.recommendation} />
            {app && (
              <Select value={app.status} onChange={(e) => changeStatus(e.target.value)} className="!w-auto py-1.5" title={ALLOWED_STATUS_HINT} disabled={busy === 'status'}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (!confirm('Remove this job from your pipeline?')) return;
                await run('delete', () => api(`/jobs/${id}`, { method: 'DELETE' }));
                router.push('/jobs');
              }}
            >
              Delete
            </Button>
          </>
        }
      />

      {app && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
          <StatusBadge status={app.status} />
          <span className="text-ink-muted">Next action:</span>
          <span className="font-medium">{job.nextAction}</span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <MatchCard job={job} onRescore={async () => { await run('rescore', () => api(`/jobs/${id}/rescore`, { method: 'POST' }), 'Re-scored'); mutate(); }} rescoring={busy === 'rescore'} />
          <AnalysisCard job={job} onDone={mutate} />
          {app && <OutreachCard job={job} contacts={contacts ?? []} onChange={refresh} />}
          <Card title="Job description">
            <details>
              <summary className="cursor-pointer text-sm text-brand">Show full description</summary>
              <p className="prose-pre mt-3 text-sm leading-relaxed text-ink-soft">{job.description}</p>
            </details>
          </Card>
        </div>
        <div className="space-y-6">
          <ContactsCard job={job} contacts={contacts ?? []} onChange={refresh} />
          <ResumeCard job={job} onChange={mutate} />
          {app && ['EMAIL_SENT', 'WAITING_FOR_REPLY', 'FOLLOWUP_SCHEDULED', 'REPLIED', 'INTERVIEW', 'OFFER', 'REJECTED'].includes(app.status) && <InterviewsCard applicationId={app.id} onChange={mutate} />}
          <CompanyCard job={job} onChange={mutate} />
        </div>
      </div>
    </>
  );
}

// ─── Match ───────────────────────────────────────────────────────────────────

function MatchCard({ job, onRescore, rescoring }: { job: JobDetail; onRescore: () => void; rescoring: boolean }) {
  const m = job.scoreBreakdown;
  if (!m) return <Card title="Match">Not scored yet.</Card>;
  const strong = m.skills.filter((s) => s.level === 'strong');
  const partial = m.skills.filter((s) => s.level === 'partial' || s.level === 'learning');
  const missing = m.skills.filter((s) => s.level === 'missing');
  return (
    <Card
      title={`Match: ${m.total}%`}
      actions={
        <Button size="sm" variant="ghost" onClick={onRescore} loading={rescoring}>
          Re-score
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-muted">Recommendation</span>
        <RecommendationBadge rec={m.recommendation} />
        {job.analysis && job.analysis.scoreAdjustment !== 0 && (
          <Badge tone="violet" title={job.analysis.adjustmentReason}>
            AI-adjusted: {Math.max(0, Math.min(100, m.total + job.analysis.scoreAdjustment))}%
          </Badge>
        )}
      </div>
      <ul className="mt-3 space-y-1 text-sm text-ink-soft">
        {m.reasons.map((r) => (
          <li key={r}>• {r}</li>
        ))}
      </ul>
      {m.flags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {m.flags.map((f) => (
            <Badge key={f} tone="red">
              {f}
            </Badge>
          ))}
        </div>
      )}
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div className="space-y-2.5">
          {m.components.map((c) => (
            <div key={c.key} title={c.reason}>
              <div className="flex justify-between text-xs">
                <span className="font-medium text-ink-soft">{c.label}</span>
                <span className="tabular-nums text-ink-muted">
                  {c.score}/{c.max}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-100">
                <div className="h-1.5 rounded bg-brand" style={{ width: `${(c.score / c.max) * 100}%` }} />
              </div>
              <p className="mt-0.5 text-xs text-ink-muted">{c.reason}</p>
            </div>
          ))}
        </div>
        <div className="space-y-3 text-sm">
          <SkillList label="Strong matches" symbol="✓" tone="text-emerald-700" items={strong.map((s) => ({ name: s.skill, note: s.via }))} />
          <SkillList label="Partial" symbol="△" tone="text-amber-700" items={partial.map((s) => ({ name: s.skill, note: s.via ?? (s.level === 'learning' ? 'learning' : undefined) }))} />
          <SkillList label="Missing" symbol="✗" tone="text-red-700" items={missing.map((s) => ({ name: s.skill, note: s.required ? 'required' : 'nice to have' }))} />
          {job.extracted && (
            <p className="text-xs text-ink-muted">
              Detected: {job.extracted.minYears ? `${job.extracted.minYears}+ yrs · ` : ''}
              {humanize(job.extracted.seniority)} · {humanize(job.extracted.workMode)}
              {job.extracted.visaSponsorship !== 'unknown' ? ` · visa sponsorship: ${job.extracted.visaSponsorship}` : ''}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function SkillList({ label, symbol, tone, items }: { label: string; symbol: string; tone: string; items: Array<{ name: string; note?: string }> }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <ul className="mt-1 space-y-0.5">
        {items.map((i) => (
          <li key={i.name}>
            <span className={cx('mr-1.5 font-semibold', tone)}>{symbol}</span>
            {i.name}
            {i.note && <span className="ml-1 text-xs text-ink-muted">({i.note})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── AI analysis ─────────────────────────────────────────────────────────────

function AnalysisCard({ job, onDone }: { job: JobDetail; onDone: () => void }) {
  const { busy, run } = useAction();
  const a = job.analysis as JobAnalysis | null;
  const analyze = async (force = false) => {
    const r = await run('analyze', () => api<{ cached: boolean; provider: string }>(`/jobs/${job.id}/analyze`, { body: { force } }));
    if (r) onDone();
  };
  return (
    <Card
      title="Analysis"
      actions={
        <Button size="sm" onClick={() => analyze(!!a)} loading={busy === 'analyze'}>
          {a ? 'Re-run' : 'Analyze'}
        </Button>
      }
    >
      {!a ? (
        <p className="text-sm text-ink-muted">Semantic analysis runs only for strong matches (to keep AI cost low). Run it manually for this job if you like. Results are cached per job description.</p>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="slate">via {a.provider ?? 'cache'}</Badge>
            {a.fallback && <Badge tone="amber">LLM unavailable — deterministic fallback</Badge>}
          </div>
          <p>{a.summary}</p>
          <p className="text-ink-soft">{a.fitAssessment}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <ListBlock title="Talking points (truthful)" items={a.talkingPoints} />
            <ListBlock title="Interview prep" items={a.interviewPrep} />
            <ListBlock title="Gaps" items={a.gaps.map((g) => `${g.skill} (${g.severity}) — ${g.note}`)} />
            <ListBlock title="Red flags" items={a.redFlags} />
          </div>
        </div>
      )}
    </Card>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{title}</p>
      {items.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-soft">
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-ink-muted">None</p>
      )}
    </div>
  );
}

// ─── Contacts ────────────────────────────────────────────────────────────────

const CONF_TONE = { VERIFIED: 'green', LIKELY: 'blue', UNVERIFIED: 'amber', UNKNOWN: 'slate' } as const;

function ContactsCard({ job, contacts, onChange }: { job: JobDetail; contacts: Contact[]; onChange: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const selected = job.application?.contact?.id;

  const discover = async () => {
    const r = await run('discover', () => api<{ newOrUpdated: number; errors: string[]; providers: Array<{ name: string; enabled: boolean }> }>(`/jobs/${job.id}/contacts/discover`, { method: 'POST' }));
    if (r) {
      const enabled = r.providers.filter((p) => p.enabled).map((p) => p.name).join(', ');
      toast(r.newOrUpdated ? `Found ${r.newOrUpdated} contact(s) via ${enabled}` : `No public contacts found via ${enabled}. Add one manually.`);
      if (r.errors.length) toast(r.errors.join('; '), 'error');
      onChange();
    }
  };

  return (
    <Card
      title="Contacts"
      actions={
        <>
          <Button size="sm" onClick={discover} loading={busy === 'discover'}>
            Find
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            Add
          </Button>
        </>
      }
    >
      {contacts.length === 0 ? (
        <div className="space-y-2 text-sm text-ink-muted">
          <p>No public contact yet. &quot;Find&quot; checks the posting, the company&apos;s own website and Hunter.io (if configured). Emails are never guessed.</p>
          <p className="text-xs">
            Look up a person yourself, then <b>Add</b> them:{' '}
            {['engineering manager', 'technical recruiter', 'CTO'].map((q, i) => (
              <span key={q}>
                {i > 0 && ' · '}
                <a className="text-brand hover:underline" target="_blank" rel="noopener noreferrer" href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${job.company.name} ${q}`)}`}>
                  {q} ↗
                </a>
              </span>
            ))}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {contacts.map((c) => (
            <li key={c.id} className={cx('rounded-md border p-3 text-sm', c.id === selected ? 'border-brand bg-brand-soft/30' : 'border-slate-200')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-ink-muted">{c.role ?? humanize(c.roleCategory)}</p>
                  <p className="truncate text-xs text-ink-soft">{c.email ?? 'No email'}</p>
                </div>
                <Badge tone={CONF_TONE[c.confidence]} title={`Source: ${c.source}${c.sourceUrl ? ` (${c.sourceUrl})` : ''}`}>
                  {humanize(c.confidence)}
                </Badge>
              </div>
              {c.rankReason && <p className="mt-1.5 text-xs text-ink-muted">{c.rankReason}</p>}
              <div className="mt-2 flex gap-2">
                {c.id !== selected && job.application && (
                  <Button size="sm" onClick={async () => { await run('assign', () => api(`/applications/${job.application!.id}/contact`, { body: { contactId: c.id } })); onChange(); }}>
                    Use for outreach
                  </Button>
                )}
                {c.linkedinUrl && (
                  <a href={c.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-brand hover:underline">
                    LinkedIn ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <AddContactModal open={adding} onClose={() => setAdding(false)} companyId={job.company.id} onAdded={onChange} />
    </Card>
  );
}

function AddContactModal({ open, onClose, companyId, onAdded }: { open: boolean; onClose: () => void; companyId: string; onAdded: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: '', role: '', email: '', linkedinUrl: '', sourceUrl: '', confidence: 'UNVERIFIED' });
  const save = async () => {
    const r = await run('save', () => api(`/companies/${companyId}/contacts`, { body: f }), 'Contact added');
    if (r) {
      onAdded();
      onClose();
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add contact">
      <div className="space-y-3">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Role / title">
          <Input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="Engineering Manager" />
        </Field>
        <Field label="Email">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Where did you find this? (URL)" hint="Only use publicly listed professional contact details.">
          <Input value={f.sourceUrl} onChange={(e) => setF({ ...f, sourceUrl: e.target.value })} />
        </Field>
        <Field label="LinkedIn URL">
          <Input value={f.linkedinUrl} onChange={(e) => setF({ ...f, linkedinUrl: e.target.value })} />
        </Field>
        <Field label="Confidence" hint="Be honest — only 'Verified' if the address is published by the person/company.">
          <Select value={f.confidence} onChange={(e) => setF({ ...f, confidence: e.target.value })}>
            <option value="VERIFIED">Verified</option>
            <option value="LIKELY">Likely</option>
            <option value="UNVERIFIED">Unverified</option>
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy === 'save'}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Company ─────────────────────────────────────────────────────────────────

function CompanyCard({ job, onChange }: { job: JobDetail; onChange: () => void }) {
  const { busy, run } = useAction();
  const c = job.company;
  const update = async (patch: Record<string, unknown>) => {
    await run('company', () => api(`/companies/${c.id}`, { method: 'PATCH', body: patch }), 'Company updated — job re-scored');
    onChange();
  };
  return (
    <Card
      title="Company"
      actions={
        <Button size="sm" variant="ghost" loading={busy === 'research'} onClick={async () => { await run('research', () => api(`/companies/${c.id}/research`, { method: 'POST' })); onChange(); }}>
          Refresh facts
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Size (affects scoring & contact strategy)">
          <Select value={c.size} onChange={(e) => update({ size: e.target.value })} disabled={busy === 'company'}>
            <option value="UNKNOWN">Unknown</option>
            <option value="EARLY_STARTUP">Early-stage startup</option>
            <option value="GROWTH_STARTUP">Growth-stage startup</option>
            <option value="MID_MARKET">Mid-market</option>
            <option value="ENTERPRISE">Large company / MNC</option>
          </Select>
        </Field>
        <Field label="Type">
          <Select value={c.companyType ?? ''} onChange={(e) => update({ companyType: e.target.value || null })} disabled={busy === 'company'}>
            <option value="">—</option>
            <option value="international_startup">International startup</option>
            <option value="remote_first">Remote-first</option>
            <option value="early_stage_startup">Early-stage startup</option>
            <option value="growth_stage_startup">Growth-stage startup</option>
            <option value="mid_market">Mid-market</option>
            <option value="enterprise">Enterprise / MNC</option>
          </Select>
        </Field>
        <DomainField value={c.domain ?? ''} onSave={(domain) => update({ domain })} />
        <div>
          <p className="text-xs font-medium text-ink-soft">Verified facts</p>
          {c.research?.length ? (
            <ul className="mt-1 space-y-1">
              {c.research.map((f) => (
                <li key={f.text} className="text-xs text-ink-soft">
                  “{f.text}”{' '}
                  {f.sourceUrl && (
                    <a className="text-brand" href={f.sourceUrl} target="_blank" rel="noopener noreferrer">
                      source
                    </a>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-ink-muted">None yet. Only self-published facts with a source are used in emails.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function DomainField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Field label="Domain">
      <div className="flex gap-2">
        <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="acme.com" />
        <Button size="sm" onClick={() => onSave(v)} disabled={v === value}>
          Save
        </Button>
      </div>
    </Field>
  );
}

// ─── Resume ──────────────────────────────────────────────────────────────────

function ResumeCard({ job, onChange }: { job: JobDetail; onChange: () => void }) {
  const { busy, run } = useAction();
  const { data: settings } = useSWR<{ ai: { llm: boolean } }>('/settings', fetcher);
  const { data: master } = useSWR<{ latex: { engine: string } | null }>('/resume/master', fetcher);
  const [showDiff, setShowDiff] = useState(false);
  const latest = job.resumeVersions[0];
  const current = job.application?.resumeVersionId ? job.resumeVersions.find((v) => v.id === job.application!.resumeVersionId) ?? latest : latest;
  const { data: diff } = useSWR<{ format: string; lines: Array<{ type: 'same' | 'add' | 'del'; line: string; n: number }> }>(showDiff && current ? `/resume/versions/${current.id}/diff` : null, fetcher);
  const tailor = async (useAi: boolean) => {
    const r = await run('tailor', () => api<{ reused: boolean; version: { compileStatus: string | null } }>(`/jobs/${job.id}/resume`, { body: { useAi } }));
    if (r) onChange();
  };
  const isLatex = !!master?.latex;
  const failed = current?.compileStatus === 'failed';
  return (
    <Card title="Tailored resume">
      {!isLatex && (
        <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
          No LaTeX resume uploaded yet — using the built-in layout. <a href="/resume" className="underline">Upload your .tex</a> to keep your own design.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => tailor(false)} loading={busy === 'tailor'}>
          {current ? 'Re-tailor' : 'Tailor resume'}
        </Button>
        {settings?.ai.llm && (
          <Button size="sm" onClick={() => tailor(true)} loading={busy === 'tailor'} title="AI rephrases plain bullets; a truth guard rejects any new facts">
            + AI phrasing
          </Button>
        )}
        {current && !failed && (
          <>
            <a href={`/api/resume/versions/${current.id}/download`} className="inline-flex items-center rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-dark">
              Download PDF
            </a>
            <a href={`/api/resume/versions/${current.id}/pdf`} target="_blank" className="inline-flex items-center rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50">
              Preview ↗
            </a>
          </>
        )}
      </div>
      {current ? (
        <div className="mt-3 space-y-2 text-xs">
          <p className="text-ink-muted">
            {formatDateTime(current.createdAt)} {current.aiAssisted && <Badge tone="violet">AI phrasing</Badge>} {isLatex && <Badge tone={failed ? 'red' : 'green'}>{failed ? 'LaTeX compile failed' : 'compiled from your LaTeX'}</Badge>}
          </p>
          {failed && <p className="rounded bg-red-50 px-2 py-1 text-red-700">The tailored .tex didn&apos;t compile. Check that your master resume compiles on the Resume page.</p>}
          {current.changes.changes.length === 0 ? (
            <p className="text-ink-muted">Nothing needed re-ordering for this job — your resume is used as-is.</p>
          ) : (
            <ul className="space-y-1 text-ink-soft">
              {current.changes.changes.map((c, i) => (
                <li key={i}>
                  • {c.change} <span className="text-ink-muted">— {c.reason}</span>
                </li>
              ))}
            </ul>
          )}
          {current.changes.gaps.length > 0 && (
            <p className="text-ink-muted">
              Not on your resume (not added): <span className="text-ink-soft">{current.changes.gaps.join(', ')}</span>
            </p>
          )}
          {isLatex && current.changes.changes.length > 0 && (
            <div className="flex gap-3">
              <button className="text-brand hover:underline" onClick={() => setShowDiff(!showDiff)}>
                {showDiff ? 'Hide' : 'Show'} exact .tex changes
              </button>
              <a className="text-brand hover:underline" href={`/api/resume/versions/${current.id}/tex`}>
                Download .tex
              </a>
            </div>
          )}
          {showDiff && diff && (
            <pre className="max-h-72 overflow-auto rounded bg-slate-900 p-2 font-mono text-[11px] leading-snug">
              {diff.lines.map((l) => (
                <div key={l.n} className={l.type === 'add' ? 'text-emerald-300' : l.type === 'del' ? 'text-red-300' : 'text-slate-400'}>
                  {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}
                  {l.line}
                </div>
              ))}
            </pre>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-muted">Re-orders your real bullets and skills for this job and compiles your own LaTeX. Nothing is invented; the design is untouched.</p>
      )}
    </Card>
  );
}

// ─── Interviews ──────────────────────────────────────────────────────────────

interface InterviewRow {
  id: string;
  stage: string;
  scheduledAt: string | null;
  outcome: string;
  notes: string | null;
}

function InterviewsCard({ applicationId, onChange }: { applicationId: string; onChange: () => void }) {
  const { data, mutate } = useSWR<InterviewRow[]>(`/applications/${applicationId}/interviews`, fetcher);
  const { busy, run } = useAction();
  const [f, setF] = useState({ stage: 'Screening call', scheduledAt: '', notes: '' });
  const add = async () => {
    const r = await run('add', () => api(`/applications/${applicationId}/interviews`, { body: { stage: f.stage, notes: f.notes || null, scheduledAt: f.scheduledAt ? new Date(f.scheduledAt).toISOString() : null } }), 'Interview added');
    if (r) {
      setF({ stage: 'Technical interview', scheduledAt: '', notes: '' });
      mutate();
      onChange();
    }
  };
  return (
    <Card title="Interviews">
      <ul className="space-y-2 text-sm">
        {data?.map((i) => (
          <li key={i.id} className="rounded border border-slate-200 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{i.stage}</span>
              <Select
                value={i.outcome}
                className="!w-auto py-0.5 text-xs"
                onChange={async (e) => { await api(`/interviews/${i.id}`, { method: 'PATCH', body: { outcome: e.target.value } }); mutate(); }}
              >
                {['PENDING', 'PASSED', 'FAILED', 'CANCELLED'].map((o) => (
                  <option key={o} value={o}>
                    {humanize(o)}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-xs text-ink-muted">{i.scheduledAt ? formatDateTime(i.scheduledAt) : 'Date not set'}</p>
            {i.notes && <p className="mt-1 whitespace-pre-wrap text-xs text-ink-soft">{i.notes}</p>}
          </li>
        ))}
      </ul>
      <div className="mt-3 space-y-2">
        <Input value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })} placeholder="Stage (e.g. Technical round)" />
        <Input type="datetime-local" value={f.scheduledAt} onChange={(e) => setF({ ...f, scheduledAt: e.target.value })} />
        <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Notes / prep" />
        <Button size="sm" onClick={add} loading={busy === 'add'} disabled={!f.stage}>
          Add interview
        </Button>
      </div>
    </Card>
  );
}

// ─── Outreach ────────────────────────────────────────────────────────────────

function OutreachCard({ job, contacts, onChange }: { job: JobDetail; contacts: Contact[]; onChange: () => void }) {
  const app = job.application!;
  const { busy, run } = useAction();
  const { data: emailStatus } = useSWR<{ mode: string }>('/email/status', fetcher);
  const initial = app.outreach.find((o) => o.kind === 'INITIAL' && o.status !== 'CANCELLED') ?? app.outreach.find((o) => o.kind === 'INITIAL');
  const [style, setStyle] = useState(initial?.style ?? 'concise');
  const [contactId, setContactId] = useState(app.contact?.id ?? '');
  useEffect(() => setContactId(app.contact?.id ?? ''), [app.contact?.id]);
  const emailable = contacts.filter((c) => c.email);

  const generate = async (regenerate: boolean) => {
    const r = await run('generate', () => api(`/applications/${app.id}/email`, { body: { contactId: contactId || undefined, style, regenerate } }));
    if (r) onChange();
  };

  return (
    <Card title="Outreach">
      {(!initial || ['DRAFT', 'FAILED', 'CANCELLED'].includes(initial.status)) && (
        <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <Select value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">{emailable.length ? 'Choose recipient…' : 'Add a contact with an email first'}</option>
            {emailable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.role ?? humanize(c.roleCategory)} ({c.email})
              </option>
            ))}
          </Select>
          <Select value={style} onChange={(e) => setStyle(e.target.value)} className="!w-auto">
            <option value="concise">Concise</option>
            <option value="technical">Technical</option>
            <option value="warm">Warm</option>
          </Select>
          <Button variant="primary" onClick={() => generate(!!initial)} loading={busy === 'generate'} disabled={!contactId}>
            {initial ? 'Regenerate' : 'Generate email'}
          </Button>
        </div>
      )}
      {!initial ? (
        <p className="text-sm text-ink-muted">Generate a personalised cold email. You review and approve before anything is sent.</p>
      ) : (
        <div className="space-y-5">
          <EmailEditor outreach={initial} onChange={onChange} />
          {initial.status === 'SENT' && <ThreadTimeline root={initial} all={app.outreach} sandbox={emailStatus?.mode === 'sandbox'} onChange={onChange} />}
        </div>
      )}
    </Card>
  );
}

function EmailEditor({ outreach: o, onChange }: { outreach: Outreach; onChange: () => void }) {
  const { busy, run } = useAction();
  const [subject, setSubject] = useState(o.subject);
  const [body, setBody] = useState(o.body);
  const [override, setOverride] = useState(false);
  const [blockers, setBlockers] = useState<string[]>([]);
  useEffect(() => {
    setSubject(o.subject);
    setBody(o.body);
  }, [o.subject, o.body]);
  const editable = ['DRAFT', 'FAILED'].includes(o.status);
  const dirty = subject !== o.subject || body !== o.body;
  const words = body.split(/\s+/).filter(Boolean).length;
  const warnings = o.warnings?.items ?? [];

  const save = async () => {
    await run('save', () => api(`/outreach/${o.id}`, { method: 'PATCH', body: { subject, body } }), 'Draft saved');
    onChange();
  };
  const approve = async () => {
    if (dirty) await api(`/outreach/${o.id}`, { method: 'PATCH', body: { subject, body } });
    setBlockers([]);
    try {
      await api(`/outreach/${o.id}/approve`, { body: { overrideCompanyCooldown: override } });
      onChange();
    } catch (e) {
      setBlockers([(e as Error).message]);
    }
  };

  return (
    <div className="rounded-md border border-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-xs">
        <span className="text-ink-muted">
          To <b className="text-ink">{o.toEmail}</b> · {o.attachResume ? 'resume attached' : 'no attachment'} · {o.style}
          {o.warnings?.provider && ` · written by ${o.warnings.provider}`}
        </span>
        <Badge tone={o.status === 'SENT' ? 'green' : o.status === 'FAILED' ? 'red' : o.status === 'DRAFT' ? 'slate' : 'amber'}>{humanize(o.status)}</Badge>
      </div>
      {['DRAFT', 'APPROVED'].includes(o.status) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-xs">
          {o.gmailDraftId ? (
            <span className="text-emerald-700">
              ✓ In your Gmail Drafts{o.attachResume ? ' with the tailored PDF attached' : ''} · synced {formatDateTime(o.draftSyncedAt)} ·{' '}
              <a className="underline" href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noopener noreferrer">
                open Gmail Drafts
              </a>
            </span>
          ) : o.draftSyncError ? (
            <span className="text-red-700">Gmail draft not created: {o.draftSyncError}</span>
          ) : (
            <span className="text-ink-muted">Not mirrored to Gmail Drafts.</span>
          )}
          {!o.gmailDraftId && (
            <Button size="sm" variant="ghost" loading={busy === 'sync'} onClick={async () => { await run('sync', () => api(`/outreach/${o.id}/sync-draft`, { method: 'POST' })); onChange(); }}>
              Create Gmail draft
            </Button>
          )}
        </div>
      )}
      <div className="space-y-2 p-3">
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!editable} className="font-medium" />
        <Textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} disabled={!editable} />
        <p className="text-xs text-ink-muted">{words} words (target 80–150)</p>
        {warnings.length > 0 && (
          <ul className="space-y-0.5 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {warnings.map((w) => (
              <li key={w}>⚠ {w}</li>
            ))}
          </ul>
        )}
        {o.error && <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{o.error}</p>}
        {blockers.length > 0 && <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{blockers.join(' ')}</p>}
        {editable && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-ink-soft">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              Override company cooldown (I&apos;m deliberately contacting a second person)
            </label>
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={!dirty} loading={busy === 'save'}>
                Save draft
              </Button>
              <Button size="sm" variant="primary" onClick={approve}>
                Approve & send
              </Button>
            </div>
          </div>
        )}
        {['APPROVED', 'SENDING'].includes(o.status) && (
          <div className="flex items-center justify-between text-xs text-ink-muted">
            <span className="flex items-center gap-2">
              <Spinner small /> Queued — sending respects your daily limit and spacing.
            </span>
            <Button size="sm" variant="ghost" onClick={async () => { await run('cancel', () => api(`/outreach/${o.id}/cancel`, { method: 'POST' }), 'Send cancelled'); onChange(); }}>
              Cancel send
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadTimeline({ root, all, sandbox, onChange }: { root: Outreach; all: Outreach[]; sandbox: boolean; onChange: () => void }) {
  const { busy, run } = useAction();
  const followupEmails = all.filter((o) => o.kind === 'FOLLOWUP');
  const followups = root.followups ?? [];
  const events = (root.events ?? []).filter((e) => ['REPLY_RECEIVED', 'AUTO_REPLY', 'BOUNCE', 'FOLLOWUP_CANCELLED'].includes(e.type));

  const simulate = async (kind: string) => {
    await run('sim', () => api('/email/sandbox/simulate', { body: { outreachId: root.id, kind } }), kind === 'reply' ? 'Reply simulated — follow-ups cancelled' : 'Simulated');
    onChange();
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Thread</p>
        <div className="flex gap-2">
          <Badge tone={root.threadState === 'REPLIED' ? 'green' : root.threadState === 'BOUNCED' ? 'red' : 'amber'}>{humanize(root.threadState)}</Badge>
          {root.threadState === 'WAITING_FOR_REPLY' && (
            <Button size="sm" variant="ghost" loading={busy === 'cancelf'} onClick={async () => { await run('cancelf', () => api(`/outreach/${root.id}/followups/cancel`, { method: 'POST' }), 'Follow-ups cancelled'); onChange(); }}>
              Stop follow-ups
            </Button>
          )}
        </div>
      </div>
      <ol className="space-y-2 border-l border-slate-200 pl-4 text-sm">
        <li>
          <p className="font-medium">Initial email sent</p>
          <p className="text-xs text-ink-muted">{formatDateTime(root.sentAt)}</p>
        </li>
        {events.map((e) => (
          <li key={e.id}>
            <p className="font-medium">{e.type === 'REPLY_RECEIVED' ? `Reply from ${e.fromEmail}` : e.type === 'AUTO_REPLY' ? 'Auto-reply (out of office) — follow-ups continue' : e.type === 'BOUNCE' ? 'Bounced' : `Follow-ups cancelled — ${(e.metadata as { reason?: string }).reason ?? ''}`}</p>
            {e.snippet && <p className="text-xs italic text-ink-soft">“{e.snippet}”</p>}
            <p className="text-xs text-ink-muted">{formatDateTime(e.occurredAt)}</p>
          </li>
        ))}
        {followups.map((f) => {
          const email = followupEmails.find((o) => o.id === f.outreachId);
          return (
            <li key={f.id}>
              <FollowupItem followup={f} email={email} onChange={onChange} />
            </li>
          );
        })}
      </ol>
      {sandbox && root.threadState === 'WAITING_FOR_REPLY' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded bg-slate-50 px-3 py-2 text-xs">
          <span className="text-ink-muted">Sandbox:</span>
          <Button size="sm" onClick={() => simulate('reply')} loading={busy === 'sim'}>
            Simulate reply
          </Button>
          <Button size="sm" onClick={() => simulate('auto_reply')}>
            Simulate out-of-office
          </Button>
          <Button size="sm" onClick={() => simulate('bounce')}>
            Simulate bounce
          </Button>
        </div>
      )}
    </div>
  );
}

export default function JobDetailPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <JobDetailInner />
    </Suspense>
  );
}

