import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseProfileMarkdown } from '../domain/profile/profile';
import { planFormAnswers, readAnswerBook, removeConfirmedAnswer, saveConfirmedAnswer, valueFor, type FormField } from './form-answers';

export const testProfile = parseProfileMarkdown(`---
name: Sample Engineer
current_company: Example Employer
current_title: Backend Engineer
location: India
career_start_year: 2020
contact:
  email: candidate@example.com
  phone: '+91-9999999999'
skills:
  strong: [Node.js, Redis, BullMQ]
  partial: [Kafka]
---
`);
const resume = 'Sample Engineer\n- Built background processing with BullMQ and Redis in production.';
const field = (label: string, over: Partial<FormField> = {}): FormField => ({ id: label, label, kind: 'text', value: '', options: [], ...over });
const config = { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:4b', timeoutMs: 1000 };
const mockModel = (answers: unknown[]) => jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith('/api/tags')
  ? { models: [{ name: config.model, digest: 'test' }] }
  : { done: true, message: { content: JSON.stringify({ answers }) } })));

describe('application form answer planning', () => {
  it('fills profile facts, preserves existing entries and does not infer exact years or use unconfirmed defaults', async () => {
    const fetcher = mockModel([]);
    const result = await planFormAnswers([
      field('Full name'), field('Mobile number', { kind: 'tel' }), field('Email'),
      field('Current company', { value: 'User edited company' }), field('Current CTC (LPA)', { kind: 'number' }),
      field('Notice period (days)', { kind: 'number' }), field('Total years of experience', { kind: 'number' }),
    ], testProfile, [{ match: ['current', 'ctc'], answer: '12 LPA', source: 'facts' }], resume, { config, fetcher });
    expect(result.answers.map((a) => a.value)).toEqual(['Sample Engineer', '+91-9999999999', 'candidate@example.com', null, null, null, null]);
    expect(result.answers[3].reason).toContain('preserved');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses confirmed facts, refuses conflicting answers, and leaves sensitive fields and unsupported skill years manual', async () => {
    const result = await planFormAnswers([
      field('Expected CTC (LPA)', { kind: 'number' }), field('Notice period (days)', { kind: 'number' }),
      field('Years of experience in Node.js', { kind: 'number' }), field('Years of experience in Kafka', { kind: 'number' }),
      field('Gender'), field('Date of birth'), field('Agree to privacy policy', { kind: 'manual' }),
    ], testProfile, [
      { match: ['expected', 'ctc'], answer: '17 LPA', source: 'you' },
      { match: ['notice'], answer: '30 days', source: 'you' }, { match: ['notice', 'period'], answer: '60 days', source: 'you' },
      { match: ['experience', 'node.js'], answer: '3.5', source: 'you' },
      { match: ['experience', 'kafka'], answer: '3', source: 'you' },
      { match: ['gender'], answer: 'Male', source: 'you' },
    ], resume);
    expect(result.answers.map((a) => a.value)).toEqual(['17', null, '3.5', null, null, null, null]);
    expect(result.answers[1].reason).toContain('conflict');
  });

  it('uses Ollama to select exact resume evidence and refuses invented references', async () => {
    const question = field('Describe your relevant project experience', { kind: 'textarea' });
    const fetcher = mockModel([{ fieldId: question.id, factId: null, evidenceIds: ['resume-2'] }]);
    const result = await planFormAnswers([question], testProfile, [], resume, { config, fetcher });
    expect(result.answers[0]).toMatchObject({ value: 'Built background processing with BullMQ and Redis in production.', source: 'ollama' });
    const bad = await planFormAnswers([question], testProfile, [], resume, { config, fetcher: mockModel([{ fieldId: question.id, factId: null, evidenceIds: ['invented'] }]) });
    expect(bad.answers[0].value).toBeNull();
    expect(bad.warning).toContain('unknown resume evidence');
  });

  it('keeps known answers usable if Ollama is offline and does not use a full name as a first name', async () => {
    const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockRejectedValue(new Error('offline'));
    const result = await planFormAnswers([field('Email'), field('First name'), field('Describe a relevant project')], testProfile, [], resume, { config, fetcher });
    expect(result.answers.map((a) => a.value)).toEqual(['candidate@example.com', null, null]);
    expect(result.warning).toContain('Could not reach local Ollama');
  });

  it('does not guess units, truncate answers or strip phone country codes', () => {
    expect(valueFor(field('Notice period in days', { kind: 'number' }), '30 days')).toBe('30');
    expect(valueFor(field('Notice period in months', { kind: 'number' }), '30 days')).toBeNull();
    expect(valueFor(field('Annual salary in INR', { kind: 'number' }), '17 LPA')).toBeNull();
    expect(valueFor(field('Mobile', { kind: 'tel' }), '+91-9999999999')).toBe('+91-9999999999');
    expect(valueFor(field('Name', { maxLength: 3 }), 'Sample Engineer')).toBeNull();
  });
  it('uses your confirmed override when the form uses different words for a profile field', async () => {
    const result = await planFormAnswers([field('Mobile number', { kind: 'tel' })], testProfile, [{ match: ['phone'], answer: '+91-8888888888', source: 'you' }], resume);
    expect(result.answers[0]).toMatchObject({ value: '+91-8888888888', source: 'saved' });
  });
  it('uses a confirmed No for a skill screening question without claiming unsupported experience', async () => {
    const result = await planFormAnswers([field('Do you have experience with Kafka?', { kind: 'radio', options: ['Yes', 'No'] })], testProfile, [{ match: ['experience', 'kafka'], answer: 'No', source: 'you' }], resume, { automatic: true });
    expect(result.answers[0]).toMatchObject({ value: 'No', source: 'saved' });
  });
  it('keeps exact years separate from a yes/no minimum-years answer and preserves a confirmed narrative', async () => {
    const result = await planFormAnswers([
      field('Do you have minimum 5 years of experience with Node.js?', { kind: 'radio', options: ['Yes', 'No'] }),
      field('Years of experience in Node.js', { kind: 'number' }), field('Describe a relevant project', { kind: 'textarea' }),
    ], testProfile, [{ match: ['experience', 'node.js'], answer: '3.5', source: 'you' }, { match: ['minimum', '5', 'years', 'node.js'], answer: 'No', source: 'you' }, { match: ['describe', 'relevant', 'project'], answer: 'My own confirmed project description.', source: 'you' }], resume, { automatic: true });
    expect(result.answers.map((a) => a.value)).toEqual(['No', '3.5', 'My own confirmed project description.']);
  });
  it('cancels an in-flight local model request when the application run is stopped', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: config.model, digest: 'test' }] }));
      return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })), { once: true }); started(); });
    });
    const work = planFormAnswers([field('Describe a relevant project')], testProfile, [], resume, { config, fetcher, automatic: true, signal: controller.signal });
    await waiting; controller.abort();
    expect((await work).answers[0].value).toBeNull();
    expect(fetcher.mock.calls[1][1]!.signal!.aborted).toBe(true);
  });
});

