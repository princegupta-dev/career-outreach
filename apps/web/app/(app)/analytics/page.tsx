'use client';

import useSWR from 'swr';
import { PageHeader } from '@/components/shell';
import { Button, Card, Spinner, Stat } from '@/components/ui';
import { fetcher } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface Bucket {
  key: string;
  sent: number;
  replied: number;
  positive: number;
  interviews: number;
  replyRate: number;
}

interface Report {
  generatedAt: string;
  totals: Record<string, number>;
  breakdowns: Record<string, Bucket[]>;
  insights: string[];
  weekly: Array<{ week: string; sent: number; replied: number }>;
}

const LABELS: Record<string, string> = {
  companySize: 'Company size',
  companyType: 'Company type',
  location: 'Location',
  role: 'Role type',
  contactType: 'Contact type',
  matchScore: 'Match score',
  emailStyle: 'Email style',
  aiGenerated: 'Writer',
};

export default function AnalyticsPage() {
  const { data, mutate, isValidating } = useSWR<Report>('/analytics', fetcher);
  if (!data) return <Spinner />;
  const t = data.totals;
  const maxWeekly = Math.max(1, ...data.weekly.map((w) => w.sent));
  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle={`Updated ${formatDateTime(data.generatedAt)}`}
        actions={
          <Button size="sm" loading={isValidating} onClick={() => mutate(fetcher<Report>('/analytics?fresh=1'), { revalidate: false })}>
            Refresh
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Emails sent" value={t.emailsSent} hint={`+ ${t.followupsSent} follow-ups`} />
        <Stat label="Replies" value={t.replies} hint={`${t.replyRate}% reply rate`} />
        <Stat label="Positive replies" value={t.positiveReplies} />
        <Stat label="Interviews / offers" value={`${t.interviews} / ${t.offers}`} />
      </div>

      <Card title="What's working" className="mt-6">
        <ul className="space-y-1 text-sm">
          {data.insights.map((i) => (
            <li key={i}>• {i}</li>
          ))}
        </ul>
      </Card>

      {data.weekly.length > 0 && (
        <Card title="Weekly outreach" className="mt-6">
          <div className="flex h-36 items-end gap-2">
            {data.weekly.map((w) => (
              <div key={w.week} className="flex flex-1 flex-col items-center gap-1" title={`${w.week}: ${w.sent} sent, ${w.replied} replied`}>
                <div className="flex w-full flex-col justify-end rounded bg-slate-100" style={{ height: `${(w.sent / maxWeekly) * 100}%` }}>
                  <div className="rounded bg-emerald-500" style={{ height: `${w.sent ? (w.replied / w.sent) * 100 : 0}%` }} />
                </div>
                <span className="text-[10px] text-ink-muted">{w.week.slice(5)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-muted">Grey: sent · Green: replied</p>
        </Card>
      )}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {Object.entries(data.breakdowns).map(([dim, buckets]) => (
          <Card key={dim} title={`By ${LABELS[dim] ?? dim}`}>
            {buckets.length === 0 ? (
              <p className="text-sm text-ink-muted">No data yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-ink-muted">
                  <tr>
                    <th className="pb-2 font-medium">Segment</th>
                    <th className="pb-2 text-right font-medium">Sent</th>
                    <th className="pb-2 text-right font-medium">Replied</th>
                    <th className="pb-2 text-right font-medium">Rate</th>
                    <th className="pb-2 text-right font-medium">Interviews</th>
                  </tr>
                </thead>
                <tbody>
                  {buckets.map((b) => (
                    <tr key={b.key} className="border-t border-slate-100">
                      <td className="py-1.5 capitalize">{b.key}</td>
                      <td className="py-1.5 text-right tabular-nums">{b.sent}</td>
                      <td className="py-1.5 text-right tabular-nums">{b.replied}</td>
                      <td className="py-1.5 text-right tabular-nums">{b.replyRate}%</td>
                      <td className="py-1.5 text-right tabular-nums">{b.interviews}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
