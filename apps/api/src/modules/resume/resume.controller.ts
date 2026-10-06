import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Res, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { OutreachService } from '../outreach/outreach.service';
import { PrismaService } from '../../common/prisma.service';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentUser, RateLimit, ZodPipe } from '../../common/http';
import { ResumeService } from './resume.service';

const MAX_UPLOAD = 5 * 1024 * 1024;

@Controller()
export class ResumeController {
  constructor(
    private readonly resumes: ResumeService,
    private readonly outreach: OutreachService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('resume/master')
  master(@CurrentUser() user: AuthUser) {
    return this.resumes.masterSummary(user.id);
  }

  /** Upload your own LaTeX resume (.tex + optional .cls/.sty/fonts). It becomes the template for every tailored PDF. */
  @Post('resume/latex')
  @HttpCode(200)
  @RateLimit({ name: 'resume-import', limit: 10, windowSec: 60 })
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: MAX_UPLOAD } }))
  async uploadLatex(@CurrentUser() user: AuthUser, @UploadedFiles() files?: Express.Multer.File[]) {
    if (!files?.length) throw new BadRequestException('Attach your .tex file in the "files" field');
    return this.resumes.uploadLatex(user.id, files);
  }

  @Delete('resume/latex')
  @HttpCode(204)
  async removeLatex(@CurrentUser() user: AuthUser) {
    await this.resumes.removeLatex(user.id);
  }

  @Get('resume/master/tex')
  async masterTex(@CurrentUser() user: AuthUser, @Res() res: Response) {
    res.setHeader('Content-Type', 'application/x-tex; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="resume.tex"');
    res.send(await this.resumes.masterLatex(user.id));
  }

  @Get('resume/versions/:id/tex')
  async versionTex(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'application/x-tex; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="resume-tailored.tex"');
    res.send(await this.resumes.versionLatex(user.id, id));
  }

  @Get('resume/versions/:id/diff')
  diff(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.resumes.versionDiff(user.id, id);
  }

  @Put('resume/master')
  save(@CurrentUser() user: AuthUser, @Body(new ZodPipe(z.object({ data: z.unknown() }))) body: { data: unknown }) {
    return this.resumes.saveMaster(user.id, body.data, 'MANUAL');
  }

  @Post('resume/master/reset')
  @HttpCode(200)
  reset(@CurrentUser() user: AuthUser) {
    return this.resumes.resetFromProfile(user.id);
  }

  /** Upload PDF/DOCX/TXT → structured preview. Saved only when the user confirms (PUT /resume/master). */
  @Post('resume/import')
  @HttpCode(200)
  @RateLimit({ name: 'resume-import', limit: 10, windowSec: 60 })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  async import(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Attach a file in the "file" field');
    return this.resumes.importPreview(file);
  }

  @Get('resume/master/pdf')
  async masterPdf(@CurrentUser() user: AuthUser, @Res() res: Response) {
    const { buffer, filename } = await this.resumes.renderPdf(user.id, null);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  }

  @Get('resume/versions/:id/download')
  async versionDownload(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { buffer, filename } = await this.resumes.renderPdf(user.id, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Get('resume/versions/:id')
  version(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.resumes.getVersion(user.id, id);
  }

  @Get('resume/versions/:id/pdf')
  async versionPdf(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { buffer, filename } = await this.resumes.renderPdf(user.id, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  }

  @Post('jobs/:id/resume')
  @HttpCode(200)
  @RateLimit({ name: 'ai', limit: 20, windowSec: 60 })
  async tailor(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ useAi: z.boolean().optional(), force: z.boolean().optional() }))) body: { useAi?: boolean; force?: boolean }) {
    const r = await this.resumes.tailor(user.id, id, body);
    // Keep any pending Gmail draft's attachment in sync with the new PDF.
    const app = await this.prisma.application.findFirst({ where: { jobId: id, userId: user.id }, select: { id: true } });
    if (app && r.version.compileStatus !== 'failed') await this.outreach.resyncApplicationDrafts(app.id);
    return r;
  }
}
