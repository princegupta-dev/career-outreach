'use client';

import { Badge, Button, Card, cx, Disclosure, Notice, Spinner, useAction } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import type { JobDetail, PreparationView, StepStatus, WorkflowStatus } from '@/lib/types';

const WORKFLOW_TONE: Record<WorkflowStatus, 'slate' | 'blue' | 'violet' | 'amber' | 'red' | 'green'> = {
  NOT_STARTED: 'slate',
  IN_PROGRESS: 'blue',
  READY_FOR_REVIEW: 'violet',
  NEEDS_INPUT: 'amber',
  FAILED: 'red',
  COMPLETED: 'green',
};

function StepIcon({ status }: { status: StepStatus }) {
  const base = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold';
  if (status === 'RUNNING')
    return (
      <span className={cx(base, 'bg-blue-50 text-blue-600')}>
        <Spinner small />
      </span>
    );
  if (status === 'DONE') return <span className={cx(base, 'bg-emerald-100 text-emerald-700')}>✓</span>;
  if (status === 'NEEDS_INPUT') return <span className={cx(base, 'bg-amber-100 text-amber-800')}>?</span>;
  if (status === 'FAILED') return <span className={cx(base, 'bg-red-100 text-red-700')}>!</span>;
  return <span className={cx(base, 'border border-slate-300 bg-white text-slate-400')}>·</span>;
}

const STEP_TONE: Record<StepStatus, 'slate' | 'blue' | 'green' | 'amber' | 'red'> = { PENDING: 'slate', RUNNING: 'blue', DONE: 'green', NEEDS_INPUT: 'amber', FAILED: 'red' };

const OPEN_LABEL: Record<string, string> = {
  listed: 'Still listed on the company board',
  reachable: "The posting page loads, but we can't confirm it still accepts applications",
  unverified: 'Could not be verified',
  closed: 'No longer listed (you chose to continue)',
};

