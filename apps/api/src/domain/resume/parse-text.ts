import { groupSkills } from './from-profile';
import { canonicalizeSkill, findSkills } from '../skills/taxonomy';
import type { ResumeData } from './types';

type Section = 'header' | 'summary' | 'experience' | 'projects' | 'education' | 'skills' | 'achievements' | 'certifications' | 'other';

const HEADINGS: Array<[RegExp, Section]> = [
  [/^(professional |work |employment )?(experience|history)$/i, 'experience'],
  [/^(summary|profile|about( me)?|objective|professional summary)$/i, 'summary'],
  [/^(personal |key |selected )?projects?$/i, 'projects'],
  [/^(education|academics?|academic background)$/i, 'education'],
  [/^(technical |core )?(skills|technologies|tech stack|competencies)$/i, 'skills'],
  [/^(key )?(achievements|accomplishments|awards|honou?rs|highlights)$/i, 'achievements'],
  [/^(production |engineering |technical )?challenges( solved)?$/i, 'achievements'],
  [/^(certifications?|licenses?( & certifications)?)$/i, 'certifications'],
];

/** "•", "–" and "▪" are often glued to the text in PDFs ("–Built …"); "-", "*" and "1." need a space after them. */
const BULLET = /^\s*(?:[•●▪◦–·]\s*|[-*]\s+|\d+\.\s+)/;
const MARKER_ONLY = /^[•●▪◦–·*-]$/;
const DATE_RANGE = /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4})\s*(?:-|–|—|to)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4}|present|current|now)/i;

function headingOf(line: string): Section | null {
  const t = line.replace(/[:：]$/, '').trim();
  if (t.length > 40) return null;
  for (const [re, s] of HEADINGS) if (re.test(t)) return s;
  // Any other short ALL-CAPS line ("CURRENT LEARNING") is a heading too, so its text is not merged into the section above.
  if (/^[A-Z][A-Z &/]{3,}$/.test(t) && t.split(/\s+/).length <= 4) return 'other';
  return null;
}

interface Item {
  bullet: boolean;
  text: string;
}

/**
 * Turn the raw lines of one section into items: bullets (with their wrapped lines joined back together) and plain
 * lines. `startsEntry` says when a plain line after a bullet begins a new entry rather than continuing the bullet.
 */
function toItems(lines: string[], startsEntry: (line: string) => boolean): Item[] {
  const items: Item[] = [];
  let nextIsBullet = false;
  for (const raw of lines) {
    let line = raw.trim();
    if (MARKER_ONLY.test(line)) {
      nextIsBullet = true;
      continue;
    }
    // "…workflows.–" — the marker of the next bullet glued to the end of this line.
    const trailing = /[^\s][•–]$/.test(line);
    if (trailing) line = line.slice(0, -1).trimEnd();
    const last = items[items.length - 1];
    if (BULLET.test(line) || nextIsBullet) {
      items.push({ bullet: true, text: line.replace(BULLET, '').trim() });
    } else if (last?.bullet && !startsEntry(line)) {
      last.text = last.text.endsWith('-') ? `${last.text}${line}` : `${last.text} ${line}`;
    } else {
      items.push({ bullet: false, text: line });
    }
    nextIsBullet = trailing;
  }
  return items.filter((i) => i.text);
}

/**
 * Best-effort, deterministic resume parser for imported text (PDF/DOCX/TXT).
 * Output is a starting point — the user reviews it in the editor before saving.
 * No LLM involved and nothing is invented: unknown fields stay empty.
 */
