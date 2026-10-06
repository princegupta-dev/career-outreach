import { parseResumeText } from '../../domain/resume/parse-text';
import type { ResumeData } from '../../domain/resume/types';

export interface ParsedResume {
  text: string;
  data: ResumeData;
}

export interface ResumeParser {
  parse(file: { buffer: Buffer; mimetype: string; originalname: string }, fallbackName: string): Promise<ParsedResume>;
}

export class ResumeParseError extends Error {}

/** Extracts text from PDF / DOCX / TXT / MD and parses it deterministically. */
export class TextResumeParser implements ResumeParser {
  async parse(file: { buffer: Buffer; mimetype: string; originalname: string }, fallbackName: string): Promise<ParsedResume> {
    const name = file.originalname.toLowerCase();
    let text: string;
    if (file.mimetype === 'application/pdf' || name.endsWith('.pdf')) {
      if (file.buffer.subarray(0, 4).toString() !== '%PDF') throw new ResumeParseError('File is not a valid PDF');
      // Import the library entry directly (the package index runs a debug harness).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string }>;
      text = (await pdfParse(file.buffer)).text;
    } else if (name.endsWith('.docx') || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require('mammoth') as { extractRawText(i: { buffer: Buffer }): Promise<{ value: string }> };
      text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
    } else if (/^text\//.test(file.mimetype) || /\.(txt|md)$/.test(name)) {
      text = file.buffer.toString('utf8');
    } else {
      throw new ResumeParseError('Unsupported file type. Upload a PDF, DOCX, TXT or MD file.');
    }
    if (text.trim().length < 50) throw new ResumeParseError('Could not extract text from the file (is it a scanned image?)');
    return { text, data: parseResumeText(text, fallbackName) };
  }
}
