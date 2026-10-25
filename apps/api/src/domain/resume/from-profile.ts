import type { CandidateProfile } from '../profile/profile';
import { getSkill } from '../skills/taxonomy';
import type { ResumeData } from './types';

const CATEGORY_LABELS: Array<[string, string[]]> = [
  ['Languages & Runtime', ['language', 'runtime']],
  ['Frameworks & ORMs', ['framework', 'orm']],
  ['Databases', ['database']],
  ['Caching & Queues', ['cache', 'queue']],
  ['Cloud & DevOps', ['cloud', 'devops', 'observability']],
  ['Backend Engineering', ['concept', 'domain']],
];

export function groupSkills(skills: string[]): Array<{ category: string; items: string[] }> {
  const groups = CATEGORY_LABELS.map(([category]) => ({ category, items: [] as string[] }));
  const other = { category: 'Other', items: [] as string[] };
  for (const s of skills) {
    const cat = getSkill(s)?.category;
    const idx = CATEGORY_LABELS.findIndex(([, cats]) => cat && cats.includes(cat));
    (idx >= 0 ? groups[idx] : other).items.push(s);
  }
  return [...groups, other].filter((g) => g.items.length);
}

/**
 * Seed a master resume from the candidate profile. Bullets are restatements of
 * facts written in the profile — nothing is added. The candidate should refine them
 * (and add his employer + dates) on the Resume page.
 */
export function resumeFromProfile(p: CandidateProfile): ResumeData {
  const has = (s: string) => p.strongSkills.includes(s);
  const bullets: Array<{ text: string; skills: string[] }> = [];
  const stack = ['Node.js', 'TypeScript', 'NestJS'].filter(has);
  const apis = ['REST APIs', 'GraphQL'].filter(has);
  if (stack.length) bullets.push({ text: `Work on production backend systems using ${stack.join(', ')}${apis.length ? `, building ${apis.join(' and ')}` : ''}.`, skills: [...stack, ...apis] });
  if (has('Redis') || has('BullMQ'))
    bullets.push({ text: `Work with ${[has('Redis') && 'Redis for caching', has('BullMQ') && 'BullMQ for queue-based background processing'].filter(Boolean).join(' and ')} in production.`, skills: ['Redis', 'BullMQ', 'Caching', 'Queue Systems'].filter(has) });
  if (has('OTP Systems') || has('Authentication')) bullets.push({ text: 'Worked on OTP and authentication systems.', skills: ['OTP Systems', 'Authentication'].filter(has) });
  const dbs = ['MySQL', 'PostgreSQL'].filter(has);
  if (dbs.length) bullets.push({ text: `Worked on ${dbs.join(' and ')} database design and database migrations${['Sequelize', 'TypeORM'].some(has) ? ` using ${['Sequelize', 'TypeORM'].filter(has).join(' and ')}` : ''}.`, skills: [...dbs, 'Database Design', 'Database Migrations', 'Sequelize', 'TypeORM'].filter(has) });
  if (has('Third-party Integrations') || has('Shopify') || has('Payment Integrations'))
    bullets.push({ text: `Worked on third-party integrations${has('Shopify') ? ' including Shopify' : ''}${has('Payment Integrations') ? ', and payment integrations' : ''}.`, skills: ['Third-party Integrations', 'Shopify', 'Payment Integrations'].filter(has) });
  const aws = ['EC2', 'RDS', 'IAM', 'CloudWatch'].filter(has);
  if (has('AWS')) bullets.push({ text: `Work with AWS${aws.length ? ` (${aws.join(', ')})` : ''}${has('Docker') ? ' and Docker' : ''} for running backend services.`, skills: ['AWS', ...aws, 'Docker'].filter(has) });
  if (has('Production Debugging') || has('Observability')) bullets.push({ text: 'Handle production debugging and observability for backend services.', skills: ['Production Debugging', 'Observability'].filter(has) });
  if (p.domains.length) bullets.push({ text: `Contributed to ${p.domains.map((d) => d.toLowerCase()).join(', ')}.`, skills: [] });

  return {
    basics: {
      name: p.name,
      headline: p.headline || p.current_title,
      email: p.contact.email,
      phone: p.contact.phone,
      location: p.location,
      linkedin: p.contact.linkedin,
      github: p.contact.github,
      website: p.contact.website,
      summary: p.body.match(/## Summary\s+([\s\S]*?)(\n## |$)/)?.[1]?.replace(/\s+/g, ' ').trim() ?? '',
    },
    experience: [
      {
        id: 'exp-current',
        company: p.current_company,
        title: p.current_title || 'Software Engineer',
        location: p.location,
        startDate: '',
        endDate: '',
        current: true,
        technologies: p.strongSkills.filter((s) => ['language', 'runtime', 'framework', 'orm', 'database', 'cache', 'queue', 'cloud', 'devops'].includes(getSkill(s)?.category ?? '')),
        bullets: bullets.map((b, i) => ({ id: `exp-current-b${i + 1}`, text: b.text, skills: b.skills })),
      },
    ],
    projects: p.projects.map((pr, i) => ({
      id: `proj-${i + 1}`,
      name: pr.name,
      description: pr.description,
      technologies: pr.technologies,
      bullets: [],
    })),
    education: p.education.map((e) => ({ degree: e.degree, field: e.field, institution: e.institution, year: e.graduation_year ?? null })),
    skills: groupSkills(p.strongSkills),
    achievements: [],
    certifications: [],
  };
}
