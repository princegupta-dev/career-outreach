'use client';

import { useRef, useState } from 'react';
import useSWR from 'swr';
import { Badge, Button, Card, Field, Input, Modal, Spinner, Textarea, useAction } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface SourceVersion {
  id: string;
  versionNo: number;
  kind: 'LEGACY' | 'UPLOAD' | 'EDIT';
  status: 'PENDING_REVIEW' | 'CONFIRMED' | 'DISCARDED';
  label: string;
  originalName: string | null;
  sizeBytes: number | null;
  warnings: string[];
  confidence: number | null;
  confirmedAt: string | null;
  createdAt: string;
}

interface Bullet {
  id: string;
  text: string;
}
interface ResumeData {
  basics: { name: string; headline: string; email: string; phone: string; location: string; summary: string; [k: string]: string };
  experience: Array<{ id: string; company: string; title: string; startDate: string; endDate: string; bullets: Bullet[]; [k: string]: unknown }>;
  projects: Array<{ id: string; name: string; bullets: Bullet[]; [k: string]: unknown }>;
  skills: Array<{ category: string; items: string[] }>;
  education: Array<{ degree: string; field: string; institution: string; year?: string | number | null }>;
  [k: string]: unknown;
}

const KIND: Record<SourceVersion['kind'], string> = { LEGACY: 'Original', UPLOAD: 'Upload', EDIT: 'Edited' };

/**
 * Settings → Resume Studio. Every upload is kept unchanged as its own version. You check what was read from it,
 * fix it, and only then make it your master resume. Tailored resumes remember which version they came from.
 */
