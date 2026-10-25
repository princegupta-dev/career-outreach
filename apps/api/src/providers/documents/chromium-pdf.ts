import { chromium, type Browser, type LaunchOptions } from 'playwright';
import { expectedTexts, type ResumeDocument } from '../../domain/resume/resume-document';
import { PageSize, renderResumeHtml } from './resume-html';

/** Thrown for anything that stops a PDF from being produced. The message is written for the person reading the UI. */
export class ResumeRenderError extends Error {}

export interface RendererOptions {
  /** Chrome/Chromium binary to use instead of Playwright's. */
  executablePath?: string;
  pageSize: PageSize;
  timeoutMs: number;
}

export interface RenderResult {
  pdf: Buffer;
  pages: number;
  /** Text extracted back out of the PDF (proof that it is selectable). */
  text: string;
  /** The tighter layout was used to keep the resume short. */
  compact: boolean;
  warnings: string[];
}

export const INSTALL_HINT = 'Install the browser used to build PDFs with "npx playwright install chromium" (the Docker image already includes it), or point RESUME_BROWSER_PATH at Chrome/Chromium.';

/** Pages we aim for; above this we try the tighter layout once. */
const TARGET_PAGES = 2;
/** More than this is almost certainly a broken document, not a long resume. */
const MAX_PAGES = 4;
const MAX_CONCURRENT = 2;
/** Page width minus the template's 0.6in side margins (CSS px at 96 dpi). */
const CONTENT_WIDTH_PX: Record<PageSize, number> = { Letter: 701, A4: 679 };

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n').find((l) => l.trim()) ?? 'unknown error';

/** Letters and digits only, lower-case, ligatures expanded: robust to line wraps, small-caps and spacing. */
export const normalizeForMatch = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

interface PdfInfo {
  pages: number;
  text: string;
  pageTexts: string[];
}

async function readPdf(pdf: Buffer): Promise<PdfInfo> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer, o?: unknown) => Promise<{ numpages: number; text: string }>;
  const pageTexts: string[] = [];
  const r = await pdfParse(pdf, {
    pagerender: (page: { getTextContent: () => Promise<{ items: Array<{ str: string }> }> }) =>
      page.getTextContent().then((c) => {
        const t = c.items.map((i) => i.str).join(' ');
        pageTexts.push(t);
        return t;
      }),
  });
  return { pages: r.numpages, text: r.text, pageTexts };
}

/**
 * Check the finished PDF against the content it was meant to contain. Throws when the file is empty, unreadable,
 * has no selectable text, is missing the name / a section / any bullet (clipped or dropped), or is absurdly long.
 */
