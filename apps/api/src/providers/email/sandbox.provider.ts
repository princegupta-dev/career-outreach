import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { DraftRef, EmailProvider, EmailProviderError, MailboxContext, MessageMeta, OutgoingEmail, SentRef } from './email-provider.interface';

interface StoredMessage extends MessageMeta {
  messageIdHeader?: string;
  body?: string;
}

/**
 * Local sandbox mailbox stored in Redis. Nothing leaves your machine.
 * Lets you exercise the full send → reply → follow-up flow without Gmail,
 * and simulate replies from the UI (dev only).
 */
export class SandboxEmailProvider implements EmailProvider {
  readonly kind = 'SANDBOX' as const;

  constructor(private readonly redis: Redis) {}

  private key(mailbox: MailboxContext, suffix: string): string {
    return `sandbox:${mailbox.accountId}:${suffix}`;
  }

  private async save(mailbox: MailboxContext, m: StoredMessage): Promise<void> {
    await this.redis
      .multi()
      .hset(this.key(mailbox, 'messages'), m.id, JSON.stringify(m))
      .rpush(this.key(mailbox, `thread:${m.threadId}`), m.id)
      .exec();
    if (m.messageIdHeader) await this.redis.hset(this.key(mailbox, 'msgid'), m.messageIdHeader, JSON.stringify({ messageId: m.id, threadId: m.threadId }));
  }

  async send(mailbox: MailboxContext, msg: OutgoingEmail): Promise<SentRef> {
    const id = `sbx-${randomUUID()}`;
    const threadId = msg.threadId ?? `sbx-thread-${randomUUID()}`;
    await this.save(mailbox, {
      id,
      threadId,
      from: `${msg.fromName} <${mailbox.email}>`,
      to: msg.to,
      subject: msg.subject,
      snippet: msg.text.slice(0, 200),
      body: msg.text,
      date: new Date(),
      headers: { 'Message-ID': msg.messageIdHeader },
      messageIdHeader: msg.messageIdHeader,
    });
    return { messageId: id, threadId };
  }

  async createDraft(_mailbox: MailboxContext, _msg: OutgoingEmail): Promise<{ draftId: string }> {
    return { draftId: `sbx-draft-${randomUUID()}` };
  }

