'use client';

import { cx } from '@/components/ui';
import { formatSalary } from '@/lib/format';
import type { JobDetail, JobSummary, VerdictKey } from '@/lib/types';

const VERDICT_STYLE: Record<VerdictKey, { box: string; dot: string }> = {
  STRONG_MATCH: { box: 'border-emerald-200 bg-emerald-50 text-emerald-900', dot: 'bg-emerald-500' },
  GOOD_MATCH: { box: 'border-blue-200 bg-blue-50 text-blue-900', dot: 'bg-blue-500' },
  REVIEW_MANUALLY: { box: 'border-amber-200 bg-amber-50 text-amber-900', dot: 'bg-amber-500' },
  NOT_RECOMMENDED: { box: 'border-slate-200 bg-slate-50 text-slate-700', dot: 'bg-slate-400' },
};

/** The answer to "should I apply?" — one label, one number, one sentence. */
export function Verdict({ summary }: { summary: JobSummary }) {
  const style = VERDICT_STYLE[summary.verdict];
  return (
    <div className={cx('rounded-lg border px-4 py-3', style.box)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-lg font-semibold">
          <span aria-hidden className={cx('h-2.5 w-2.5 rounded-full', style.dot)} />
          {summary.verdictLabel}
        </span>
        {summary.score != null && <span className="text-sm font-medium tabular-nums opacity-80">{summary.score}% match</span>}
      </div>
      <p className="mt-1 text-sm leading-relaxed">{summary.explanation}</p>
    </div>
  );
}

function Fact({ label, value, note, unknown, tone }: { label: string; value: string; note?: string | null; unknown?: boolean; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className={cx('mt-0.5 text-sm', unknown ? 'italic text-ink-muted' : 'font-medium text-ink')}>
        {tone && <span aria-hidden className={cx('mr-1.5 inline-block h-2 w-2 rounded-full align-middle', tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-red-500')} />}
        {value}
      </dd>
      {note && <dd className="text-xs text-ink-muted">{note}</dd>}
    </div>
  );
}

/** The four facts that decide whether to apply. Anything we could not establish says "Unknown" — it is never guessed. */
export function KeyFacts({ job }: { job: JobDetail }) {
  const f = job.summary.facts;
  const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod);
  const loc = f.location;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
      <Fact label="Salary" value={salary ?? 'Not disclosed'} unknown={!salary} note={salary ? 'From the posting' : null} />
      <Fact label="Experience" value={f.experience.known ? f.experience.label : 'Not stated'} unknown={!f.experience.known} note={f.experience.known ? f.experience.source : null} />
      <Fact
        label="Location eligibility"
        value={loc.label}
        unknown={!loc.known}
        tone={loc.status === 'open' ? 'ok' : loc.status === 'restricted' ? 'bad' : 'warn'}
        note={loc.status === 'uncertain' ? 'Verify before applying' : loc.status === 'restricted' ? 'May exclude India' : null}
      />
      <Fact label="Company size" value={f.companySize.label} unknown={!f.companySize.known} note={f.companySize.known ? f.companySize.source : null} />
    </dl>
  );
}

function Bullets({ items, empty, tone }: { items: string[]; empty: string; tone: 'good' | 'warn' }) {
  if (!items.length) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-sm text-ink-soft">
      {items.map((t) => (
        <li key={t} className="flex gap-2">
          <span aria-hidden className={cx('mt-0.5 shrink-0 font-semibold', tone === 'good' ? 'text-emerald-600' : 'text-amber-600')}>
            {tone === 'good' ? '✓' : '!'}
          </span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

function Chips({ label, items, tone }: { label: string; items: string[]; tone: 'red' | 'slate' | 'amber' }) {
  if (!items.length) return null;
  const c = { red: 'bg-red-50 text-red-700 ring-red-200', slate: 'bg-slate-100 text-slate-700 ring-slate-200', amber: 'bg-amber-50 text-amber-800 ring-amber-200' }[tone];
  return (
    <div>
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {items.map((s) => (
          <span key={s} className={cx('rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', c)}>
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Three short sections. Everything else about the score lives in "Details". */
export function Insights({ summary }: { summary: JobSummary }) {
  const { skills } = summary;
  const hasSkills = skills.missingRequired.length + skills.missingPreferred.length + skills.partial.length > 0;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-ink">Why this job matches you</h2>
        <Bullets items={summary.whyMatches} empty="No strong signals found yet." tone="good" />
      </section>
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-ink">Things to verify before applying</h2>
        <Bullets items={summary.toVerify} empty="Nothing flagged." tone="warn" />
      </section>
      {hasSkills && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 md:col-span-2">
          <h2 className="mb-2 text-sm font-semibold text-ink">Missing or preferred skills</h2>
          <div className="space-y-2.5">
            <Chips label="Required, not in your profile" items={skills.missingRequired} tone="red" />
            <Chips label="Partly covered" items={skills.partial} tone="amber" />
            <Chips label="Nice to have, not in your profile" items={skills.missingPreferred} tone="slate" />
          </div>
        </section>
      )}
    </div>
  );
}
