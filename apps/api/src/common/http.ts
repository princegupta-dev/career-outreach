import {
  ArgumentsHost,
  BadRequestException,
  CanActivate,
  Catch,
  createParamDecorator,
  ExceptionFilter,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  PipeTransform,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { ZodError, type ZodType } from 'zod';
import { ENV, Env } from '../config/env';
import { requestContext } from './context';
import { RedisService } from './redis.service';
import { InvalidTransitionError } from '../domain/applications/state-machine';
import { ProfileParseError } from '../domain/profile/profile';
import { JobProviderError } from '../providers/jobs/job-provider.interface';
import { FetchError } from '../providers/http';
import { EmailProviderError } from '../providers/email/email-provider.interface';
import { AiProviderError } from '../providers/ai/anthropic.provider';
import { ResumeParseError } from '../providers/resume/resume-parser';

export const SESSION_COOKIE = 'jh_session';
export const CSRF_COOKIE = 'jh_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthUser {
  id: string;
  email: string;
}

export type AuthedRequest = Request & { user?: AuthUser; id?: string };

// ─── Decorators ──────────────────────────────────────────────────────────────

const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

const RATE_LIMIT = 'rateLimit';
export interface RateLimitOptions {
  name: string;
  limit: number;
  windowSec: number;
}
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT, opts);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new UnauthorizedException();
  return req.user;
});

// ─── Middleware: correlation context ─────────────────────────────────────────

export function contextMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  const correlationId = req.id ?? (req.headers['x-request-id'] as string | undefined);
  if (correlationId) res.setHeader('x-request-id', correlationId);
  requestContext.run({ correlationId, ip: req.ip }, () => next());
}

// ─── Guards ──────────────────────────────────────────────────────────────────

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Not signed in');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(token);
      req.user = { id: payload.sub, email: payload.email };
      requestContext.setUser(payload.sub);
      return true;
    } catch {
      throw new UnauthorizedException('Session expired');
    }
  }
}

/** Double-submit cookie CSRF protection for all state-changing requests. */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const cookie = req.cookies?.[CSRF_COOKIE];
    const header = req.headers[CSRF_HEADER];
    if (typeof cookie !== 'string' || typeof header !== 'string' || cookie.length < 20) throw new ForbiddenException('Missing CSRF token');
    const a = Buffer.from(cookie);
    const b = Buffer.from(header);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('Invalid CSRF token');
    return true;
  }
}

/** Redis-backed per-IP/per-user rate limiting (default 600 req/min). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.env.NODE_ENV === 'test') return true;
    const opts = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT, [ctx.getHandler(), ctx.getClass()]) ?? { name: 'default', limit: 600, windowSec: 60 };
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const who = req.user?.id ?? req.ip ?? 'unknown';
    const r = await this.redis.limiter.hit(`${opts.name}:${who}`, opts.limit, opts.windowSec * 1000);
    const res = ctx.switchToHttp().getResponse<Response>();
    res.setHeader('X-RateLimit-Limit', String(opts.limit));
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(r.resetMs / 1000)));
      throw new HttpException('Too many requests — slow down', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return r.data;
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly status: number = HttpStatus.UNPROCESSABLE_ENTITY,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = requestContext.correlationId();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { message: 'Internal server error' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      body = typeof r === 'string' ? { message: r } : (r as Record<string, unknown>);
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      body = { message: 'Validation failed', issues: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    } else if (exception instanceof DomainError) {
      status = exception.status;
      body = { message: exception.message, details: exception.details };
    } else if (exception instanceof InvalidTransitionError) {
      status = HttpStatus.CONFLICT;
      body = { message: exception.message };
    } else if (exception instanceof ProfileParseError || exception instanceof ResumeParseError) {
      status = HttpStatus.BAD_REQUEST;
      body = { message: exception.message };
    } else if (exception instanceof JobProviderError || exception instanceof FetchError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      body = { message: exception.message };
    } else if (exception instanceof AiProviderError) {
      status = HttpStatus.BAD_GATEWAY;
      body = { message: exception.message };
    } else if (exception instanceof EmailProviderError) {
      status = exception.authError ? HttpStatus.UNAUTHORIZED : HttpStatus.BAD_GATEWAY;
      body = { message: exception.message, reconnectGmail: exception.authError };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        body = { message: 'This record already exists' };
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        body = { message: 'Not found' };
      }
    }

    if (status >= 500) this.logger.error({ msg: 'Unhandled error', err: exception instanceof Error ? { message: exception.message, stack: exception.stack } : String(exception) });
    res.status(status).json({ statusCode: status, ...body, correlationId });
  }
}