  async upsertDraft(mailbox: MailboxContext, msg: OutgoingEmail, existingDraftId?: string | null): Promise<DraftRef> {
    const key = this.key(mailbox, 'drafts');
    const existing = existingDraftId ? await this.redis.hget(key, existingDraftId) : null;
    const draftId = existing ? existingDraftId! : `sbx-draft-${randomUUID()}`;
    const messageId = existing ? (JSON.parse(existing) as { messageId: string }).messageId : `sbx-${randomUUID()}`;
    await this.redis.hset(key, draftId, JSON.stringify({ messageId, msg: { ...msg, attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content.length })) } }));
    return { draftId, messageId, threadId: msg.threadId ?? null };
  }

  async sendDraft(mailbox: MailboxContext, draftId: string): Promise<SentRef> {
    const key = this.key(mailbox, 'drafts');
    const raw = await this.redis.hget(key, draftId);
    if (!raw) throw new EmailProviderError('Draft not found', false, false, 404);
    const { messageId, msg } = JSON.parse(raw) as { messageId: string; msg: OutgoingEmail & { attachments: Array<{ filename: string }> } };
    const threadId = msg.threadId ?? `sbx-thread-${randomUUID()}`;
    await this.save(mailbox, {
      id: messageId,
      threadId,
      from: `${msg.fromName} <${mailbox.email}>`,
      to: msg.to,
      subject: msg.subject,
      snippet: msg.text.slice(0, 200),
      body: msg.text,
      date: new Date(),
      headers: { 'Message-ID': msg.messageIdHeader, 'X-Attachments': msg.attachments.map((a) => a.filename).join(',') },
      messageIdHeader: msg.messageIdHeader,
    });
    await this.redis.hdel(key, draftId);
    return { messageId, threadId };
  }

  async getMessageState(mailbox: MailboxContext, messageId: string): Promise<{ labelIds: string[]; threadId: string } | null> {
    const sent = await this.load(mailbox, messageId);
    if (sent) return { labelIds: ['SENT'], threadId: sent.threadId };
    const drafts = await this.redis.hvals(this.key(mailbox, 'drafts'));
    const d = drafts.map((x) => JSON.parse(x) as { messageId: string; msg: { threadId?: string } }).find((x) => x.messageId === messageId);
    return d ? { labelIds: ['DRAFT'], threadId: d.msg.threadId ?? '' } : null;
  }

  /** Dev/test helper: simulate the user clicking "Send" on the draft in their mail client. */
  async sendDraftFromClient(mailbox: MailboxContext, draftId: string): Promise<SentRef> {
    return this.sendDraft(mailbox, draftId);
  }

  async deleteDraft(mailbox: MailboxContext, draftId: string): Promise<void> {
    await this.redis.hdel(this.key(mailbox, 'drafts'), draftId);
  }

  /** Dev/test helper: list drafts (what would appear in Gmail Drafts). */
  async listDrafts(mailbox: MailboxContext): Promise<Array<{ draftId: string; messageId: string; to: string; subject: string; attachments: string[] }>> {
    const all = await this.redis.hgetall(this.key(mailbox, 'drafts'));
    return Object.entries(all).map(([draftId, v]) => {
      const d = JSON.parse(v) as { messageId: string; msg: { to: string; subject: string; attachments: Array<{ filename: string }> } };
      return { draftId, messageId: d.messageId, to: d.msg.to, subject: d.msg.subject, attachments: d.msg.attachments.map((a) => a.filename) };
    });
  }

  async findByMessageIdHeader(mailbox: MailboxContext, messageIdHeader: string): Promise<SentRef | null> {
    const v = await this.redis.hget(this.key(mailbox, 'msgid'), messageIdHeader);
    return v ? (JSON.parse(v) as SentRef) : null;
  }

  private async load(mailbox: MailboxContext, id: string): Promise<StoredMessage | null> {
    const v = await this.redis.hget(this.key(mailbox, 'messages'), id);
    if (!v) return null;
    const m = JSON.parse(v) as StoredMessage;
    return { ...m, date: new Date(m.date) };
  }

  async getThread(mailbox: MailboxContext, threadId: string): Promise<MessageMeta[]> {
    const ids = await this.redis.lrange(this.key(mailbox, `thread:${threadId}`), 0, -1);
    const msgs = await Promise.all(ids.map((id) => this.load(mailbox, id)));
    return msgs.filter((m): m is StoredMessage => !!m);
  }

  async searchFrom(mailbox: MailboxContext, fromEmail: string, since: Date): Promise<MessageMeta[]> {
    const all = await this.redis.hvals(this.key(mailbox, 'messages'));
    return all
      .map((v) => JSON.parse(v) as StoredMessage)
      .map((m) => ({ ...m, date: new Date(m.date) }))
      .filter((m) => m.from.toLowerCase().includes(fromEmail.toLowerCase()) && m.date >= since);
  }

  /** Dev helper: inject an inbound message into a thread. */
  async simulateInbound(
    mailbox: MailboxContext,
    args: { threadId: string; from: string; subject: string; body: string; headers?: Record<string, string> },
  ): Promise<MessageMeta> {
    const m: StoredMessage = {
      id: `sbx-${randomUUID()}`,
      threadId: args.threadId,
      from: args.from,
      to: mailbox.email,
      subject: args.subject,
      snippet: args.body.slice(0, 200),
      body: args.body,
      date: new Date(),
      headers: args.headers ?? {},
    };
    await this.save(mailbox, m);
    return m;
  }
}
