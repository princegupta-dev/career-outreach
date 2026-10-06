import { buildMime, toBase64Url } from '../../domain/email/mime';
import { DraftRef, EmailProvider, EmailProviderError, MailboxContext, MessageMeta, OutgoingEmail, SentRef } from './email-provider.interface';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const META_HEADERS = ['From', 'To', 'Subject', 'Date', 'Message-ID', 'Auto-Submitted', 'X-Autoreply', 'X-Autorespond', 'Precedence', 'Content-Type'];

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose', // create drafts + send
  'https://www.googleapis.com/auth/gmail.readonly', // read outreach threads for reply detection
  'openid',
  'email',
];

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

/** Gmail REST client (no SDK needed). Token refresh is handled by MailboxContext. */
export class GmailProvider implements EmailProvider {
  readonly kind = 'GMAIL' as const;

  private async request<T>(mailbox: MailboxContext, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await mailbox.getAccessToken();
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method: init.method ?? 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new EmailProviderError(`Gmail network error: ${(e as Error).message}`, true);
    }
    if (res.status === 204) return undefined as T;
    if (res.ok) return (await res.json()) as T;
    const detail = await res.text().catch(() => '');
    const short = detail.slice(0, 300);
    if (res.status === 401) throw new EmailProviderError('Gmail authorization expired or was revoked — reconnect Gmail', false, true);
    if (res.status === 403 && /insufficient/i.test(detail)) throw new EmailProviderError('Gmail permission missing — reconnect Gmail and grant access', false, true);
    if (res.status === 429 || res.status >= 500) throw new EmailProviderError(`Gmail temporary error ${res.status}`, true, false, res.status);
    throw new EmailProviderError(`Gmail error ${res.status}: ${short}`, false, false, res.status);
  }

  private raw(mailbox: MailboxContext, msg: OutgoingEmail): string {
    return toBase64Url(
      buildMime({
        from: mailbox.email,
        fromName: msg.fromName,
        to: msg.to,
        toName: msg.toName,
        subject: msg.subject,
        text: msg.text,
        messageId: msg.messageIdHeader,
        inReplyTo: msg.inReplyTo ?? undefined,
        references: msg.references,
        attachments: msg.attachments,
      }),
    );
  }

  async send(mailbox: MailboxContext, msg: OutgoingEmail): Promise<SentRef> {
    const r = await this.request<{ id: string; threadId: string }>(mailbox, '/messages/send', {
      method: 'POST',
      body: { raw: this.raw(mailbox, msg), ...(msg.threadId ? { threadId: msg.threadId } : {}) },
    });
    return { messageId: r.id, threadId: r.threadId };
  }

  async createDraft(mailbox: MailboxContext, msg: OutgoingEmail): Promise<{ draftId: string }> {
    const r = await this.request<{ id: string }>(mailbox, '/drafts', {
      method: 'POST',
      body: { message: { raw: this.raw(mailbox, msg), ...(msg.threadId ? { threadId: msg.threadId } : {}) } },
    });
    return { draftId: r.id };
  }

  async upsertDraft(mailbox: MailboxContext, msg: OutgoingEmail, existingDraftId?: string | null): Promise<DraftRef> {
    const message = { raw: this.raw(mailbox, msg), ...(msg.threadId ? { threadId: msg.threadId } : {}) };
    type DraftRes = { id: string; message: { id: string; threadId?: string } };
    let r: DraftRes;
    if (existingDraftId) {
      try {
        r = await this.request<DraftRes>(mailbox, `/drafts/${encodeURIComponent(existingDraftId)}`, { method: 'PUT', body: { id: existingDraftId, message } });
      } catch (e) {
        // Draft deleted (or already sent) in Gmail → create a fresh one.
        if (!(e instanceof EmailProviderError) || (e.status !== 404 && e.status !== 400)) throw e;
        r = await this.request<DraftRes>(mailbox, '/drafts', { method: 'POST', body: { message } });
      }
    } else {
      r = await this.request<DraftRes>(mailbox, '/drafts', { method: 'POST', body: { message } });
    }
    return { draftId: r.id, messageId: r.message.id, threadId: r.message.threadId ?? null };
  }

  async sendDraft(mailbox: MailboxContext, draftId: string): Promise<SentRef> {
    const r = await this.request<{ id: string; threadId: string }>(mailbox, '/drafts/send', { method: 'POST', body: { id: draftId } });
    return { messageId: r.id, threadId: r.threadId };
  }

  async getMessageState(mailbox: MailboxContext, messageId: string): Promise<{ labelIds: string[]; threadId: string } | null> {
    try {
      const r = await this.request<{ labelIds?: string[]; threadId: string }>(mailbox, `/messages/${encodeURIComponent(messageId)}?format=minimal`);
      return { labelIds: r.labelIds ?? [], threadId: r.threadId };
    } catch (e) {
      if (e instanceof EmailProviderError && e.status === 404) return null;
      throw e;
    }
  }

  async deleteDraft(mailbox: MailboxContext, draftId: string): Promise<void> {
    try {
      await this.request(mailbox, `/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
    } catch (e) {
      if (!(e instanceof EmailProviderError) || e.status !== 404) throw e;
    }
  }

  async findByMessageIdHeader(mailbox: MailboxContext, messageIdHeader: string): Promise<SentRef | null> {
    const q = encodeURIComponent(`rfc822msgid:${messageIdHeader.replace(/[<>]/g, '')}`);
    const r = await this.request<{ messages?: Array<{ id: string; threadId: string }> }>(mailbox, `/messages?q=${q}&includeSpamTrash=true&maxResults=1`);
    const m = r.messages?.[0];
    return m ? { messageId: m.id, threadId: m.threadId } : null;
  }

  private toMeta(m: GmailMessage): MessageMeta {
    const headers: Record<string, string> = {};
    for (const h of m.payload?.headers ?? []) headers[h.name] = h.value;
    const get = (n: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1] ?? '';
    return {
      id: m.id,
      threadId: m.threadId,
      from: get('From'),
      to: get('To'),
      subject: get('Subject'),
      snippet: (m.snippet ?? '').slice(0, 200),
      date: m.internalDate ? new Date(Number(m.internalDate)) : new Date(get('Date') || Date.now()),
      headers,
    };
  }

  private metaQuery(): string {
    return `format=metadata&${META_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join('&')}`;
  }

  async getThread(mailbox: MailboxContext, threadId: string): Promise<MessageMeta[]> {
    const r = await this.request<{ messages?: GmailMessage[] }>(mailbox, `/threads/${encodeURIComponent(threadId)}?${this.metaQuery()}`);
    return (r.messages ?? []).map((m) => this.toMeta(m));
  }

  async searchFrom(mailbox: MailboxContext, fromEmail: string, since: Date): Promise<MessageMeta[]> {
    const q = encodeURIComponent(`from:${fromEmail} after:${Math.floor(since.getTime() / 1000)}`);
    const list = await this.request<{ messages?: Array<{ id: string }> }>(mailbox, `/messages?q=${q}&maxResults=10`);
    const out: MessageMeta[] = [];
    for (const { id } of list.messages ?? []) {
      out.push(this.toMeta(await this.request<GmailMessage>(mailbox, `/messages/${id}?${this.metaQuery()}`)));
    }
    return out;
  }
}

// ─── OAuth 2.0 (authorization code + PKCE-less server flow with state) ───────

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
}

export class GmailOAuth {
  constructor(
    private readonly clientId?: string,
    private readonly clientSecret?: string,
    private readonly redirectUri?: string,
  ) {}

  get configured(): boolean {
    return !!(this.clientId && this.clientSecret && this.redirectUri);
  }

  authUrl(state: string, loginHint?: string): string {
    if (!this.configured) throw new EmailProviderError('Gmail OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)', false);
    const p = new URLSearchParams({
      client_id: this.clientId!,
      redirect_uri: this.redirectUri!,
      response_type: 'code',
      scope: GMAIL_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      ...(loginHint ? { login_hint: loginHint } : {}),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }

  private async token(body: Record<string, string>): Promise<GoogleTokens> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId!, client_secret: this.clientSecret!, ...body }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
    if (!res.ok || !json.access_token) {
      const authErr = json.error === 'invalid_grant';
      throw new EmailProviderError(`Google token request failed${json.error ? ` (${json.error})` : ''}`, !authErr && res.status >= 500, authErr);
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
      scope: json.scope ?? '',
    };
  }

  exchangeCode(code: string): Promise<GoogleTokens> {
    return this.token({ code, redirect_uri: this.redirectUri!, grant_type: 'authorization_code' });
  }

  refresh(refreshToken: string): Promise<GoogleTokens> {
    return this.token({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  }

  async revoke(token: string): Promise<void> {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  }

  async profileEmail(accessToken: string): Promise<string> {
    const res = await fetch(`${API}/profile`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new EmailProviderError(`Could not read Gmail profile (${res.status})`, false, res.status === 401);
    const json = (await res.json()) as { emailAddress: string };
    return json.emailAddress.toLowerCase();
  }
}
