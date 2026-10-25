import { BACKEND_JD, loadProfile } from '../__fixtures__/fixtures';
import { extractJob } from '../skills/extract';
import { classifyInbound, isUnsubscribeRequest, replySentiment } from './classify-reply';
import { buildMessageId, buildMime } from './mime';
import { writeFollowupEmail, writeInitialEmail } from './template-writer';
import { checkVoice, countWords, generateEmailInputSchema, GenerateEmailInput } from './voice';

const profile = loadProfile();
const ex = extractJob({ title: 'Senior Backend Engineer', description: BACKEND_JD });

const input: GenerateEmailInput = {
  jobTitle: 'Senior Backend Engineer',
  companyName: 'Acme',
  recipientName: 'Sarah Lee',
  recipientRole: 'Engineering Manager',
  recipientCategory: 'ENGINEERING_MANAGER',
  jobSkills: [...ex.requiredSkills, ...ex.preferredSkills],
  overlapSkills: ['Node.js', 'TypeScript', 'Redis', 'AWS', 'PostgreSQL'],
  missingSkills: ['Kafka'],
  companyFacts: [],
  jobSummary: BACKEND_JD,
  style: 'concise',
  attachResume: true,
  workMode: 'remote',
};

const rules = { minWords: 60, maxWords: 160, candidateSkills: profile.strongSkills.concat(['SQL', 'Caching', 'Queue Systems']), jobSkills: input.jobSkills };

describe('email generation input validation', () => {
  it('accepts a valid input', () => {
    expect(generateEmailInputSchema.safeParse(input).success).toBe(true);
  });
  it('rejects missing recipient, unknown style and oversized fields', () => {
    expect(generateEmailInputSchema.safeParse({ ...input, recipientName: '' }).success).toBe(false);
    expect(generateEmailInputSchema.safeParse({ ...input, style: 'salesy' }).success).toBe(false);
    expect(generateEmailInputSchema.safeParse({ ...input, jobTitle: 'x'.repeat(500) }).success).toBe(false);
    expect(generateEmailInputSchema.safeParse({ ...input, jobSkills: 'Node' }).success).toBe(false);
  });
});

describe('voice check', () => {
  it('rejects banned phrases', () => {
    const r = checkVoice({ subject: 'Hello', body: 'Hi Sarah,\n\nI hope this email finds you well. I am thrilled to apply.\n\nBest,\nPrince' }, rules);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/finds you well/);
  });
  it('rejects technologies the candidate does not have and is not in the JD', () => {
    const body = `Hi Sarah,\n\n${'I work on backend systems with Node.js. '.repeat(10)} I also use Elixir daily.\n\nBest,\nPrince`;
    expect(checkVoice({ subject: 'Backend', body }, rules).problems.join()).toMatch(/Elixir/);
  });
  it('flags invented metrics', () => {
    const body = `Hi Sarah,\n\n${'I work on backend systems with Node.js. '.repeat(10)} I reduced latency by 45%.\n\nBest,\nPrince`;
    expect(checkVoice({ subject: 'Backend', body }, rules).problems.join()).toMatch(/metric/);
  });
});

describe('template email writer', () => {
  const draft = writeInitialEmail(input, profile);

  it('produces an 80–150 word email that passes the voice check', () => {
    const check = checkVoice(draft, { ...rules, minWords: 60, maxWords: 150 });
    expect(check.problems).toEqual([]);
    expect(countWords(draft.body)).toBeGreaterThanOrEqual(70);
    expect(countWords(draft.body)).toBeLessThanOrEqual(160);
  });

  it('is personalised to the role, company and recipient', () => {
    expect(draft.body).toMatch(/^Hi Sarah,/);
    expect(draft.body).toContain('Acme');
    expect(draft.body).toContain('Senior Backend Engineer');
    expect(draft.body).toMatch(/resume/);
    expect(draft.body).toMatch(/Best,\nAlex Morgan/);
  });

  it('does not claim Kafka experience', () => {
    const technical = writeInitialEmail({ ...input, style: 'technical' }, profile);
    expect(technical.body).not.toMatch(/(worked|experience) (with|on) Kafka/i);
    if (/Kafka/.test(technical.body)) expect(technical.body).toMatch(/haven't used Kafka/);
  });

  it('varies between companies', () => {
    const bodies = new Set(['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli'].map((c) => writeInitialEmail({ ...input, companyName: c }, profile).body.replace(new RegExp(c, 'g'), 'X')));
    expect(bodies.size).toBeGreaterThan(1);
  });

  it('writes three distinct follow-ups', () => {
    const f = [1, 2, 3].map((sequence) =>
      writeFollowupEmail({ sequence, totalFollowups: 3, recipientName: 'Sarah', jobTitle: 'Senior Backend Engineer', companyName: 'Acme', jobSkills: input.jobSkills, usedFacts: [] }, profile).body,
    );
    expect(new Set(f).size).toBe(3);
    expect(f[0]).toMatch(/following up/i);
    expect(f[2]).toMatch(/close the loop/i);
    for (const body of f) expect(countWords(body)).toBeLessThan(90);
  });
});

describe('reply classification', () => {
  const own = ['prince@example.com'];
  it('detects real replies, auto-replies, bounces and own messages', () => {
    expect(classifyInbound({ from: 'Sarah <sarah@acme.com>', subject: 'Re: Backend', snippet: 'Thanks', headers: {} }, own)).toBe('reply');
    expect(classifyInbound({ from: 'sarah@acme.com', subject: 'Out of Office', snippet: '', headers: {} }, own)).toBe('auto_reply');
    expect(classifyInbound({ from: 'sarah@acme.com', subject: 'Re: x', snippet: '', headers: { 'Auto-Submitted': 'auto-replied' } }, own)).toBe('auto_reply');
    expect(classifyInbound({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', snippet: '', headers: {} }, own)).toBe('bounce');
    expect(classifyInbound({ from: 'Prince <prince@example.com>', subject: 'Re: x', snippet: '', headers: {} }, own)).toBe('self');
  });
  it('classifies sentiment and unsubscribe requests', () => {
    expect(replySentiment("Thanks Prince — let's schedule a call next week")).toBe('positive');
    expect(replySentiment('Unfortunately the position has been filled')).toBe('negative');
    expect(isUnsubscribeRequest('Please stop emailing me')).toBe(true);
    expect(isUnsubscribeRequest('Sounds good')).toBe(false);
  });
});

describe('MIME builder', () => {
  it('builds a threaded message with attachment and safe headers', () => {
    const raw = buildMime({
      from: 'prince@example.com',
      fromName: 'Prince Gupta',
      to: 'sarah@acme.com',
      subject: 'Re: Senior Backend Engineer\r\nBcc: evil@x.com',
      text: 'Hello',
      messageId: buildMessageId('abc', 'example.com'),
      inReplyTo: '<root@example.com>',
      references: ['<root@example.com>'],
      attachments: [{ filename: 'Prince_Gupta_Resume.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') }],
    });
    expect(raw).toContain('Message-ID: <jh-abc@example.com>');
    expect(raw).toContain('In-Reply-To: <root@example.com>');
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('filename="Prince_Gupta_Resume.pdf"');
    expect(raw).not.toMatch(/^Bcc:/m);
  });
});
