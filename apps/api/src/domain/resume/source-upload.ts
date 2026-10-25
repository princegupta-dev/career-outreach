import type { ResumeData } from './types';

export const MAX_RESUME_UPLOAD_BYTES = 5 * 1024 * 1024;

export type ResumeFileType = 'pdf' | 'docx';

export class ResumeUploadError extends Error {}

/**
 * Accept only real PDF and DOCX files: checked by content (magic bytes), not just the name, so a renamed file is
 * refused. DOCX is a zip; the presence of word/document.xml is checked when it is parsed.
 */
export function detectResumeFileType(file: { buffer: Buffer; originalname: string }): ResumeFileType {
  const name = file.originalname.toLowerCase();
  if (!file.buffer.length) throw new ResumeUploadError('The file is empty.');
  if (file.buffer.length > MAX_RESUME_UPLOAD_BYTES) throw new ResumeUploadError('The file is larger than 5 MB.');
  const head = file.buffer.subarray(0, 5).toString('latin1');
  if (name.endsWith('.pdf')) {
    if (head !== '%PDF-') throw new ResumeUploadError('This file is named .pdf but is not a PDF.');
    return 'pdf';
  }
  if (name.endsWith('.docx')) {
    if (head.slice(0, 4) !== 'PK\u0003\u0004') throw new ResumeUploadError('This file is named .docx but is not a Word document.');
    return 'docx';
  }
  throw new ResumeUploadError('Upload a PDF or a Word (.docx) file.');
}

export interface ExtractionQuality {
  /** 0–1: share of the usual resume parts that were found. */
  confidence: number;
  warnings: string[];
}

/** How complete the extraction looks, and what the user should check before confirming it. */
export function extractionQuality(data: ResumeData, text: string): ExtractionQuality {
  const bullets = data.experience.reduce((a, e) => a + e.bullets.length, 0) + data.projects.reduce((a, p) => a + p.bullets.length, 0);
  const checks: Array<[boolean, string]> = [
    [!!data.basics.name.trim(), 'No name was found.'],
    [!!(data.basics.email || data.basics.phone), 'No email or phone number was found.'],
    [!!data.basics.summary.trim(), 'No summary paragraph was found.'],
    [data.experience.length > 0, 'No employment history was found.'],
    [bullets >= 3, 'Few or no bullet points were found under experience or projects.'],
    [data.skills.some((s) => s.items.length > 0), 'No skills section was found.'],
    [data.education.length > 0, 'No education was found.'],
  ];
  const warnings = checks.filter(([ok]) => !ok).map(([, w]) => w);
  if (text.length > 30_000) warnings.push('The document is very long; check that nothing was merged or cut.');
  for (const e of data.experience) if (!e.startDate && !e.endDate) warnings.push(`No dates found for "${e.title}${e.company ? ` at ${e.company}` : ''}".`);
  // A skill listed in a document is a claim, not proof. Evidence is confirmed separately.
  warnings.push('Skills in the file are listed as written. They are not treated as verified experience until you confirm them.');
  return { confidence: Math.round((checks.filter(([ok]) => ok).length / checks.length) * 100) / 100, warnings };
}
