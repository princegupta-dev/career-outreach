import { detectResumeFileType, extractionQuality, MAX_RESUME_UPLOAD_BYTES } from './source-upload';
import { resumeDataSchema } from './types';

const pdf = Buffer.from('%PDF-1.7\n...');
const zip = Buffer.from('PK\u0003\u0004rest', 'latin1');

describe('detectResumeFileType', () => {
  it('accepts real PDF and DOCX by content', () => {
    expect(detectResumeFileType({ buffer: pdf, originalname: 'cv.PDF' })).toBe('pdf');
    expect(detectResumeFileType({ buffer: zip, originalname: 'cv.docx' })).toBe('docx');
  });
  it('rejects renamed, empty, oversized and other files', () => {
    expect(() => detectResumeFileType({ buffer: zip, originalname: 'cv.pdf' })).toThrow(/not a PDF/);
    expect(() => detectResumeFileType({ buffer: pdf, originalname: 'cv.docx' })).toThrow(/not a Word/);
    expect(() => detectResumeFileType({ buffer: Buffer.alloc(0), originalname: 'cv.pdf' })).toThrow(/empty/);
    expect(() => detectResumeFileType({ buffer: Buffer.alloc(MAX_RESUME_UPLOAD_BYTES + 1, 0x25), originalname: 'cv.pdf' })).toThrow(/5 MB/);
    expect(() => detectResumeFileType({ buffer: pdf, originalname: 'cv.doc' })).toThrow(/PDF or a Word/);
  });
});

describe('extractionQuality', () => {
  it('scores an empty extraction low and says what is missing', () => {
    const q = extractionQuality(resumeDataSchema.parse({ basics: { name: 'Prince' } }), 'text');
    expect(q.confidence).toBeLessThan(0.3);
    expect(q.warnings).toEqual(expect.arrayContaining(['No employment history was found.', 'No skills section was found.']));
  });
  it('always reminds that listed skills are not verified evidence', () => {
    expect(extractionQuality(resumeDataSchema.parse({ basics: { name: 'P' } }), '').warnings.join(' ')).toMatch(/not treated as verified/);
  });
});
