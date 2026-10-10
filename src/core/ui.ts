import { ActionRowBuilder, MessageFlags, type MessageActionRowComponentBuilder } from 'discord.js';

export type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

/** Message texte simple. Choisi volontairement plutot qu'un embed (goût du proprio). */
export const plain = (content: string): { content: string; flags?: number } => ({ content: content.slice(0, 2000) });
export const ephemeral = <T extends object>(x: T): T & { flags: number } => ({ ...x, flags: MessageFlags.Ephemeral });
export const rows = (...comps: ComponentLike[][]): Row[] =>
  comps.filter((c) => c.length).map((c) => new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(c) as Row);

export type ComponentLike =
  | import('discord.js').ButtonBuilder
  | import('discord.js').StringSelectMenuBuilder
  | import('discord.js').ChannelSelectMenuBuilder
  | import('discord.js').UserSelectMenuBuilder
  | import('discord.js').RoleSelectMenuBuilder
  | import('discord.js').MentionableSelectMenuBuilder;

export const truncate = (s: string, n = 1020): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function chunk(s: string, size = 1900): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [''];
}

const UNITS: Record<string, number> = { s: 1_000, sec: 1_000, seconde: 1_000, secondes: 1_000, m: 60_000, min: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, heure: 3_600_000, heures: 3_600_000, hr: 3_600_000, hour: 3_600_000, j: 86_400_000, jour: 86_400_000, jours: 86_400_000, d: 86_400_000, day: 86_400_000, sem: 604_800_000, semaine: 604_800_000, w: 604_800_000, mois: 2_592_000_000 };

/** "2j12h", "30m", "1 heure", "45 minutes" => ms. null si pas compris. */
export function parseDuration(input: string): number | null {
  let s = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '').replace(/([a-z]+)\.?(?:s)?/g, '$1');
  // « 1h30 » se lit 1 h 30 min, « 2j12 » = 2 j 12 h : un nombre nu herite du cran inferieur.
  const APRÈS: Record<string, string> = { j: 'h', d: 'h', day: 'h', h: 'min', heure: 'min', min: 's' };
  s = s.replace(/(\d+)([a-z]+)(\d+)$/g, (whole, n1: string, u: string, n2: string) => {
    const next = APRÈS[u];
    return next && /^\d+$/.test(n2) ? `${n1}${u}${n2}${next}` : whole;
  });
  const re = /(\d+(?:[.,]\d+)?)([a-zé]+)/g;
  let total = 0, found = false, consumed = 0;
  for (const m of s.matchAll(re)) {
    const unit = UNITS[m[2]!] ?? UNITS[m[2]!.replace(/s$/, '')];
    if (!unit) continue;
    total += Math.round(parseFloat(m[1]!.replace(',', '.')) * unit);
    found = true;
    consumed += m[0].length;
  }
  if (!found) return null;
  if (consumed < s.length && !/^\d*$/.test(s.slice(consumed))) return null;
  return total;
}

export function fmtDur(ms: number): string {
  const neg = ms < 0; ms = Math.abs(ms);
  const j = Math.floor(ms / 86_400_000), h = Math.floor(ms / 3_600_000) % 24, m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
  const parts = [j && `${j}j`, h && `${h}h`, m && `${m}min`, !j && !h && s && `${s}s`].filter(Boolean) as string[];
  return (neg ? '-' : '') + (parts.join(' ') || '0s');
}

/**
 * Une date lisible PAR CHACUN : on rend un timestamp Discord (<t:…:F>), pas une heure
 * de Paris imposee a un membre qui vit a Montreal. '—' quand la date manque.
 */
export const at = (d: Date | number | string | null | undefined): string => {
  if (d === null || d === undefined) return '—';
  const ms = new Date(d).getTime();
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:F>` : '—';
};
/**
 * Une `value` d'option de menu Discord : minuscules, chiffres, `. _ -`, 100 caractères, et rien
 * d'autre — un seul caractère interdit (le deux-points d'un `module:cle`, un accent, une
 * majuscule) fait rejeter le message ENTIER avec un `Invalid Form Body` introuvable. On nettoie
 * a la source plutot que de surveiller chaque constructeur de menu.
 */
export const valeurOption = (s: string): string => {
  const propre = String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (propre || 'valeur').slice(0, 100);
};

/** Le inverse : retrouver la cle d'origine quand on a encode `module.cle` dans une value. */
export const decouperOption = (s: string, n = 2): string[] => String(s ?? '').split('.', n);

/** Timestamp Discord relatif (le client rend « dans 2 h », « il y a 3 min »). */
export const rel = (d: Date | number): string => `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>`;
export const until = (d: Date | number): string => `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>`;

export function bar(pct: number, width = 12): string {
  const p = Math.max(0, Math.min(1, pct));
  const fill = Math.round(p * width);
  return `${'▓'.repeat(fill)}${'░'.repeat(width - fill)} ${Math.round(p * 100)}%`;
}

/** Courbe de niveau : xp cumulé requis pour atteindre le niveau L. */
export const xpForLevel = (level: number): number => Math.floor(60 * level ** 1.6 + 40 * level);
export function levelFromXp(xp: number): { level: number; into: number; need: number; pct: number } {
  let level = 0;
  while (xp >= xpForLevel(level + 1) && level < 500) level++;
  const base = xpForLevel(level), next = xpForLevel(level + 1);
  return { level, into: xp - base, need: next - base, pct: (xp - base) / (next - base || 1) };
}

/** Nom de salon/slug légal Discord (minuscules, sans accents). */
export function slug(input: string, max = 60): string {
  const s = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return s || 'sans-nom';
}
export const pad = (n: number | string, size = 4): string => String(n).padStart(size, '0');
export const list = (items: (string | null | undefined)[], sep = ', '): string => items.filter(Boolean).join(sep) || '—';
export const bool = (v: boolean): string => (v ? '✅' : '❌');
export const maskLink = (s: string): string => s.replace(/(https?:\/\/\S+)/g, '<$1>');
