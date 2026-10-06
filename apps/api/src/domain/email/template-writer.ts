import type { CandidateProfile } from '../profile/profile';
import { sha256 } from '../../common/crypto';
import { getSkill } from '../skills/taxonomy';
import { countWords, firstName, GenerateEmailInput } from './voice';

/**
 * Deterministic, zero-cost email writer in Prince's voice. Used when no LLM is
 * configured, and as a safe fallback if the LLM output fails validation.
 * Variation comes from a seed so two companies don't receive identical emails.
 */

interface ExperienceFact {
  /** Skills that make this fact relevant. */
  triggers: string[];
  /** Must be supported by the profile's strong skills. */
  requires: string[];
  /** Optional: a profile domain (substring, case-insensitive) that must be present. */
  domain?: string;
  phrase: string;
}

const FACTS: ExperienceFact[] = [
  { triggers: ['Queue Systems', 'BullMQ', 'Kafka', 'RabbitMQ', 'SQS', 'Event-Driven Architecture', 'ETL'], requires: ['BullMQ'], phrase: 'queue processing with BullMQ' },
  { triggers: ['Redis', 'Caching', 'Performance Optimization'], requires: ['Redis'], phrase: 'Redis-backed caching' },
  { triggers: ['Authentication', 'OAuth', 'JWT', 'OTP Systems', 'Security'], requires: ['OTP Systems'], phrase: 'OTP and authentication flows' },
  { triggers: ['Third-party Integrations', 'Shopify', 'E-commerce', 'REST APIs', 'GraphQL'], requires: ['Shopify'], phrase: 'third-party integrations such as Shopify' },
  { triggers: ['Payment Integrations', 'Stripe', 'Razorpay', 'Fintech'], requires: ['Payment Integrations'], phrase: 'payment integrations' },
  { triggers: ['MySQL', 'PostgreSQL', 'SQL', 'Database Design', 'Database Migrations'], requires: ['MySQL'], phrase: 'MySQL schema design and database migrations' },
  { triggers: ['AWS', 'EC2', 'RDS', 'CloudWatch', 'IAM', 'Lambda', 'S3', 'ECS', 'Serverless'], requires: ['AWS'], phrase: 'services running on AWS (EC2, RDS, CloudWatch)' },
  { triggers: ['Observability', 'Production Debugging', 'Datadog', 'Prometheus', 'Grafana', 'OpenTelemetry', 'Sentry'], requires: ['Production Debugging'], phrase: 'production debugging and observability' },
  { triggers: ['Distributed Systems', 'Microservices', 'System Design', 'Backend Architecture'], requires: ['Distributed Systems'], phrase: 'distributed backend workflows' },
  { triggers: ['Loyalty Platforms', 'E-commerce', 'SaaS'], requires: [], domain: 'loyalty', phrase: 'loyalty and e-commerce platforms' },
];

function pick<T>(items: T[], seed: string, salt: string): T {
  const h = parseInt(sha256(`${seed}:${salt}`).slice(0, 8), 16);
  return items[h % items.length];
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Prefer concrete technologies over broad concepts when describing a role's focus. */
function focusSkills(input: GenerateEmailInput, limit = 3): string[] {
  const rank = (s: string) => {
    const c = getSkill(s)?.category;
    return c === 'runtime' || c === 'language' || c === 'framework' ? 0 : c === 'database' || c === 'cache' || c === 'queue' || c === 'cloud' ? 1 : 2;
  };
  const overlap = [...input.overlapSkills].filter((s) => !['JavaScript', 'SQL', 'Caching', 'Git', 'Testing'].includes(s));
  return overlap.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

export function relevantFacts(profile: CandidateProfile, jobSkills: string[], limit: number, exclude: string[] = [], alreadyMentioned: string[] = []): string[] {
  const has = (s: string) => profile.strongSkills.includes(s);
  const hasDomain = (d?: string) => !d || profile.domains.some((x) => x.toLowerCase().includes(d));
  const scored = FACTS.filter((f) => f.requires.every(has) && hasDomain(f.domain) && !exclude.includes(f.phrase))
    // Facts that only repeat technologies already named in the email are less useful.
    .map((f) => ({ f, hits: f.triggers.filter((t) => jobSkills.includes(t)).length - (f.requires.length && f.requires.every((r) => alreadyMentioned.includes(r)) ? 2 : 0) }))
    .sort((a, b) => b.hits - a.hits);
  const chosen = scored.filter((s) => s.hits > 0).slice(0, limit).map((s) => s.f.phrase);
  for (const s of scored) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(s.f.phrase)) chosen.push(s.f.phrase);
  }
  return chosen;
}

function coreStack(profile: CandidateProfile, input: GenerateEmailInput): string[] {
  const base = ['Node.js', 'TypeScript', 'NestJS'].filter((s) => profile.strongSkills.includes(s));
  const extras = ['Redis', 'MySQL', 'PostgreSQL', 'AWS', 'GraphQL', 'BullMQ'].filter(
    (s) => profile.strongSkills.includes(s) && input.jobSkills.includes(s),
  );
  const fallback = ['Redis', 'MySQL', 'AWS'].filter((s) => profile.strongSkills.includes(s));
  return [...base, ...(extras.length ? extras : fallback)].filter((v, i, a) => a.indexOf(v) === i).slice(0, 6);
}

export function signature(profile: CandidateProfile): string {
  const lines = [profile.name];
  if (profile.contact.linkedin) lines.push(profile.contact.linkedin);
  return lines.join('\n');
}

