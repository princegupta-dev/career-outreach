import ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ApplyLog } from './apply/log';
import { SITE_FOR_SOURCE } from './apply/engine';
import type { StoredFoundJob } from './results';

/**
 * The Excel report: what to apply to by hand (with the reason the tool did not), what it applied to, and every job.
 * Saved outside the repo (it holds your data), in ~/.job-hunter/reports/.
 */
export const reportsDir = () => process.env.JOB_HUNTER_REPORTS ?? path.join(os.homedir(), '.job-hunter', 'reports');

export interface ReportRow {
  score: number;
  title: string;
  company: string;
  location: string;
  posted: string;
  source: string;
  link: string;
  status: string;
  salary: string;
  emails: string;
  recruiter: string;
  missingSkills: string;
  whyItFits: string;
  description: string;
}

const SOURCE_NAMES: Record<string, string> = {
  GREENHOUSE: 'Company site', LEVER: 'Company site', ASHBY: 'Company site', WORKDAY: 'Company site (Workday)',
  NAUKRI: 'Naukri', HIRIST: 'Hirist', INSTAHYRE: 'Instahyre', WELLFOUND: 'Wellfound', LINKEDIN: 'LinkedIn', INDEED: 'Indeed',
};

const REASONS: Record<string, string> = {
  'needs-answers': 'Asked a question with no saved answer',
  external: 'Applies on the company website',
  'no-button': 'Apply button not found',
  failed: 'Auto-apply failed',
  'dry-run': 'Only a dry run so far (auto-apply is not switched on for this site)',
};

/** Why a job is (or is not) applied: from the apply log, the job's flags, or its source. */
export function statusOf(job: StoredFoundJob, log: ApplyLog): { applied: boolean; text: string } {
  const e = log[job.id];
  if (e?.status === 'applied') return { applied: true, text: `Auto-applied ${e.at.slice(0, 10)}` };
  if (e?.status === 'already-applied') return { applied: true, text: 'You had already applied' };
  if (e) return { applied: false, text: `${REASONS[e.status] ?? e.status}${e.note ? ` — ${e.note}` : ''}` };
  if (job.flags.includes('apply:company-site')) return { applied: false, text: 'Applies on the company website' };
  if (!SITE_FOR_SOURCE[job.source]) return { applied: false, text: `No auto-apply on ${SOURCE_NAMES[job.source] ?? job.source}: apply via the link` };
  return { applied: false, text: 'Not tried yet (score below the auto-apply minimum, or today\'s limit reached)' };
}

export function toRow(job: StoredFoundJob, log: ApplyLog): ReportRow {
  const emails = job.contacts.map((c) => c.email).filter(Boolean);
  const people = job.contacts.filter((c) => c.linkedinUrl).map((c) => `${c.name}${c.role ? ` (${c.role})` : ''}: ${c.linkedinUrl}`);
  return {
    score: job.score,
    title: job.title,
    company: job.company,
    location: job.location ?? '',
    posted: job.postedAt ? job.postedAt.slice(0, 10) : '',
    source: SOURCE_NAMES[job.source] ?? job.source,
    link: job.url ?? '',
    status: statusOf(job, log).text,
    salary: job.salaryText ?? '',
    emails: [...new Set(emails)].join(', '),
    recruiter: people.join('\n'),
    missingSkills: job.missingSkills.join(', '),
    whyItFits: job.reasons.join('; '),
    description: job.description ?? '',
  };
}

