import * as fs from 'fs';
import * as path from 'path';
import { documentFromData, expectedTexts, inlineText, parseInline, parseLatexResume, ResumeDocumentError } from './resume-document';
import { resumeDataSchema } from './types';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../../../../candidate/resume.tex'), 'utf8');

describe('LaTeX resume → document', () => {
  const doc = parseLatexResume(SOURCE);

  it('reads every section of the real resume, in order, with nothing dropped', () => {
    expect(doc.name).toBe('Prince Gupta');
    expect(doc.sections.map((s) => s.title)).toEqual(['Summary', 'Technical Skills', 'Experience', 'Production Challenges', 'Selected Projects', 'Current Learning', 'Education']);
    expect(inlineText(doc.header[0])).toBe('Full-Stack Software Engineer | Backend Systems & GenAI | Gurgaon, India');
    expect(inlineText(doc.header[1])).toBe('+91-8059258639 | pg150704@gmail.com | LinkedIn | GitHub');
  });

  it('keeps links, skill rows, entries, projects and bullets as structured content', () => {
    const links = doc.header[1].filter((r) => r.href).map((r) => [r.text, r.href]);
    expect(links).toEqual([
      ['pg150704@gmail.com', 'mailto:pg150704@gmail.com'],
      ['LinkedIn', 'https://linkedin.com/in/princegupta123/'],
      ['GitHub', 'https://github.com/princegupta-dev'],
    ]);
    const by = (t: string) => doc.sections.find((s) => s.title === t)!.blocks;
    const skills = by('Technical Skills')[0];
    expect(skills.type === 'skills' && skills.rows.map((r) => inlineText(r.label))).toEqual(['Languages', 'Frontend', 'Backend', 'Databases & Caching', 'Messaging & Systems', 'AI / GenAI', 'Cloud & Delivery', 'Engineering']);
    const exp = by('Experience')[0];
    expect(exp).toMatchObject({ type: 'entry' });
    if (exp.type === 'entry') {
      expect([inlineText(exp.title), inlineText(exp.aside), inlineText(exp.subtitle), inlineText(exp.subAside)]).toEqual(['Senior Software Engineer', 'May 2023 – Present', 'Tech Almond Solutions Pvt. Ltd. (Almonds.ai)', 'Gurgaon, India']);
      expect(exp.bullets).toHaveLength(9);
    }
    const challenges = by('Production Challenges')[0];
    expect(challenges.type === 'bullets' && challenges.items).toHaveLength(10);
    const projects = by('Selected Projects');
    expect(projects.map((p) => p.type === 'project' && [inlineText(p.title), p.bullets.length])).toEqual([
      ['Loyalty Platform – LLM / GenAI Automation', 3],
      ['HCCB DMC – Driver Management System', 3],
      ['GPI – Loyalty & Productivity Platform', 3],
      ['Fills – Shopify-Integrated Marketplace', 2],
    ]);
    const edu = by('Education')[0];
    expect(edu.type === 'entry' && [inlineText(edu.title), inlineText(edu.aside), inlineText(edu.subAside)]).toEqual(['Indira Gandhi University (IGU)', 'Haryana, India', '2019 – 2023']);
  });

  it('preserves inline styling: bold lead-ins, monospace terms, escaped characters', () => {
    const challenges = doc.sections.find((s) => s.title === 'Production Challenges')!.blocks[0];
    if (challenges.type !== 'bullets') throw new Error('expected bullets');
    const first = challenges.items[0];
    expect(first[0]).toMatchObject({ text: 'Redis Cluster key-slot errors:', bold: true });
    expect(first.find((r) => r.code)?.text).toBe('CROSSSLOT');
    expect(inlineText(parseInline('Tom \\& Jerry, 100\\% sure, a -- b --- c, $|$ x'))).toBe('Tom & Jerry, 100% sure, a – b — c, | x');
    expect(parseInline('\\href{javascript:alert(1)}{click}')[0]).toMatchObject({ text: 'click', href: 'javascript:alert(1)' }); // kept as data; the HTML layer refuses to link it
  });

  it('follows the (tailored) order of the .tex it is given — nothing is re-sorted here', () => {
    const swapped = SOURCE.replace(/(\\itemx\{Build and maintain[^\n]*\n)(\\itemx\{Design REST[^\n]*\n)/, '$2$1');
    expect(swapped).not.toBe(SOURCE);
    const exp = parseLatexResume(swapped).sections.find((s) => s.title === 'Experience')!.blocks[0];
    expect(exp.type === 'entry' && inlineText(exp.bullets[0]).startsWith('Design REST and GraphQL')).toBe(true);
  });

  it('lists every piece of text the finished PDF must contain', () => {
    const texts = expectedTexts(doc);
    expect(texts).toEqual(expect.arrayContaining(['Prince Gupta', 'Production Challenges']));
    expect(texts.filter((t) => t.length > 40).length).toBeGreaterThan(30);
  });

  it('fails loudly instead of producing a thin resume', () => {
    expect(() => parseLatexResume('\\documentclass{article}')).toThrow(ResumeDocumentError);
    expect(() => parseLatexResume('\\documentclass{article}\\begin{document}Hello\\end{document}')).toThrow(/No \\section/);
    expect(() => parseLatexResume('\\documentclass{article}\\begin{document}\\section{Experience}\\end{document}', 'Pat')).toThrow(/empty|do not understand/);
    expect(() => parseLatexResume('\\documentclass{article}\\begin{document}\\section{A}\\begin{itemize}\\item Did a thing\\end{itemize}\\end{document}')).toThrow(/name/);
  });
});

describe('structured resume → document', () => {
  it('draws the same document model, so both kinds of master look alike', () => {
    const data = resumeDataSchema.parse({
      basics: { name: 'Pat Lee', headline: 'Backend Engineer', email: 'pat@example.com', location: 'Pune', summary: 'Builds APIs.' },
      experience: [{ id: 'e1', title: 'Engineer', company: 'Acme', startDate: '2022', current: true, bullets: [{ id: 'b1', text: 'Built an API.' }] }],
      projects: [{ id: 'p1', name: 'Tool', technologies: ['Node.js'], bullets: [{ id: 'b2', text: 'Shipped it.' }] }],
      skills: [{ category: 'Backend', items: ['Node.js', 'Redis'] }],
      education: [{ degree: 'BTech', institution: 'IGU', year: 2023 }],
    });
    const doc = documentFromData(data);
    expect(doc.name).toBe('Pat Lee');
    expect(doc.sections.map((s) => s.title)).toEqual(['Summary', 'Technical Skills', 'Experience', 'Projects', 'Education']);
    expect(expectedTexts(doc)).toEqual(expect.arrayContaining(['Built an API.', 'Shipped it.']));
  });
});
