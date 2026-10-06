import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import { randomToken } from '../../common/crypto';
import { AuthUser, CSRF_COOKIE, CurrentUser, Public, RateLimit, SESSION_COOKIE, ZodPipe } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { ENV, Env } from '../../config/env';
import { AuthService, SESSION_TTL_SECONDS } from './auth.service';
import { QueueService } from '../queues/queues';
import { JobsService } from '../jobs/jobs.service';

const credentials = z.object({ email: z.string().trim().email().max(254), password: z.string().min(10, 'Use at least 10 characters').max(200) });
const registerSchema = credentials.extend({ name: z.string().trim().min(1).max(100) });
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) });
const passwordSchema = z.object({ current: z.string().min(1).max(200), next: z.string().min(10).max(200) });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    private readonly queues: QueueService,
    private readonly jobs: JobsService,
  ) {}

  private cookieBase(): CookieOptions {
    return { sameSite: 'lax', secure: this.env.NODE_ENV === 'production' && this.env.APP_URL.startsWith('https'), path: '/' };
  }

  /** Issues the CSRF double-submit cookie (readable by the SPA, not HttpOnly). */
  @Public()
  @Get('csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    let token = req.cookies?.[CSRF_COOKIE] as string | undefined;
    if (!token || token.length < 20) {
      token = randomToken(32);
      res.cookie(CSRF_COOKIE, token, { ...this.cookieBase(), httpOnly: false, maxAge: SESSION_TTL_SECONDS * 1000 });
    }
    return { csrfToken: token };
  }

  @Public()
  @Get('status')
  async status() {
    return { registrationOpen: await this.auth.registrationOpen() };
  }

  @Public()
  @Post('register')
  @RateLimit({ name: 'auth', limit: 10, windowSec: 60 })
  async register(@Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.register(body.email, body.password, body.name);
    // Zero setup: seed default job sources and start the first search right away.
    await this.jobs.ensureDefaultSources(user.id);
    await this.queues.discover({ userId: user.id, trigger: 'signup' });
    res.cookie(SESSION_COOKIE, await this.auth.issueSession(user), { ...this.cookieBase(), httpOnly: true, maxAge: SESSION_TTL_SECONDS * 1000 });
    return { id: user.id, email: user.email, name: user.name };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit({ name: 'auth', limit: 10, windowSec: 60 })
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.login(body.email, body.password);
    res.cookie(SESSION_COOKIE, await this.auth.issueSession(user), { ...this.cookieBase(), httpOnly: true, maxAge: SESSION_TTL_SECONDS * 1000 });
    return { id: user.id, email: user.email, name: user.name };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, this.cookieBase());
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, email: true, name: true, createdAt: true } });
    return u;
  }

  @Post('password')
  @HttpCode(200)
  @RateLimit({ name: 'auth', limit: 10, windowSec: 60 })
  async password(@CurrentUser() user: AuthUser, @Body(new ZodPipe(passwordSchema)) body: z.infer<typeof passwordSchema>) {
    await this.auth.changePassword(user.id, body.current, body.next);
    return { ok: true };
  }
}