export function parseResumeText(text: string, fallbackName = ''): ResumeData {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd());
  const buckets: Record<Section, string[]> = { header: [], summary: [], experience: [], projects: [], education: [], skills: [], achievements: [], certifications: [], other: [] };
  let current: Section = 'header';
  for (const line of lines) {
    if (!line.trim()) continue;
    const h = headingOf(line);
    if (h) {
      current = h;
      continue;
    }
    buckets[current].push(line.trim());
  }

  const all = text;
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(all)?.[0] ?? '';
  const phone = /(\+?\d[\d\s-]{8,}\d)/.exec(buckets.header.join(' '))?.[0]?.trim() ?? '';
  const linkedin = /(https?:\/\/)?(www\.)?linkedin\.com\/in\/[\w-]+\/?/i.exec(all)?.[0] ?? '';
  const github = /(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/?/i.exec(all)?.[0] ?? '';
  const name = buckets.header.find((l) => /^[A-Za-z][A-Za-z .'-]{2,40}$/.test(l) && l.split(' ').length <= 4) ?? fallbackName;

  // Experience: an entry starts on a plain line; bullets attach to the latest entry. After a bullet, only a line with
  // a date range starts a new role (everything else is the bullet wrapping onto the next line).
  const experience: ResumeData['experience'] = [];
  for (const { bullet, text: line } of toItems(buckets.experience, (l) => DATE_RANGE.test(l))) {
    if (bullet && experience.length) {
      const exp = experience[experience.length - 1];
      exp.bullets.push({ id: `${exp.id}-b${exp.bullets.length + 1}`, text: line });
      continue;
    }
    const dates = DATE_RANGE.exec(line);
    const last = experience[experience.length - 1];
    if (last && !last.bullets.length && (dates || !last.company)) {
      // Continuation of the header (company / dates on a second line).
      if (dates) {
        last.startDate = last.startDate || dates[1];
        last.endDate = last.endDate || dates[2];
        last.current = /present|current|now/i.test(dates[2]);
      }
      const rest = line.replace(DATE_RANGE, '').replace(/[|,–-]\s*$/, '').trim();
      if (rest && !last.company) last.company = rest;
      continue;
    }
    if (last && last.bullets.length && !dates && line.length > 60) {
      // Paragraph-style description: treat as a bullet.
      last.bullets.push({ id: `${last.id}-b${last.bullets.length + 1}`, text: line });
      continue;
    }
    const [titlePart, companyPart] = line.replace(DATE_RANGE, '').split(/\s+(?:at|@|\||—|–|-)\s+|,\s+/);
    experience.push({
      id: `exp-${experience.length + 1}`,
      title: (titlePart ?? line).trim() || 'Role',
      company: (companyPart ?? '').trim(),
      location: '',
      startDate: dates?.[1] ?? '',
      endDate: dates?.[2] ?? '',
      current: dates ? /present|current|now/i.test(dates[2]) : false,
      technologies: [],
      bullets: [],
    });
  }
  for (const exp of experience) {
    exp.technologies = [...new Set(exp.bullets.flatMap((b) => [...findSkills(b.text).keys()]))];
  }

  const projects: ResumeData['projects'] = [];
  // A project title line looks like "Name – what it is | tech"; any other line after a bullet continues it.
  for (const { bullet, text: line } of toItems(buckets.projects, (l) => /\s[|–—]\s/.test(l))) {
    if (bullet && projects.length) {
      const p = projects[projects.length - 1];
      p.bullets.push({ id: `${p.id}-b${p.bullets.length + 1}`, text: line });
    } else {
      const [n, ...desc] = line.split(/\s+[-–—:|]\s+/);
      projects.push({ id: `proj-${projects.length + 1}`, name: n.trim(), description: desc.join(' — ').trim(), technologies: [...findSkills(line).keys()], bullets: [] });
    }
  }

  const skillText = buckets.skills.join(', ');
  const rawSkills = skillText
    .split(/[,;|•\n]/)
    .map((s) => s.replace(/^[^:]*:\s*/, '').trim())
    .filter((s) => s && s.length < 40);
  const detected = [...new Set([...rawSkills.map(canonicalizeSkill), ...findSkills(skillText).keys()])];

  const eduText = buckets.education.map((l) => l.replace(DATE_RANGE, (m) => ` ${m}`));
  const range = DATE_RANGE.exec(eduText.join(' '));
  const education = buckets.education.length
    ? [
        {
          degree: (eduText.find((l) => /(b\.?tech|bachelor|master|m\.?tech|b\.?e\.?|b\.?sc|m\.?sc|mba|phd)/i.test(l)) ?? eduText[0]).replace(DATE_RANGE, '').trim(),
          field: '',
          institution: eduText.find((l) => /(university|institute|college|iit|nit|school)/i.test(l))?.replace(DATE_RANGE, '').trim() ?? '',
          // The end of a "2019 – 2023" range is the graduation year.
          year: range ? range[2] : (/\b(19|20)\d{2}\b/.exec(eduText.join(' '))?.[0] ?? null),
        },
      ]
    : [];

  return {
    basics: {
      name: name || 'Unknown',
      headline: '',
      email,
      phone,
      location: '',
      linkedin,
      github,
      website: '',
      summary: buckets.summary.join(' '),
    },
    experience,
    projects,
    education,
    skills: groupSkills(detected),
    achievements: toItems(buckets.achievements, () => false).map((t, i) => ({ id: `ach-${i + 1}`, text: t.text })),
    certifications: buckets.certifications.map((t) => ({ name: t.replace(BULLET, ''), issuer: '', year: null })),
  };
}
