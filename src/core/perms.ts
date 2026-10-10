/** Pont manifeste <-> discord.js : bits, index de rôles résolus, gardes de commandes. */
import { PermissionFlagsBits, OverwriteType, type GuildMember, type OverwriteData } from 'discord.js';
import { type PermName, type RoleKey, ROLE_DEFS, roleDef, roleLevel } from '../manifest.js';

const BITS = PermissionFlagsBits as unknown as Record<PermName, bigint>;
export const bit = (p: PermName): bigint => BITS[p];
export const bits = (names: PermName[]): bigint => names.reduce<bigint>((acc, n) => acc | bit(n), 0n);

/** Correspondance RoleKey <-> ID Discord, produite par le resolveur de structure. */
export interface RoleIndex {
  byKey: Record<RoleKey, string | null>;
  byId: Map<string, RoleKey>;
}
export const buildRoleIndex = (resolved: Record<RoleKey, string | null>): RoleIndex => ({
  byKey: resolved,
  byId: new Map(Object.entries(resolved).filter(([, v]) => v).map(([k, v]) => [v!, k as RoleKey])),
});

export const roleIds = (idx: RoleIndex, k: RoleKey): string => {
  const id = idx.byKey[k];
  if (!id) throw new Error(`rôle ${k} non résolu`);
  return id;
};

export const keysOf = (m: GuildMember, idx: RoleIndex): RoleKey[] =>
  [...m.roles.cache.keys()].map((id) => idx.byId.get(id)).filter((k): k is RoleKey => Boolean(k));

export const topKey = (m: GuildMember, idx: RoleIndex): RoleKey | null =>
  keysOf(m, idx).reduce<RoleKey | null>((best, k) => (!best || roleLevel(k) > roleLevel(best) ? k : best), null);

/** Le membre a-t-il le rôle `min` ou un rôle plus haut ( Fondateur/owner = toujours oui) ? */
export function atLeast(m: GuildMember, min: RoleKey, idx: RoleIndex): boolean {
  if (m.id === m.guild.ownerId) return true;
  const top = topKey(m, idx);
  return !!top && roleLevel(top) >= roleLevel(min);
}

export const isOwner = (m: GuildMember): boolean => m.id === m.guild.ownerId;

/** Un overwrite de rôle (ou @everyone si `id` = id de la guilde). */
export const overwrite = (id: string, allow: PermName[] = [], deny: PermName[] = []): OverwriteData =>
  ({ id, type: OverwriteType.Role, allow: bits(allow), deny: bits(deny) });

/** Le rôle Edge peut-il gérer ce rôle cible ? (position Discord réelle + pas Administrator) */
export function canManageRole(me: GuildMember, target: RoleKey, idx: RoleIndex): boolean {
  const def = roleDef(target);
  const role = idx.byKey[target] ? me.guild.roles.cache.get(idx.byKey[target]!) : undefined;
  if (!role) return false;
  return me.roles.highest.position > role.position && !def.perms.includes('Administrator');
}

/** Un mod peut-il sanctionner cette cible ? Garde hiérarchique + interdits durs. */
export function canActOn(actor: GuildMember, target: GuildMember, idx: RoleIndex): { ok: boolean; why?: string } {
  if (target.id === target.guild.ownerId) return { ok: false, why: 'Le fondateur est intouchable.' };
  if (actor.id === target.id) return { ok: false, why: 'Pas sur toi-même.' };
  const actorTop = topKey(actor, idx);
  const targetTop = topKey(target, idx);
  if (!actorTop) return { ok: false, why: 'Tu n’as aucun rôle staff : rien à sanctionner ici.' };
  if (targetTop && roleLevel(targetTop) >= roleLevel(actorTop) && actorTop !== 'fondateur')
    return { ok: false, why: `Cible de rang ${roleDef(targetTop).name} ≥ ton rang ${roleDef(actorTop).name} : escalade la demande.` };
  if ((targetTop === 'admin') && actorTop !== 'fondateur') return { ok: false, why: 'Seul le fondateur touche à un Administrateur.' };
  return { ok: true };
}

/** Rôles du staff, du plus bas au plus haut (pour les rapports). */
export const STAFF_KEYS = ROLE_DEFS.filter((r) => r.order >= roleLevel('helper')).map((r) => r.key);
