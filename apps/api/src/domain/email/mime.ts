import { randomBytes } from 'crypto';

export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MimeMessage {
  from: string;
  fromName?: string;
  to: string;
  toName?: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: MimeAttachment[];
  date?: Date;
}

/** RFC 2047 encode a header value if it is not plain ASCII. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function address(email: string, name?: string): string {
  const e = sanitizeHeader(email);
  if (!name) return e;
  const n = sanitizeHeader(name).replace(/"/g, "'");
  return `${encodeHeader(n) === n ? `"${n}"` : encodeHeader(n)} <${e}>`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

/** Deterministic Message-ID for an outreach row (idempotency across retries). */
export function buildMessageId(outreachId: string, domain: string): string {
  return `<jh-${outreachId}@${domain || 'job-hunter.local'}>`;
}

/** Build an RFC 5322 message (multipart/mixed when attachments exist). */
export function buildMime(msg: MimeMessage): string {
  const headers = [
    `From: ${address(msg.from, msg.fromName)}`,
    `To: ${address(msg.to, msg.toName)}`,
    `Subject: ${encodeHeader(sanitizeHeader(msg.subject))}`,
    `Message-ID: ${sanitizeHeader(msg.messageId)}`,
    `Date: ${(msg.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeader(msg.inReplyTo)}`);
  if (msg.references?.length) headers.push(`References: ${msg.references.map(sanitizeHeader).join(' ')}`);

  const textPart = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(msg.text, 'utf8').toString('base64'))].join('\r\n');

  if (!msg.attachments?.length) {
    return [...headers, textPart].join('\r\n');
  }
  const boundary = `jh_${randomBytes(12).toString('hex')}`;
  const parts = [`--${boundary}\r\n${textPart}`];
  for (const a of msg.attachments) {
    const fname = sanitizeHeader(a.filename).replace(/"/g, '');
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${a.contentType}; name="${fname}"`,
        `Content-Disposition: attachment; filename="${fname}"`,
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(a.content.toString('base64')),
      ].join('\r\n'),
    );
  }
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', parts.join('\r\n'), `--${boundary}--`, ''].join('\r\n');
}

export function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** Quote the previous message below a follow-up (plain-text reply style). */
export function quotePrevious(body: string, prevBody: string, prevDate: Date, prevFrom: string): string {
  const quoted = prevBody
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return `${body}\n\nOn ${prevDate.toUTCString()}, ${prevFrom} wrote:\n${quoted}`;
}