/** Split the jobs into the three sheets. "High quality" = score at or above the minimum, posted in the last 14 days (or undated). */
export function buildReport(jobs: StoredFoundJob[], log: ApplyLog, o: { minScore: number; now?: Date }): { manual: ReportRow[]; applied: ReportRow[]; all: ReportRow[] } {
  const now = (o.now ?? new Date()).getTime();
  const recent = (j: StoredFoundJob) => !j.postedAt || now - Date.parse(j.postedAt) <= 14 * 86_400_000;
  const byScore = [...jobs].sort((a, b) => b.score - a.score || (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
  return {
    manual: byScore.filter((j) => j.score >= o.minScore && recent(j) && !statusOf(j, log).applied).map((j) => toRow(j, log)),
    applied: byScore.filter((j) => statusOf(j, log).applied).map((j) => toRow(j, log)),
    all: byScore.map((j) => toRow(j, log)),
  };
}

const COLUMNS: Array<{ header: string; key: keyof ReportRow; width: number }> = [
  { header: 'Score', key: 'score', width: 7 },
  { header: 'Title', key: 'title', width: 40 },
  { header: 'Company', key: 'company', width: 24 },
  { header: 'Location', key: 'location', width: 24 },
  { header: 'Posted', key: 'posted', width: 11 },
  { header: 'Source', key: 'source', width: 16 },
  { header: 'Apply link', key: 'link', width: 40 },
  { header: 'Status / why not auto-applied', key: 'status', width: 45 },
  { header: 'Salary', key: 'salary', width: 16 },
  { header: 'Emails (from the posting)', key: 'emails', width: 28 },
  { header: 'Recruiter / poster (LinkedIn)', key: 'recruiter', width: 40 },
  { header: 'Missing skills', key: 'missingSkills', width: 28 },
  { header: 'Why it fits', key: 'whyItFits', width: 40 },
  { header: 'Job description', key: 'description', width: 80 },
];

/** Excel keeps at most 32,767 characters in a cell; descriptions are already capped at 4,000. */
export async function writeReport(report: ReturnType<typeof buildReport>, file: string): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Job Hunter';
  for (const [name, rows] of [['Apply manually', report.manual], ['Applied', report.applied], ['All jobs', report.all]] as const) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = COLUMNS;
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      const row = ws.addRow(r);
      if (r.link) row.getCell('link').value = { text: r.link, hyperlink: r.link };
      row.alignment = { vertical: 'top', wrapText: false };
    }
    ws.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
  return file;
}

/**
 * The discovery report: today's new jobs (you apply yourself), the skill gaps, and the experience picture.
 * Separate from the daily report above, which stays as it is.
 */
export async function writeDiscoverReport(jobs: StoredFoundJob[] | import('./search').FoundJob[], insights: import('./discover/insights').Insights, file: string): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Job Hunter';
  const today = wb.addWorksheet("Today's jobs", { views: [{ state: 'frozen', ySplit: 1 }] });
  today.columns = COLUMNS.filter((c) => c.key !== 'status');
  today.getRow(1).font = { bold: true };
  for (const j of jobs) {
    const r = toRow(j as StoredFoundJob, {});
    const row = today.addRow(r);
    if (r.link) row.getCell('link').value = { text: r.link, hyperlink: r.link };
  }
  today.autoFilter = { from: 'A1', to: { row: 1, column: today.columns.length } };

  const LABEL: Record<string, string> = { 'on-resume': 'You have it (on resume)', 'not-on-resume': 'You have it — NOT on resume', partial: 'Partial', missing: 'Missing' };
  const gaps = wb.addWorksheet('Skill gaps', { views: [{ state: 'frozen', ySplit: 1 }] });
  gaps.columns = [
    { header: 'Skill', key: 'skill', width: 28 },
    { header: 'Jobs asking', key: 'jobs', width: 12 },
    { header: '% of jobs', key: 'percent', width: 10 },
    { header: 'You', key: 'status', width: 32 },
  ];
  gaps.getRow(1).font = { bold: true };
  for (const s of insights.skills) gaps.addRow({ ...s, status: LABEL[s.status] ?? s.status });
  gaps.autoFilter = { from: 'A1', to: { row: 1, column: 4 } };

  const exp = wb.addWorksheet('Experience');
  exp.columns = [{ header: 'Measure', key: 'k', width: 44 }, { header: 'Value', key: 'v', width: 16 }];
  exp.getRow(1).font = { bold: true };
  const e = insights.experience;
  exp.addRows([
    { k: 'Jobs analysed', v: insights.jobsAnalysed },
    { k: 'Jobs stating a minimum experience', v: e.withYears },
    { k: `Asking for more than your ${e.yours} years`, v: `${e.aboveYours} (${e.percentAboveYours}%)` },
    ...Object.entries(e.buckets).map(([k, v]) => ({ k: `Minimum asked: ${k}`, v })),
    ...Object.entries(insights.seniority).map(([k, v]) => ({ k: `Seniority: ${k}`, v })),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
  return file;
}
