'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { LatexResumeCard } from '@/components/latex-resume';
import { PageHeader } from '@/components/shell';
import { Button, Card, Field, Input, Modal, Spinner, Textarea, useAction } from '@/components/ui';
import { api, fetcher } from '@/lib/api';

interface Bullet {
  id: string;
  text: string;
  skills?: string[];
}
interface ResumeData {
  basics: { name: string; headline: string; email: string; phone: string; location: string; linkedin: string; github: string; website: string; summary: string };
  experience: Array<{ id: string; company: string; title: string; location: string; startDate: string; endDate: string; current: boolean; technologies: string[]; bullets: Bullet[] }>;
  projects: Array<{ id: string; name: string; description: string; technologies: string[]; bullets: Bullet[] }>;
  education: Array<{ degree: string; field: string; institution: string; year: string | number | null }>;
  skills: Array<{ category: string; items: string[] }>;
  achievements: Array<{ id: string; text: string }>;
  certifications: Array<{ name: string; issuer: string; year: string | number | null }>;
}
interface Master {
  id: string;
  source: string;
  updatedAt: string;
  data: ResumeData;
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

/** Re-key bullets from edited text, keeping skill tags when a bullet text is unchanged. */
function toBullets(text: string, prefix: string, previous: Bullet[]): Bullet[] {
  return lines(text).map((t, i) => {
    const same = previous.find((b) => b.text === t);
    return { id: `${prefix}-b${i + 1}`, text: t, ...(same?.skills ? { skills: same.skills } : {}) };
  });
}

export default function ResumePage() {
  const { data: master, mutate } = useSWR<Master>('/resume/master', fetcher);
  const [draft, setDraft] = useState<ResumeData | null>(null);
  const [preview, setPreview] = useState<ResumeData | null>(null);
  const { busy, run } = useAction();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (master) setDraft(structuredClone(master.data));
  }, [master]);

  if (!master || !draft) return <Spinner />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(master.data);
  const set = (fn: (d: ResumeData) => void) => {
    const next = structuredClone(draft);
    fn(next);
    setDraft(next);
  };

  const save = async (data: ResumeData = draft) => {
    const r = await run('save', () => api<Master>('/resume/master', { method: 'PUT', body: { data } }), 'Master resume saved');
    if (r) mutate(r, { revalidate: false });
  };

  const upload = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const r = await run('import', () => api<{ data: ResumeData }>('/resume/import', { form }));
    if (r) setPreview(r.data);
  };

  return (
    <>
      <PageHeader
        title="Master resume"
        subtitle="Your own LaTeX resume is the template for every tailored PDF. Tailoring only re-orders — it never adds facts or changes the design."
        actions={
          <>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button onClick={() => fileRef.current?.click()} loading={busy === 'import'} title="Import a PDF/DOCX/TXT into the structured data below">
              Import PDF/DOCX
            </Button>
            <Button
              onClick={async () => {
                if (!confirm('Replace the master resume with content generated from your candidate profile?')) return;
                const r = await run('reset', () => api<Master>('/resume/master/reset', { method: 'POST' }), 'Reset from profile');
                if (r) mutate(r, { revalidate: false });
              }}
            >
              Reset from profile
            </Button>
            <a href="/api/resume/master/pdf" target="_blank" className="rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium hover:bg-slate-50">
              PDF ↗
            </a>
            <Button variant="primary" onClick={() => save()} disabled={!dirty} loading={busy === 'save'}>
              Save
            </Button>
          </>
        }
      />

      <div className="mb-6">
        <LatexResumeCard onChanged={() => mutate()} />
      </div>
      <h2 className="mb-1 text-sm font-semibold">Structured resume data</h2>
      <p className="mb-4 text-xs text-ink-muted">Derived from your LaTeX when uploaded (otherwise from your profile). Used for matching and email writing; only used for the PDF when no LaTeX resume exists.</p>

      {!draft.experience.some((e) => e.company) && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Add your current employer and dates to the experience entry — they are left blank rather than guessed.</div>
      )}

      <div className="space-y-6" key={master.updatedAt}>
        <Card title="Basics">
          <div className="grid gap-3 md:grid-cols-3">
            {(['name', 'headline', 'email', 'phone', 'location', 'linkedin', 'github', 'website'] as const).map((k) => (
              <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
                <Input value={draft.basics[k]} onChange={(e) => set((d) => void (d.basics[k] = e.target.value))} />
              </Field>
            ))}
          </div>
          <div className="mt-3">
            <Field label="Summary">
              <Textarea rows={3} value={draft.basics.summary} onChange={(e) => set((d) => void (d.basics.summary = e.target.value))} />
            </Field>
          </div>
        </Card>

        <Card
          title="Experience"
          actions={
            <Button size="sm" onClick={() => set((d) => void d.experience.push({ id: uid('exp'), company: '', title: 'Role', location: '', startDate: '', endDate: '', current: false, technologies: [], bullets: [] }))}>
              Add role
            </Button>
          }
        >
          <div className="space-y-6">
            {draft.experience.map((e, i) => (
              <div key={e.id} className="space-y-3 border-b border-slate-100 pb-6 last:border-0 last:pb-0">
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="Title">
                    <Input value={e.title} onChange={(ev) => set((d) => void (d.experience[i].title = ev.target.value))} />
                  </Field>
                  <Field label="Company">
                    <Input value={e.company} onChange={(ev) => set((d) => void (d.experience[i].company = ev.target.value))} />
                  </Field>
                  <Field label="Location">
                    <Input value={e.location} onChange={(ev) => set((d) => void (d.experience[i].location = ev.target.value))} />
                  </Field>
                  <Field label="Start">
                    <Input value={e.startDate} placeholder="Jul 2023" onChange={(ev) => set((d) => void (d.experience[i].startDate = ev.target.value))} />
                  </Field>
                  <Field label="End">
                    <Input value={e.endDate} disabled={e.current} onChange={(ev) => set((d) => void (d.experience[i].endDate = ev.target.value))} />
                  </Field>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input type="checkbox" checked={e.current} onChange={(ev) => set((d) => void (d.experience[i].current = ev.target.checked))} /> Current role
                  </label>
                </div>
                <Field label="Technologies (comma separated)">
                  <Input defaultValue={e.technologies.join(', ')} onBlur={(ev) => set((d) => void (d.experience[i].technologies = csv(ev.target.value)))} />
                </Field>
                <Field label="Bullets (one per line — only true statements, no invented metrics)">
                  <Textarea rows={Math.max(4, e.bullets.length + 1)} defaultValue={e.bullets.map((b) => b.text).join('\n')} onBlur={(ev) => set((d) => void (d.experience[i].bullets = toBullets(ev.target.value, e.id, e.bullets)))} />
                </Field>
                <Button size="sm" variant="danger" onClick={() => set((d) => void d.experience.splice(i, 1))}>
                  Remove role
                </Button>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Projects" actions={<Button size="sm" onClick={() => set((d) => void d.projects.push({ id: uid('proj'), name: 'Project', description: '', technologies: [], bullets: [] }))}>Add project</Button>}>
          <div className="space-y-5">
            {draft.projects.map((p, i) => (
              <div key={p.id} className="grid gap-3 border-b border-slate-100 pb-5 last:border-0 md:grid-cols-2">
                <Field label="Name">
                  <Input value={p.name} onChange={(ev) => set((d) => void (d.projects[i].name = ev.target.value))} />
                </Field>
                <Field label="Technologies">
                  <Input defaultValue={p.technologies.join(', ')} onBlur={(ev) => set((d) => void (d.projects[i].technologies = csv(ev.target.value)))} />
                </Field>
                <div className="md:col-span-2">
                  <Field label="Description">
                    <Input value={p.description} onChange={(ev) => set((d) => void (d.projects[i].description = ev.target.value))} />
                  </Field>
                </div>
                <div className="md:col-span-2">
                  <Field label="Bullets (one per line)">
                    <Textarea rows={3} defaultValue={p.bullets.map((b) => b.text).join('\n')} onBlur={(ev) => set((d) => void (d.projects[i].bullets = toBullets(ev.target.value, p.id, p.bullets)))} />
                  </Field>
                </div>
                <div>
                  <Button size="sm" variant="danger" onClick={() => set((d) => void d.projects.splice(i, 1))}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Skills" actions={<Button size="sm" onClick={() => set((d) => void d.skills.push({ category: 'Other', items: [] }))}>Add group</Button>}>
            <div className="space-y-3">
              {draft.skills.map((g, i) => (
                <div key={i} className="grid grid-cols-[10rem_1fr_auto] gap-2">
                  <Input value={g.category} onChange={(ev) => set((d) => void (d.skills[i].category = ev.target.value))} />
                  <Input defaultValue={g.items.join(', ')} onBlur={(ev) => set((d) => void (d.skills[i].items = csv(ev.target.value)))} />
                  <Button size="sm" variant="ghost" onClick={() => set((d) => void d.skills.splice(i, 1))}>
                    ✕
                  </Button>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Education" actions={<Button size="sm" onClick={() => set((d) => void d.education.push({ degree: '', field: '', institution: '', year: null }))}>Add</Button>}>
            <div className="space-y-3">
              {draft.education.map((e, i) => (
                <div key={i} className="grid grid-cols-2 gap-2">
                  <Input placeholder="Degree" value={e.degree} onChange={(ev) => set((d) => void (d.education[i].degree = ev.target.value))} />
                  <Input placeholder="Field" value={e.field} onChange={(ev) => set((d) => void (d.education[i].field = ev.target.value))} />
                  <Input placeholder="Institution" value={e.institution} onChange={(ev) => set((d) => void (d.education[i].institution = ev.target.value))} />
                  <Input placeholder="Year" value={e.year ?? ''} onChange={(ev) => set((d) => void (d.education[i].year = ev.target.value || null))} />
                </div>
              ))}
            </div>
          </Card>
          <Card title="Achievements">
            <Textarea rows={4} defaultValue={draft.achievements.map((a) => a.text).join('\n')} placeholder="One per line — only verifiable achievements" onBlur={(ev) => set((d) => void (d.achievements = lines(ev.target.value).map((t, i) => ({ id: `ach-${i + 1}`, text: t }))))} />
          </Card>
          <Card title="Certifications">
            <Textarea
              rows={4}
              defaultValue={draft.certifications.map((c) => [c.name, c.issuer, c.year ?? ''].filter(Boolean).join(' | ')).join('\n')}
              placeholder="Name | Issuer | Year"
              onBlur={(ev) =>
                set(
                  (d) =>
                    void (d.certifications = lines(ev.target.value).map((l) => {
                      const [name, issuer = '', year = ''] = l.split('|').map((x) => x.trim());
                      return { name, issuer, year: year || null };
                    })),
                )
              }
            />
          </Card>
        </div>
      </div>

      <Modal open={!!preview} onClose={() => setPreview(null)} title="Imported resume — review before replacing" wide>
        {preview && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-muted">Parsed deterministically (no AI). Check it, then replace your master resume, and fix anything in the editor.</p>
            <p>
              <b>{preview.basics.name}</b> · {preview.basics.email || 'no email found'}
            </p>
            <p>
              {preview.experience.length} role(s), {preview.experience.reduce((a, e) => a + e.bullets.length, 0)} bullet(s), {preview.projects.length} project(s), {preview.skills.reduce((a, g) => a + g.items.length, 0)} skill(s)
            </p>
            <ul className="max-h-64 list-disc space-y-1 overflow-y-auto pl-5 text-ink-soft">
              {preview.experience.map((e) => (
                <li key={e.id}>
                  {e.title}
                  {e.company && ` — ${e.company}`} ({e.bullets.length} bullets)
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setPreview(null)}>Discard</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  await save(preview);
                  setPreview(null);
                }}
              >
                Replace master resume
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
