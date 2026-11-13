import ExcelJS from 'exceljs';
import * as fs from 'fs';
import nodemailer from 'nodemailer';
import * as os from 'os';
import * as path from 'path';
import type { ApplyLog } from './apply/log';
import { loadMail, MAIL_TEMPLATE, sendReport } from './mail';
import { buildReport, statusOf, writeReport } from './report';
import type { StoredFoundJob } from './results';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-report-'));
const now = new Date('2026-11-12T08:00:00Z');
const job = (id: string, over: Partial<StoredFoundJob> = {}): StoredFoundJob => ({
  id, title: 'Backend Engineer', company: 'Acme', companyDomain: null, location: 'Gurugram', remote: null, url: `https://x/${id}`, postedAt: '2026-11-10T00:00:00.000Z',
  source: 'NAUKRI', salaryText: '12-22 Lacs PA', teamSize: null, score: 80, recommendation: 'APPLY', reasons: ['Node.js match'], missingSkills: ['Kafka'], flags: [],
  contacts: [], description: 'Build Node.js APIs.', firstSeenAt: '2026-11-10T00:00:00.000Z', lastSeenAt: '2026-11-10T00:00:00.000Z', ...over,
});
const e = (jobId: string, status: ApplyLog[string]['status'], note?: string) => ({ jobId, url: '', title: '', company: '', status, at: '2026-11-12T03:00:00.000Z', note });

describe('statusOf (why a job is or is not applied)', () => {
  it.each([
    [job('a'), { a: e('a', 'applied') }, true, 'Auto-applied 2026-11-12'],
    [job('b'), { b: e('b', 'already-applied') }, true, 'You had already applied'],
    [job('c'), { c: e('c', 'needs-answers', 'No saved answer for: "Kafka?"') }, false, 'Asked a question with no saved answer — No saved answer for: "Kafka?"'],
    [job('d', { flags: ['apply:company-site'] }), {}, false, 'Applies on the company website'],
    [job('f', { source: 'LINKEDIN' }), {}, false, 'No auto-apply on LinkedIn: apply via the link'],
  ] as const)('%#', (j, log, applied, text) => {
    expect(statusOf(j, log as ApplyLog)).toEqual({ applied, text });
  });
});

describe('buildReport', () => {
  it('puts good recent jobs that were not applied in "Apply manually", applied ones apart, and everything in "All jobs"', () => {
    const jobs = [
      job('ok', { score: 90 }),
      job('done', { score: 85 }),
      job('low', { score: 50 }),
      job('old', { postedAt: '2026-10-01T00:00:00.000Z' }),
      job('li', { source: 'LINKEDIN', score: 75, contacts: [{ name: 'Jane', role: 'Recruiter', linkedinUrl: 'https://in.linkedin.com/in/jane', roleCategory: 'RECRUITER', source: 'linkedin-job-poster', confidence: 'VERIFIED' }, { name: 'hr@acme.in', email: 'hr@acme.in', roleCategory: 'RECRUITER', source: 'job-description', confidence: 'VERIFIED' }] }),
    ];
    const r = buildReport(jobs, { done: e('done', 'applied') }, { minScore: 70, now });
    expect(r.manual.map((x) => x.link)).toEqual(['https://x/ok', 'https://x/li']);
    expect(r.applied.map((x) => x.link)).toEqual(['https://x/done']);
    expect(r.all).toHaveLength(5);
    expect(r.manual[1]).toMatchObject({ source: 'LinkedIn', emails: 'hr@acme.in', recruiter: 'Jane (Recruiter): https://in.linkedin.com/in/jane' });
  });

  it('writes an Excel file with the three sheets and clickable links', async () => {
    const file = await writeReport(buildReport([job('ok')], {}, { minScore: 70, now }), path.join(tmp, 'r.xlsx'));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Apply manually', 'Applied', 'All jobs']);
    const ws = wb.getWorksheet('Apply manually')!;
    expect(ws.getRow(1).getCell(2).value).toBe('Title');
    expect(ws.getRow(2).getCell(7).value).toEqual({ text: 'https://x/ok', hyperlink: 'https://x/ok' });
    expect(ws.getRow(2).getCell(14).value).toBe('Build Node.js APIs.');
  });
});

describe('email', () => {
  it('creates the settings file on first use and does not send without an App Password', () => {
    const file = path.join(tmp, 'mail.json');
    expect(loadMail(file)).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(MAIL_TEMPLATE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600); // readable by you only
    fs.writeFileSync(file, JSON.stringify({ ...MAIL_TEMPLATE, appPassword: 'abcd efgh ijkl mnop' }));
    expect(loadMail(file)?.appPassword).toBe('abcdefghijklmnop');
  });

  it('sends the report only to you, with the Excel file attached (test transport: nothing leaves the machine)', async () => {
    const file = await writeReport(buildReport([job('ok')], {}, { minScore: 70, now }), path.join(tmp, 'jobs-2026-11-12.xlsx'));
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const sent = jest.spyOn(transport, 'sendMail');
    await sendReport({ subject: 'Job Hunter: 1 to apply', text: 'hi', file, settings: { user: 'me@gmail.com', appPassword: 'x'.repeat(16), to: 'me@gmail.com' }, transport });
    const msg = sent.mock.calls[0][0];
    expect(msg).toMatchObject({ to: 'me@gmail.com', subject: 'Job Hunter: 1 to apply' });
    expect(msg.attachments).toEqual([{ filename: 'jobs-2026-11-12.xlsx', path: file }]);
  });
});
