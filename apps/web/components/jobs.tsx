'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { formatSalary } from '@/lib/format';
import type { Recommendation } from '@/lib/types';
import { Button, Field, Input, Modal, RecommendationBadge, ScorePill, StatusBadge, Tabs, Textarea, useAction } from './ui';

interface IngestResult {
  jobId: string;
  duplicate: boolean;
  score: number | null;
  recommendation: Recommendation | null;
}

/** Add a job by URL (ATS / schema.org pages), pasted JD, or manual entry. */
export function AddJobModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded?: () => void }) {
  const router = useRouter();
  const { busy, run } = useAction();
  const [tab, setTab] = useState<'url' | 'paste' | 'manual'>('url');
  const [url, setUrl] = useState('');
  const [form, setForm] = useState({ title: '', companyName: '', location: '', description: '', url: '', companyWebsite: '', salaryText: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  const done = (r: IngestResult | undefined) => {
    if (!r) return;
    onAdded?.();
    onClose();
    router.push(`/jobs/${r.jobId}${r.duplicate ? '?duplicate=1' : ''}`);
  };

  const submit = async () => {
    if (tab === 'url') {
      done(await run('add', () => api<IngestResult>('/jobs/import-url', { body: { url } })));
    } else {
      const body = { ...form, mode: tab, url: form.url || null, location: form.location || null, companyWebsite: form.companyWebsite || null, salaryText: form.salaryText || null };
      done(await run('add', () => api<IngestResult>('/jobs/manual', { body })));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a job" wide>
      <Tabs
        tabs={[
          { id: 'url', label: 'From URL' },
          { id: 'paste', label: 'Paste JD' },
          { id: 'manual', label: 'Manual' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mt-4 space-y-3">
        {tab === 'url' ? (
          <>
            <Field label="Job URL" hint="Greenhouse, Lever and Ashby links use their public APIs. Other career pages are fetched once (robots.txt respected). LinkedIn/Indeed/Naukri aren't fetched — paste the JD instead.">
              <Input placeholder="https://boards.greenhouse.io/company/jobs/123" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
            </Field>
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Job title">
                <Input value={form.title} onChange={set('title')} placeholder="Senior Backend Engineer" />
              </Field>
              <Field label="Company">
                <Input value={form.companyName} onChange={set('companyName')} placeholder="Acme" />
              </Field>
              <Field label="Location">
                <Input value={form.location} onChange={set('location')} placeholder="Remote / Bengaluru" />
              </Field>
              <Field label="Company website (optional)" hint="Used for verified company facts and contact lookup">
                <Input value={form.companyWebsite} onChange={set('companyWebsite')} placeholder="acme.com" />
              </Field>
              {tab === 'manual' && (
                <>
                  <Field label="Job URL (optional)">
                    <Input value={form.url} onChange={set('url')} />
                  </Field>
                  <Field label="Salary (optional)">
                    <Input value={form.salaryText} onChange={set('salaryText')} placeholder="₹30-40 LPA" />
                  </Field>
                </>
              )}
            </div>
            <Field label="Job description">
              <Textarea rows={10} value={form.description} onChange={set('description')} placeholder="Paste the full job description…" />
            </Field>
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy === 'add'}>
            Add & score
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface JobCardData {
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
  company: { name: string };
  application: { status: string; contact: { name: string; role: string | null } | null } | null;
  nextAction: string | null;
}

export function JobCard({ job }: { job: JobCardData }) {
  const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod);
  return (
    <Link href={`/jobs/${job.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-300 hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-ink-muted">{job.company.name}</p>
          <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-ink">{job.title}</p>
        </div>
        <ScorePill score={job.score} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <RecommendationBadge rec={job.recommendation} />
        {job.application && <StatusBadge status={job.application.status} />}
      </div>
      <dl className="mt-3 space-y-1 text-xs text-ink-soft">
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Location</dt>
          <dd className="truncate">{job.remote ? 'Remote' : job.location || '—'}</dd>
        </div>
        {salary && (
          <div className="flex justify-between gap-2">
            <dt className="text-ink-muted">Salary</dt>
            <dd>{salary}</dd>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Contact</dt>
          <dd className="truncate">{job.application?.contact ? `${job.application.contact.name}${job.application.contact.role ? ` · ${job.application.contact.role}` : ''}` : '—'}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Next</dt>
          <dd className="font-medium text-ink">{job.nextAction ?? '—'}</dd>
        </div>
      </dl>
    </Link>
  );
}
