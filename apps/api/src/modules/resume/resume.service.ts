import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type Resume, type ResumeSource } from '@prisma/client';
import { promises as fs } from 'fs';
import { AuditService } from '../../common/audit.service';
import { hashObject, sha256 } from '../../common/crypto';
import { DomainError } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { detectEngine, latexOutline, parseLatex, REORDERABLE_SECTION, validateLatexUpload } from '../../domain/latex/latex';
import { latexBullets, lineDiff, tailorLatex } from '../../domain/latex/tailor-latex';
import { classifySkill } from '../../domain/matching/scorer';
import { resumeFromProfile } from '../../domain/resume/from-profile';
import { parseResumeText } from '../../domain/resume/parse-text';
import { bulletSkills, jobSkillWeights, relevance, tailorResume } from '../../domain/resume/tailor';
import { checkBulletRewrite } from '../../domain/resume/truth-guard';
import { ResumeChange, ResumeData, resumeDataSchema } from '../../domain/resume/types';
import { extractJob, JobExtraction } from '../../domain/skills/extract';
import { LatexCompiler, sanitizeAssetName } from '../../providers/documents/latex-compiler';
import { PdfKitRenderer } from '../../providers/documents/pdf-renderer';
import { TextResumeParser } from '../../providers/resume/resume-parser';
import { AiService } from '../ai/ai.service';
import { ApplicationsService } from '../applications/applications.service';
import { ProfileService } from '../profile/profile.service';

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

