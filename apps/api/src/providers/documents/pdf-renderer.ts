import PDFDocument from 'pdfkit';
import type { ResumeData } from '../../domain/resume/types';

export interface DocumentRenderer {
  readonly contentType: string;
  readonly extension: string;
  renderResume(resume: ResumeData): Promise<Buffer>;
}

/**
 * ATS-friendly single-column PDF (selectable text, standard fonts, no tables).
 */
export class PdfKitRenderer implements DocumentRenderer {
  readonly contentType = 'application/pdf';
  readonly extension = 'pdf';

  renderResume(r: ResumeData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 42, bottom: 42, left: 50, right: 50 }, info: { Title: `${r.basics.name} — Resume`, Author: r.basics.name } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const width = doc.page.width - 100;
      const ink = '#111111';
      const muted = '#555555';

      doc.font('Helvetica-Bold').fontSize(20).fillColor(ink).text(r.basics.name, { align: 'left' });
      if (r.basics.headline) doc.font('Helvetica').fontSize(11).fillColor(muted).text(r.basics.headline);
      const contact = [r.basics.email, r.basics.phone, r.basics.location, r.basics.linkedin, r.basics.github, r.basics.website].filter(Boolean).join('  |  ');
      if (contact) doc.moveDown(0.2).fontSize(9).fillColor(muted).text(contact);

      const section = (title: string) => {
        doc.moveDown(0.8).font('Helvetica-Bold').fontSize(11).fillColor(ink).text(title.toUpperCase(), { characterSpacing: 0.5 });
        const y = doc.y + 2;
        doc.moveTo(50, y).lineTo(50 + width, y).lineWidth(0.5).strokeColor('#999999').stroke();
        doc.moveDown(0.4);
      };
      const bullets = (items: string[]) => {
        doc.font('Helvetica').fontSize(10).fillColor(ink);
        for (const t of items) doc.text(`•  ${t}`, { indent: 0, paragraphGap: 2, width });
      };

      if (r.basics.summary) {
        section('Summary');
        doc.font('Helvetica').fontSize(10).fillColor(ink).text(r.basics.summary, { width });
      }

      if (r.experience.length) {
        section('Experience');
        for (const e of r.experience) {
          const dates = [e.startDate, e.current ? 'Present' : e.endDate].filter(Boolean).join(' – ');
          doc.font('Helvetica-Bold').fontSize(10.5).fillColor(ink).text(`${e.title}${e.company ? ` — ${e.company}` : ''}`, { continued: !!dates });
          if (dates) doc.font('Helvetica').fillColor(muted).text(`   ${dates}`);
          if (e.location) doc.font('Helvetica').fontSize(9).fillColor(muted).text(e.location);
          doc.moveDown(0.2);
          bullets(e.bullets.map((b) => b.text));
          if (e.technologies.length) doc.moveDown(0.1).font('Helvetica-Oblique').fontSize(9).fillColor(muted).text(`Tech: ${e.technologies.join(', ')}`, { width });
          doc.moveDown(0.5);
        }
      }

      if (r.projects.length) {
        section('Projects');
        for (const p of r.projects) {
          doc.font('Helvetica-Bold').fontSize(10.5).fillColor(ink).text(p.name);
          if (p.description) doc.font('Helvetica').fontSize(10).fillColor(ink).text(p.description, { width });
          if (p.bullets.length) bullets(p.bullets.map((b) => b.text));
          if (p.technologies.length) doc.font('Helvetica-Oblique').fontSize(9).fillColor(muted).text(`Tech: ${p.technologies.join(', ')}`);
          doc.moveDown(0.4);
        }
      }

      if (r.skills.length) {
        section('Skills');
        for (const g of r.skills) {
          doc.font('Helvetica-Bold').fontSize(10).fillColor(ink).text(`${g.category}: `, { continued: true }).font('Helvetica').text(g.items.join(', '), { width });
        }
      }

      if (r.education.length) {
        section('Education');
        for (const ed of r.education) {
          const line = [`${ed.degree}${ed.field ? ` in ${ed.field}` : ''}`, ed.institution, ed.year ? String(ed.year) : ''].filter(Boolean).join(' — ');
          doc.font('Helvetica').fontSize(10).fillColor(ink).text(line, { width });
        }
      }

      if (r.achievements.length) {
        section('Achievements');
        bullets(r.achievements.map((a) => a.text));
      }
      if (r.certifications.length) {
        section('Certifications');
        bullets(r.certifications.map((c) => [c.name, c.issuer, c.year ? String(c.year) : ''].filter(Boolean).join(' — ')));
      }
      doc.end();
    });
  }
}
