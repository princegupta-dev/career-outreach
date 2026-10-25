import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { promises as fs } from 'fs';
import * as path from 'path';
import { AuditService } from '../../common/audit.service';
import { sha256 } from '../../common/crypto';
import { PrismaService } from '../../common/prisma.service';
import { ENV, Env } from '../../config/env';
import { CandidateProfile, parseProfileMarkdown } from '../../domain/profile/profile';

/**
 * The candidate profile lives in /candidate/candidate-profile.md (canonical).
 * The DB row is a mirror for history/joins; reads always come from the file.
 */
@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);
  private cache: { hash: string; profile: CandidateProfile; markdown: string; loadedAt: number } | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  get filePath(): string {
    return this.env.candidateProfilePath;
  }

  /** The candidate's own LaTeX resume, kept next to the profile (candidate/resume.tex). */
  get resumeTexPath(): string {
    return path.join(path.dirname(this.filePath), 'resume.tex');
  }

  /** Sample profile shipped in the repo (candidate/candidate-profile.example.md). */
  get examplePath(): string {
    return path.join(path.dirname(this.filePath), 'candidate-profile.example.md');
  }

  async readMarkdown(): Promise<string> {
    try {
      return await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // First run on a fresh clone: start from the sample so the app works, and say so loudly.
      await fs.copyFile(this.examplePath, this.filePath);
      this.logger.warn({ msg: 'No candidate profile found — created it from the sample. Replace it with your own facts.', path: this.filePath });
      return fs.readFile(this.filePath, 'utf8');
    }
  }

  /** Parsed profile, re-read when the file changes (checked at most every 2s). */
  async get(): Promise<CandidateProfile & { hash: string }> {
    if (this.cache && Date.now() - this.cache.loadedAt < 2000) return { ...this.cache.profile, hash: this.cache.hash };
    const markdown = await this.readMarkdown();
    const hash = sha256(markdown);
    if (!this.cache || this.cache.hash !== hash) {
      this.cache = { hash, profile: parseProfileMarkdown(markdown), markdown, loadedAt: Date.now() };
    } else {
      this.cache.loadedAt = Date.now();
    }
    return { ...this.cache.profile, hash };
  }

  async hash(): Promise<string> {
    return (await this.get()).hash;
  }

  /** Mirror the file into the profiles table for this user (idempotent). */
  async syncToDb(userId: string): Promise<void> {
    const markdown = await this.readMarkdown();
    const profile = parseProfileMarkdown(markdown);
    const contentHash = sha256(markdown);
    const existing = await this.prisma.profile.findUnique({ where: { userId } });
    if (existing?.contentHash === contentHash) return;
    const { body: _body, ...data } = profile;
    await this.prisma.profile.upsert({
      where: { userId },
      create: { userId, markdown, data: data as unknown as Prisma.InputJsonValue, contentHash },
      update: { markdown, data: data as unknown as Prisma.InputJsonValue, contentHash },
    });
  }

  /** Validate + atomically write the canonical file, then mirror to DB. */
  async update(userId: string, markdown: string): Promise<CandidateProfile & { hash: string }> {
    parseProfileMarkdown(markdown); // throws ProfileParseError on invalid content
    const dir = path.dirname(this.filePath);
    const tmp = path.join(dir, `.candidate-profile.${process.pid}.tmp`);
    await fs.writeFile(tmp, markdown, 'utf8');
    await fs.rename(tmp, this.filePath);
    this.cache = null;
    await this.syncToDb(userId);
    await this.audit.log('profile.updated', { userId, entityType: 'profile', metadata: { hash: sha256(markdown) } });
    this.logger.log({ msg: 'Candidate profile updated' });
    return this.get();
  }
}
