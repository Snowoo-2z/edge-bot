/**
 * Modèle de permissions PUR (aucun appel Discord) : ce qui est VRAI sur le serveur
 * d'après le manifeste. `npm test` vérifie les promesses de ta config (pings, 🔒,
 * accès tickets, selfroles) sans avoir besoin d'un token.
 */
import {
  type ChannelAcl, type ChannelKey, type PermName, type RoleKey,
  channelDef, expectedAcl, roleDef, ASSIGNABLE_ROLES,
} from '../manifest.js';

/** Ce que @everyone a au niveau guilde sur un serveur Discord standard. */
export const EVERYONE_GUILD_DEFAULTS: PermName[] = [
  'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads',
  'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'AddReactions', 'UseExternalEmojis',
  'Connect', 'Speak', 'UseVAD', 'Stream', 'UseApplicationCommands', 'RequestToSpeak',
];

const ORDER: Record<RoleKey, number> = Object.fromEntries(
  (['notifGiveaway','notifPartenaire','booster','partenaire','membre','animateur','helper','manager','mod','admin','fondateur'] as RoleKey[])
    .map((k, i) => [k, i]),
) as Record<RoleKey, number>;

function apply(spec: { allow: PermName[]; deny: PermName[] }, perms: Set<PermName>): void {
  for (const p of spec.allow) perms.add(p);
  for (const p of spec.deny) perms.delete(p);
}

/** Droits effectifs d'un membre (liste de rôles Edge) dans un salon donné. */
export function effectivePerms(actorRoles: RoleKey[], chKey: ChannelKey, acl: ChannelAcl = expectedAcl(channelDef(chKey))): Set<PermName> {
  const perms = new Set<PermName>(EVERYONE_GUILD_DEFAULTS);
  for (const r of actorRoles) for (const p of roleDef(r).perms) perms.add(p);
  if (perms.has('Administrator')) return new Set<PermName>(ALL_PERMS);

  apply(acl.everyone, perms);
  // Hiérarchie : on applique les overwrites du plus bas au plus haut => le plus fort gagne.
  const sorted = [...actorRoles].sort((a, b) => ORDER[a] - ORDER[b]);
  for (const r of sorted) {
    const spec = acl.roles[r];
    if (spec) apply(spec, perms);
  }
  return perms;
}

const ALL_PERMS = new Set<PermName>([
  ...EVERYONE_GUILD_DEFAULTS, 'Administrator', 'ManageChannels', 'ManageGuild', 'ManageRoles', 'ManageMessages',
  'ManageThreads', 'MentionEveryone', 'ModerateMembers', 'KickMembers', 'BanMembers', 'ViewAuditLog',
  'ManageEvents', 'MoveMembers', 'MuteMembers', 'DeafenMembers', 'ManageNicknames', 'ChangeNickname',
  'ManageWebhooks', 'ManageEmojisAndStickers', 'UseExternalSounds', 'AttachFiles', 'UseVAD', 'Stream',
]);

export const can = (perms: Set<PermName>, p: PermName): boolean => perms.has(p);
export const canSpeakIn = (actorRoles: RoleKey[], chKey: ChannelKey): boolean => can(effectivePerms(actorRoles, chKey), 'SendMessages');
export const canSeeChannel = (actorRoles: RoleKey[], chKey: ChannelKey): boolean => can(effectivePerms(actorRoles, chKey), 'ViewChannel');

/** Un rôle `mentionable: false` ne se pingue QUE par un membre qui a MentionEveryone. */
export function canPingRole(actorRoles: RoleKey[], target: RoleKey, chKey?: ChannelKey): boolean {
  const perms = chKey ? effectivePerms(actorRoles, chKey) : new Set<PermName>([...EVERYONE_GUILD_DEFAULTS, ...actorRoles.flatMap((r) => roleDef(r).perms)]);
  const speaks = !chKey || can(perms, 'SendMessages');
  if (!speaks) return false;
  if (perms.has('Administrator')) return true;
  if (roleDef(target).mentionable) return true;
  return can(perms, 'MentionEveryone');
}

export function canPingEveryone(actorRoles: RoleKey[], chKey: ChannelKey): boolean {
  const perms = effectivePerms(actorRoles, chKey);
  return perms.has('Administrator') || can(perms, 'MentionEveryone');
}

