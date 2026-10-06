import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma.service';
import { buildMessageId } from '../../src/domain/email/mime';
import { EmailAccountsService } from '../../src/modules/email/email-accounts.service';
import { EmailSyncService } from '../../src/modules/email/email-sync.service';
import { EmailProviderError, MailboxContext } from '../../src/providers/email/email-provider.interface';
import { GmailProvider } from '../../src/providers/email/gmail.provider';
import { createContext, createUser, flushRedis, resetDatabase } from '../setup/helpers';

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;

function mockFetch(handler: Handler) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const r = handler(url, init);
    if (!r) throw new Error(`Unexpected fetch ${url}`);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}

const mailbox: MailboxContext = { accountId: 'acc', email: 'prince@gmail.com', getAccessToken: async () => 'access-token' };

describe('Gmail provider (REST abstraction)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends a threaded MIME message with attachment and our Message-ID', async () => {
    let sentBody: { raw: string; threadId?: string } | null = null;
    let auth = '';
    mockFetch((url, init) => {
      if (url.endsWith('/messages/send')) {
        sentBody = JSON.parse(String(init!.body));
        auth = (init!.headers as Record<string, string>).Authorization;
        return { body: { id: 'm1', threadId: 't1' } };
      }
      return undefined;
    });
    const res = await new GmailProvider().send(mailbox, {
      fromName: 'Prince Gupta',
      to: 'sarah@acme.com',
      toName: 'Sarah Lee',
      subject: 'Re: Senior Backend Engineer',
      text: 'Hi Sarah',
      messageIdHeader: buildMessageId('abc', 'gmail.com'),
      threadId: 't1',
      inReplyTo: '<root@gmail.com>',
      references: ['<root@gmail.com>'],
      attachments: [{ filename: 'resume.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') }],
    });
    expect(res).toEqual({ messageId: 'm1', threadId: 't1' });
    expect(auth).toBe('Bearer access-token');
    expect(sentBody!.threadId).toBe('t1');
    const mime = Buffer.from(sentBody!.raw, 'base64url').toString('utf8');
    expect(mime).toContain('From: "Prince Gupta" <prince@gmail.com>');
    expect(mime).toContain('Message-ID: <jh-abc@gmail.com>');
    expect(mime).toContain('In-Reply-To: <root@gmail.com>');
    expect(mime).toContain('filename="resume.pdf"');
  });

  it('finds an already-sent message by Message-ID (idempotency check)', async () => {
    let query = '';
    mockFetch((url) => {
      if (url.includes('/messages?q=')) {
        query = decodeURIComponent(url.split('q=')[1].split('&')[0]);
        return { body: { messages: [{ id: 'm9', threadId: 't9' }] } };
      }
      return undefined;
    });
    expect(await new GmailProvider().findByMessageIdHeader(mailbox, '<jh-abc@gmail.com>')).toEqual({ messageId: 'm9', threadId: 't9' });
    expect(query).toBe('rfc822msgid:jh-abc@gmail.com');
  });

  it('reads thread metadata and maps auth errors', async () => {
    mockFetch((url) => {
      if (url.includes('/threads/t1')) {
        return {
          body: {
            messages: [
              { id: 'm1', threadId: 't1', internalDate: '1759730000000', snippet: 'Hi', payload: { headers: [{ name: 'From', value: 'Prince <prince@gmail.com>' }, { name: 'Subject', value: 'Role' }] } },
              { id: 'm2', threadId: 't1', internalDate: '1759740000000', snippet: 'Thanks Prince, lets chat', payload: { headers: [{ name: 'From', value: 'Sarah <sarah@acme.com>' }, { name: 'Subject', value: 'Re: Role' }] } },
            ],
          },
        };
      }
      if (url.includes('/threads/bad')) return { status: 401, body: { error: 'unauthorized' } };
      return undefined;
    });
    const gmail = new GmailProvider();
    const msgs = await gmail.getThread(mailbox, 't1');
    expect(msgs[1]).toMatchObject({ id: 'm2', from: 'Sarah <sarah@acme.com>', subject: 'Re: Role' });
    await expect(gmail.getThread(mailbox, 'bad')).rejects.toMatchObject({ authError: true, retryable: false });
  });

  it('treats 429/5xx as retryable', async () => {
    mockFetch(() => ({ status: 503, body: {} }));
    const err = await new GmailProvider().getThread(mailbox, 't1').catch((e) => e);
    expect(err).toBeInstanceOf(EmailProviderError);
    expect(err.retryable).toBe(true);
  });
});

