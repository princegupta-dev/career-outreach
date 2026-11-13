import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import nodemailer, { Transporter } from 'nodemailer';

/**
 * Sends the daily report to you through your own Gmail, using a Gmail App Password: a separate 16-character
 * password that can only be used for this and that you can revoke at any time (myaccount.google.com/apppasswords).
 * Settings live in ~/.job-hunter/mail.json, on your Mac only. Nothing is ever sent to anyone but `to`.
 */
export const mailFile = () => process.env.JOB_HUNTER_MAIL ?? path.join(os.homedir(), '.job-hunter', 'mail.json');

export interface MailSettings {
  user: string;
  appPassword: string;
  to: string;
}

export const MAIL_TEMPLATE: MailSettings = { user: 'pg150704@gmail.com', appPassword: '', to: 'pg150704@gmail.com' };

/** Your mail settings, or null (with the file created for you to fill in) when the App Password is not set yet. */
export function loadMail(file = mailFile()): MailSettings | null {
  let raw: Partial<MailSettings> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MailSettings>;
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(MAIL_TEMPLATE, null, 2), { mode: 0o600 });
    return null;
  }
  const s = { ...MAIL_TEMPLATE, ...raw };
  const password = s.appPassword.replace(/\s+/g, '');
  return s.user && s.to && password.length >= 16 ? { ...s, appPassword: password } : null;
}

export async function sendReport(opts: { subject: string; text: string; file: string; settings: MailSettings; transport?: Transporter }): Promise<string> {
  const t = opts.transport ?? nodemailer.createTransport({ service: 'gmail', auth: { user: opts.settings.user, pass: opts.settings.appPassword } });
  const info = await t.sendMail({
    from: `Job Hunter <${opts.settings.user}>`,
    to: opts.settings.to,
    subject: opts.subject,
    text: opts.text,
    attachments: [{ filename: path.basename(opts.file), path: opts.file }],
  });
  return String(info.messageId ?? '');
}
