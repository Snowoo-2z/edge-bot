/** Echelles de sanction — pur, testable hors ligne. */
export type CaseType = 'note' | 'warn' | 'timeout' | 'kick' | 'ban' | 'unban' | 'pardon';

export interface LadderStep { fromPoints: number; action: CaseType; minutes?: number; label: string }

/** Points de warn -> action suivante conseillée. Rien n'est automatique au-dela du warn : un humain valide. */
export const WARN_LADDER: readonly LadderStep[] = [
  { fromPoints: 0, action: 'note', label: 'note interne, rien pour le membre' },
  { fromPoints: 1, action: 'warn', label: 'avertissement officiel' },
  { fromPoints: 2, action: 'timeout', minutes: 60, label: 'timeout 1 h' },
  { fromPoints: 3, action: 'timeout', minutes: 1_440, label: 'timeout 24 h' },
  { fromPoints: 4, action: 'timeout', minutes: 10_080, label: 'timeout 7 j (max Discord)' },
  { fromPoints: 5, action: 'kick', label: 'expulsion (le membre peut revenir, c’est le but)' },
  { fromPoints: 6, action: 'ban', label: 'ban — à confirmer par un Admin' },
] as const;

export function escalate(points: number): LadderStep {
  let best = WARN_LADDER[0]!;
  for (const s of WARN_LADDER) if (points >= s.fromPoints) best = s;
  return best;
}

/** Coût en points de chaque action (les warn points montent, pas les notes). */
export const POINTS: Record<CaseType, number> = { note: 0, warn: 1, timeout: 1, kick: 2, ban: 4, unban: 0, pardon: -99 };

export function pointsAfter(current: number, type: CaseType): number {
  if (type === 'pardon') return 0;
  if (type === 'ban') return current;
  return Math.max(0, current + POINTS[type]);
}

/** Un dossier est-il encore actif ? (warns et timeouts purgent, notes jamais) */
export function isActive(row: { type: string; active?: unknown; created_at?: string | Date | null; expires_at?: string | Date | null }, now = Date.now(), ttlDays = 60): boolean {
  if (row.active === false) return false;
  if (row.type === 'note') return true;
  if (row.expires_at) return new Date(row.expires_at).getTime() > now;
  const born = row.created_at ? new Date(row.created_at).getTime() : 0;
  if (!born) return true;
  return now - born < ttlDays * 86_400_000;
}

/** Recompense de palier de warns : ce qu'on propose au staff. */
export const WARN_TTL_DAYS = 60;

/* ------------------------------------------------- automod : severite -> action */

export type AutomodAction = 'ignore' | 'delete' | 'delete_warn' | 'timeout' | 'kick_suggest' | 'ban_suggest';

export interface AutomodStep { hits: number; action: AutomodAction; minutes?: number; label: string }

/** Paliers de l'automod : 1er = on retire juste le message, ensuite ca monte, et on s'arrete avant le ban. */
export const AUTOMOD_LADDER: readonly AutomodStep[] = [
  { hits: 0, action: 'ignore', label: 'rien' },
  { hits: 1, action: 'delete', label: 'message supprimé + explication' },
  { hits: 2, action: 'delete', minutes: 0, label: 'supprimé, on surveille' },
  { hits: 3, action: 'timeout', minutes: 10, label: 'timeout 10 min' },
  { hits: 4, action: 'timeout', minutes: 60, label: 'timeout 1 h' },
  { hits: 5, action: 'timeout', minutes: 1_440, label: 'timeout 24 h' },
  { hits: 7, action: 'ban_suggest', label: 'ban proposé au staff (Edge ne bannit pas seul)' },
] as const;

export function automodStep(hits: number): AutomodStep {
  let best = AUTOMOD_LADDER[0]!;
  for (const s of AUTOMOD_LADDER) if (hits >= s.hits) best = s;
  return best;
}

/** Le motif est-il « sale » au point de compter un hit ? (les regles douces ne comptent pas) */
export const HARD_KINDS = new Set(['invite', 'webhook', 'token', 'everyone_ping', 'nsfw_link', 'raid_join']);

/* ------------------------------------------------------------- partenariat */

export type PartnershipState = 'pending' | 'active' | 'paused' | 'expired';

/** 3 controles de reciprocite ratés => expiration. */
export function afterCheck(state: PartnershipState, ok: boolean, fails: number): { state: PartnershipState; fails: number } {
  if (state === 'expired') return { state, fails };
  if (ok) return { state: 'active', fails: 0 };
  const next = fails + 1;
  return { state: next >= 3 ? 'expired' : 'paused', fails: next };
}

/* ------------------------------------------------------------------ giveaway */

/** Ponderation par role : multiplicateur applique au billet de chaque participant. */
export const DEFAULT_WEIGHTS: Record<string, number> = { booster: 2, animateur: 1.5, partenaire: 1.25, membre: 1 };
export function weightOf(roleKeys: string[], weights: Record<string, number> = DEFAULT_WEIGHTS): number {
  return roleKeys.reduce((max, r) => Math.max(max, weights[r] ?? 1), 1);
}