export function PreparationPanel({
  job,
  prep,
  onChange,
  onOpenDetails,
}: {
  job: JobDetail;
  prep: PreparationView;
  onChange: (p?: PreparationView) => void;
  onOpenDetails: (id: string) => void;
}) {
  const { busy, run } = useAction();
  const review = prep.review;

  const act = async (key: string, path: string, success?: string) => {
    const r = await run(key, () => api<PreparationView>(`/jobs/${job.id}/preparation${path}`, { method: 'POST' }), success);
    if (r) onChange(r);
  };
  const markApplied = async () => {
    if (!job.application) return;
    const r = await run('applied', () => api(`/applications/${job.application!.id}/lifecycle`, { body: { action: 'mark_applied' } }), 'Marked as applied');
    if (r) onChange();
  };

  const applied = job.lifecycle?.stage === 'APPLIED' || ['REPLIED', 'INTERVIEW', 'OFFER', 'REJECTED'].includes(job.lifecycle?.stage ?? '');

  return (
    <Card id="prepare-panel" title="Application preparation" actions={<Badge tone={WORKFLOW_TONE[prep.status]}>{prep.statusLabel}</Badge>}>
      {prep.stalledHint && (
        <div className="mb-4">
          <Notice
            tone="amber"
            title="Waiting to start"
            actions={
              <Button size="sm" variant="primary" loading={busy === 'restart'} onClick={() => act('restart', '/start')}>
                Restart preparation
              </Button>
            }
          >
            {prep.stalledHint}
          </Notice>
        </div>
      )}

      <ol className="space-y-3">
        {prep.steps.map((s) => (
          <li key={s.key} className="flex gap-3">
            <StepIcon status={s.status} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-sm font-medium text-ink">{s.label}</p>
                <Badge tone={STEP_TONE[s.status]}>{s.statusLabel}</Badge>
                {s.finishedAt && s.status === 'DONE' && <span className="text-xs text-ink-muted">{relativeTime(s.finishedAt)}</span>}
                {s.attempts > 1 && <span className="text-xs text-ink-muted">attempt {s.attempts}</span>}
              </div>
              {s.summary && s.status !== 'FAILED' && <p className="mt-0.5 text-sm text-ink-soft">{s.summary}</p>}
              {s.error && <p className="mt-0.5 text-sm text-red-700">{s.error}</p>}
              {s.status === 'NEEDS_INPUT' && s.needs && (
                <div className="mt-2">
                  <Notice
                    tone="amber"
                    actions={
                      <>
                        <Button size="sm" variant="primary" loading={busy === `confirm-${s.key}`} onClick={() => act(`confirm-${s.key}`, `/steps/${s.key}/confirm`)}>
                          {s.needs.kind === 'confirm_open' ? 'Continue anyway' : 'Use this contact'}
                        </Button>
                        {s.needs.kind === 'confirm_contact' && (
                          <Button size="sm" onClick={() => onOpenDetails('details-contacts')}>
                            Add a different contact
                          </Button>
                        )}
                      </>
                    }
                  >
                    {s.needs.message}
                  </Notice>
                </div>
              )}
              {s.status === 'FAILED' && (
                <div className="mt-2 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="primary" loading={busy === `retry-${s.key}`} onClick={() => act(`retry-${s.key}`, `/steps/${s.key}/retry`)}>
                      Retry this step
                    </Button>
                    {s.key === 'RESUME' && (
                      <Button size="sm" loading={busy === 'skip-RESUME'} onClick={() => act('skip-RESUME', '/steps/RESUME/skip')}>
                        Continue without a tailored resume
                      </Button>
                    )}
                    <span className="text-xs text-ink-muted">Finished steps are kept.</span>
                  </div>
                </div>
              )}
              {s.key === 'RESUME' && s.status === 'DONE' && !s.skipped && prep.status !== 'COMPLETED' && (
                <div className="mt-1">
                  <button type="button" className="text-xs text-brand hover:underline disabled:opacity-50" disabled={busy === 'retry-RESUME'} onClick={() => act('retry-RESUME', '/steps/RESUME/retry')}>
                    Tailor again
                  </button>
                </div>
              )}
              {s.key === 'RESUME' && s.skipped && prep.status !== 'COMPLETED' && (
                <div className="mt-2">
                  <Button size="sm" loading={busy === 'retry-RESUME'} onClick={() => act('retry-RESUME', '/steps/RESUME/retry')}>
                    Try tailoring again
                  </Button>
                </div>
              )}
              {s.key === 'CONTACT' && s.status === 'DONE' && review && !review.contact && prep.status !== 'COMPLETED' && (
                <div className="mt-2">
                  <Button size="sm" loading={busy === 'retry-CONTACT'} onClick={() => act('retry-CONTACT', '/steps/CONTACT/retry')}>
                    Look again
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>

      {review && (
        <div id="review" className="mt-6 space-y-5 border-t border-slate-100 pt-5">
          <h3 className="text-sm font-semibold text-ink">Preparation summary</h3>

          <dl className="grid gap-x-6 gap-y-4 md:grid-cols-2">
            <Section title="Job check">
              <p>{OPEN_LABEL[review.job.open] ?? review.job.open}.</p>
              {review.job.note && review.job.open !== 'closed' && <p className="text-ink-muted">{review.job.note}</p>}
              {review.job.checkedAt && <p className="text-xs text-ink-muted">Checked {relativeTime(review.job.checkedAt)}</p>}
            </Section>

            <Section title="Contact">
              {review.contact ? (
                <>
                  <p className="font-medium">
                    {review.contact.name}
                    {review.contact.role && <span className="font-normal text-ink-muted"> · {review.contact.role}</span>}
                  </p>
                  <p className="break-all">{review.contact.email}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                    <Badge tone={review.contact.confidence === 'VERIFIED' ? 'green' : 'amber'}>{review.contact.confidence === 'VERIFIED' ? 'Verified' : 'Not verified'}</Badge>
                    via {review.contact.source}
                    {review.contact.sourceUrl && (
                      <a href={review.contact.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                        source ↗
                      </a>
                    )}
                  </p>
                </>
              ) : (
                <>
                  <p>No public hiring contact was found. Emails are never guessed.</p>
                  <ul className="mt-1 space-y-0.5">
                    {review.fallbackRoutes.map((r) => (
                      <li key={r.url}>
                        <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                          {r.label} ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Section>

            <Section title="Tailored resume">
              {review.resume ? (
                <>
                  <p>
                    {review.resume.reused ? 'Reused (nothing changed since last time).' : 'Tailored for this job.'} {review.resume.changes > 0 && `${review.resume.changes} change${review.resume.changes === 1 ? '' : 's'}: items re-ordered, nothing added or invented.`}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-2">
                    <a href={review.resume.previewUrl} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                      Preview PDF ↗
                    </a>
                    <a href={review.resume.downloadUrl} className="text-brand hover:underline">
                      Download
                    </a>
                    <button type="button" className="text-brand hover:underline" onClick={() => onOpenDetails('details-resume')}>
                      See what changed
                    </button>
                  </p>
                </>
              ) : prep.steps.find((x) => x.key === 'RESUME')?.skipped ? (
                <p>Skipped — you chose to continue without one. Use your own resume when you apply.</p>
              ) : (
                <p className="text-ink-muted">Not ready yet.</p>
              )}
            </Section>

            <Section title={review.email ? 'Email draft' : 'Application checklist'}>
              {review.email ? (
                <>
                  <p>
                    To <span className="font-medium">{review.email.to}</span> {review.email.attachResume && <span className="text-ink-muted">· resume attached</span>}
                  </p>
                  <p className="font-medium">{review.email.subject}</p>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-brand">Read the draft</summary>
                    <p className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-ink-soft">{review.email.body}</p>
                    <button type="button" className="mt-2 text-brand hover:underline" onClick={() => onOpenDetails('details-email')}>
                      Edit the draft
                    </button>
                  </details>
                  <p className="mt-1 text-xs text-ink-muted">Status: {review.email.status.toLowerCase()}. It has not been sent.</p>
                </>
              ) : review.checklist ? (
                <ul className="list-disc space-y-1 pl-4">
                  {review.checklist.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-muted">Not ready yet.</p>
              )}
            </Section>
          </dl>

          <Disclosure title="Company research" hint={`${review.company.filter((f) => f.value).length} of ${review.company.length} facts found`}>
            <ul className="space-y-1.5 text-sm">
              {review.company.map((f, i) => (
                <li key={`${f.label}-${i}`}>
                  <span className="font-medium text-ink">{f.label}: </span>
                  {f.value ? (
                    <>
                      <span className="text-ink-soft">{f.value}</span>
                      <span className="text-xs text-ink-muted">
                        {' '}
                        — {f.source ?? 'source not recorded'}
                        {f.asOf ? `, ${formatDate(f.asOf)}` : ''}
                      </span>
                      {f.sourceUrl && (
                        <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-xs text-brand hover:underline">
                          ↗
                        </a>
                      )}
                    </>
                  ) : (
                    <span className="italic text-ink-muted">Unknown</span>
                  )}
                </li>
              ))}
            </ul>
          </Disclosure>

          {review.outstandingChecks.length > 0 && (
            <Notice tone="amber" title="Check before you approve">
              <ul className="list-disc space-y-0.5 pl-4">
                {review.outstandingChecks.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Notice>
          )}

          {/* The single final action. Nothing is sent or submitted before this. */}
          {review.canApprove ? (
            <div className="rounded-lg border border-brand/30 bg-brand-soft/30 p-4">
              <Button variant="primary" className="w-full sm:w-auto" loading={busy === 'approve'} onClick={() => act('approve', '/approve', 'Approved')}>
                {review.approveLabel}
              </Button>
              <p className="mt-2 text-xs text-ink-muted">{review.email ? 'Nothing is sent until you click this. Daily limits and the existing send safeguards still apply.' : 'This only records your approval. Nothing is submitted for you.'}</p>
            </div>
          ) : prep.status === 'COMPLETED' ? (
            applied ? (
              <Notice tone="green" title="Applied">
                {review.email ? 'The email was sent. Replies are tracked automatically.' : 'You marked this job as applied.'}
              </Notice>
            ) : review.email ? (
              <Notice tone="green" title="Approved — the email is queued">
                It is sent by the background worker, within your daily limits and spacing rules. You can still cancel it from Details → Email until it is sent.
              </Notice>
            ) : (
              <Notice
                tone="green"
                title="Approved — now apply on the company site"
                actions={
                  <>
                    {job.url && (
                      <a href={job.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-ink hover:bg-slate-50">
                        Open the posting ↗
                      </a>
                    )}
                    <Button size="sm" variant="primary" loading={busy === 'applied'} onClick={markApplied}>
                      I applied
                    </Button>
                  </>
                }
              >
                We never apply for you. Click &quot;I applied&quot; once you have, so the job is tracked.
              </Notice>
            )
          ) : (
            <p className="text-sm text-ink-muted">Approval unlocks when every step above is completed.</p>
          )}
        </div>
      )}

      {prep.events.length > 0 && (
        <div className="mt-5">
          <Disclosure title="Activity" hint={`${prep.events.length} recent events`}>
            <ul className="space-y-1 text-xs">
              {prep.events.map((e) => (
                <li key={e.id} className={cx('flex gap-2', e.type === 'failed' ? 'text-red-700' : 'text-ink-soft')}>
                  <span className="w-28 shrink-0 text-ink-muted">{relativeTime(e.createdAt)}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 text-sm">
      <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">{title}</dt>
      <dd className="space-y-0.5 text-ink-soft">{children}</dd>
    </div>
  );
}
