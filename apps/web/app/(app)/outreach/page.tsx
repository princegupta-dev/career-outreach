'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import useSWR from 'swr';
import { FollowupItem } from '@/components/followup-item';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Empty, Spinner, StatusBadge, Tabs, useAction } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { formatDateTime, humanize } from '@/lib/format';
import type { Outreach } from '@/lib/types';

type Tab = 'drafts' | 'followups' | 'queued' | 'sent' | 'failed';

interface OutreachRow extends Outreach {
  contact: { id: string; name: string; role: string | null; email: string | null };
  application: { id: string; status: string; job: { id: string; title: string; company: { name: string } } };
  followupOf: { id: string; sequence: number; scheduledAt: string; status: string } | null;
}

interface PendingFollowup {
  id: string;
  sequence: number;
  scheduledAt: string;
  status: string;
  cancelReason: string | null;
  outreachId: string | null;
  outreach: Outreach | null;
  root: { id: string; subject: string; toEmail: string; threadState: string; sentAt: string; contact: { name: string }; application: { id: string; job: { id: string; title: string; company: { name: string } } } };
}

const STATUS_FOR: Record<Exclude<Tab, 'followups'>, string> = { drafts: 'DRAFT', queued: 'APPROVED', sent: 'SENT', failed: 'FAILED' };

function OutreachInner() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get('tab') as Tab) ?? 'drafts';
  const { busy, run } = useAction();
  const { data: rows, mutate, isLoading } = useSWR<OutreachRow[]>(tab === 'followups' ? null : `/outreach?status=${STATUS_FOR[tab]}${tab === 'drafts' ? '&kind=INITIAL' : ''}`, fetcher, { refreshInterval: tab === 'queued' ? 5000 : 0 });
  const { data: followups, mutate: mutateF } = useSWR<PendingFollowup[]>(tab === 'followups' ? '/followups' : null, fetcher);

  return (
    <>
      <PageHeader
        title="Outreach"
        subtitle="Every email needs your approval. Follow-ups stop automatically the moment someone replies."
        actions={
          <Button loading={busy === 'sync'} onClick={async () => { const r = await run('sync', () => api<{ threads: number; replies: number }>('/email/sync', { method: 'POST' })); if (r) { mutate(); mutateF(); } }}>
            Check for replies
          </Button>
        }
      />
      <Tabs
        tabs={[
          { id: 'drafts', label: 'Drafts to approve' },
          { id: 'followups', label: 'Follow-ups' },
          { id: 'queued', label: 'Queued' },
          { id: 'sent', label: 'Sent' },
          { id: 'failed', label: 'Failed / blocked' },
        ]}
        value={tab}
        onChange={(t) => router.replace(`/outreach?tab=${t}`)}
      />
      <div className="mt-4">
        {tab === 'followups' ? (
          !followups ? (
            <Spinner />
          ) : followups.length === 0 ? (
            <Empty title="No pending follow-ups">Follow-ups are scheduled automatically after an initial email is sent (default: 4, 5 and 7 days).</Empty>
          ) : (
            <div className="space-y-3">
              {followups.map((f) => (
                <div key={f.id} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <Link href={`/jobs/${f.root.application.job.id}`} className="font-medium hover:underline">
                      {f.root.application.job.company.name} — {f.root.application.job.title}
                    </Link>
                    <span className="text-xs text-ink-muted">
                      to {f.root.contact.name} · initial sent {formatDateTime(f.root.sentAt)}
                    </span>
                  </div>
                  <FollowupItem followup={f} email={f.outreach ?? undefined} onChange={() => mutateF()} />
                </div>
              ))}
            </div>
          )
        ) : isLoading || !rows ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty title="Nothing here">{tab === 'drafts' ? 'Generate an email from a job page to see it here.' : undefined}</Empty>
        ) : (
          <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {rows.map((o) => (
              <div key={o.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/jobs/${o.application.job.id}`} className="text-sm font-medium hover:underline">
                      {o.application.job.company.name} — {o.application.job.title}
                    </Link>
                    {o.kind === 'FOLLOWUP' && <Badge tone="amber">Follow-up #{o.sequence}</Badge>}
                    <StatusBadge status={o.application.status} />
                  </div>
                  <p className="mt-0.5 truncate text-sm text-ink-soft">{o.subject}</p>
                  <p className="text-xs text-ink-muted">
                    to {o.contact.name} &lt;{o.toEmail}&gt; · {o.status === 'SENT' ? `sent ${formatDateTime(o.sentAt)}` : `updated ${formatDateTime((o as unknown as { updatedAt: string }).updatedAt)}`}
                    {o.status === 'SENT' && o.kind === 'INITIAL' && ` · ${humanize(o.threadState)}`}
                  </p>
                  {o.error && <p className="mt-1 text-xs text-red-700">{o.error}</p>}
                </div>
                <Link href={`/jobs/${o.application.job.id}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50">
                  {tab === 'drafts' || tab === 'failed' ? 'Review' : 'Open'}
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export default function OutreachPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <OutreachInner />
    </Suspense>
  );
}
