import { buildTemplateNote, checkLinkedInNote, LINKEDIN_NOTE_LIMIT, LinkedInNoteInput } from './note';

const input: LinkedInNoteInput = {
  jobTitle: 'Senior Backend Engineer',
  companyName: 'Acme Payments',
  recipientName: 'Dr. Asha Rao',
  recipientRole: 'Engineering Manager',
  overlapSkills: ['Node.js', 'TypeScript', 'NestJS', 'Redis'],
  companyFacts: [],
  jobSummary: 'Build APIs',
};

describe('buildTemplateNote', () => {
  it('fits the limit, greets by first name and names only real skills', () => {
    const n = buildTemplateNote(input);
    expect(n.length).toBeLessThanOrEqual(LINKEDIN_NOTE_LIMIT);
    expect(n).toMatch(/^Hi Asha,/);
    expect(n).toContain('Acme Payments');
    expect(checkLinkedInNote(n, input.overlapSkills, `${input.jobTitle} ${input.companyName}`, input.companyName).ok).toBe(true);
  });
  it('still fits with very long names', () => {
    const n = buildTemplateNote({ ...input, jobTitle: 'Principal Staff Software Engineer, Platform Reliability and Developer Productivity', companyName: 'A Very Long Company Name Incorporated Worldwide Holdings' });
    expect(n.length).toBeLessThanOrEqual(LINKEDIN_NOTE_LIMIT);
  });
  it('works without a contact', () => {
    expect(buildTemplateNote({ ...input, recipientName: null })).toMatch(/^Hi, /);
  });
});

describe('checkLinkedInNote', () => {
  const ok = ['Node.js'];
  it('accepts a short honest note', () => expect(checkLinkedInNote('Hi Asha, I work with Node.js and liked the role. Happy to connect.', ok).ok).toBe(true));
  it('rejects over-long notes', () => expect(checkLinkedInNote('x'.repeat(301), ok).problems[0]).toMatch(/Too long/));
  it('rejects links, emails and phone numbers', () => {
    expect(checkLinkedInNote('See https://x.io for more', ok).ok).toBe(false);
    expect(checkLinkedInNote('Mail me: a@b.com', ok).ok).toBe(false);
    expect(checkLinkedInNote('Call +91 80592 58639', ok).ok).toBe(false);
  });
  it('rejects a skill the person has not confirmed', () => expect(checkLinkedInNote('I love Kafka and Node.js', ok).problems.join()).toMatch(/Kafka/));
  it('rejects hashtags, emoji and notes that skip the company', () => {
    expect(checkLinkedInNote('Hi, I use Node.js #hiring', ok).ok).toBe(false);
    expect(checkLinkedInNote('Hi 👋 happy to connect', ok).ok).toBe(false);
    expect(checkLinkedInNote('Hi, happy to connect.', ok, '', 'Acme').problems.join()).toMatch(/company/);
  });
  it('rejects referral asks and cliches', () => {
    expect(checkLinkedInNote('Hi, please refer me', ok).ok).toBe(false);
    expect(checkLinkedInNote('I hope you are well', ok).ok).toBe(false);
  });
});
