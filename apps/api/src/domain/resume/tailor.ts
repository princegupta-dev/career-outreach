import type { CandidateProfile } from '../profile/profile';
import type { JobExtraction } from '../skills/extract';
import { classifySkill } from '../matching/scorer';
import { findSkills, getSkill } from '../skills/taxonomy';
import type { ResumeBullet, ResumeChange, ResumeData, TailoredResumeResult } from './types';

export function bulletSkills(b: ResumeBullet): string[] {
  return [...new Set([...(b.skills ?? []), ...findSkills(b.text).keys()])];
}

/** Weight of each JD skill: required counts double, mentions add emphasis. */
export function jobSkillWeights(ex: JobExtraction): Map<string, number> {
  const w = new Map<string, number>();
  for (const s of ex.requiredSkills) w.set(s, 2 + Math.min(3, (ex.skillCounts[s] ?? 1) - 1) * 0.5);
  for (const s of ex.preferredSkills) w.set(s, 1);
  return w;
}

export function relevance(skills: string[], weights: Map<string, number>): number {
  return skills.reduce((a, s) => a + (weights.get(s) ?? 0), 0);
}

function reorder<T>(items: T[], score: (t: T) => number): { items: T[]; moved: boolean } {
  const indexed = items.map((item, i) => ({ item, i, s: score(item) }));
  const sorted = [...indexed].sort((a, b) => b.s - a.s || a.i - b.i);
  return { items: sorted.map((x) => x.item), moved: sorted.some((x, idx) => x.i !== idx) };
}

const MAX_BULLETS_CURRENT = 8;
const MAX_BULLETS_PAST = 5;
const MAX_PROJECTS = 3;

/**
 * Deterministic tailoring: select and order existing truthful content by JD
 * relevance. It never adds skills, metrics, titles or responsibilities.
 */
export function tailorResume(master: ResumeData, ex: JobExtraction, profile: CandidateProfile, jobTitle: string): TailoredResumeResult {
  const weights = jobSkillWeights(ex);
  const changes: ResumeChange[] = [];
  const data: ResumeData = JSON.parse(JSON.stringify(master));

  // Experience: reorder bullets by relevance; trim irrelevant bullets on older roles.
  data.experience = data.experience.map((exp) => {
    const { items, moved } = reorder(exp.bullets, (b) => relevance(bulletSkills(b), weights));
    const limit = exp.current ? MAX_BULLETS_CURRENT : MAX_BULLETS_PAST;
    const kept = items.length > limit ? items.filter((b, i) => i < limit || relevance(bulletSkills(b), weights) > 0).slice(0, limit) : items;
    if (moved) changes.push({ section: 'experience', change: `Reordered bullets for ${exp.title}${exp.company ? ` at ${exp.company}` : ''}`, reason: 'Most JD-relevant work first' });
    if (kept.length < items.length) changes.push({ section: 'experience', change: `Trimmed ${items.length - kept.length} less relevant bullet(s) from ${exp.title}`, reason: 'Keep the resume focused' });
    return { ...exp, bullets: kept };
  });

  // Projects: keep the most relevant ones.
  if (data.projects.length) {
    const projScore = (p: ResumeData['projects'][number]) =>
      relevance([...new Set([...p.technologies, ...findSkills(`${p.name} ${p.description}`).keys(), ...p.bullets.flatMap(bulletSkills)])], weights);
    const { items } = reorder(data.projects, projScore);
    const relevant = items.filter((p) => projScore(p) > 0);
    const selected = (relevant.length ? relevant : items).slice(0, MAX_PROJECTS);
    if (selected.length !== data.projects.length || selected.some((p, i) => p.id !== data.projects[i]?.id)) {
      changes.push({ section: 'projects', change: `Selected ${selected.length} of ${data.projects.length} projects`, reason: relevant.length ? 'Projects overlapping with the JD first' : 'No project overlaps the JD; kept the first ones' });
    }
    data.projects = selected;
  }

  // Skills: reorder categories and items; never add.
  const skillScore = (s: string) => weights.get(s) ?? 0;
  data.skills = reorder(
    data.skills.map((g) => ({ ...g, items: reorder(g.items, skillScore).items })),
    (g) => g.items.reduce((a, s) => a + skillScore(s), 0),
  ).items;
  changes.push({ section: 'skills', change: 'Ordered skills with JD-matching technologies first', reason: 'Keyword alignment without adding anything new' });

  // Summary: built only from skills the candidate has.
  const resumeSkills = new Set([...data.skills.flatMap((g) => g.items), ...data.experience.flatMap((e) => [...e.technologies, ...e.bullets.flatMap(bulletSkills)])]);
  // Concrete technologies first (runtime/language/framework, then data/infra), then concepts.
  const tier = (s: string) => {
    const c = getSkill(s)?.category;
    return c === 'runtime' || c === 'language' || c === 'framework' ? 0 : c === 'database' || c === 'cache' || c === 'queue' || c === 'cloud' || c === 'orm' ? 1 : 2;
  };
  const overlap = [...weights.keys()]
    .filter((s) => classifySkill(s, profile).level === 'strong' && resumeSkills.has(s) && getSkill(s)?.category !== 'domain')
    .sort((a, b) => tier(a) - tier(b) || skillScore(b) - skillScore(a));
  if (overlap.length) {
    const title = profile.current_title || master.basics.headline || 'Software Engineer';
    const core = overlap.slice(0, 3);
    const more = overlap.slice(3, 7);
    data.basics.summary = `${title} focused on backend engineering with ${core.join(', ')}.${more.length ? ` Production experience with ${more.join(', ')}.` : ''} Looking to take on ${/senior/i.test(jobTitle) ? 'senior ' : ''}backend ownership in a ${jobTitle} role.`;
    changes.push({ section: 'summary', change: 'Rewrote summary around overlapping skills', reason: `Highlights ${core.join(', ')} which the JD emphasises` });
  }

  const gaps = [...weights.keys()].filter((s) => !resumeSkills.has(s) && classifySkill(s, profile).level !== 'strong');
  return { data, changes, gaps };
}