export async function validateResumePdf(pdf: Buffer, doc: ResumeDocument): Promise<{ pages: number; text: string; warnings: string[] }> {
  if (pdf.length < 2000 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ResumeRenderError('The generated file is not a valid PDF.');
  let info: PdfInfo;
  try {
    info = await readPdf(pdf);
  } catch (e) {
    throw new ResumeRenderError(`The generated PDF could not be read back: ${firstLine(e)}`);
  }
  if (info.pages < 1) throw new ResumeRenderError('The generated PDF has no pages.');
  const flat = normalizeForMatch(info.text);
  if (flat.length < 200) throw new ResumeRenderError('The generated PDF contains no selectable text.');
  if (info.pages > MAX_PAGES) throw new ResumeRenderError(`The resume came out ${info.pages} pages long. Shorten the master resume.`);

  // Everything we meant to print must be in the PDF — checked at both ends so a clipped line is caught too.
  const missing: string[] = [];
  for (const t of expectedTexts(doc)) {
    const n = normalizeForMatch(t);
    if (!n) continue;
    const ok = n.length <= 60 ? flat.includes(n) : flat.includes(n.slice(0, 50)) && flat.includes(n.slice(-40));
    if (!ok) missing.push(t.length > 70 ? `${t.slice(0, 67)}…` : t);
  }
  if (missing.length) throw new ResumeRenderError(`Some resume text is missing or cut off in the PDF (${missing.length}): ${missing.slice(0, 3).join(' | ')}`);

  const warnings: string[] = [];
  if (info.pages > TARGET_PAGES) warnings.push(`The resume is ${info.pages} pages long.`);
  // A section title stranded at the bottom of a page is a layout fault worth reporting.
  const titles = doc.sections.map((s) => normalizeForMatch(s.title));
  info.pageTexts.slice(0, -1).forEach((t, i) => {
    const tail = normalizeForMatch(t);
    if (titles.some((s) => tail.endsWith(s))) warnings.push(`A section heading is left alone at the bottom of page ${i + 1}.`);
  });
  return { pages: info.pages, text: info.text, warnings };
}

/**
 * Builds PDFs by printing the HTML template with headless Chromium. One browser is started on first use and
 * reused; each render gets its own isolated context with scripts' network access blocked.
 */
export class ChromiumPdfRenderer {
  private browser: Promise<Browser> | null = null;
  private failedAt = 0;
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly opts: RendererOptions) {}

  private async launch(): Promise<Browser> {
    const args = ['--disable-dev-shm-usage'];
    const attempts: Array<{ label: string; options: LaunchOptions }> = this.opts.executablePath
      ? [{ label: `RESUME_BROWSER_PATH (${this.opts.executablePath})`, options: { executablePath: this.opts.executablePath, args } }]
      : [
          { label: 'Playwright Chromium', options: { args } },
          { label: 'installed Google Chrome', options: { channel: 'chrome', args } },
          { label: 'installed Microsoft Edge', options: { channel: 'msedge', args } },
        ];
    const errors: string[] = [];
    for (const a of attempts) {
      try {
        const b = await chromium.launch({ headless: true, ...a.options });
        b.on('disconnected', () => {
          this.browser = null;
        });
        return b;
      } catch (e) {
        errors.push(`${a.label}: ${firstLine(e)}`);
      }
    }
    throw new ResumeRenderError(`Could not start a browser to build the PDF. ${INSTALL_HINT} (${errors.join('; ')})`);
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      // After a failed start, do not retry on every call for a few seconds.
      if (Date.now() - this.failedAt < 3000) return Promise.reject(new ResumeRenderError(`Could not start a browser to build the PDF. ${INSTALL_HINT}`));
      this.browser = this.launch().catch((e) => {
        this.browser = null;
        this.failedAt = Date.now();
        throw e;
      });
    }
    return this.browser;
  }

  /** Can a browser be started here? (Used to tell the user what to install before they hit an error.) */
  async available(): Promise<boolean> {
    try {
      await this.getBrowser();
      return true;
    } catch {
      return false;
    }
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  /** Print one HTML document to PDF. Returns the bytes and whether anything overflowed the page width. */
  async renderHtml(html: string, pageSize: PageSize = this.opts.pageSize): Promise<{ pdf: Buffer; overflow: string[] }> {
    return this.slot(async () => {
      const browser = await this.getBrowser();
      const context = await browser.newContext({ viewport: { width: CONTENT_WIDTH_PX[pageSize], height: 1000 }, acceptDownloads: false });
      const work = (async () => {
        // The template needs nothing from the network; refuse everything except inline data.
        await context.route('**/*', (route) => (/^(data:|about:)/.test(route.request().url()) ? route.continue() : route.abort()));
        const page = await context.newPage();
        page.setDefaultTimeout(this.opts.timeoutMs);
        await page.setContent(html, { waitUntil: 'load' });
        // Anything wider than the printable width would be cut off at the page edge.
        const overflow = await page.evaluate<string[]>(`(() => {
          const out = [];
          const limit = document.documentElement.clientWidth;
          for (const el of Array.from(document.body.querySelectorAll('*'))) {
            if (el.getBoundingClientRect().right > limit + 1) out.push(el.tagName.toLowerCase() + ': ' + (el.textContent || '').trim().slice(0, 50));
          }
          return out.slice(0, 5);
        })()`);
        await page.emulateMedia({ media: 'print' });
        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true });
        return { pdf: Buffer.from(pdf), overflow };
      })();
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ResumeRenderError(`Building the PDF took longer than ${Math.round(this.opts.timeoutMs / 1000)} seconds.`)), this.opts.timeoutMs + 2000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        work.catch(() => undefined);
        await context.close().catch(() => undefined);
      }
    });
  }

  /** Document → validated PDF. Uses the tighter layout once if the default runs past two pages and that helps. */
  async renderResume(doc: ResumeDocument): Promise<RenderResult> {
    const size = this.opts.pageSize;
    const attempt = async (compact: boolean) => {
      let r;
      try {
        r = await this.renderHtml(renderResumeHtml(doc, { pageSize: size, compact }), size);
      } catch (e) {
        if (e instanceof ResumeRenderError) throw e;
        throw new ResumeRenderError(`Could not build the PDF: ${firstLine(e)}`);
      }
      if (r.overflow.length) throw new ResumeRenderError(`Some text is wider than the page and would be cut off: ${r.overflow[0]}`);
      return { ...r, ...(await validateResumePdf(r.pdf, doc)), compact };
    };
    let best = await attempt(false);
    if (best.pages > TARGET_PAGES) {
      const tight = await attempt(true).catch(() => null);
      if (tight && tight.pages < best.pages) best = tight;
    }
    return { pdf: best.pdf, pages: best.pages, text: best.text, compact: best.compact, warnings: best.warnings };
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b).close().catch(() => undefined);
  }
}
