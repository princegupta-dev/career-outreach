import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectEngine } from '../../domain/latex/latex';

export type TexEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface CompileResult {
  ok: boolean;
  pdf?: Buffer;
  engine: TexEngine;
  /** Tail of the TeX log (errors are near the end). */
  log: string;
  /** Short human-readable reason when ok=false. */
  error?: string;
}

/** Persistent font/format caches (shared across compiles; not user content). */
const CACHE_HOME = path.join(os.tmpdir(), 'jh-tex-cache');

const ALLOWED_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(cls|sty|bst|bib|png|jpe?g|pdf|otf|ttf|tex|def|cfg|fd)$/i;

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        // Paranoid file access: TeX may only read/write inside the job directory.
        env: { ...process.env, openin_any: 'p', openout_any: 'p', shell_escape: 'f', HOME: CACHE_HOME, TEXMFVAR: path.join(CACHE_HOME, 'texmf-var') },
      },
      (err, stdout) => {
        const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout ?? ''), timedOut: !!e?.killed || e?.signal === 'SIGTERM' });
      },
    );
    child.stdin?.end();
  });
}

/**
 * Compiles the user's own LaTeX (TeX Live in the Docker image).
 * - no shell escape, file access restricted to a throw-away directory
 * - timeout + limited concurrency
 */
export class LatexCompiler {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  private availability: Record<string, boolean> = {};

  constructor(
    private readonly timeoutMs = 60_000,
    private readonly maxConcurrent = 2,
  ) {}

  async available(engine: TexEngine = 'pdflatex'): Promise<boolean> {
    if (engine in this.availability) return this.availability[engine];
    const r = await run(engine, ['--version'], os.tmpdir(), 10_000).catch(() => ({ code: 1, stdout: '', timedOut: false }));
    this.availability[engine] = r.code === 0;
    return this.availability[engine];
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  async compile(source: string, assets: Record<string, string> = {}, engineOverride?: string | null): Promise<CompileResult> {
    const engine = (engineOverride as TexEngine) || detectEngine(source);
    if (!(await this.available(engine))) {
      return { ok: false, engine, log: '', error: `${engine} is not installed. Run the app with Docker (TeX Live is included) or install TeX Live / MacTeX locally.` };
    }
    return this.slot(async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jh-tex-'));
      try {
        for (const [name, b64] of Object.entries(assets)) {
          if (!ALLOWED_ASSET.test(name)) continue;
          await fs.writeFile(path.join(dir, name), Buffer.from(b64, 'base64'));
        }
        await fs.writeFile(path.join(dir, 'resume.tex'), source, 'utf8');
        const args = ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-no-shell-escape', 'resume.tex'];
        let r = await run(engine, args, dir, this.timeoutMs);
        let log = await fs.readFile(path.join(dir, 'resume.log'), 'utf8').catch(() => r.stdout);
        // Second pass for references / page numbers when TeX asks for it.
        if (r.code === 0 && /Rerun to get|Label\(s\) may have changed/.test(log)) {
          r = await run(engine, args, dir, this.timeoutMs);
          log = await fs.readFile(path.join(dir, 'resume.log'), 'utf8').catch(() => r.stdout);
        }
        const pdf = await fs.readFile(path.join(dir, 'resume.pdf')).catch(() => undefined);
        const tail = log.slice(-6000);
        if (r.timedOut) return { ok: false, engine, log: tail, error: 'LaTeX compilation timed out' };
        if (r.code !== 0 || !pdf) return { ok: false, engine, log: tail, error: summarizeTexError(log) };
        return { ok: true, engine, log: tail, pdf };
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }
}

/** First meaningful error line(s) from a TeX log. */
export function summarizeTexError(log: string): string {
  const missing = /! LaTeX Error: File `([^']+)' not found/.exec(log);
  if (missing) return `Missing LaTeX file/package "${missing[1]}". Upload it with your .tex, or use the Docker image (full TeX Live).`;
  const line = log.split('\n').find((l) => /^!|:\d+: /.test(l));
  return line ? line.replace(/^.*?:\d+: /, '').slice(0, 300) : 'LaTeX compilation failed (see log)';
}

export function sanitizeAssetName(name: string): string | null {
  const base = path.basename(name);
  return ALLOWED_ASSET.test(base) ? base : null;
}
