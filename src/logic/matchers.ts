/** Detecteurs d'automod, purs (chaine -> hits). L'action et l'etat vivent dans le module. */
import type { } from 'node:url';

export type RuleKind = 'invite' | 'webhook' | 'token' | 'mass_mention' | 'everyone_ping' | 'caps' | 'flood' | 'duplicate' | 'unicode_spam' | 'link' | 'zalgo';

export interface Hit { kind: RuleKind; detail: string; delete: boolean; score: number }
export interface ScanOpts {
  /** Salon ou les invitations sont autorisees (💌│・Invitations). */
  inviteAllowed: boolean;
  /** ID du serveur courant : un lien d'invite vers nous n'est pas de la pub. */
  guildId: string;
  vanityCode?: string | null;
  /** Codes d'invite crees par le serveur (les notres). */
  ownCodes?: string[];
  maxMentions?: number;
  allowLinks?: boolean;
  capsMinLength?: number;
}

const INVITE_RE = /(?:https?:\/\/)?(?:\w+\.)?(?:discord|discordapp)\.(?:gg|com|me)\/(?:invite\/)?([a-zA-Z0-9-]{2,32})/gi;
const WEBHOOK_RE = /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/gi;
const TOKEN_RE = /[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,39}/g;
const URL_RE = /https?:\/\/[^\s<]+/gi;

export function scan(text: string, o: ScanOpts): Hit[] {
  const out: Hit[] = [];
  if (!text) return out;

  const own = new Set((o.ownCodes ?? []).map((c) => c.toLowerCase()));
  if (o.vanityCode) own.add(o.vanityCode.toLowerCase());
  for (const m of text.matchAll(INVITE_RE)) {
    const code = (m[1] ?? '').toLowerCase();
    if (own.has(code) || code === o.guildId.toLowerCase()) continue;
    if (o.inviteAllowed) continue;
    out.push({ kind: 'invite', detail: `invitation ${code ? `«${code}»` : 'étrangère'} hors de 💌│・Invitations`, delete: true, score: 3 });
    break;
  }

  if (WEBHOOK_RE.test(text)) { WEBHOOK_RE.lastIndex = 0; out.push({ kind: 'webhook', detail: 'URL de webhook collée (vol ou pub)', delete: true, score: 4 }); } else WEBHOOK_RE.lastIndex = 0;

  TOKEN_RE.lastIndex = 0;
  if (TOKEN_RE.test(text)) { TOKEN_RE.lastIndex = 0; out.push({ kind: 'token', detail: 'segment type jeton Discord', delete: true, score: 4 }); } else TOKEN_RE.lastIndex = 0;

  if (/(?:^|\s)@(?:everyone|here)\b|(?:<@\|?(?:everyone|here)>)/i.test(text)) out.push({ kind: 'everyone_ping', detail: '@everyone / @here par un non-Admin', delete: true, score: 3 });

  const roleMentions = (text.match(/<@&\d+>/g) ?? []).length;
  const userMentions = (text.match(/<@!?\d+>/g) ?? []).length;
  const max = o.maxMentions ?? 5;
  if (roleMentions + userMentions >= max) out.push({ kind: 'mass_mention', detail: `${roleMentions} rôle(s) + ${userMentions} membre(s) pingués`, delete: true, score: 3 });

  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length >= (o.capsMinLength ?? 14)) {
    const up = [...letters].filter((ch) => ch === ch.toUpperCase() && /[A-ZÀ-Þ]/.test(ch)).length;
    if (up / letters.length >= 0.72) out.push({ kind: 'caps', detail: `${Math.round((up / letters.length) * 100)} % de majuscules`, delete: true, score: 1 });
  }

  if (/(.)\1{7,}/u.test(text)) out.push({ kind: 'unicode_spam', detail: 'caractère répété ×8', delete: true, score: 1 });
  // Un « à͇͖͎̜̻͉͍̥͉ » reel etale 2-4 marques par lettre : on compte la densite, pas une serie.
  const marks = (text.match(/[\u0300-\u036f\u0489\u0591-\u05bd\u0610-\u061a\u1ab0-\u1aff\u20d0-\u20f0\ufe20-\ufe2f]/g) ?? []).length;
  const codes = [...text].length;
  if (marks >= 6 && marks > codes * 0.35) out.push({ kind: 'zalgo', detail: `${marks} marques diacritiques collées`, delete: true, score: 4 });

  if (!o.allowLinks) {
    const links = (text.match(URL_RE) ?? []).filter((u) => !/discord\.com\/channels|tenor\.com|giphy\.com|youtube\.com|youtu\.be|open\.spotify\.com|clips\.twitch\.tv|medal\.tv|streamable\.com/i.test(u));
    if (links.length) out.push({ kind: 'link', detail: `lien externe ${links[0]!.slice(0, 60)}`, delete: false, score: 1 });
  }
  return out;
}

/** Flood : n messages identiques ou quasi dans la meme fenetre. */
export function duplicateScore(history: string[], candidate: string, similarity = 0.85): number {
  const c = norm(candidate);
  if (c.length < 6) return 0;
  let hits = 0;
  for (const h of history) {
    const p = norm(h);
    if (p === c) { hits++; continue; }
    if (jaccard(p, c) >= similarity) hits++;
  }
  return hits;
}

/** Minuscules, ponctuation et accents ignores : « Ca va ! » == « ca va ». */
export const norm = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 200);

function jaccard(a: string, b: string): number {
  const A = new Set(shingles(a)), B = new Set(shingles(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
const shingles = (s: string): string[] => { const out: string[] = []; for (let i = 0; i + 3 <= s.length; i += 1) out.push(s.slice(i, i + 3)); return out; };

/** Meme contenu 3x de suite par la meme personne => flood. */
export function floodBurst(history: { text: string; at: number }[], now = Date.now(), windowMs = 8_000, threshold = 3): boolean {
  const recent = history.filter((h) => now - h.at <= windowMs);
  return recent.length >= threshold;
}
