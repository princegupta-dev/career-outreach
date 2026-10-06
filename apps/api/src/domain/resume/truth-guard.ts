import { findSkills } from '../skills/taxonomy';
import { BANNED_PHRASES } from '../email/voice';

export interface RewriteCheck {
  ok: boolean;
  reasons: string[];
}

const numbers = (s: string) => new Set(s.match(/\d+(?:[.,]\d+)?/g) ?? []);

/**
 * Guards an AI-rewritten resume bullet. A rewrite may rephrase and reorder words,
 * but may not introduce technologies, numbers/metrics or hype that were not in the
 * original bullet (or in the same role's technology list).
 */
export function checkBulletRewrite(original: string, rewritten: string, allowedSkills: string[]): RewriteCheck {
  const reasons: string[] = [];
  const origSkills = new Set(findSkills(original).keys());
  const allowed = new Set([...origSkills, ...allowedSkills]);
  const introduced = [...findSkills(rewritten).keys()].filter((s) => !allowed.has(s));
  if (introduced.length) reasons.push(`Introduces technologies not in the original: ${introduced.join(', ')}`);

  const origNums = numbers(original);
  const newNums = [...numbers(rewritten)].filter((n) => !origNums.has(n));
  if (newNums.length) reasons.push(`Introduces numbers/metrics not in the original: ${newNums.join(', ')}`);

  if (/%|\b\d+x\b/i.test(rewritten) && !/%|\b\d+x\b/i.test(original)) reasons.push('Introduces a metric');
  for (const [re, label] of BANNED_PHRASES) if (re.test(rewritten) && !re.test(original)) reasons.push(`Uses banned phrase "${label}"`);
  if (/\b(led|managed|owned|architected|spearheaded|headed)\b/i.test(rewritten) && !/\b(led|managed|owned|architected|spearheaded|headed)\b/i.test(original)) {
    reasons.push('Upgrades the level of responsibility (led/owned/architected)');
  }
  if (rewritten.length > original.length * 1.6 + 40) reasons.push('Rewrite is much longer than the original');
  if (!rewritten.trim()) reasons.push('Empty rewrite');
  return { ok: reasons.length === 0, reasons };
}
