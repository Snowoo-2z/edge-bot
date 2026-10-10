/**
 * resolveur de structure : manifeste -> objets Discord reels, + rapport d'ecart.
 *
 * Regles :
 *  - lecture seule absolue (Edge ne cree ni ne repare un salon/r6le) ;
 *  - resolution par nom exact, puis par nom normalise (sans emoji, accents, separateurs),
 *    namespace par type pour eviter les collisions (`🎵│・Musique` texte vs `🎵│ Musique` vocal) ;
 *  - un module dont une dependance manque est DESACTIVE avec un motif lisible, jamais plante.
 */
import { ChannelType, type CategoryChannel, type Guild, type Role, type TextChannel, type VoiceChannel } from 'discord.js';
import {
  type CategoryKey, type ChannelAcl, type ChannelKey, type PermName, type RoleKey,
  CATEGORY_DEFS, CHANNEL_DEFS, EDGE_ROLE_NAME, ROLE_DEFS, channelDef, expectedAcl, roleDef,
} from '../manifest.js';
import { PERM_NAMES } from '../manifest.js';
import { buildRoleIndex, type RoleIndex, bit } from './perms.js';

/** `🎁│・Giveaway` -> `giveaway`. Minuscule, sans accents, sans separateurs. */
export const norm = (name: string): string =>
  name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');

export const textKey = (name: string): string => `t:${norm(name)}`;
export const voiceKey = (name: string): string => `v:${norm(name)}`;
export const catKey = (name: string): string => `c:${norm(name)}`;

export interface Resolved {
  guild: Guild;
  idx: RoleIndex;
  roles: Record<RoleKey, Role | null>;
  categories: Record<CategoryKey, CategoryChannel | null>;
  channels: Record<ChannelKey, TextChannel | VoiceChannel | null>;
  missingRoles: RoleKey[];
  missingChannels: ChannelKey[];
  missingCategories: CategoryKey[];
  role(k: RoleKey): Role | null;
  roleId(k: RoleKey): string | null;
  channel(k: ChannelKey): TextChannel | VoiceChannel | null;
  channelId(k: ChannelKey): string | null;
  category(k: CategoryKey): CategoryChannel | null;
  /** Retourne le salon, ou leve une erreur parlante (utile dans les handlers). */
  must(k: ChannelKey): TextChannel | VoiceChannel;
}

export function resolveStructure(guild: Guild): Resolved {
  const roles = {} as Record<RoleKey, Role | null>;
  const byExactRole = new Map<string, Role>();
  const byNormRole = new Map<string, Role>();
  for (const r of guild.roles.cache.values()) {
    if (!byExactRole.has(r.name)) byExactRole.set(r.name, r);
    const k = norm(r.name);
    if (k && !byNormRole.has(k)) byNormRole.set(k, r);
  }
  for (const def of ROLE_DEFS) {
    roles[def.key] = byExactRole.get(def.name) ?? byNormRole.get(norm(def.name)) ?? null;
  }

  const categories = {} as Record<CategoryKey, CategoryChannel | null>;
  const channels = {} as Record<ChannelKey, TextChannel | VoiceChannel | null>;
  const byCat = new Map<string, CategoryChannel>();
  const byText = new Map<string, TextChannel | VoiceChannel>();
  for (const c of guild.channels.cache.values()) {
    if (c.type === ChannelType.GuildCategory) byCat.set(catKey(c.name), c as CategoryChannel);
    else if (c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice) {
      const k = c.type === ChannelType.GuildText ? textKey(c.name) : voiceKey(c.name);
      byText.set(k, c as TextChannel | VoiceChannel);
    }
  }
  for (const def of CATEGORY_DEFS) {
    categories[def.key] = byExactCat(guild, def.name) ?? byCat.get(catKey(def.name)) ?? null;
  }
  for (const def of CHANNEL_DEFS) {
    const k = def.kind === 'voice' ? voiceKey(def.name) : textKey(def.name);
    const found = byText.get(k);
    channels[def.key] = found && channelTypeOf(found) === def.kind ? found : null;
  }

  const roleIds = {} as Record<RoleKey, string | null>;
  for (const def of ROLE_DEFS) roleIds[def.key] = roles[def.key]?.id ?? null;
  const idx = buildRoleIndex(roleIds);

  const missingRoles = ROLE_DEFS.filter((r) => !roles[r.key]).map((r) => r.key);
  const missingCategories = CATEGORY_DEFS.filter((c) => !categories[c.key]).map((c) => c.key);
  const missingChannels = CHANNEL_DEFS.filter((c) => !channels[c.key]).map((c) => c.key);

  return {
    guild, idx, roles, categories, channels, missingRoles, missingChannels, missingCategories,
    role: (k) => roles[k],
    roleId: (k) => roles[k]?.id ?? null,
    channel: (k) => channels[k],
    channelId: (k) => channels[k]?.id ?? null,
    category: (k) => categories[k],
    must: (k) => {
      const c = channels[k];
      if (!c) throw new Error(`salon « ${channelDef(k).name} » introuvable sur ce serveur`);
      return c;
    },
  };
}

