'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { Insights, KeyFacts, Verdict } from '@/components/job/decision';
import { PreparationPanel } from '@/components/job/preparation-panel';
import { Badge, Button, Card, Disclosure, Empty, Notice, Select, Spinner, StageBadge, useAction, useToast } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { formatDate, humanize } from '@/lib/format';
import { Contact, JobDetail, PreparationView, SOURCE_LABEL, STATUSES } from '@/lib/types';
import { AnalysisCard, CompanyCard, ContactsCard, InterviewsCard, LinkedInCard, MatchCard, OutreachCard, ResumeCard } from './details';

/** Open a collapsed section (and the "More details" wrapper around it) and scroll to it. */
function openDetails(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  document.getElementById('details-all')?.setAttribute('open', '');
  target.setAttribute('open', '');
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

type Primary = { label: string; onClick: () => void; loading?: boolean; disabled?: boolean; note?: string };

function JobDetailInner() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { data: job, error, mutate } = useSWR<JobDetail>(`/jobs/${id}`, fetcher, { refreshInterval: (j) => (j?.application?.outreach.some((o) => ['APPROVED', 'SENDING'].includes(o.status)) ? 3000 : 0) });
  const { data: prep, error: prepError, mutate: mutatePrep } = useSWR<PreparationView>(`/jobs/${id}/preparation`, fetcher, { refreshInterval: (p) => (p?.status === 'IN_PROGRESS' ? 2000 : 0) });
  const { data: contacts, mutate: mutateContacts } = useSWR<Contact[]>(`/jobs/${id}/contacts`, fetcher);
  const { busy, run } = useAction();

  useEffect(() => {
    if (params.get('duplicate')) toast('This job was already in your pipeline — showing the existing entry.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When a preparation run changes state, refresh the job (status, contact, resume, draft).
  const lastPrep = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prep?.status && lastPrep.current && lastPrep.current !== prep.status) {
      mutate();
      mutateContacts();
    }
    lastPrep.current = prep?.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prep?.status]);

  if (error && !job) {
    return (
      <Empty title="Couldn't load this job">
        <p>{(error as Error).message}</p>
        <div className="mt-3 flex justify-center gap-2">
          <Button onClick={() => mutate()}>Try again</Button>
          <Link href="/jobs" className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-ink hover:bg-slate-50">
            Back to jobs
          </Link>
        </div>
      </Empty>
    );
  }
  if (!job) return <Spinner />;

  const app = job.application;
  const stage = job.lifecycle?.stage;
  const refresh = async (p?: PreparationView) => {
    if (p) await mutatePrep(p, false);
    await Promise.all([mutate(), mutateContacts(), mutatePrep()]);
  };

  const prepare = async () => {
    const r = await run('prepare', () => api<PreparationView>(`/jobs/${id}/preparation/start`, { method: 'POST' }));
    if (r) {
      await mutatePrep(r, false);
      await mutate();
      setTimeout(() => scrollTo('prepare-panel'), 100);
    }
  };
  const lifecycle = async (action: 'shortlist' | 'skip' | 'restore' | 'archive' | 'mark_applied', success: string) => {
    if (!app) return;
    const r = await run(`lc-${action}`, () => api(`/applications/${app.id}/lifecycle`, { body: { action } }), success);
    if (r) await refresh();
  };

  // ── The one primary action ──
  const primary = ((): Primary | null => {
    if (!app || !stage) return null;
    const wf = prep?.status ?? 'NOT_STARTED';
    switch (stage) {
      case 'DISCOVERED':
      case 'SHORTLISTED':
        return { label: 'Prepare my application', onClick: prepare, loading: busy === 'prepare' };
      case 'PREPARING':
        if (wf === 'IN_PROGRESS' && prep?.stalledHint) return { label: 'Restart preparation', onClick: prepare, loading: busy === 'prepare', note: 'Nothing has picked this up yet — see the message below.' };
        if (wf === 'IN_PROGRESS') return { label: 'Preparing…', onClick: () => undefined, loading: true, disabled: true, note: 'This runs in the background — you can leave this page.' };
        if (wf === 'NEEDS_INPUT') return { label: 'Answer the question below', onClick: () => scrollTo('prepare-panel') };
        if (wf === 'FAILED') return { label: 'Continue preparing', onClick: prepare, loading: busy === 'prepare', note: 'Retries only what failed.' };
        return { label: 'Prepare my application', onClick: prepare, loading: busy === 'prepare' };
      case 'READY_FOR_REVIEW':
        // Prepared before the workflow existed (older auto-prepare): adopt it. Finished work is reused, so this only re-checks the job and company.
        return prep?.review ? { label: 'Review and approve', onClick: () => scrollTo('review') } : { label: 'Review and approve', onClick: prepare, loading: busy === 'prepare', note: 'Opens a summary of the contact, resume and draft first.' };
      case 'APPROVED':
        return prep?.mode === 'EXTERNAL'
          ? { label: 'I applied', onClick: () => lifecycle('mark_applied', 'Marked as applied'), loading: busy === 'lc-mark_applied', note: 'Apply on the company site first — we never apply for you.' }
          : { label: 'Email queued to send', onClick: () => undefined, disabled: true };
      case 'SKIPPED':
      case 'ARCHIVED':
        return { label: 'Restore job', onClick: () => lifecycle('restore', 'Restored to Shortlisted'), loading: busy === 'lc-restore' };
      default:
        return null; // applied / replied / interview / offer / rejected: nothing to prepare
    }
  })();

  const canShortlist = stage === 'DISCOVERED';
  const canSkip = !!stage && ['DISCOVERED', 'SHORTLISTED', 'PREPARING', 'READY_FOR_REVIEW'].includes(stage);
  const canMarkApplied = !!stage && ['DISCOVERED', 'SHORTLISTED', 'PREPARING', 'READY_FOR_REVIEW'].includes(stage);
  const sourceName = job.source?.name ?? SOURCE_LABEL[job.provider] ?? humanize(job.provider);
  const place = job.location || (job.remote ? 'Remote' : 'Location not stated');
  const mode = job.extracted?.workMode && job.extracted.workMode !== 'unknown' ? humanize(job.extracted.workMode) : null;
  const workMode = mode && !place.toLowerCase().includes(mode.toLowerCase()) ? mode : null; // don't say "Remote Remote"

  return (
    <div className="space-y-5">
      <div>
        <Link href="/jobs" className="text-sm text-ink-muted hover:text-ink">
          ← Jobs
        </Link>
        <h1 className="mt-2 text-2xl font-semibold leading-tight text-ink">{job.title}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
          <span className="font-medium">{job.company.name}</span>
          <span>{place}</span>
          {workMode && <span>{workMode}</span>}
          <span className="text-ink-muted">via {sourceName}</span>
          {job.postedAt && <span className="text-ink-muted">posted {formatDate(job.postedAt)}</span>}
          {job.url && (
            <a href={job.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
              Original posting ↗
            </a>
          )}
        </p>
      </div>

      {/* ── What should I do with this job? ── */}
      <Card>
        <div className="space-y-4">
          <Verdict summary={job.summary} />
          <KeyFacts job={job} />

          {job.lifecycle && (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <StageBadge lifecycle={job.lifecycle} />
              {job.lifecycle.label !== '—' && (
                <span className="text-ink-soft">
                  Next: <span className="font-medium text-ink">{job.lifecycle.label}</span>
                </span>
              )}
            </p>
          )}

          {primary && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Button variant="primary" className="w-full sm:w-auto sm:px-5" onClick={primary.onClick} loading={primary.loading} disabled={primary.disabled}>
                {primary.label}
              </Button>
              {canShortlist && (
                <Button className="w-full sm:w-auto" onClick={() => lifecycle('shortlist', 'Shortlisted')} loading={busy === 'lc-shortlist'}>
                  Shortlist
                </Button>
              )}
              {stage === 'SHORTLISTED' && (
                <span className="px-1 text-sm text-ink-muted" aria-label="Already shortlisted">
                  ✓ Shortlisted
                </span>
              )}
              {canSkip && (
                <Button variant="ghost" className="w-full text-ink-muted sm:ml-auto sm:w-auto" onClick={() => lifecycle('skip', 'Skipped — you can restore it any time')} loading={busy === 'lc-skip'}>
                  Skip job
                </Button>
              )}
            </div>
          )}
          {primary?.note && <p className="-mt-2 text-xs text-ink-muted">{primary.note}</p>}
          {canMarkApplied && (
            <p className="text-xs text-ink-muted">
              Already applied somewhere else?{' '}
              <button type="button" className="text-brand hover:underline" onClick={() => lifecycle('mark_applied', 'Marked as applied')}>
                Mark as applied
              </button>
            </p>
          )}
          {stage === 'SKIPPED' && <Notice tone="blue">You skipped this job. It is hidden from your action list, and nothing was deleted.</Notice>}
        </div>
      </Card>

      <Insights summary={job.summary} />

      {prepError && !prep && (
        <Notice tone="red" title="Couldn't load preparation progress" actions={<Button size="sm" onClick={() => mutatePrep()}>Try again</Button>}>
          {(prepError as Error).message}
        </Notice>
      )}
      {prep && prep.status !== 'NOT_STARTED' && <PreparationPanel job={job} prep={prep} onChange={refresh} onOpenDetails={openDetails} />}

      {/* ── Everything else, out of the way ── */}
      <Disclosure id="details-all" title="More details and tools" hint="score breakdown, contacts, resume, company, email">
        <div className="space-y-3">
          <Disclosure id="details-match" title="Score breakdown and skills" hint={job.score != null ? `${job.score}%` : undefined}>
            <MatchCard job={job} onRescore={async () => { await run('rescore', () => api(`/jobs/${id}/rescore`, { method: 'POST' }), 'Re-scored'); mutate(); }} rescoring={busy === 'rescore'} />
          </Disclosure>
          <Disclosure id="details-analysis" title="AI analysis" hint={job.analysis ? undefined : 'not run'}>
            <AnalysisCard job={job} onDone={mutate} />
          </Disclosure>
          <Disclosure id="details-contacts" title="Contacts" hint={contacts?.length ? `${contacts.length} found` : 'none yet'}>
            <ContactsCard job={job} contacts={contacts ?? []} onChange={refresh} />
          </Disclosure>
          <Disclosure id="details-linkedin" title="LinkedIn note" hint="connection request text">
            <LinkedInCard job={job} />
          </Disclosure>
          <Disclosure id="details-resume" title="Tailored resume">
            <ResumeCard job={job} onChange={mutate} />
          </Disclosure>
          <Disclosure id="details-company" title={`About ${job.company.name}`}>
            <CompanyCard job={job} onChange={mutate} />
          </Disclosure>
          {app && (
            <Disclosure id="details-email" title="Email and follow-ups" hint={app.outreach.length ? `${app.outreach.length} email${app.outreach.length === 1 ? '' : 's'}` : undefined}>
              <OutreachCard job={job} contacts={contacts ?? []} onChange={refresh} />
            </Disclosure>
          )}
          {app && stage && ['APPLIED', 'REPLIED', 'INTERVIEW', 'OFFER', 'REJECTED'].includes(stage) && (
            <Disclosure id="details-interviews" title="Interviews" defaultOpen={stage === 'INTERVIEW'}>
              <InterviewsCard applicationId={app.id} onChange={mutate} />
            </Disclosure>
          )}
          <Disclosure id="details-description" title="Job description">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{job.description}</p>
          </Disclosure>
          <Disclosure id="details-advanced" title="Advanced" hint="technical details, manual status, archive, delete">
            <div className="space-y-4 text-sm">
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <Row label="Source">{sourceName}</Row>
                <Row label="Found">{formatDate(job.createdAt)}</Row>
                <Row label="Location check">{job.eligibility ? humanize(job.eligibility) : '—'}</Row>
                <Row label="Job ID">
                  <code className="text-xs">{job.id}</code>
                </Row>
              </dl>
              {!!job.eligibilityFlags?.length && (
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-muted">Signals recorded at discovery</p>
                  <div className="flex flex-wrap gap-1.5">
                    {job.eligibilityFlags.map((f) => (
                      <Badge key={f}>{f}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {app && (
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs font-medium text-ink-muted">
                    Set status manually
                    <Select
                      value={app.status}
                      className="mt-1 !w-auto"
                      disabled={busy === 'status'}
                      onChange={async (e) => {
                        await run('status', () => api(`/applications/${app.id}/status`, { body: { status: e.target.value } }), `Moved to ${humanize(e.target.value)}`);
                        refresh();
                      }}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {humanize(s)}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {stage !== 'ARCHIVED' && (
                    <Button onClick={() => lifecycle('archive', 'Archived')} loading={busy === 'lc-archive'}>
                      Archive
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    onClick={async () => {
                      if (!confirm('Delete this job and its drafts from your pipeline?')) return;
                      await run('delete', () => api(`/jobs/${id}`, { method: 'DELETE' }));
                      router.push('/jobs');
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
              <p className="text-xs text-ink-muted">Manual status changes are checked against the allowed lifecycle moves.</p>
            </div>
          </Disclosure>
        </div>
      </Disclosure>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-100 py-1">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right text-ink">{children}</dd>
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
