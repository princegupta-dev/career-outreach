'use client';

import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { AddJobModal } from '@/components/jobs';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, Empty, RecommendationBadge, ScorePill, Spinner, Stat, useAction } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { formatDateTime, formatSalary, relativeTime } from '@/lib/format';
import type { Recommendation } from '@/lib/types';

interface Dashboard {
  stats: { jobsDiscovered: number; strongMatches: number; emailsSent: number; replies: number; replyRate: number; interviews: number; offers: number; pendingFollowups: number };
  pipeline: Array<{ label: string; statuses: string[]; count: number }>;
  actions: { draftsToReview: number; followupDraftsToReview: number; failedSends: number; repliesToAnswer: Array<{ id: string; replySentiment: string | null; job: { id: string; title: string; company: { name: string } } }> };
  setup: { emailMode: 'gmail' | 'sandbox'; gmailConnected: boolean; ai: { provider: string; model: string | null; llm: boolean; circuit?: { open: boolean; reason: string | null; until: string | null } } };
}

interface TodayJob {
  id: string;
  title: string;
  location: string | null;
  remote: boolean | null;
  score: number | null;
  recommendation: Recommendation | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  provider: string;
  createdAt: string;
  company: { name: string };
  application: { id: string; status: string; autoPreparedAt: string | null; contact: { name: string; role: string | null } | null; outreach: Array<{ id: string; status: string; gmailDraftId: string | null }> } | null;
}

interface Today {
  relevant: number;
  strong: number;
  consider: number;
  readyToSend: number;
  sources: number;
  running: boolean;
  lastRun: { at: string; trigger: string; stats: { sources: number; sourcesFailed: number; fetched: number; afterFilters: number; created: number; relevant: number; prepared: number; errors: Array<{ source: string; error: string }> } } | null;
  jobs: TodayJob[];
}

interface Interview {
  id: string;
  stage: string;
  scheduledAt: string | null;
  application: { job: { id: string; title: string; company: { name: string } } };
}

const SOURCE_LABEL: Record<string, string> = {
  GREENHOUSE: 'Company board',
  ASHBY: 'Company board',
  LEVER: 'Company board',
  HN_HIRING: 'HN Who is hiring',
  WWR: 'We Work Remotely',
  REMOTIVE: 'Remotive',
  HIMALAYAS: 'Himalayas',
  JOBICY: 'Jobicy',
  REMOTEOK: 'Remote OK',
  ARBEITNOW: 'Arbeitnow',
  URL: 'URL',
  PASTE: 'Pasted',
  MANUAL: 'Manual',
};

function readiness(j: TodayJob): { label: string; tone: 'green' | 'violet' | 'amber' | 'slate' } {
  const o = j.application?.outreach[0];
  if (o?.status === 'SENT') return { label: 'Sent', tone: 'green' };
  if (o?.status === 'DRAFT') return { label: o.gmailDraftId ? 'Draft ready in Gmail' : 'Email draft ready', tone: 'violet' };
  if (j.application?.autoPreparedAt && !j.application.contact) return { label: 'Needs a contact', tone: 'amber' };
  return { label: 'Review', tone: 'slate' };
}

