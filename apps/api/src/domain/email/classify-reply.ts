export type InboundKind = 'reply' | 'auto_reply' | 'bounce' | 'self';

export interface InboundMessage {
  from: string;
  subject: string;
  snippet: string;
  headers: Record<string, string>;
}

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (subsystem|system))/i;
const BOUNCE_SUBJECT = /(undeliverable|delivery status notification|mail delivery failed|returned mail|delivery (has )?failed|address not found)/i;
const AUTO_SUBJECT = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|on (annual )?leave|away from (my|the) (desk|office)|vacation)/i;

export function extractAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** Classify a message found in an outreach thread (or from the contact). */
export function classifyInbound(msg: InboundMessage, ownAddresses: string[]): InboundKind {
  const from = extractAddress(msg.from);
  if (ownAddresses.map((a) => a.toLowerCase()).includes(from)) return 'self';
  const h = Object.fromEntries(Object.entries(msg.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (BOUNCE_FROM.test(msg.from) || BOUNCE_SUBJECT.test(msg.subject) || (h['content-type'] ?? '').includes('report-type=delivery-status')) return 'bounce';
  const autoSubmitted = (h['auto-submitted'] ?? '').toLowerCase();
  if (
    (autoSubmitted && autoSubmitted !== 'no') ||
    h['x-autoreply'] ||
    h['x-autorespond'] ||
    (h['precedence'] ?? '').toLowerCase() === 'auto_reply' ||
    AUTO_SUBJECT.test(msg.subject)
  )
    return 'auto_reply';
  return 'reply';
}

/** Lightweight sentiment for analytics. Users can override in the UI. */
export function replySentiment(snippet: string): 'positive' | 'negative' | 'neutral' {
  const s = snippet.toLowerCase();
  if (/(not (a )?(good )?fit|decided to (move|go) forward with other|no longer (open|hiring)|position (has been )?filled|unfortunately|not moving forward|won't be moving|not interested)/.test(s)) return 'negative';
  if (/(let'?s (chat|talk|connect|schedule)|schedule (a )?(call|chat|time)|calendly|available (for|to)|interview|next steps?|would love to|happy to (chat|talk|connect)|share (your|some) availability|set up (a )?(call|time))/.test(s)) return 'positive';
  return 'neutral';
}

/** Recipient asked not to be contacted again → suppress. */
export function isUnsubscribeRequest(snippet: string): boolean {
  return /(unsubscribe|remove me|stop (emailing|contacting)|don'?t (email|contact) me|do not (email|contact) me|please stop)/i.test(snippet);
}