export function ResumeStudioCard() {
  const { data, mutate } = useSWR<{ activeId: string | null; versions: SourceVersion[] }>('/resume/sources', fetcher);
  const { busy, run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);

  const upload = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const v = await run('upload', () => api<SourceVersion>('/resume/sources', { form }));
    if (input.current) input.current.value = '';
    if (v) {
      await mutate();
      setReviewId(v.id);
    }
  };

  return (
    <Card
      title="Resume Studio"
      actions={
        <>
          <input ref={input} type="file" accept=".pdf,.docx" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <Button size="sm" variant="primary" loading={busy === 'upload'} onClick={() => input.current?.click()}>
            Upload resume (PDF or Word)
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-ink-muted">
        Your master resume is what every tailored resume starts from. A new upload is kept as its own version and is not used until you check it and click <b>Use as master</b>. Resumes already made for jobs are never changed.
      </p>
      {!data ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {data.versions.map((v) => {
            const active = v.id === data.activeId;
            return (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    v{v.versionNo} · {v.label} {active && <Badge tone="green">Master</Badge>} {v.status === 'PENDING_REVIEW' && <Badge tone="amber">Needs your review</Badge>}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {KIND[v.kind]} · {formatDateTime(v.createdAt)}
                    {v.confidence != null && ` · ${Math.round(v.confidence * 100)}% of usual sections found`}
                  </p>
                </div>
                <div className="flex gap-2">
                  {v.originalName && (
                    <a className="text-xs text-brand hover:underline" href={`/api/resume/sources/${v.id}/file`}>
                      Original file
                    </a>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setReviewId(v.id)}>
                    {v.status === 'PENDING_REVIEW' ? 'Review' : 'View / edit'}
                  </Button>
                  {!active && v.status === 'CONFIRMED' && (
                    <Button size="sm" loading={busy === `act-${v.id}`} onClick={async () => { if (await run(`act-${v.id}`, () => api(`/resume/sources/${v.id}/activate`, { method: 'POST' }), `v${v.versionNo} is now your master resume`)) mutate(); }}>
                      Use as master
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {reviewId && (
        <ReviewModal
          id={reviewId}
          isActive={reviewId === data?.activeId}
          onClose={() => setReviewId(null)}
          onDone={async (nextId) => {
            await mutate();
            setReviewId(nextId);
          }}
        />
      )}
    </Card>
  );
}

const linesOf = (bullets: Bullet[]) => bullets.map((b) => b.text).join('\n');
function toBullets(text: string, prefix: string, previous: Bullet[]): Bullet[] {
  return text
    .split('\n')
    .map((t) => t.replace(/^\s*[-•–]\s*/, '').trim())
    .filter(Boolean)
    .map((t, i) => ({ id: previous[i]?.id ?? `${prefix}-b${i + 1}`, text: t }));
}

function ReviewModal({ id, isActive, onClose, onDone }: { id: string; isActive: boolean; onClose: () => void; onDone: (nextId: string | null) => void }) {
  const { data: v } = useSWR<SourceVersion & { data: ResumeData; extractedText: string | null }>(`/resume/sources/${id}`, fetcher);
  const [draft, setDraft] = useState<ResumeData | null>(null);
  const [showText, setShowText] = useState(false);
  const { busy, run } = useAction();
  const d = draft ?? v?.data ?? null;
  const set = (fn: (x: ResumeData) => void) => {
    if (!d) return;
    const next = structuredClone(d);
    fn(next);
    setDraft(next);
  };
  const pending = v?.status === 'PENDING_REVIEW';

  // Saving a confirmed version creates a new version to review; it never changes the confirmed one.
  const save = async (): Promise<string | null> => {
    if (!draft) return id;
    const r = await run('save', () => api<{ id: string }>(`/resume/sources/${id}`, { method: 'PUT', body: { data: draft } }), pending ? 'Saved' : 'Saved as a new version to review');
    return r?.id ?? null;
  };
  const activate = async () => {
    const savedId = await save();
    if (!savedId) return;
    if (await run('activate', () => api(`/resume/sources/${savedId}/activate`, { method: 'POST' }), 'This is now your master resume')) onDone(null);
  };

  return (
    <Modal open onClose={onClose} title={v ? `Review v${v.versionNo}: ${v.label}` : 'Review'} wide>
      {!v || !d ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-sm">
          {v.warnings.length > 0 && (
            <ul className="space-y-1 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {v.warnings.map((w) => (
                <li key={w}>• {w}</li>
              ))}
            </ul>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Name">
              <Input value={d.basics.name} onChange={(e) => set((x) => void (x.basics.name = e.target.value))} />
            </Field>
            <Field label="Headline">
              <Input value={d.basics.headline} onChange={(e) => set((x) => void (x.basics.headline = e.target.value))} />
            </Field>
            <Field label="Email">
              <Input value={d.basics.email} onChange={(e) => set((x) => void (x.basics.email = e.target.value))} />
            </Field>
            <Field label="Phone">
              <Input value={d.basics.phone} onChange={(e) => set((x) => void (x.basics.phone = e.target.value))} />
            </Field>
          </div>
          <Field label="Summary">
            <Textarea rows={4} value={d.basics.summary} onChange={(e) => set((x) => void (x.basics.summary = e.target.value))} />
          </Field>
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">Skills (as written in the file, not yet verified)</p>
            {d.skills.map((s, i) => (
              <div key={i} className="mb-1 flex gap-2">
                <Input className="w-40" value={s.category} onChange={(e) => set((x) => void (x.skills[i].category = e.target.value))} />
                <Input value={s.items.join(', ')} onChange={(e) => set((x) => void (x.skills[i].items = e.target.value.split(',').map((t) => t.trim()).filter(Boolean)))} />
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Experience</p>
            {d.experience.map((e, i) => (
              <div key={e.id} className="space-y-2 rounded border border-slate-200 p-3">
                <div className="grid gap-2 md:grid-cols-4">
                  <Input placeholder="Title" value={e.title} onChange={(ev) => set((x) => void (x.experience[i].title = ev.target.value))} />
                  <Input placeholder="Company" value={e.company} onChange={(ev) => set((x) => void (x.experience[i].company = ev.target.value))} />
                  <Input placeholder="Start" value={e.startDate} onChange={(ev) => set((x) => void (x.experience[i].startDate = ev.target.value))} />
                  <Input placeholder="End" value={e.endDate} onChange={(ev) => set((x) => void (x.experience[i].endDate = ev.target.value))} />
                </div>
                <Textarea rows={Math.min(10, e.bullets.length + 1)} value={linesOf(e.bullets)} onChange={(ev) => set((x) => void (x.experience[i].bullets = toBullets(ev.target.value, e.id, e.bullets)))} />
              </div>
            ))}
            {d.projects.map((p, i) => (
              <div key={p.id} className="space-y-2 rounded border border-slate-200 p-3">
                <Input placeholder="Project" value={p.name} onChange={(ev) => set((x) => void (x.projects[i].name = ev.target.value))} />
                <Textarea rows={Math.min(8, p.bullets.length + 1)} value={linesOf(p.bullets)} onChange={(ev) => set((x) => void (x.projects[i].bullets = toBullets(ev.target.value, p.id, p.bullets)))} />
              </div>
            ))}
          </div>
          {v.extractedText && (
            <div>
              <button className="text-xs text-brand hover:underline" onClick={() => setShowText(!showText)}>
                {showText ? 'Hide' : 'Show'} the text read from the file
              </button>
              {showText && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">{v.extractedText}</pre>}
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
            {pending && (
              <Button variant="danger" size="sm" loading={busy === 'discard'} onClick={async () => { await run('discard', () => api(`/resume/sources/${id}`, { method: 'DELETE' }), 'Discarded'); onDone(null); }}>
                Discard
              </Button>
            )}
            <Button size="sm" disabled={!draft} loading={busy === 'save'} onClick={async () => { const nid = await save(); if (nid) { setDraft(null); onDone(nid); } }}>
              {pending ? 'Save' : 'Save as new version'}
            </Button>
            {!(isActive && !draft) && (
              <Button size="sm" variant="primary" loading={busy === 'activate'} onClick={activate}>
                {pending ? 'Looks right: use as master' : 'Save and use as master'}
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
