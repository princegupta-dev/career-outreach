export type HandoffReason = 'login' | 'captcha' | 'answers' | 'form' | 'destination';
export interface HandoffRequest { reason: HandoffReason; message: string; url: string }
export interface HandoffState extends HandoffRequest { token: string; jobId: string }
export type HandoffAction = 'resume' | 'skip';

/** Display a destination without account redirect tokens or other query-string data. */
export function displayLocation(value: string) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return ''; }
}