@Injectable()
export class ResumeService {
  private readonly logger = new Logger(ResumeService.name);
  readonly renderer = new PdfKitRenderer();
  readonly parser = new TextResumeParser();
  readonly compiler = new LatexCompiler();

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfileService,
    private readonly ai: AiService,
    private readonly applications: ApplicationsService,
    private readonly audit: AuditService,
  ) {}

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
      const hasPdf = await this.prisma.resume.count({ where: { id: m.id, pdf: { not: null } } });
      latex = {
        engine: m.latexEngine,
        sections: doc.sections.map((s) => s.title),
        bullets: doc.lists.reduce((a, l) => a + l.items.length, 0),
        reorderableBullets: doc.lists.filter((l) => REORDERABLE_SECTION.test(l.section)).reduce((a, l) => a + l.items.length, 0),
        skillLines: doc.skillSegments.length,
        compiled: hasPdf > 0,
        compileLog: m.compileLog,
        updatedAt: m.updatedAt,
        hasAssets: Object.keys((m.latexAssets as Record<string, string> | null) ?? {}),
      };
    }
    const { latexSource: _src, latexAssets: _assets, ...rest } = m;
    return { ...rest, latex, compilerAvailable: await this.compiler.available(m.latexSource ? detectEngine(m.latexSource) : 'pdflatex') };
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
    const engine = detectEngine(source);
    const compiled = await this.compiler.compile(source, assets, engine);

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
        latexEngine: compiled.engine,
        latexHash: sha256(source + JSON.stringify(Object.keys(assets).sort())),
        pdf: compiled.ok ? toBytes(compiled.pdf) : null,
        compileLog: compiled.ok ? null : `${compiled.error}\n\n${compiled.log}`.slice(0, 8000),
        data: data as unknown as Prisma.InputJsonValue,
        contentHash: hashObject(data),
        source: 'IMPORT',
      },
      omit: OMIT_PDF,
    });
    await this.audit.log('resume.latex_uploaded', { userId, entityType: 'resume', entityId: master.id, metadata: { engine: compiled.engine, compiled: compiled.ok, assets: Object.keys(assets) } });
    return { compiled: compiled.ok, error: compiled.error ?? null, engine: compiled.engine, summary: await this.masterSummary(userId) };
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
    const m = await this.prisma.resume.findFirstOrThrow({ where: { userId, isMaster: true, deletedAt: null }, orderBy: { updatedAt: 'desc' } });
    if (m.pdf) return Buffer.from(m.pdf);
    if (!m.latexSource) throw new DomainError('No LaTeX resume', 400);
    const c = await this.compiler.compile(m.latexSource, (m.latexAssets as Record<string, string>) ?? {}, m.latexEngine);
    if (!c.ok) throw new DomainError(`Your LaTeX resume could not be compiled: ${c.error}`, 422, { log: c.log.slice(-2000) });
    await this.prisma.resume.update({ where: { id: m.id }, data: { pdf: toBytes(c.pdf), compileLog: null } });
    return c.pdf!;
  }

  // ─── Tailoring ─────────────────────────────────────────────────────────────

  /**
   * Tailor the resume to a job. With a LaTeX master: re-order bullets/skills in the
   * user's own .tex (design untouched), optionally apply guarded AI rephrasing,
   * compile to PDF. Without: structured selection + built-in PDF layout.
   * Re-uses the stored version when inputs are unchanged.
   */
  async tailor(userId: string, jobId: string, opts: { useAi?: boolean; force?: boolean } = {}) {
    const job = await this.prisma.job.findFirst({ where: { id: jobId, userId }, include: { company: true, application: true } });
    if (!job) throw new NotFoundException('Job not found');
    const master = await this.getMaster(userId);
    const profile = await this.profiles.get();
    const useAi = !!opts.useAi && this.ai.usesLlm;
    const inputHash = hashObject({ master: master.contentHash, latex: master.latexHash, job: job.contentHash, profile: profile.hash, useAi, v: 'v2' });

    if (!opts.force) {
      const existing = await this.prisma.resumeVersion.findUnique({ where: { resumeId_jobId_inputHash: { resumeId: master.id, jobId, inputHash } }, omit: OMIT_PDF });
      if (existing && existing.compileStatus !== 'failed') {
        await this.linkToApplication(job.application?.id, existing.id);
        return { version: existing, reused: true };
      }
    }

    const extraction = (job.extracted as unknown as JobExtraction | null) ?? extractJob({ title: job.title, description: job.description, location: job.location, companyName: job.company.name });
    const weights = jobSkillWeights(extraction);
    const gaps = [...weights.keys()].filter((s) => classifySkill(s, profile).level !== 'strong');
    let data = master.data;
    let changes: ResumeChange[] = [];
    let latex: string | null = null;
    let pdf: Buffer | null = null;
    let compileStatus: string | null = null;
    let compileLog: string | null = null;
    let rejected: Array<{ id: string; reasons: string[] }> = [];
    let aiAssisted = false;

    if (master.latexSource) {
      const doc = parseLatex(master.latexSource);
      let rewrites: Array<{ id: string; text: string; reason?: string }> = [];
      if (useAi) {
        const candidates = latexBullets(doc, weights)
          .filter((b) => b.simple && b.relevance > 0)
          .sort((a, b) => b.relevance - a.relevance)
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
                bullets: candidates.map((c) => ({ id: c.id, text: c.text, roleTechnologies: [] })),
              }),
            { force: opts.force },
          );
          rewrites = ai.output.rewrites;
        }
      }
      const result = tailorLatex(master.latexSource, weights, { rewrites });
      latex = result.latex;
      changes = result.changes;
      rejected = result.rejected;
      aiAssisted = changes.some((c) => c.section === 'bullet');
      const compiled = await this.compiler.compile(latex, (master.latexAssets as Record<string, string>) ?? {}, master.latexEngine);
      compileStatus = compiled.ok ? 'ok' : 'failed';
      compileLog = compiled.ok ? null : `${compiled.error}\n\n${compiled.log}`.slice(0, 8000);
      pdf = compiled.ok ? compiled.pdf! : null;
    } else {
      const result = tailorResume(master.data, extraction, profile, job.title);
      data = result.data;
      changes = [...result.changes];
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

    const payload = {
      data: data as unknown as Prisma.InputJsonValue,
      changes: { changes, gaps, rejected, format: master.latexSource ? 'latex' : 'structured' } as unknown as Prisma.InputJsonValue,
      contentHash: hashObject({ data, latex }),
      aiAssisted,
      latex,
      pdf: toBytes(pdf),
      compileStatus,
      compileLog,
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
      if (v.latex) throw new DomainError(`The tailored LaTeX resume failed to compile: ${(v.compileLog ?? '').split('\n')[0]}`, 422);
      return { buffer: await this.renderer.renderResume(resumeDataSchema.parse(v.data)), filename };
    }
    const master = await this.getMaster(userId);
    if (master.latexSource) return { buffer: await this.masterPdf(userId), filename };
    return { buffer: await this.renderer.renderResume(master.data), filename };
  }
}
