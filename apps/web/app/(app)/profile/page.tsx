'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, Spinner, Textarea, useAction } from '@/components/ui';
import { api, fetcher } from '@/lib/api';

interface ProfileResponse {
  markdown: string;
  path: string;
  missing: string[];
  profile: {
    name: string;
    current_title: string;
    experienceYears: number;
    strongSkills: string[];
    partialSkills: string[];
    learningSkills: string[];
    target_roles: string[];
    target_locations: string[];
    compensation: { india_min_lpa: number | null; india_max_lpa: number | null };
  };
}

export default function ProfilePage() {
  const { data, mutate } = useSWR<ProfileResponse>('/profile', fetcher);
  const [md, setMd] = useState('');
  const { busy, run } = useAction();
  useEffect(() => {
    if (data) setMd(data.markdown);
  }, [data]);
  if (!data) return <Spinner />;
  const p = data.profile;

  const save = async () => {
    const r = await run('save', () => api<{ rescored: number }>('/profile', { method: 'PUT', body: { markdown: md } }));
    if (r) {
      mutate();
      alert(`Profile saved. ${r.rescored} job(s) re-scored against the updated profile.`);
    }
  };

  return (
    <>
      <PageHeader
        title="Candidate profile"
        subtitle={<span>Canonical source of truth for scoring, resumes and emails. Stored in <code className="rounded bg-slate-100 px-1 text-xs">{data.path}</code></span>}
        actions={
          <Button variant="primary" onClick={save} disabled={md === data.markdown} loading={busy === 'save'}>
            Save & re-score
          </Button>
        }
      />
      {data.missing.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Unknown fields (left blank, never invented): {data.missing.join(', ')}. Fill them in when you can.
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Textarea value={md} onChange={(e) => setMd(e.target.value)} rows={40} spellCheck={false} className="font-mono text-xs leading-relaxed" />
        </div>
        <div className="space-y-6">
          <Card title="Parsed">
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs text-ink-muted">Name / title</dt>
                <dd>
                  {p.name} — {p.current_title}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">Experience (from career start)</dt>
                <dd>~{p.experienceYears} years</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">India target</dt>
                <dd>
                  ₹{p.compensation.india_min_lpa ?? '?'}–{p.compensation.india_max_lpa ?? '?'} LPA
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">Target roles</dt>
                <dd>{p.target_roles.join(', ')}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">Locations</dt>
                <dd>{p.target_locations.join(', ')}</dd>
              </div>
            </dl>
          </Card>
          <Card title={`Strong skills (${p.strongSkills.length})`}>
            <div className="flex flex-wrap gap-1.5">
              {p.strongSkills.map((s) => (
                <Badge key={s} tone="green">
                  {s}
                </Badge>
              ))}
              {p.partialSkills.map((s) => (
                <Badge key={s} tone="amber">
                  {s} (partial)
                </Badge>
              ))}
              {p.learningSkills.map((s) => (
                <Badge key={s} tone="blue">
                  {s} (learning)
                </Badge>
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-muted">Only add a skill you have used professionally. Anything not listed is reported as a gap — never claimed.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