describe('confirmed answers from the UI', () => {
  let dir: string;
  const previous = { answers: process.env.JOB_HUNTER_ANSWERS, questions: process.env.JOB_HUNTER_QUESTIONS };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-book-'));
    process.env.JOB_HUNTER_ANSWERS = path.join(dir, 'answers.json');
    process.env.JOB_HUNTER_QUESTIONS = path.join(dir, 'questions.json');
  });
  afterEach(() => {
    if (previous.answers === undefined) delete process.env.JOB_HUNTER_ANSWERS; else process.env.JOB_HUNTER_ANSWERS = previous.answers;
    if (previous.questions === undefined) delete process.env.JOB_HUNTER_QUESTIONS; else process.env.JOB_HUNTER_QUESTIONS = previous.questions;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('reads without creating files and saves explicit confirmation privately without losing other entries', () => {
    expect(readAnswerBook()).toEqual({ answers: [], questions: [] });
    expect(fs.readdirSync(dir)).toHaveLength(0);
    saveConfirmedAnswer('Notice period (days)', '30 days');
    saveConfirmedAnswer('Expected CTC (LPA)', '17 LPA');
    const notice = readAnswerBook().answers[0];
    saveConfirmedAnswer('Notice period (days)', '45 days', notice.match);
    expect(readAnswerBook().answers).toHaveLength(2);
    expect(readAnswerBook().answers.find((a) => a.answer === '45 days')?.source).toBe('you');
    expect(fs.statSync(process.env.JOB_HUNTER_ANSWERS!).mode & 0o777).toBe(0o600);
    removeConfirmedAnswer(notice.match);
    expect(readAnswerBook().answers.map((a) => a.answer)).toEqual(['17 LPA']);
  });
  it('does not overwrite a corrupt answer book', () => {
    fs.writeFileSync(process.env.JOB_HUNTER_ANSWERS!, '{broken');
    expect(() => saveConfirmedAnswer('Notice period', '30 days')).toThrow();
    expect(fs.readFileSync(process.env.JOB_HUNTER_ANSWERS!, 'utf8')).toBe('{broken');
  });
});