export function writeInitialEmail(input: GenerateEmailInput, profile: CandidateProfile): { subject: string; body: string } {
  const seed = input.variantSeed ?? `${input.companyName}:${input.jobTitle}`;
  const first = firstName(input.recipientName);
  const focus = focusSkills(input);
  const focusText = focus.length ? joinList(focus) : 'backend systems';
  const title = profile.current_title || 'Software Engineer';
  const stackList = coreStack(profile, input);
  const stack = joinList(stackList);
  const facts = relevantFacts(profile, input.jobSkills, input.style === 'concise' ? 2 : 3, [], stackList);

  const subject = pick(
    [
      `${input.jobTitle} — ${focus.slice(0, 2).join(' / ') || 'Node.js / TypeScript'}`,
      `${input.jobTitle} — interested in ${input.companyName}`,
      `${input.jobTitle} role at ${input.companyName}`,
    ],
    seed,
    'subject',
  );

  const remote = input.workMode === 'remote' ? ' (remote)' : '';
  const opening = pick(
    [
      `I came across the ${input.jobTitle} role at ${input.companyName}${remote} and noticed it's focused heavily on ${focusText}.`,
      `I saw that ${input.companyName} is hiring a ${input.jobTitle}${remote}. The focus on ${focusText} caught my attention.`,
      `I'm reaching out about the ${input.jobTitle} opening at ${input.companyName}${remote} — the work around ${focusText} lines up closely with what I do day to day.`,
    ],
    seed,
    'opening',
  );

  const experience = `I'm currently working as a ${title}, mostly on backend systems with ${stack}. I've worked on production systems involving ${joinList(facts)}.`;

  // Honest gap line: only for a related (partial) skill, never claiming it.
  // Prefer meaningful gaps (queues, databases, infra) over trivial cloud sub-services.
  const GAP_PRIORITY = ['queue', 'database', 'devops', 'language', 'runtime', 'framework', 'concept'];
  const partialGap = input.missingSkills
    .map((m) => ({ m, def: getSkill(m), related: getSkill(m)?.relatedTo?.find((r) => profile.strongSkills.includes(r)) }))
    .filter((x) => x.related && GAP_PRIORITY.includes(x.def?.category ?? ''))
    .sort((a, b) => GAP_PRIORITY.indexOf(a.def!.category) - GAP_PRIORITY.indexOf(b.def!.category))[0];
  const gap =
    input.style !== 'concise' && partialGap
      ? `I haven't used ${partialGap.m} in production yet, but I've worked on similar problems with ${partialGap.related}.`
      : '';

  const fact = input.style === 'warm' && input.companyFacts[0] ? `What ${input.companyName} is building also looks interesting to me.` : '';

  const alignment = pick(
    [
      'The role looks closely aligned with the kind of backend engineering work I want to take on next.',
      "It's very close to the backend work I want to do more of next.",
      'It looks like a strong fit for the backend ownership I want in my next role.',
    ],
    seed,
    'alignment',
  );

  const smallCompany = ['FOUNDER', 'CTO'].includes(input.recipientCategory);
  const recruiter = ['RECRUITER', 'TECHNICAL_RECRUITER', 'HR'].includes(input.recipientCategory);
  const resume = input.attachResume ? "I've attached my resume for context. " : '';
  const cta = smallCompany
    ? `${resume}Would you be open to a short call in the next week or two?`
    : recruiter
      ? `${resume}Happy to share anything else that would help, and to talk whenever it suits you.`
      : `${resume}If you're the right person to speak with, I'd be happy to discuss the role.`;

  const paragraphs = [`Hi ${first},`, opening, experience, gap, [fact, alignment].filter(Boolean).join(' '), cta, `Best,\n${signature(profile)}`].filter(Boolean);
  let body = paragraphs.join('\n\n');
  // Keep within the 80–150 word target: drop optional sentences if needed.
  if (countWords(body) > 150 && gap) body = body.replace(`${gap}\n\n`, '');
  return { subject, body };
}

export interface FollowupTemplateInput {
  sequence: number;
  totalFollowups: number;
  recipientName: string;
  jobTitle: string;
  companyName: string;
  jobSkills: string[];
  /** Phrases already used in earlier emails in this thread. */
  usedFacts: string[];
}

export function writeFollowupEmail(input: FollowupTemplateInput, profile: CandidateProfile): { subject: string; body: string; usedFact?: string } {
  const first = firstName(input.recipientName);
  const sign = `Best,\n${profile.name}`;
  const isFinal = input.sequence >= input.totalFollowups;
  if (isFinal && input.sequence > 1) {
    return {
      subject: '',
      body: [
        `Hi ${first},`,
        `I'll close the loop here so I don't keep filling your inbox. If the ${input.jobTitle} role is still open later, or something else comes up on the backend side at ${input.companyName}, I'd be glad to hear from you.`,
        `Thanks for your time,\n${profile.name}`,
      ].join('\n\n'),
    };
  }
  if (input.sequence === 1) {
    return {
      subject: '',
      body: [
        `Hi ${first},`,
        `Just following up on my note below about the ${input.jobTitle} role. Happy to share more context or jump on a quick call if it's useful.`,
        sign,
      ].join('\n\n'),
    };
  }
  const [fact] = relevantFacts(profile, input.jobSkills, 1, input.usedFacts);
  const contextLine = fact
    ? `One thing I didn't mention earlier: I've also worked on ${fact}, which seems relevant to what the team is building.`
    : `I've spent most of my time on production backend systems with ${joinList(['Node.js', 'TypeScript', 'NestJS'].filter((s) => profile.strongSkills.includes(s)))}, which matches what the role asks for.`;
  return {
    subject: '',
    usedFact: fact,
    body: [
      `Hi ${first},`,
      `Circling back on the ${input.jobTitle} role at ${input.companyName}. ${contextLine}`,
      `If someone else is handling backend hiring, I'd appreciate a pointer to the right person.`,
      sign,
    ].join('\n\n'),
  };
}