describe('Gmail OAuth + token storage + reply sync', () => {
  let ctx: INestApplicationContext;
  let prisma: PrismaService;
  let accounts: EmailAccountsService;
  let userId: string;

  beforeAll(async () => {
    ctx = await createContext();
    prisma = ctx.get(PrismaService);
    accounts = ctx.get(EmailAccountsService);
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await flushRedis();
    userId = (await createUser(prisma)).id;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => ctx.close());

  async function connect(): Promise<string> {
    const { url } = await accounts.startGmailConnect(userId);
    const state = new URL(url).searchParams.get('state')!;
    expect(new URL(url).searchParams.get('scope')).toContain('gmail.compose');
    expect(new URL(url).searchParams.get('access_type')).toBe('offline');
    mockFetch((u) => {
      if (u.startsWith('https://oauth2.googleapis.com/token')) return { body: { access_token: 'plain-access-token', refresh_token: 'plain-refresh-token', expires_in: 3600, scope: 'gmail.compose gmail.readonly' } };
      if (u.endsWith('/profile')) return { body: { emailAddress: 'Prince@Gmail.com' } };
      return undefined;
    });
    const account = await accounts.completeGmailConnect(userId, 'auth-code', state);
    jest.restoreAllMocks();
    return account.id;
  }

  it('rejects unknown or reused OAuth state (CSRF protection)', async () => {
    await expect(accounts.completeGmailConnect(userId, 'code', 'forged-state')).rejects.toThrow(/state/);
    const { url } = await accounts.startGmailConnect(userId);
    const state = new URL(url).searchParams.get('state')!;
    const other = await createUser(prisma);
    await expect(accounts.completeGmailConnect(other.id, 'code', state)).rejects.toThrow(/state/);
  });

  it('stores tokens encrypted (never plaintext) and refreshes expired tokens', async () => {
    const id = await connect();
    const row = await prisma.emailAccount.findUniqueOrThrow({ where: { id } });
    expect(row.email).toBe('prince@gmail.com');
    expect(row.accessTokenEnc).not.toContain('plain-access-token');
    expect(row.refreshTokenEnc).not.toContain('plain-refresh-token');
    expect(row.accessTokenEnc!.startsWith('v1.')).toBe(true);

    expect(await accounts.mailbox(row).getAccessToken()).toBe('plain-access-token');

    await prisma.emailAccount.update({ where: { id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    let refreshCalls = 0;
    mockFetch((u, init) => {
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        refreshCalls++;
        expect(String(init!.body)).toContain('grant_type=refresh_token');
        return { body: { access_token: 'new-access-token', expires_in: 3600 } };
      }
      return undefined;
    });
    const fresh = await prisma.emailAccount.findUniqueOrThrow({ where: { id } });
    expect(await accounts.mailbox(fresh).getAccessToken()).toBe('new-access-token');
    expect(refreshCalls).toBe(1);
    const updated = await prisma.emailAccount.findUniqueOrThrow({ where: { id } });
    expect(updated.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('marks the account as errored when Google revokes the refresh token', async () => {
    const id = await connect();
    await prisma.emailAccount.update({ where: { id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    mockFetch((u) => (u.startsWith('https://oauth2.googleapis.com/token') ? { status: 400, body: { error: 'invalid_grant' } } : undefined));
    const row = await prisma.emailAccount.findUniqueOrThrow({ where: { id } });
    await expect(accounts.mailbox(row).getAccessToken()).rejects.toMatchObject({ authError: true });
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id } })).status).toBe('ERROR');
  });

  it('detects a Gmail reply and cancels all pending follow-ups', async () => {
    const id = await connect();
    const company = await prisma.company.create({ data: { userId, name: 'Acme', normalizedName: 'acme' } });
    const job = await prisma.job.create({ data: { userId, companyId: company.id, provider: 'MANUAL', title: 'Senior Backend Engineer', description: 'x'.repeat(60), contentHash: 'h1' } });
    const app = await prisma.application.create({ data: { userId, jobId: job.id, status: 'FOLLOWUP_SCHEDULED' } });
    const contact = await prisma.contact.create({ data: { userId, companyId: company.id, name: 'Sarah', email: 'sarah@acme.com', emailNormalized: 'sarah@acme.com', source: 'manual' } });
    const root = await prisma.outreach.create({
      data: { userId, applicationId: app.id, contactId: contact.id, emailAccountId: id, kind: 'INITIAL', toEmail: 'sarah@acme.com', subject: 'Role', body: 'Hi', status: 'SENT', threadState: 'WAITING_FOR_REPLY', messageIdHeader: '<jh-root@gmail.com>', gmailMessageId: 'm1', gmailThreadId: 't1', sentAt: new Date(Date.now() - 86_400_000) },
    });
    await prisma.followup.createMany({ data: [1, 2, 3].map((s) => ({ userId, rootId: root.id, sequence: s, scheduledAt: new Date(Date.now() + s * 86_400_000) })) });

    mockFetch((u) => {
      if (u.includes('/threads/t1'))
        return {
          body: {
            messages: [
              { id: 'm1', threadId: 't1', internalDate: String(Date.now() - 86_400_000), snippet: 'Hi', payload: { headers: [{ name: 'From', value: 'prince@gmail.com' }] } },
              { id: 'm2', threadId: 't1', internalDate: String(Date.now() - 3600_000), snippet: "Thanks Prince — let's schedule a call", payload: { headers: [{ name: 'From', value: 'Sarah <sarah@acme.com>' }, { name: 'Subject', value: 'Re: Role' }] } },
            ],
          },
        };
      if (u.includes('/messages?q=')) return { body: {} };
      return undefined;
    });
    const result = await ctx.get(EmailSyncService).syncUser(userId);
    expect(result.replies).toBe(1);
    const after = await prisma.outreach.findUniqueOrThrow({ where: { id: root.id } });
    expect(after.threadState).toBe('REPLIED');
    const fus = await prisma.followup.findMany({ where: { rootId: root.id } });
    expect(fus.every((f) => f.status === 'CANCELLED')).toBe(true);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe('REPLIED');
    // Idempotent: syncing again records nothing new.
    await ctx.get(EmailSyncService).syncUser(userId);
    expect(await prisma.emailEvent.count({ where: { type: 'REPLY_RECEIVED' } })).toBe(1);
  });
});