const channelTypeOf = (c: TextChannel | VoiceChannel): 'text' | 'voice' => (c.type === ChannelType.GuildVoice ? 'voice' : 'text');

function byExactCat(guild: Guild, name: string): CategoryChannel | null {
  for (const c of guild.channels.cache.values()) if (c.type === ChannelType.GuildCategory && c.name === name) return c as CategoryChannel;
  return null;
}

/* --------------------------------------------------------------------- ecarts */

export type DriftLevel = 'error' | 'warn' | 'info';
export interface Drift { level: DriftLevel; area: 'role' | 'channel' | 'acl' | 'bot' | 'police'; what: string; expected?: string; got?: string }

/** Rapport d'ecart manifeste vs serveur reel. `audit` l'affiche, `health` s'en sert pour couper des modules. */
export function driftReport(r: Resolved): Drift[] {
  const out: Drift[] = [];
  const me = r.guild.members.me;
  const add = (level: DriftLevel, area: Drift['area'], what: string, expected?: string, got?: string): void => { out.push({ level, area, what, expected, got }); };

  for (const k of r.missingRoles) add('error', 'role', `rôle manquant : ${roleDef(k).name}`, 'présent', 'absent');
  for (const k of r.missingCategories) add('error', 'channel', `catégorie manquante : ${CATEGORY_DEFS.find((c) => c.key === k)!.name}`);
  for (const k of r.missingChannels) add('error', 'channel', `salon manquant : ${channelDef(k).name} (catégorie ${channelDef(k).cat})`);

  // Un salon qui traine hors manifeste n'est surveille par aucun module (ni XP, ni automod,
  // ni logs). On le signale sans bloquer : c'est souvent un restant d'un ancien bot.
  const attendus = new Set<string>(CHANNEL_DEFS.map((d) => norm(d.name)));
  for (const [, ch] of r.guild.channels.cache as Iterable<[string, { id: string; name?: string; type?: number; parentId?: string; parent?: { name?: string } }]>) {
    if (!ch || typeof ch.name !== 'string') continue;
    if (ch.type !== 0 && ch.type !== 2) continue;
    if (attendus.has(norm(ch.name))) continue;
    if (/^t-\d{4}-/i.test(ch.name)) continue; // tickets creats par Edge
    if (r.categories.tickets && ch.parentId === r.categories.tickets.id) continue; // salons de ticket
    add('warn', 'channel', `salon hors manifeste : ${ch.name}`, 'aucun', (ch.parent?.name ?? 'catégorie inconnue'));
  }

  for (const def of ROLE_DEFS) {
    const role = r.roles[def.key];
    if (!role) continue;
    if (role.hexColor.toUpperCase() !== def.color.toUpperCase()) add('warn', 'role', `couleur de ${def.name}`, def.color, role.hexColor);
    if (role.hoist !== def.hoist) add('warn', 'role', `hoist de ${def.name}`, String(def.hoist), String(role.hoist));
    if (role.mentionable !== def.mentionable) {
      add(def.mentionable ? 'warn' : 'error', 'police', `mentionable de ${def.name}`, String(def.mentionable), String(role.mentionable));
    }
    const missing = def.perms.filter((p) => !role.permissions.has(bit(p)));
    if (missing.length) add('error', 'role', `permissions manquantes sur ${def.name}`, def.perms.join(', '), `manque: ${missing.join(', ')}`);
    const extra = [...role.permissions.toArray()].filter((p) => !def.perms.includes(p as PermName) && p !== 'ViewChannel');
    if (extra.length && !def.perms.includes('Administrator')) add('info', 'role', `${def.name} a des permissions en trop`, '—', extra.join(', '));
  }

  const dupColor = ROLE_DEFS.filter((a, i) => ROLE_DEFS.some((b, j) => j > i && b.color === a.color));
  if (dupColor.length) add('info', 'police', 'couleurs de rôles dupliquées (lisibilité des logs)', 'uniques', dupColor.map((d) => `${d.name} ${d.color}`).join(' + '));

  for (const def of CHANNEL_DEFS) {
    const ch = r.channels[def.key];
    if (!ch) continue;
    const parent = r.categories[def.cat];
    if (parent && ch.parentId !== parent.id) add('warn', 'channel', `${def.name} n’est pas dans ${CATEGORY_DEFS.find((c) => c.key === def.cat)!.name}`, parent.name, ch.parent?.name ?? 'aucune catégorie');
    const exp = expectedAcl(def);
    const everyoneId = r.guild.id;
    const ev = ch.permissionOverwrites.cache.get(everyoneId);
    const denySet = (p: PermName): boolean => {
      const real = ch.permissionsFor(r.guild.roles.everyone);
      return real ? !real.has(bit(p)) : exp.everyone.allow.includes(p);
    };
    if (def.locked && !denySet('SendMessages')) add('error', 'acl', `${def.name} devrait être en lecture seule pour @everyone`, 'SendMessages refusé', 'SendMessages autorisé');
    if (!def.locked && def.cat !== 'tickets' && def.cat !== 'staff' && denySet('SendMessages') && !ev) add('warn', 'acl', `${def.name} est silencieux pour @everyone mais ne devrait pas`, 'public', 'verrouillé');
    if ((def.cat === 'tickets' || def.cat === 'staff')) {
      const view = ch.permissionsFor(r.guild.roles.everyone)?.has(bit('ViewChannel'));
      if (view) add('error', 'acl', `FUITE : @everyone voit ${def.name}`, 'ViewChannel refusé', 'ViewChannel autorisé');
    }
    if (def.slowmode && 'rateLimitPerUser' in ch && ch.rateLimitPerUser !== def.slowmode) add('info', 'channel', `slowmode de ${def.name}`, `${def.slowmode}s`, `${ch.rateLimitPerUser ?? 0}s`);
    if (me) {
      const p = ch.permissionsFor(me);
      if (!p?.has(bit('ViewChannel'))) add('error', 'bot', `Edge ne voit pas ${def.name}`, 'ViewChannel', '—');
      else if (!p.has(bit('SendMessages')) && def.kind === 'text') add('warn', 'bot', `Edge ne peut pas écrire dans ${def.name}`, 'SendMessages', '—');
      if (!p.has(bit('ReadMessageHistory')) && def.kind === 'text') add('warn', 'bot', `Edge ne lit pas l’historique de ${def.name}`, 'ReadMessageHistory', '—');
    }
  }

  if (me) {
    const edgeRole = r.guild.roles.cache.find((x) => x.name === EDGE_ROLE_NAME);
    if (!edgeRole) add('warn', 'bot', `aucun rôle « ${EDGE_ROLE_NAME} » pour le bot`, 'rôle entre 💼│ Manager et ⚔️│ Modérateur', 'absent');
    else {
      const mod = r.roles.mod?.position, manager = r.roles.manager?.position;
      if (mod !== undefined && edgeRole.position >= mod) add('error', 'bot', 'le rôle Edge est trop haut (il pourrait toucher Modérateur/Admin)', `position < ${mod}`, String(edgeRole.position));
      if (manager !== undefined && edgeRole.position <= manager) add('warn', 'bot', 'le rôle Edge est trop bas (il ne peut plus gérer Manager/selfroles)', `position > ${manager}`, String(edgeRole.position));
    }
    const lacking = [...new Set<string>()];
    for (const p of ['MentionEveryone', 'ManageRoles', 'ManageChannels', 'ModerateMembers'] as PermName[]) {
      if (!r.guild.members.me?.permissions.has(bit(p))) lacking.push(p);
    }
    for (const p of lacking) add('error', 'bot', `Edge n’a pas ${p} au niveau guilde`, 'acquis', 'refusé');
  }

  const counts = { roles: r.guild.roles.cache.size - 1, channels: r.guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).size };
  add('info', 'police', `taille serveur vs manifeste (${ROLE_DEFS.length} rôles / ${CHANNEL_DEFS.length} salons attendus)`, `${ROLE_DEFS.length} rôles, ${CHANNEL_DEFS.length} salons`, `${counts.roles} rôles, ${counts.channels} salons`);
  return out;
}

/** Overwrites reels d'un salon, au format du modele de permissions pur. */
export function realAcl(r: Resolved, key: ChannelKey): ChannelAcl | null {
  const ch = r.channels[key];
  if (!ch) return null;
  const acl: ChannelAcl = { everyone: { allow: [], deny: [] }, roles: {} };
  for (const o of ch.permissionOverwrites.cache.values()) {
    const allow = o.allow.toArray().map(String).flatMap(toPerm);
    const deny = o.deny.toArray().map(String).flatMap(toPerm);
    if (o.id === r.guild.id) { acl.everyone = { allow, deny }; continue; }
    const rk = r.idx.byId.get(o.id);
    if (rk) acl.roles[rk] = { allow, deny };
  }
  return acl;
}

const FLAG_TO_PERM = new Map<string, PermName>(PERM_NAMES.map((p) => [p.toLowerCase(), p]));
function toPerm(flagName: string): PermName[] {
  const p = FLAG_TO_PERM.get(flagName.toLowerCase());
  return p ? [p] : [];
}
