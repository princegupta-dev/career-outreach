import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Prisma, type Resume, type ResumeSource } from '@prisma/client';
import { promises as fs } from 'fs';
import { AuditService } from '../../common/audit.service';
import { hashObject, sha256 } from '../../common/crypto';
import { DomainError } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { ENV, Env } from '../../config/env';
import { latexOutline, parseLatex, resumeBodyText, REORDERABLE_SECTION, sanitizeAssetName, validateLatexUpload } from '../../domain/latex/latex';
import { canonicalizeSkill, findSkills } from '../../domain/skills/taxonomy';
import { latexBullets, latexSummary, lineDiff, tailorLatex } from '../../domain/latex/tailor-latex';
import { classifySkill } from '../../domain/matching/scorer';
import { resumeFromProfile } from '../../domain/resume/from-profile';
import { parseResumeText } from '../../domain/resume/parse-text';
import { documentFromData, parseLatexResume, ResumeDocument, ResumeDocumentError } from '../../domain/resume/resume-document';
import { bulletSkills, jobSkillWeights, relevance, resumeGaps, tailorResume } from '../../domain/resume/tailor';
import { checkBulletRewrite } from '../../domain/resume/truth-guard';
import { ResumeChange, ResumeData, resumeDataSchema } from '../../domain/resume/types';
import { extractJob, JobExtraction } from '../../domain/skills/extract';
import { ChromiumPdfRenderer } from '../../providers/documents/chromium-pdf';
import { TextResumeParser } from '../../providers/resume/resume-parser';
import { AiService } from '../ai/ai.service';
import { ApplicationsService } from '../applications/applications.service';
import { ProfileService } from '../profile/profile.service';
import { ResumeSourcesService } from './resume-sources.service';

const MAX_AI_BULLETS = 8;

/** Prisma Bytes expect a Uint8Array backed by a plain ArrayBuffer. */
const toBytes = (b: Buffer | null | undefined): Uint8Array<ArrayBuffer> | null => (b ? new Uint8Array(b) : null);

/** Never ship PDF bytes in JSON responses. */
const OMIT_PDF = { pdf: true } as const;

type MasterResume = Omit<Resume, 'pdf'> & { data: ResumeData };

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/** What building a PDF produced, or why it could not be built (the message is shown to the user). */
type Built = { ok: true; pdf: Buffer; pages: number; compact: boolean; warnings: string[] } | { ok: false; error: string };

@Injectable()
export class ResumeService implements OnModuleDestroy {
  private readonly logger = new Logger(ResumeService.name);
  /** HTML template → PDF with headless Chromium. No TeX installation needed. */
  readonly pdf: ChromiumPdfRenderer;
  readonly parser = new TextResumeParser();

  constructor(
    @Inject(ENV) env: Env,
    private readonly prisma: PrismaService,
    private readonly profiles: ProfileService,
    private readonly ai: AiService,
    private readonly applications: ApplicationsService,
    private readonly audit: AuditService,
    private readonly sources: ResumeSourcesService,
  ) {
    this.pdf = new ChromiumPdfRenderer({ executablePath: env.RESUME_BROWSER_PATH || undefined, pageSize: env.RESUME_PAGE_SIZE, timeoutMs: env.RESUME_RENDER_TIMEOUT_MS });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pdf.close();
  }