/** Un membre peut-il poser/retirer ce rôle tout seul via le panneau ? */
export function canSelfAssign(target: RoleKey): boolean {
  const def = roleDef(target);
  return ASSIGNABLE_ROLES.includes(target) && def.selfAssignable === true && !def.protected && !def.autoOnly;
}

/** Niveau logique le plus haut d'un membre (-1 = simple @everyone). */
export function topLevel(actorRoles: RoleKey[]): number {
  return actorRoles.reduce((acc, r) => Math.max(acc, roleDef(r).order), -1);
}
export const atLeast = (actorRoles: RoleKey[], min: RoleKey): boolean => topLevel(actorRoles) >= roleLevelOf(min);
export const roleLevelOf = (r: RoleKey): number => roleDef(r).order;

/* ------------------------------------------------- les promesses de ton serveur */

export interface Invariant { id: string; attendu: boolean; description: string; check: () => boolean }

/**
 * Les invariants que tu as écrits dans ta spec. Chacun est évaluable hors ligne ;
 * `modules/audit` les re-vérifie aussi contre le Discord RÉEL au boot.
 */
export const INVARIANTS: Invariant[] = [
  {
    id: 'ping-everyone-bloque', attendu: true,
    description: '@everyone / Membre / Booster ne peuvent ping aucune notification',
    check: () => ['membre', 'booster', 'partenaire'].every(
      (r) => !canPingRole([r as RoleKey], 'notifGiveaway', 'giveaway') && !canPingEveryone([r as RoleKey], 'discussion'),
    ),
  },
  {
    id: 'animateur-ping-giveaway', attendu: true,
    description: '🎉│ Animateur peut ping 🎁│ Notification Giveaway dans 🎁│・Giveaway',
    check: () => canPingRole(['animateur'], 'notifGiveaway', 'giveaway') && canSpeakIn(['animateur'], 'giveaway'),
  },
  {
    id: 'manager-ping-partenariat', attendu: true,
    description: '💼│ Manager Partenariat peut ping 🤝│ Notification Partenariat',
    check: () => canPingRole(['manager'], 'notifPartenaire', 'discussion'),
  },
  {
    id: 'manager-annonce-bloque', attendu: true,
    description: '⚠️ Manager NE peut PAS écrire dans 📣│・Annonces => c’est Edge qui poste l’annonce de partenariat',
    check: () => !canSpeakIn(['manager'], 'annonces'),
  },
  {
    id: 'lecture-seule-info', attendu: true,
    description: '📄│↦ INFORMATIONS est en lecture seule pour un membre lambda',
    check: () => ['reglement', 'annonces', 'boosts', 'selfroles', 'bienvenue'].every((k) => !canSpeakIn(['membre'], k as ChannelKey)),
  },
  {
    id: 'tickets-invisibles', attendu: true,
    description: '📁│↦ TICKETS et 🔐│↦ STAFF sont invisibles pour @everyone et pour un simple Membre',
    check: () => !canSeeChannel([], 'modLogs') && !canSeeChannel(['membre'], 'ticketLogs') && canSeeChannel(['helper'], 'ticketLogs'),
  },
  {
    id: 'staff-peut-ecrire-partout-prive', attendu: true,
    description: '⚔️│ Modérateur peut écrire dans 🛡️│・Modération-logs et 📋│・Audit-staff',
    check: () => canSpeakIn(['mod'], 'modLogs') && canSpeakIn(['mod'], 'auditStaff'),
  },
  {
    id: 'helper-ticket-lecture', attendu: true,
    description: '🧰│ Helper voit les tickets (via l’overwrite du salon créé) mais 📁│↦ TICKETS reste verrouillé à @everyone',
    check: () => canSpeakIn(['helper'], 'modLogs') === false && canSeeChannel(['helper'], 'staffChat'),
  },
  {
    id: 'animateur-fuite-everyone', attendu: true,
    description: '⚠️ Risque connu : 🎉│ Animateur a MentionEveryone => il PEUT ping @everyone dans 💬│・Discussion. Le module automod le surveille.',
    check: () => canPingEveryone(['animateur'], 'discussion'),
  },
  {
    id: 'selfroles-notifs', attendu: true,
    description: 'Membre peut s’auto-donner 🎁/🤝 Notification via 🎭│・Choisir-ses-rôles (Edge a ManageRoles)',
    check: () => canSelfAssign('notifGiveaway') && canSelfAssign('notifPartenaire') && !canSelfAssign('booster'),
  },
];
