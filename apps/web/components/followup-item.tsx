'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatDateTime, humanize, relativeTime } from '@/lib/format';
import type { Outreach } from '@/lib/types';
import { Badge, Button, Textarea, useAction } from './ui';

/** One follow-up in a thread: schedule, status, draft review and approval. */
export function FollowupItem({ followup: f, email, onChange }: { followup: { id: string; sequence: number; scheduledAt: string; status: string; cancelReason: string | null }; email?: Outreach; onChange: () => void }) {
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(email?.body ?? '');
  useEffect(() => setBody(email?.body ?? ''), [email?.body]);
  const tone = f.status === 'SENT' ? 'green' : f.status === 'CANCELLED' || f.status === 'FAILED' ? 'red' : f.status === 'SKIPPED' ? 'slate' : 'amber';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">Follow-up #{f.sequence}</p>
        <Badge tone={tone}>{humanize(f.status)}</Badge>
        <span className="text-xs text-ink-muted">
          {f.status === 'SENT' ? `sent ${relativeTime(email?.sentAt)}` : `due ${formatDateTime(f.scheduledAt)} (${relativeTime(f.scheduledAt)})`}
        </span>
      </div>
      {f.cancelReason && <p className="text-xs text-ink-muted">{f.cancelReason}</p>}
      <div className="mt-1 flex flex-wrap gap-2">
        {f.status === 'SCHEDULED' && (
          <Button size="sm" loading={busy === 'prep'} onClick={async () => { await run('prep', () => api(`/followups/${f.id}/prepare`, { body: {} })); onChange(); setOpen(true); }}>
            Prepare draft now
          </Button>
        )}
        {email && f.status !== 'CANCELLED' && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'View'} draft
          </Button>
        )}
        {['SCHEDULED', 'DRAFT_READY', 'APPROVED'].includes(f.status) && (
          <Button size="sm" variant="ghost" onClick={async () => { await run('skip', () => api(`/followups/${f.id}/skip`, { method: 'POST' }), 'Skipped'); onChange(); }}>
            Skip
          </Button>
        )}
      </div>
      {open && email && (
        <div className="mt-2 space-y-2 rounded border border-slate-200 p-2">
          <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} disabled={!['DRAFT', 'FAILED'].includes(email.status)} />
          {(email.warnings?.items ?? []).map((w) => (
            <p key={w} className="text-xs text-amber-800">
              ⚠ {w}
            </p>
          ))}
          {['DRAFT', 'FAILED'].includes(email.status) && (
            <div className="flex justify-end gap-2">
              <Button size="sm" disabled={body === email.body} onClick={async () => { await run('save', () => api(`/outreach/${email.id}`, { method: 'PATCH', body: { body } }), 'Saved'); onChange(); }}>
                Save
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={busy === 'approve'}
                onClick={async () => {
                  if (body !== email.body) await api(`/outreach/${email.id}`, { method: 'PATCH', body: { body } });
                  await run('approve', () => api(`/outreach/${email.id}/approve`, { body: {} }), 'Approved — it will be sent when due, unless they reply first');
                  onChange();
                }}
              >
                Approve
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
