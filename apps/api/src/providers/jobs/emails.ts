/**
 * Emails written in a job description ("send your CV to hr@acme.in"). Only what is published is returned:
 * nothing is guessed or built from a name. Placeholders, no-reply and image-like strings are dropped.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const JUNK = /^(no-?reply|noreply|donotreply|example|test|user|name|email|your\.?name|you)@|@(example|test|domain|email)\.(com|org|in)$|\.(png|jpe?g|gif|svg|webp)$/i;

export function extractEmails(text: string): string[] {
  const found = (text.match(EMAIL) ?? []).map((e) => e.replace(/[.,;:]+$/, '').toLowerCase());
  return [...new Set(found)].filter((e) => !JUNK.test(e));
}
