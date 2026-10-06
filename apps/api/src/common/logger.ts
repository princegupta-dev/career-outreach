import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Params } from 'nestjs-pino';
import type { Env } from '../config/env';
import { requestContext } from './context';

/** Never log credentials, tokens or cookies. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.apiKey',
  '*.code',
  '*.body.text',
];

export function loggerParams(env: Env, service: 'api' | 'worker'): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      base: { service },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      mixin: () => {
        const ctx = requestContext.get();
        return ctx ? { correlationId: ctx.correlationId, userId: ctx.userId } : {};
      },
      genReqId: (req: IncomingMessage) => {
        const header = req.headers['x-request-id'];
        const id = typeof header === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(header) ? header : randomUUID();
        return id;
      },
      customProps: (req: IncomingMessage) => ({ correlationId: (req as IncomingMessage & { id?: string }).id }),
      autoLogging: { ignore: (req: IncomingMessage) => req.url === '/api/health' },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url?.split('?')[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } } : undefined,
    },
  };
}