  /** Draw a document and check the result. Never throws: a failure becomes a message the UI can show next to a retry button. */
  private async build(doc: () => ResumeDocument): Promise<Built> {
    try {
      const r = await this.pdf.renderResume(doc());
      return { ok: true, pdf: r.pdf, pages: r.pages, compact: r.compact, warnings: r.warnings };
    } catch (e) {
      this.logger.warn({ msg: 'Resume PDF could not be built', error: (e as Error).message });
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * The master resume. Seeded from the candidate profile on first use; if candidate/resume.tex
   * exists and no LaTeX has been uploaded yet, that file becomes the template automatically.
   */
  async getMaster(userId: string): Promise<MasterResume> {
    const master = await this.findOrCreateMaster(userId);
    if (master.latexSource || master.source !== 'SEED') return master;
    const file = await fs.readFile(this.profiles.resumeTexPath).catch(() => null);
    if (!file) return master;
    try {
      const r = await this.uploadLatex(userId, [{ originalname: 'resume.tex', buffer: file, mimetype: 'application/x-tex' }]);
      this.logger.log(`Using ${this.profiles.resumeTexPath} as the LaTeX resume template (compiled: ${r.compiled})`);
    } catch (err) {
      this.logger.warn(`Could not use ${this.profiles.resumeTexPath} as the resume template: ${(err as Error).message}`);
      return master;
    }
    return this.findOrCreateMaster(userId);
  }

  private async findOrCreateMaster(userId: string): Promise<MasterResume> {
    const existing = await this.prisma.resume.findFirst({ where: { userId, isMaster: true, deletedAt: null }, orderBy: { updatedAt: 'desc' }, omit: OMIT_PDF });
    if (existing) return { ...existing, data: resumeDataSchema.parse(existing.data) };
    const data = resumeFromProfile(await this.profiles.get());
    const created = await this.prisma.resume.create({
      data: { userId, name: 'Master resume', isMaster: true, data: data as unknown as Prisma.InputJsonValue, source: 'SEED', contentHash: hashObject(data) },
      omit: OMIT_PDF,
    });
    return { ...created, data };
  }

  /** Summary for the UI (no PDF bytes, no full source unless asked). */
  async masterSummary(userId: string) {
    const m = await this.getMaster(userId);
    let latex: null | { engine: string | null; sections: string[]; bullets: number; reorderableBullets: number; skillLines: number; compiled: boolean; compileLog: string | null; updatedAt: Date; hasAssets: string[] } = null;
    if (m.latexSource) {
      const doc = parseLatex(m.latexSource);
      let hasPdf = await this.prisma.resume.count({ where: { id: m.id, pdf: { not: null } } });
      let buildError = m.compileLog;
      if (!hasPdf) {
        // Never built, or it failed under the old LaTeX engine: try again with the current renderer.
        try {
          await this.masterPdf(userId);
          hasPdf = 1;
          buildError = null;
        } catch (e) {
          buildError = (e as Error).message.slice(0, 8000);
          await this.prisma.resume.update({ where: { id: m.id }, data: { compileLog: buildError } });
        }
      }
      latex = {
        engine: 'chromium',
        sections: doc.sections.map((s) => s.title),
        bullets: doc.lists.reduce((a, l) => a + l.items.length, 0),
        reorderableBullets: doc.lists.filter((l) => REORDERABLE_SECTION.test(l.section)).reduce((a, l) => a + l.items.length, 0),
        skillLines: doc.skillSegments.length,
        compiled: hasPdf > 0,
        compileLog: buildError,
        updatedAt: m.updatedAt,
        hasAssets: Object.keys((m.latexAssets as Record<string, string> | null) ?? {}),
      };
    }
    const { latexSource: _src, latexAssets: _assets, ...rest } = m;
    return { ...rest, latex, rendererAvailable: await this.pdf.available() };
  }

  async saveMaster(userId: string, raw: unknown, source: ResumeSource = 'MANUAL') {
    const parsed = resumeDataSchema.safeParse(raw);
    if (!parsed.success) throw new DomainError('Invalid resume data', 400, parsed.error.issues.slice(0, 10));
    const data = parsed.data;
    const ids = [...data.experience.flatMap((e) => [e.id, ...e.bullets.map((b) => b.id)]), ...data.projects.flatMap((p) => [p.id, ...p.bullets.map((b) => b.id)])];
    if (new Set(ids).size !== ids.length) throw new DomainError('Resume item ids must be unique', 400);
    const master = await this.getMaster(userId);
    const contentHash = hashObject(data);
    if (contentHash === master.contentHash) return master;
    const updated = await this.prisma.resume.update({ where: { id: master.id }, data: { data: data as unknown as Prisma.InputJsonValue, contentHash, source }, omit: OMIT_PDF });
    await this.audit.log('resume.master_updated', { userId, entityType: 'resume', entityId: master.id, metadata: { source } });
    await this.sources.recordMasterChange(userId, source === 'SEED' ? 'Reset from profile' : 'Edited in the resume editor');
    return { ...updated, data };
  }

  async resetFromProfile(userId: string) {
    return this.saveMaster(userId, resumeFromProfile(await this.profiles.get()), 'SEED');
  }

  /** Parse an uploaded file into a structured preview (not saved until confirmed). */
  async importPreview(file: UploadedFile) {
    const profile = await this.profiles.get();
    const parsed = await this.parser.parse(file, profile.name);
    return { data: parsed.data, textPreview: parsed.text.slice(0, 4000) };
  }

  // ─── LaTeX master ──────────────────────────────────────────────────────────

  /**
   * Store the user's own LaTeX resume as the authoritative template.
   * Accepts the main .tex plus optional .cls/.sty/font/image files it needs.
   */
  async uploadLatex(userId: string, files: UploadedFile[]) {
    const texFiles = files.filter((f) => /\.tex$/i.test(f.originalname));
    if (!texFiles.length) throw new DomainError('Upload your resume .tex file (plus any .cls/.sty it needs).', 400);
    const main = texFiles.find((f) => /\\documentclass/.test(f.buffer.toString('utf8'))) ?? texFiles[0];
    const source = main.buffer.toString('utf8').replace(/^\uFEFF/, '');
    const problems = validateLatexUpload(source);
    if (problems.length) throw new DomainError(problems.join(' '), 400);
    const doc = parseLatex(source);
    if (!doc.sections.length) throw new DomainError('Could not find any \\section{…} in the document body.', 400);
    const assets: Record<string, string> = {};
    for (const f of files) {
      if (f === main) continue;
      const name = sanitizeAssetName(f.originalname);
      if (!name) throw new DomainError(`Unsupported file "${f.originalname}". Allowed: .tex .cls .sty .bst .bib .png .jpg .pdf .otf .ttf`, 400);
      if (f.buffer.length > 5 * 1024 * 1024) throw new DomainError(`${name} is larger than 5 MB`, 400);
      assets[name] = f.buffer.toString('base64');
    }
    // Read the content the PDF will be drawn from. If it cannot be read, say so now instead of producing a thin resume later.
    let layout: ResumeDocument;
    try {
      layout = parseLatexResume(source, (await this.profiles.get()).name);
    } catch (e) {
      if (e instanceof ResumeDocumentError) throw new DomainError(`We could not read your resume content from this file: ${e.message}`, 400);
      throw e;
    }
    const compiled = await this.build(() => layout);

    // Derive structured data (for emails/analysis) from the LaTeX content, keeping profile contact details.
    const profile = await this.profiles.get();
    const derived = parseResumeText(latexOutline(doc), profile.name);
    const base = resumeFromProfile(profile);
    const data: ResumeData = {
      ...derived,
      basics: { ...base.basics, ...Object.fromEntries(Object.entries(derived.basics).filter(([, v]) => v)), name: profile.name },
      experience: derived.experience.length ? derived.experience : base.experience,
      skills: derived.skills.length ? derived.skills : base.skills,
      education: derived.education.length ? derived.education : base.education,
    };
    const master = await this.findOrCreateMaster(userId);
    await this.prisma.resume.update({
      where: { id: master.id },
      data: {
        latexSource: source,
        latexAssets: assets as Prisma.InputJsonValue,
        latexEngine: 'chromium',
        latexHash: sha256(source + JSON.stringify(Object.keys(assets).sort())),
        pdf: compiled.ok ? toBytes(compiled.pdf) : null,
        compileLog: compiled.ok ? null : compiled.error.slice(0, 8000),
        data: data as unknown as Prisma.InputJsonValue,
        contentHash: hashObject(data),
        source: 'IMPORT',
      },
      omit: OMIT_PDF,
    });
    // Before the first upload there is nothing to version yet: the snapshot taken later covers it.
    if (master.activeSourceVersionId) await this.sources.recordMasterChange(userId, 'Uploaded .tex resume');
    await this.audit.log('resume.latex_uploaded', { userId, entityType: 'resume', entityId: master.id, metadata: { compiled: compiled.ok, pages: compiled.ok ? compiled.pages : null, assets: Object.keys(assets) } });
    return { compiled: compiled.ok, error: compiled.ok ? null : compiled.error, engine: 'chromium', summary: await this.masterSummary(userId) };
  }

  async removeLatex(userId: string) {
    const master = await this.getMaster(userId);
    await this.prisma.resume.update({ where: { id: master.id }, data: { latexSource: null, latexAssets: Prisma.DbNull, latexEngine: null, latexHash: null, pdf: null, compileLog: null } });
  }

  async masterLatex(userId: string): Promise<string> {
    const m = await this.getMaster(userId);
    if (!m.latexSource) throw new NotFoundException('No LaTeX resume uploaded');
    return m.latexSource;
  }

  private async masterPdf(userId: string): Promise<Buffer> {
    await this.getMaster(userId); // creates (or imports candidate/resume.tex into) the master on first use
    const m = await this.prisma.resume.findFirstOrThrow({ where: { userId, isMaster: true, deletedAt: null }, orderBy: { updatedAt: 'desc' } });
    if (m.pdf) return Buffer.from(m.pdf);
    const profile = await this.profiles.get();
    const built = await this.build(() => (m.latexSource ? parseLatexResume(m.latexSource, profile.name) : documentFromData(resumeDataSchema.parse(m.data))));
    if (!built.ok) throw new DomainError(`Your resume could not be turned into a PDF: ${built.error}`, 422);
    await this.prisma.resume.update({ where: { id: m.id }, data: { pdf: toBytes(built.pdf), compileLog: null } });
    return built.pdf;
  }

  // ─── Tailoring ─────────────────────────────────────────────────────────────

  /**
   * Tailor the resume to a job. With a LaTeX master: re-order bullets/skills in the
   * user's own .tex (design untouched), optionally apply guarded AI rephrasing,
   * compile to PDF. Without: structured selection + built-in PDF layout.
   * Re-uses the stored version when inputs are unchanged.
   */
  async tailor(userId: string, jobId: string, opts: { useAi?: boolean; force?: boolean; confirmedSkills?: string[] } = {}) {
    const job = await this.prisma.job.findFirst({ where: { id: jobId, userId }, include: { company: true, application: true } });
    if (!job) throw new NotFoundException('Job not found');
    const master = await this.getMaster(userId);
    const profile = await this.profiles.get();
    const useAi = !!opts.useAi && this.ai.usesLlm;
    // Skills the person said they have. Only canonical skills that this job actually asks for can be added.
    // Not stated => keep what was confirmed for this job before (so re-running "Prepare" does not drop them).
    let confirmed = opts.confirmedSkills;
    if (confirmed === undefined) {
      const prev = await this.prisma.resumeVersion.findFirst({ where: { userId, jobId }, orderBy: { createdAt: 'desc' }, select: { changes: true } });
      confirmed = ((prev?.changes as { confirmedSkills?: string[] } | null)?.confirmedSkills ?? []).filter((x) => typeof x === 'string');
    }
    const confirmedKey = [...new Set(confirmed.map((x) => canonicalizeSkill(x)))].sort();
    const inputHash = hashObject({ master: master.contentHash, latex: master.latexHash, job: job.contentHash, profile: profile.hash, useAi, skills: confirmedKey, v: 'v4' });

    if (!opts.force) {
      const existing = await this.prisma.resumeVersion.findUnique({ where: { resumeId_jobId_inputHash: { resumeId: master.id, jobId, inputHash } }, omit: OMIT_PDF });
      if (existing && existing.compileStatus !== 'failed') {
        await this.linkToApplication(job.application?.id, existing.id);
        return { version: existing, reused: true };
      }
    }

    const extraction = (job.extracted as unknown as JobExtraction | null) ?? extractJob({ title: job.title, description: job.description, location: job.location, companyName: job.company.name });
    const weights = jobSkillWeights(extraction);
    const addSkills = confirmedKey.filter((x) => weights.has(x));
    // LaTeX master: gaps are measured against the resume body (not the header, whose "GitHub" link label is not a skill). Structured master: tailorResume reports them below.
    let gaps = master.latexSource ? resumeGaps(resumeBodyText(master.latexSource), weights) : [...weights.keys()].filter((s) => classifySkill(s, profile).level !== 'strong');
    let data = master.data;
    let changes: ResumeChange[] = [];
    let latex: string | null = null;
    let built: Built | null = null;
    let rejected: Array<{ id: string; reasons: string[] }> = [];
    let aiAssisted = false;

    if (master.latexSource) {
      const doc = parseLatex(master.latexSource);
      const summary = latexSummary(doc)?.text;
      let summaryRewrite: string | undefined;
      let rewrites: Array<{ id: string; text: string; reason?: string }> = [];
      if (useAi) {
        const candidates = latexBullets(doc, weights)
          .filter((b) => b.simple && b.relevance > 0)
          .sort((a, b) => b.relevance - a.relevance)
          .slice(0, MAX_AI_BULLETS);
        if (candidates.length || summary) {
          const ai = await this.ai.run(
            userId,
            'RESUME_TAILOR',
            { inputHash, bullets: candidates.map((c) => [c.id, c.text]), summary },
            (p) =>
              p.tailorResume({
                profile,
                jobTitle: job.title,
                companyName: job.company.name,
                jobSkills: [...extraction.requiredSkills, ...extraction.preferredSkills],
                description: job.description,
                bullets: candidates.map((c) => ({ id: c.id, text: c.text, roleTechnologies: [] })),
                summary,
              }),
            { force: opts.force },
          );
          rewrites = ai.output.rewrites;
          summaryRewrite = ai.output.summary;
        }
      }
      const result = tailorLatex(master.latexSource, weights, { rewrites, summaryRewrite, addSkills, summarySkills: [...findSkills(resumeBodyText(master.latexSource)).keys(), ...addSkills] });
      latex = result.latex;
      changes = result.changes;
      rejected = result.rejected;
      aiAssisted = changes.some((c) => c.section === 'bullet' || c.section === 'summary');
      gaps = gaps.filter((g) => !changes.some((c) => c.section === 'skills' && c.change === `Added skill you confirmed: ${g}`));
      built = await this.build(() => parseLatexResume(latex!, profile.name));
    } else {
      const result = tailorResume(master.data, extraction, profile, job.title);
      data = result.data;
      changes = [...result.changes];
      gaps = result.gaps; // checked against the resume's own skills, not just the profile
      if (useAi) {
        const candidates = data.experience
          .flatMap((e) => e.bullets.map((b) => ({ id: b.id, text: b.text, roleTechnologies: e.technologies, rel: relevance(bulletSkills(b), weights) })))
          .filter((b) => b.rel > 0)
          .sort((a, b) => b.rel - a.rel)
          .slice(0, MAX_AI_BULLETS);
        if (candidates.length) {
          const ai = await this.ai.run(
            userId,
            'RESUME_TAILOR',
            { inputHash, bullets: candidates.map((c) => [c.id, c.text]) },
            (p) =>
              p.tailorResume({
                profile,
                jobTitle: job.title,
                companyName: job.company.name,
                jobSkills: [...extraction.requiredSkills, ...extraction.preferredSkills],
                description: job.description,
                bullets: candidates.map(({ id, text, roleTechnologies }) => ({ id, text, roleTechnologies })),
              }),
            { force: opts.force },
          );
          for (const rw of ai.output.rewrites) {
            const original = candidates.find((c) => c.id === rw.id);
            if (!original) continue;
            const check = checkBulletRewrite(original.text, rw.text, original.roleTechnologies.filter((t) => profile.strongSkills.includes(t)));
            if (!check.ok) {
              rejected.push({ id: rw.id, reasons: check.reasons });
              continue;
            }
            for (const exp of data.experience) {
              const b = exp.bullets.find((x) => x.id === rw.id);
              if (b) {
                b.text = rw.text.trim();
                aiAssisted = true;
                changes.push({ section: 'bullet', change: `Rephrased: "${original.text.slice(0, 60)}…"`, reason: rw.reason });
              }
            }
          }
        }
      }
    }

    if (!built) {
      const finalData = data;
      built = await this.build(() => documentFromData(finalData));
    }
    const compileStatus = built.ok ? 'ok' : 'failed';
    const payload = {
      data: data as unknown as Prisma.InputJsonValue,
      changes: { changes, gaps, rejected, confirmedSkills: addSkills, format: master.latexSource ? 'latex' : 'structured', ...(built.ok ? { pages: built.pages, compact: built.compact, warnings: built.warnings } : {}) } as unknown as Prisma.InputJsonValue,
      contentHash: hashObject({ data, latex }),
      sourceVersionId: master.activeSourceVersionId,
      aiAssisted,
      latex,
      pdf: toBytes(built.ok ? built.pdf : null),
      compileStatus,
      compileLog: built.ok ? null : built.error.slice(0, 8000),
    };
    const version = await this.prisma.resumeVersion.upsert({
      where: { resumeId_jobId_inputHash: { resumeId: master.id, jobId, inputHash } },
      create: { userId, resumeId: master.id, jobId, inputHash, ...payload },
      update: payload,
      omit: OMIT_PDF,
    });
    if (compileStatus !== 'failed') await this.linkToApplication(job.application?.id, version.id);
    await this.audit.log('resume.tailored', { userId, entityType: 'job', entityId: jobId, metadata: { versionId: version.id, aiAssisted, compileStatus } });
    return { version, reused: false };
  }

  private async linkToApplication(applicationId: string | undefined, versionId: string) {
    if (!applicationId) return;
    await this.prisma.application.update({ where: { id: applicationId }, data: { resumeVersionId: versionId } });
    await this.applications.autoAdvance(applicationId, 'RESUME_READY');
  }

  async getVersion(userId: string, id: string) {
    const v = await this.prisma.resumeVersion.findFirst({ where: { id, userId }, omit: OMIT_PDF });
    if (!v) throw new NotFoundException('Resume version not found');
    return { ...v, data: resumeDataSchema.parse(v.data) };
  }

  /** Changed lines (with one line of context) between the master .tex and a tailored version. */
  async versionDiff(userId: string, id: string) {
    const v = await this.getVersion(userId, id);
    if (!v.latex) return { format: 'structured', lines: [] };
    const master = await this.prisma.resume.findUniqueOrThrow({ where: { id: v.resumeId }, select: { latexSource: true } });
    const diff = lineDiff(master.latexSource ?? '', v.latex);
    const keep = new Set<number>();
    diff.forEach((d, i) => {
      if (d.type !== 'same') for (let k = i - 1; k <= i + 1; k++) keep.add(k);
    });
    return { format: 'latex', lines: diff.map((d, i) => ({ ...d, n: i })).filter((d) => keep.has(d.n)) };
  }

  async versionLatex(userId: string, id: string): Promise<string> {
    const v = await this.getVersion(userId, id);
    if (!v.latex) throw new NotFoundException('This version has no LaTeX source');
    return v.latex;
  }

  /** PDF for a tailored version (or the master). Never falls back to a different design when a LaTeX master exists. */
  async renderPdf(userId: string, versionId?: string | null): Promise<{ buffer: Buffer; filename: string }> {
    const profile = await this.profiles.get();
    const filename = `${profile.name.replace(/[^A-Za-z0-9]+/g, '_')}_Resume.pdf`;
    if (versionId) {
      const v = await this.prisma.resumeVersion.findFirst({ where: { id: versionId, userId } });
      if (!v) throw new NotFoundException('Resume version not found');
      if (v.pdf) return { buffer: Buffer.from(v.pdf), filename };
      // No PDF stored: a version saved before PDFs were kept with it, or one whose earlier build failed (for example
      // when no browser was installed yet). Build it again from what was saved; the saved content is what it was.
      const built = await this.build(() => (v.latex ? parseLatexResume(v.latex, profile.name) : documentFromData(resumeDataSchema.parse(v.data))));
      if (!built.ok) {
        await this.prisma.resumeVersion.update({ where: { id: v.id }, data: { compileStatus: 'failed', compileLog: built.error.slice(0, 8000) } });
        throw new DomainError(`The tailored resume could not be built: ${built.error}`, 422);
      }
      await this.prisma.resumeVersion.update({ where: { id: v.id }, data: { pdf: toBytes(built.pdf), compileStatus: 'ok', compileLog: null } });
      return { buffer: built.pdf, filename };
    }
    return { buffer: await this.masterPdf(userId), filename };
  }
}
