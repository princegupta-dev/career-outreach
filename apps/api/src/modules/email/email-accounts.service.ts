import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { EmailAccount } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { ENCRYPTOR } from '../../common/common.module';
import { Encryptor, randomToken } from '../../common/crypto';
import { DomainError } from '../../common/http';
import { MetricsService } from '../../common/metrics.service';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { ENV, Env } from '../../config/env';
import { EmailProvider, EmailProviderError, MailboxContext } from '../../providers/email/email-provider.interface';
import { GmailOAuth, GmailProvider } from '../../providers/email/gmail.provider';
import { SandboxEmailProvider } from '../../providers/email/sandbox.provider';

const STATE_TTL_SECONDS = 600;
export const SANDBOX_ADDRESS = 'sandbox@job-hunter.local';

@Injectable()
export class EmailAccountsService {
  private readonly logger = new Logger(EmailAccountsService.name);
  readonly oauth: GmailOAuth;
  readonly gmail = new GmailProvider();
  readonly sandbox: SandboxEmailProvider;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {
    this.oauth = new GmailOAuth(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
    this.sandbox = new SandboxEmailProvider(redis.client);
  }

  get mode(): 'gmail' | 'sandbox' {
    return this.env.EMAIL_PROVIDER;
  }

  providerFor(account: Pick<EmailAccount, 'provider'>): EmailProvider {
    return account.provider === 'GMAIL' ? this.gmail : this.sandbox;
  }

  async status(userId: string) {
    const accounts = await this.prisma.emailAccount.findMany({
      where: { userId },
      select: { id: true, provider: true, email: true, status: true, scopes: true, lastSyncAt: true, lastError: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return { mode: this.mode, gmailOAuthConfigured: this.oauth.configured, accounts };
  }

  // ─── Gmail OAuth ───────────────────────────────────────────────────────────

  async startGmailConnect(userId: string): Promise<{ url: string }> {
    if (!this.oauth.configured) throw new DomainError('Gmail OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI (see README).', 400);
    const state = randomToken(24);
    await this.redis.client.set(`oauth:state:${state}`, userId, 'EX', STATE_TTL_SECONDS);
    return { url: this.oauth.authUrl(state) };
  }

  /** OAuth callback: validates state (CSRF), exchanges the code, stores encrypted tokens. */
  async completeGmailConnect(userId: string, code: string, state: string): Promise<EmailAccount> {
    const owner = await this.redis.client.getdel(`oauth:state:${state}`);
    if (!owner || owner !== userId) throw new DomainError('OAuth state is invalid or expired. Please try connecting again.', 400);
    const tokens = await this.oauth.exchangeCode(code);
    const email = await this.oauth.profileEmail(tokens.accessToken);
    const existing = await this.prisma.emailAccount.findUnique({ where: { userId_provider_email: { userId, provider: 'GMAIL', email } } });
    if (!tokens.refreshToken && !existing?.refreshTokenEnc) {
      throw new DomainError('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.', 400);
    }
    const account = await this.prisma.emailAccount.upsert({
      where: { userId_provider_email: { userId, provider: 'GMAIL', email } },
      create: {
        userId,
        provider: 'GMAIL',
        email,
        accessTokenEnc: this.enc.encrypt(tokens.accessToken),
        refreshTokenEnc: tokens.refreshToken ? this.enc.encrypt(tokens.refreshToken) : null,
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scope,
        status: 'CONNECTED',
      },
      update: {
        accessTokenEnc: this.enc.encrypt(tokens.accessToken),
        ...(tokens.refreshToken ? { refreshTokenEnc: this.enc.encrypt(tokens.refreshToken) } : {}),
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scope,
        status: 'CONNECTED',
        lastError: null,
      },
    });
    await this.audit.log('email_account.connected', { userId, entityType: 'email_account', entityId: account.id, metadata: { provider: 'GMAIL', email } });
    return account;
  }

  async disconnect(userId: string, accountId: string): Promise<void> {
    const account = await this.prisma.emailAccount.findFirst({ where: { id: accountId, userId } });
    if (!account) throw new NotFoundException('Account not found');
    if (account.provider === 'GMAIL' && account.refreshTokenEnc) {
      await this.oauth.revoke(this.enc.decrypt(account.refreshTokenEnc)).catch(() => undefined);
    }
    await this.prisma.emailAccount.update({ where: { id: accountId }, data: { status: 'REVOKED', accessTokenEnc: null, refreshTokenEnc: null, tokenExpiresAt: null } });
    await this.audit.log('email_account.disconnected', { userId, entityType: 'email_account', entityId: accountId });
  }

  // ─── Mailbox access ────────────────────────────────────────────────────────

  /** The account used for sending in the current mode (sandbox account auto-created). */
  async sendingAccount(userId: string): Promise<EmailAccount> {
    if (this.mode === 'sandbox') {
      return this.prisma.emailAccount.upsert({
        where: { userId_provider_email: { userId, provider: 'SANDBOX', email: SANDBOX_ADDRESS } },
        create: { userId, provider: 'SANDBOX', email: SANDBOX_ADDRESS, status: 'CONNECTED' },
        update: {},
      });
    }
    const account = await this.prisma.emailAccount.findFirst({ where: { userId, provider: 'GMAIL', status: 'CONNECTED' }, orderBy: { updatedAt: 'desc' } });
    if (!account) throw new DomainError('Connect your Gmail account in Settings before sending.', 400);
    return account;
  }

  mailbox(account: EmailAccount): MailboxContext {
    return {
      accountId: account.id,
      email: account.email,
      getAccessToken: () => this.accessToken(account.id),
    };
  }

  /** Decrypts the access token, refreshing (and persisting) it when about to expire. */
  private async accessToken(accountId: string): Promise<string> {
    const account = await this.prisma.emailAccount.findUniqueOrThrow({ where: { id: accountId } });
    if (account.provider === 'SANDBOX') return 'sandbox';
    if (account.status !== 'CONNECTED') throw new EmailProviderError('Gmail is disconnected — reconnect in Settings', false, true);
    if (account.accessTokenEnc && account.tokenExpiresAt && account.tokenExpiresAt.getTime() - Date.now() > 60_000) {
      return this.enc.decrypt(account.accessTokenEnc);
    }
    if (!account.refreshTokenEnc) throw new EmailProviderError('No refresh token — reconnect Gmail', false, true);
    const release = await this.redis.acquireLock(`token-refresh:${accountId}`, 20_000);
    try {
      if (!release) {
        await new Promise((r) => setTimeout(r, 1500));
        const again = await this.prisma.emailAccount.findUniqueOrThrow({ where: { id: accountId } });
        if (again.accessTokenEnc && again.tokenExpiresAt && again.tokenExpiresAt.getTime() - Date.now() > 60_000) return this.enc.decrypt(again.accessTokenEnc);
      }
      const tokens = await this.oauth.refresh(this.enc.decrypt(account.refreshTokenEnc));
      await this.prisma.emailAccount.update({
        where: { id: accountId },
        data: {
          accessTokenEnc: this.enc.encrypt(tokens.accessToken),
          tokenExpiresAt: tokens.expiresAt,
          ...(tokens.refreshToken ? { refreshTokenEnc: this.enc.encrypt(tokens.refreshToken) } : {}),
        },
      });
      return tokens.accessToken;
    } catch (e) {
      if (e instanceof EmailProviderError && e.authError) {
        await this.prisma.emailAccount.update({ where: { id: accountId }, data: { status: 'ERROR', lastError: 'Authorization revoked or expired — reconnect Gmail' } });
        await this.metrics.record('gmail.failure', { reason: 'auth' });
      }
      throw e;
    } finally {
      await release?.();
    }
  }
}