export default function DashboardPage() {
  const { data: today, mutate: mutateToday } = useSWR<Today>('/discovery/today', fetcher, { refreshInterval: (d) => (d?.running ? 4000 : 60_000) });
  const { data, mutate } = useSWR<Dashboard>('/dashboard', fetcher, { refreshInterval: 60_000 });
  const { data: interviews } = useSWR<Interview[]>('/interviews', fetcher);
  const [adding, setAdding] = useState(false);
  const { busy, run } = useAction();

  if (!data || !today) return <Spinner />;
  const s = data.stats;
  const a = data.actions;
  const last = today.lastRun;

  const findNow = async () => {
    await run('find', () => api('/discovery/run', { method: 'POST' }), 'Searching all sources — results appear here as they come in.');
    setTimeout(() => mutateToday(), 1500);
  };

  return (
    <>
      <PageHeader
        title="Dashboard"
        actions={
          <>
            <Button onClick={() => setAdding(true)}>Add a job manually</Button>
            <Button variant="primary" onClick={findNow} loading={busy === 'find' || today.running}>
              {today.running ? 'Searching…' : 'Find jobs now'}
            </Button>
          </>
        }
      />
      <AddJobModal open={adding} onClose={() => setAdding(false)} onAdded={() => { mutate(); mutateToday(); }} />

      {(data.setup.emailMode === 'sandbox' || (data.setup.emailMode === 'gmail' && !data.setup.gmailConnected)) && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {data.setup.emailMode === 'sandbox' ? (
            <p>Email is in <b>sandbox mode</b>: nothing leaves your machine. Set EMAIL_PROVIDER=gmail and connect Gmail in Settings to send for real.</p>
          ) : (
            <p>
              Gmail isn&apos;t connected — <Link className="underline" href="/settings">connect it in Settings</Link> so drafts appear in your Gmail.
            </p>
          )}
        </div>
      )}

      {data.setup.ai.circuit?.open && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            <b>AI is paused</b> until {formatDateTime(data.setup.ai.circuit.until)} — Anthropic said: <i>{data.setup.ai.circuit.reason?.replace(/^.*"message":"([^"]+)".*$/, '$1')}</i>. Using the built-in
            templates meanwhile (everything keeps working). Add credit at console.anthropic.com or set AI_PROVIDER=template.
          </p>
        </div>
      )}

      {/* ── Today's headline ─────────────────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-2xl font-semibold tracking-tight">
          {today.running && today.relevant === 0
            ? 'Searching for jobs…'
            : `We found ${today.relevant} relevant job${today.relevant === 1 ? '' : 's'} for you today.`}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          {today.strong > 0 && <span>{today.strong} strong match{today.strong === 1 ? '' : 'es'} · </span>}
          {today.readyToSend > 0 && <span>{today.readyToSend} email{today.readyToSend === 1 ? '' : 's'} drafted for your review · </span>}
          {today.consider > 0 && <span>{today.consider} more to consider · </span>}
          {last ? (
            <span>
              Last search {relativeTime(last.at)} across {last.stats.sources} sources: {last.stats.fetched.toLocaleString()} postings → {last.stats.afterFilters} after filters → {last.stats.created} new
              {last.stats.sourcesFailed > 0 && <span className="text-amber-700"> ({last.stats.sourcesFailed} sources unavailable — see Settings)</span>}
            </span>
          ) : (
            <span>The first search runs automatically; it takes a minute or two.</span>
          )}
        </p>
        {today.jobs.length === 0 ? (
          <div className="mt-4">
            <Empty title={today.running ? 'Searching job boards and company career pages…' : 'Nothing new today yet'}>
              {today.running ? 'This page updates automatically.' : 'Discovery runs every morning. Click "Find jobs now" to search immediately.'}
            </Empty>
          </div>
        ) : (
          <div className="mt-4 divide-y divide-slate-100 rounded-md border border-slate-100">
            {today.jobs.map((j) => {
              const r = readiness(j);
              const salary = formatSalary(j.salaryMin, j.salaryMax, j.salaryCurrency, j.salaryPeriod);
              return (
                <Link key={j.id} href={`/jobs/${j.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-50">
                  <ScorePill score={j.score} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {j.title} <span className="font-normal text-ink-muted">· {j.company.name}</span>
                    </p>
                    <p className="truncate text-xs text-ink-muted">
                      {j.remote ? 'Remote' : j.location || 'Location not stated'}
                      {salary && ` · ${salary}`} · via {SOURCE_LABEL[j.provider] ?? j.provider}
                      {j.application?.contact && ` · contact: ${j.application.contact.name}`}
                    </p>
                  </div>
                  <RecommendationBadge rec={j.recommendation} />
                  <Badge tone={r.tone}>{r.label}</Badge>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
        <Stat label="Jobs" value={s.jobsDiscovered} />
        <Stat label="Strong matches" value={s.strongMatches} />
        <Stat label="Emails sent" value={s.emailsSent} />
        <Stat label="Replies" value={s.replies} />
        <Stat label="Reply rate" value={`${s.replyRate}%`} />
        <Stat label="Interviews" value={s.interviews} />
        <Stat label="Offers" value={s.offers} />
        <Stat label="Follow-ups" value={s.pendingFollowups} hint="pending" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Pipeline" className="lg:col-span-2">
          <div className="grid grid-cols-7 gap-2">
            {data.pipeline.map((p) => (
              <Link key={p.label} href={`/jobs?status=${p.statuses[0]}`} className="group text-center">
                <div className="rounded-md bg-slate-50 px-1 py-3 group-hover:bg-slate-100">
                  <p className="text-xl font-semibold tabular-nums">{p.count}</p>
                </div>
                <p className="mt-1.5 truncate text-xs text-ink-muted">{p.label}</p>
              </Link>
            ))}
          </div>
        </Card>
        <Card title="Next actions">
          <ul className="space-y-2 text-sm">
            {a.draftsToReview > 0 && (
              <li>
                <Link href="/outreach" className="flex justify-between hover:underline">
                  <span>Emails to review & approve</span>
                  <Badge tone="violet">{a.draftsToReview}</Badge>
                </Link>
              </li>
            )}
            {a.followupDraftsToReview > 0 && (
              <li>
                <Link href="/outreach?tab=followups" className="flex justify-between hover:underline">
                  <span>Follow-up drafts ready</span>
                  <Badge tone="amber">{a.followupDraftsToReview}</Badge>
                </Link>
              </li>
            )}
            {a.failedSends > 0 && (
              <li>
                <Link href="/outreach?tab=failed" className="flex justify-between hover:underline">
                  <span>Failed / blocked sends</span>
                  <Badge tone="red">{a.failedSends}</Badge>
                </Link>
              </li>
            )}
            {a.repliesToAnswer.map((r) => (
              <li key={r.id}>
                <Link href={`/jobs/${r.job.id}`} className="flex justify-between gap-2 hover:underline">
                  <span className="truncate">Reply from {r.job.company.name}</span>
                  <Badge tone={r.replySentiment === 'positive' ? 'green' : r.replySentiment === 'negative' ? 'red' : 'blue'}>{r.replySentiment ?? 'reply'}</Badge>
                </Link>
              </li>
            ))}
            {interviews?.map((i) => (
              <li key={i.id}>
                <Link href={`/jobs/${i.application.job.id}`} className="flex justify-between gap-2 hover:underline">
                  <span className="truncate">
                    {i.stage} — {i.application.job.company.name}
                  </span>
                  <Badge tone="green">{i.scheduledAt ? formatDateTime(i.scheduledAt) : 'Interview'}</Badge>
                </Link>
              </li>
            ))}
            {a.draftsToReview + a.followupDraftsToReview + a.failedSends + a.repliesToAnswer.length + (interviews?.length ?? 0) === 0 && (
              <li className="text-ink-muted">Nothing waiting on you right now.</li>
            )}
          </ul>
        </Card>
      </div>
    </>
  );
}
