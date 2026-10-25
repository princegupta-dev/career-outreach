import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ResumeSourceKind, type ResumeSourceVersion } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { hashObject, sha256 } from '../../common/crypto';
import { DomainError } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { detectResumeFileType, extractionQuality, ResumeUploadError } from '../../domain/resume/source-upload';
import { ResumeData, resumeDataSchema } from '../../domain/resume/types';
import { ResumeParseError, TextResumeParser } from '../../providers/resume/resume-parser';
import { ProfileService } from '../profile/profile.service';

/** Everything except the file bytes and the full extracted text. */
const LIGHT = { originalFile: true, extractedText: true, latexSource: true } as const;
type LightVersion = Omit<ResumeSourceVersion, 'originalFile' | 'extractedText' | 'latexSource'>;

/**
 * Versions of the master resume. An upload is kept byte-for-byte, its extracted content waits for the user to check
 * it, and only an explicit "activate" makes it the master. Confirmed versions are never edited (an edit creates a
 * new version), so tailored resumes built from an older version keep pointing at exactly what they used.
 */
@Injectable()
export class ResumeSourcesService {
  private readonly parser = new TextResumeParser();

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfileService,
    private readonly audit: AuditService,
  ) {}

  private async master(userId: string) {
    const m = await this.prisma.resume.findFirst({ where: { userId, isMaster: true, deletedAt: null }, orderBy: { updatedAt: 'desc' }, omit: { pdf: true } });
    if (!m) throw new NotFoundException('No master resume yet');
    return m;
  }

  private async nextNo(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    const last = await tx.resumeSourceVersion.findFirst({ where: { userId }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
    return (last?.versionNo ?? 0) + 1;
  }

  /**
   * The resume that existed before versioning (resume.tex or the profile seed) becomes version 1, so switching to
   * an upload never loses it and it can be activated again. Runs once; safe to call repeatedly.
   */
  async ensureLegacySnapshot(userId: string): Promise<void> {
    const m = await this.master(userId);
    if (m.activeSourceVersionId) return;
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.resume.findUniqueOrThrow({ where: { id: m.id }, select: { activeSourceVersionId: true } });
      if (fresh.activeSourceVersionId) return;
      const v = await tx.resumeSourceVersion.create({
        data: {
          userId,
          resumeId: m.id,
          versionNo: await this.nextNo(tx, userId),
          kind: 'LEGACY',
          status: 'CONFIRMED',
          label: m.latexSource ? 'Original resume (resume.tex)' : 'Original resume (from profile)',
          data: m.data as Prisma.InputJsonValue,
          latexSource: m.latexSource,
          contentHash: m.contentHash,
          confirmedAt: new Date(),
        },
      });
      await tx.resume.update({ where: { id: m.id }, data: { activeSourceVersionId: v.id } });
    });
  }

  async list(userId: string): Promise<{ activeId: string | null; versions: LightVersion[] }> {
    await this.ensureLegacySnapshot(userId);
    const m = await this.master(userId);
    const versions = await this.prisma.resumeSourceVersion.findMany({ where: { userId, jobId: null, status: { not: 'DISCARDED' } }, orderBy: { versionNo: 'desc' }, omit: LIGHT });
    return { activeId: m.activeSourceVersionId, versions };
  }

  async get(userId: string, id: string) {
    const v = await this.prisma.resumeSourceVersion.findFirst({ where: { id, userId }, omit: { originalFile: true } });
    if (!v) throw new NotFoundException('Resume version not found');
    return v;
  }

  async originalFile(userId: string, id: string): Promise<{ buffer: Buffer; name: string; mimeType: string }> {
    const v = await this.prisma.resumeSourceVersion.findFirst({ where: { id, userId }, select: { originalFile: true, originalName: true, mimeType: true } });
    if (!v?.originalFile) throw new NotFoundException('This version has no uploaded file');
    return { buffer: Buffer.from(v.originalFile), name: v.originalName ?? 'resume', mimeType: v.mimeType ?? 'application/octet-stream' };
  }

  /** Store the file unchanged and extract its content for review. Nothing uses it until it is activated. */
  async upload(userId: string, file: { buffer: Buffer; originalname: string; mimetype: string }, opts: { label?: string } = {}): Promise<LightVersion> {
    let type;
    try {
      type = detectResumeFileType(file);
    } catch (e) {
      if (e instanceof ResumeUploadError) throw new DomainError(e.message, 400);
      throw e;
    }
    await this.ensureLegacySnapshot(userId);
    const m = await this.master(userId);
    const fileSha256 = sha256(file.buffer);
    const same = await this.prisma.resumeSourceVersion.findFirst({ where: { userId, fileSha256, jobId: null, status: { not: 'DISCARDED' } }, omit: LIGHT });
    if (same) return same; // the same file uploaded twice: one version

    let parsed;
    try {
      parsed = await this.parser.parse({ ...file, mimetype: type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, (await this.profiles.get()).name);
    } catch (e) {
      if (e instanceof ResumeParseError) throw new DomainError(e.message, 400);
      throw new DomainError(`We could not read this ${type.toUpperCase()} file: ${(e as Error).message.split('\n')[0].slice(0, 160)}`, 400);
    }
    const quality = extractionQuality(parsed.data, parsed.text);
    const v = await this.prisma.$transaction(async (tx) =>
      tx.resumeSourceVersion.create({
        data: {
          userId,
          resumeId: m.id,
          versionNo: await this.nextNo(tx, userId),
          kind: 'UPLOAD',
          status: 'PENDING_REVIEW',
          label: opts.label?.trim() || file.originalname,
          originalName: file.originalname.slice(0, 200),
          mimeType: type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: file.buffer.length,
          fileSha256,
          originalFile: new Uint8Array(file.buffer),
          extractedText: parsed.text.slice(0, 100_000),
          data: parsed.data as unknown as Prisma.InputJsonValue,
          contentHash: hashObject(parsed.data),
          warnings: quality.warnings,
          confidence: quality.confidence,
        },
        omit: LIGHT,
      }),
    );
    await this.audit.log('resume.source_uploaded', { userId, entityType: 'resume_source', entityId: v.id, metadata: { versionNo: v.versionNo, type, confidence: quality.confidence } });
    return v;
  }

  private parseData(raw: unknown): ResumeData {
    const parsed = resumeDataSchema.safeParse(raw);
    if (!parsed.success) throw new DomainError('Invalid resume data', 400, parsed.error.issues.slice(0, 10));
    const d = parsed.data;
    const ids = [...d.experience.flatMap((e) => [e.id, ...e.bullets.map((b) => b.id)]), ...d.projects.flatMap((p) => [p.id, ...p.bullets.map((b) => b.id)])];
    if (new Set(ids).size !== ids.length) throw new DomainError('Resume item ids must be unique', 400);
    return d;
  }

  /**
   * Save edits to the structured content. A version still under review is updated (its original file is never
   * touched); a confirmed version is left as it is and the edit becomes a new version to review.
   */
  async update(userId: string, id: string, raw: unknown, label?: string): Promise<LightVersion> {
    const v = await this.get(userId, id);
    const data = this.parseData(raw);
    const contentHash = hashObject(data);
    if (v.status === 'DISCARDED') throw new DomainError('This version was discarded', 409);
    if (v.status === 'PENDING_REVIEW') {
      return this.prisma.resumeSourceVersion.update({ where: { id }, data: { data: data as unknown as Prisma.InputJsonValue, contentHash, ...(label ? { label } : {}) }, omit: LIGHT });
    }
    if (contentHash === v.contentHash) return (await this.prisma.resumeSourceVersion.findUniqueOrThrow({ where: { id }, omit: LIGHT }));
    return this.prisma.$transaction(async (tx) =>
      tx.resumeSourceVersion.create({
        data: {
          userId,
          resumeId: v.resumeId,
          versionNo: await this.nextNo(tx, userId),
          kind: 'EDIT' as ResumeSourceKind,
          status: 'PENDING_REVIEW',
          label: label?.trim() || `Edited from v${v.versionNo}`,
          parentId: v.id,
          jobId: v.jobId,
          data: data as unknown as Prisma.InputJsonValue,
          // Text edits leave the old LaTeX layout behind: the new version is drawn from the structured data.
          latexSource: null,
          contentHash,
          warnings: [],
        },
        omit: LIGHT,
      }),
    );
  }

  /**
   * Make a version the master. This is the user's confirmation of the extracted content. Tailored resumes that
   * were already built keep their own copy and their link to the version they came from.
   */
  async activate(userId: string, id: string): Promise<LightVersion> {
    const v = await this.get(userId, id);
    if (v.jobId) throw new DomainError('This version belongs to one job and cannot become the master', 400);
    if (v.status === 'DISCARDED') throw new DomainError('This version was discarded', 409);
    const data = this.parseData(v.data);
    const current = await this.master(userId);
    const sameLatex = !!v.latexSource && v.latexSource === current.latexSource;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.resumeSourceVersion.update({ where: { id }, data: { status: 'CONFIRMED', confirmedAt: v.confirmedAt ?? new Date() }, omit: LIGHT });
      await tx.resume.update({
        where: { id: v.resumeId },
        data: {
          activeSourceVersionId: id,
          data: data as unknown as Prisma.InputJsonValue,
          contentHash: v.contentHash,
          latexSource: v.latexSource,
          // Unchanged LaTeX keeps its hash (and its PDF), so existing tailored resumes are still re-used.
          ...(sameLatex ? {} : { latexHash: v.latexSource ? sha256(v.latexSource) : null, pdf: null, compileLog: null }),
          // No longer the profile seed: resume.tex is not imported over it again.
          source: v.kind === 'LEGACY' ? undefined : 'IMPORT',
        },
      });
      return row;
    });
    await this.audit.log('resume.source_activated', { userId, entityType: 'resume_source', entityId: id, metadata: { versionNo: v.versionNo } });
    return updated;
  }

  /**
   * The master was changed through the older paths (structured editor, .tex upload). Record that content as a new
   * confirmed version and make it active, so the version list always describes what the master really is.
   */
  async recordMasterChange(userId: string, label: string): Promise<void> {
    await this.ensureLegacySnapshot(userId);
    const m = await this.master(userId);
    const active = m.activeSourceVersionId ? await this.prisma.resumeSourceVersion.findUnique({ where: { id: m.activeSourceVersionId }, select: { contentHash: true, latexSource: true } }) : null;
    if (active && active.contentHash === m.contentHash && active.latexSource === m.latexSource) return;
    await this.prisma.$transaction(async (tx) => {
      const v = await tx.resumeSourceVersion.create({
        data: { userId, resumeId: m.id, versionNo: await this.nextNo(tx, userId), kind: 'EDIT', status: 'CONFIRMED', label, parentId: m.activeSourceVersionId, data: m.data as Prisma.InputJsonValue, latexSource: m.latexSource, contentHash: m.contentHash, confirmedAt: new Date() },
      });
      await tx.resume.update({ where: { id: m.id }, data: { activeSourceVersionId: v.id } });
    });
  }

  async discard(userId: string, id: string): Promise<void> {
    const v = await this.get(userId, id);
    if (v.status !== 'PENDING_REVIEW') throw new DomainError('Only a version that is still under review can be discarded', 409);
    await this.prisma.resumeSourceVersion.update({ where: { id }, data: { status: 'DISCARDED' } });
  }
}
