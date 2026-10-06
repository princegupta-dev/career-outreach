import type { EmailProviderKind } from '@prisma/client';

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

/** Credentials handle passed to providers. Tokens are resolved lazily (and refreshed) by the caller. */
export interface MailboxContext {
  accountId: string;
  email: string;
  getAccessToken(): Promise<string>;
}

export interface OutgoingEmail {
  fromName: string;
  to: string;
  toName?: string;
  subject: string;
  text: string;
  /** Our deterministic Message-ID — the idempotency key for sends. */
  messageIdHeader: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
}

export interface SentRef {
  messageId: string;
  threadId: string;
}

export interface MessageMeta {
  id: string;
  threadId: string;
  from: string;
  to?: string;
  subject: string;
  snippet: string;
  date: Date;
  headers: Record<string, string>;
}

export interface DraftRef {
  draftId: string;
  messageId: string;
  threadId?: string | null;
}

export interface EmailProvider {
  readonly kind: EmailProviderKind;
  send(mailbox: MailboxContext, msg: OutgoingEmail): Promise<SentRef>;
  /** Save a draft in the mailbox (optional review in the mail client). */
  createDraft(mailbox: MailboxContext, msg: OutgoingEmail): Promise<{ draftId: string }>;
  /** Create or replace the draft that mirrors an outreach email. */
  upsertDraft(mailbox: MailboxContext, msg: OutgoingEmail, existingDraftId?: string | null): Promise<DraftRef>;
  /** Send an existing draft. Throws EmailProviderError (404) if the draft no longer exists. */
  sendDraft(mailbox: MailboxContext, draftId: string): Promise<SentRef>;
  /** Label ids of a message (null if it doesn't exist). Used to detect drafts sent from the mail client. */
  getMessageState(mailbox: MailboxContext, messageId: string): Promise<{ labelIds: string[]; threadId: string } | null>;
  deleteDraft(mailbox: MailboxContext, draftId: string): Promise<void>;
  /** Idempotency check: was a message with this Message-ID already sent? */
  findByMessageIdHeader(mailbox: MailboxContext, messageIdHeader: string): Promise<SentRef | null>;
  getThread(mailbox: MailboxContext, threadId: string): Promise<MessageMeta[]>;
  /** Messages from an address since a date (replies that started a new thread). */
  searchFrom(mailbox: MailboxContext, fromEmail: string, since: Date): Promise<MessageMeta[]>;
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly authError = false,
    public readonly status?: number,
  ) {
    super(message);
  }
}
