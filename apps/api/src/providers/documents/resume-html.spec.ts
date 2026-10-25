import { ResumeDocument } from '../../domain/resume/resume-document';
import { renderResumeHtml, safeHref } from './resume-html';

const doc: ResumeDocument = {
  name: 'Pat <b>Lee</b>',
  header: [[{ text: 'pat@example.com', href: 'mailto:pat@example.com' }, { text: ' | ' }, { text: 'evil', href: 'javascript:alert(1)' }]],
  sections: [
    {
      title: 'Experience & More',
      blocks: [
        { type: 'entry', title: [{ text: 'Engineer', bold: true }], aside: [{ text: '2022 – Present' }], subtitle: [{ text: 'Acme' }], subAside: [{ text: 'Pune' }], bullets: [[{ text: 'Fixed <script>alert(1)</script> bugs' }]] },
        { type: 'bullets', items: [[{ text: 'Handled ' }, { text: 'CROSSSLOT', code: true }]] },
      ],
    },
  ],
};

describe('resume HTML template', () => {
  const html = renderResumeHtml(doc);

  it('escapes everything it prints (names, titles and bullets are data, never markup)', () => {
    expect(html).toContain('Pat &lt;b&gt;Lee&lt;/b&gt;');
    expect(html).toContain('Fixed &lt;script&gt;alert(1)&lt;/script&gt; bugs');
    expect(html).toContain('Experience &amp; More');
    expect(html).not.toMatch(/<script|<b>Lee/i);
  });

  it('only links to web, mail and phone addresses', () => {
    expect(html).toContain('<a href="mailto:pat@example.com">');
    expect(html).not.toContain('javascript:');
    expect(safeHref('example.com/x')).toBe('https://example.com/x');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', '']) expect(safeHref(bad)).toBeNull();
  });

  it('forbids scripts and network access from inside the document', () => {
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
  });

  it('is plain, selectable text with print rules: page size, margins, headings kept with content', () => {
    expect(html).toContain('@page { size: Letter;');
    expect(renderResumeHtml(doc, { pageSize: 'A4' })).toContain('size: A4');
    expect(html).toMatch(/h2 \{[^}]*break-after: avoid/);
    expect(html).toMatch(/li \{[^}]*break-inside: avoid/);
    expect(html).not.toMatch(/<img|<svg|<canvas|<table|<iframe/i);
    expect(html).toContain('<code>CROSSSLOT</code>');
  });

  it('has a tighter variant for long resumes', () => {
    expect(renderResumeHtml(doc, { compact: true })).toMatch(/font-size: 9\.5pt/);
    expect(html).toMatch(/font-size: 10pt/);
  });
});
