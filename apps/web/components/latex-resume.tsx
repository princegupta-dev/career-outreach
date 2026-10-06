'use client';

import { useRef } from 'react';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Badge, Button, Card, useAction, useToast } from './ui';

interface MasterSummary {
  latex: null | {
    engine: string | null;
    sections: string[];
    bullets: number;
    reorderableBullets: number;
    skillLines: number;
    compiled: boolean;
    compileLog: string | null;
    updatedAt: string;
    hasAssets: string[];
  };
  compilerAvailable: boolean;
}

/** Upload / status of the user's own LaTeX resume (the template for every tailored PDF). */
export function LatexResumeCard({ onChanged }: { onChanged?: () => void }) {
  const { data, mutate } = useSWR<MasterSummary>('/resume/master', fetcher);
  const { busy, run } = useAction();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList) => {
    const form = new FormData();
    for (const f of Array.from(files)) form.append('files', f);
    const r = await run('upload', () => api<{ compiled: boolean; error: string | null }>('/resume/latex', { form }));
    if (r) {
      toast(r.compiled ? 'LaTeX resume uploaded and compiled ✓' : `Uploaded, but it did not compile: ${r.error}`, r.compiled ? 'ok' : 'error');
      mutate();
      onChanged?.();
    }
  };

  const l = data?.latex;
  return (
    <Card
      title="Your LaTeX resume (source of truth)"
      actions={
        <>
          <input ref={fileRef} type="file" multiple accept=".tex,.cls,.sty,.bst,.bib,.png,.jpg,.jpeg,.pdf,.otf,.ttf" className="hidden" onChange={(e) => e.target.files?.length && upload(e.target.files)} />
          <Button size="sm" variant={l ? 'secondary' : 'primary'} onClick={() => fileRef.current?.click()} loading={busy === 'upload'}>
            {l ? 'Replace .tex' : 'Upload .tex'}
          </Button>
        </>
      }
    >
      {!data ? null : !l ? (
        <div className="space-y-2 text-sm text-ink-soft">
          <p>Upload your existing resume&apos;s <b>.tex</b> file (select any .cls/.sty/font files it needs at the same time).</p>
          <p className="text-xs text-ink-muted">
            For each job, the app only re-orders your existing bullets and skills (and, with AI enabled, rephrases plain bullets under a strict no-new-facts check), then compiles your own LaTeX. Your design is never changed.
          </p>
          {!data.compilerAvailable && <p className="text-xs text-amber-800">No LaTeX engine found in this environment — run the app with Docker (TeX Live included) to compile PDFs.</p>}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={l.compiled ? 'green' : 'red'}>{l.compiled ? 'Compiles ✓' : 'Does not compile'}</Badge>
            <Badge>{l.engine}</Badge>
            <span className="text-xs text-ink-muted">uploaded {formatDateTime(l.updatedAt)}</span>
          </div>
          <p className="text-xs text-ink-soft">
            Detected sections: {l.sections.join(' · ')}. {l.reorderableBullets} bullets can be re-ordered per job; {l.skillLines} skills line{l.skillLines === 1 ? '' : 's'} can be re-ordered.
            {l.hasAssets.length > 0 && ` Extra files: ${l.hasAssets.join(', ')}.`}
          </p>
          {l.reorderableBullets === 0 && <p className="text-xs text-amber-800">No bullet lists found under Experience/Projects sections — tailoring will leave the resume unchanged.</p>}
          {l.compileLog && <pre className="max-h-48 overflow-auto rounded bg-slate-900 p-2 font-mono text-[11px] text-red-200">{l.compileLog}</pre>}
          <div className="flex flex-wrap gap-2">
            {l.compiled && (
              <a href="/api/resume/master/pdf" target="_blank" className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50">
                Preview PDF ↗
              </a>
            )}
            <a href="/api/resume/master/tex" className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50">
              Download .tex
            </a>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (!confirm('Remove the LaTeX resume? Tailored PDFs will fall back to the built-in layout.')) return;
                await api('/resume/latex', { method: 'DELETE' });
                mutate();
                onChanged?.();
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
