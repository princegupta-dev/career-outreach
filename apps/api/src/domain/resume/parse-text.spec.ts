import { parseResumeText } from './parse-text';

/** Line shapes seen in real PDF text: glued markers, wrapped bullets, glued dates, ALL-CAPS headings. */
const PDF_TEXT = `Prince Gupta
Backend Engineer | Gurgaon, India
+1-555-0100 | pg@example.com
SUMMARY
Software Engineer with 3+ years of experience building production backend systems and
AI-enabled workflows.
EXPERIENCE
Senior Software EngineerMay 2023 – Present
Tech Almond Solutions Pvt. Ltd.
–Build and maintain production services using Node.js for enterprise loyalty, engagement, and e-
commerce platforms.
–Design REST and GraphQL APIs.
PRODUCTION CHALLENGES
•Redis Cluster key-slot errors: Investigated CROSSSLOT failures by tracing key patterns and
Cluster slot constraints.
•Slow database queries: optimized indexing.
SELECTED PROJECTS
Fills – Shopify-Integrated Marketplace | Node.js, Shopify APIs
–Built backend integrations for product and order synchronization between the marketplace and
Shopify.
GPI – Loyalty Platform | Node.js, Redis
–Built OTP flows.
CURRENT LEARNING
Deepening practical knowledge of RAG and embeddings.
EDUCATION
Example Institute of Technology (EIT)
Bachelor of Technology in Computer Science Engineering2019 – 2023`;

describe('parseResumeText', () => {
  const d = parseResumeText(PDF_TEXT, 'Prince Gupta');

  it('joins wrapped bullet lines instead of creating fake jobs', () => {
    expect(d.experience).toHaveLength(1);
    expect(d.experience[0]).toMatchObject({ title: 'Senior Software Engineer', startDate: 'May 2023', endDate: 'Present', current: true });
    expect(d.experience[0].bullets.map((b) => b.text)).toEqual([
      'Build and maintain production services using Node.js for enterprise loyalty, engagement, and e-commerce platforms.',
      'Design REST and GraphQL APIs.',
    ]);
  });

  it('keeps challenges and projects in their own sections', () => {
    expect(d.achievements.map((a) => a.text)).toEqual(['Redis Cluster key-slot errors: Investigated CROSSSLOT failures by tracing key patterns and Cluster slot constraints.', 'Slow database queries: optimized indexing.']);
    expect(d.projects.map((p) => [p.name, p.bullets.length])).toEqual([['Fills', 1], ['GPI', 1]]);
    expect(d.projects[0].bullets[0].text).toMatch(/marketplace and Shopify\.$/);
  });

  it('does not merge an unknown ALL-CAPS section into the one above', () => {
    expect(JSON.stringify(d.projects)).not.toContain('RAG');
  });

  it('reads education without the glued date range', () => {
    expect(d.education[0]).toMatchObject({ degree: 'Bachelor of Technology in Computer Science Engineering', institution: 'Example Institute of Technology (EIT)', year: '2023' });
  });

  it('still reads "- " bullets and does not treat hyphenated words as bullets', () => {
    const r = parseResumeText('EXPERIENCE\nEngineer, Acme — Jan 2020 – Dec 2021\n- Built APIs\n- Ran on-call\nmulti-region failover drills', 'X');
    expect(r.experience[0].bullets.map((b) => b.text)).toEqual(['Built APIs', 'Ran on-call multi-region failover drills']);
  });
});
