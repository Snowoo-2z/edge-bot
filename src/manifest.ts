/**
 * Le manifeste d'Edge : la photographie EXHAUSTIVE du serveur 1558076024778919946.
 *
 * C'est le seul fichier à éditer si la structure change. Edge ne crée jamais de
 * rôle ni de salon : il résout ce manifeste contre le serveur réel, et grogne si
 * ça ne colle pas (voir core/structure.ts + modules/audit).
 *
 * Aucun import de discord.js ici => ce fichier est testable hors ligne (npm test).
 */

export const GUILD_ID = '1558076024778919946';

/* ------------------------------------------------------------------ permissions */

export const PERM_NAMES = [
  'CreateInstantInvite', 'KickMembers', 'BanMembers', 'Administrator', 'ManageChannels', 'ManageGuild',
  'ViewAuditLog', 'PrioritySpeaker', 'Stream', 'ViewChannel', 'SendMessages', 'SendTTSMessages',
  'ManageMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'MentionEveryone',
  'UseExternalEmojis', 'ViewGuildInsights', 'Connect', 'Speak', 'MuteMembers', 'DeafenMembers',
  'MoveMembers', 'UseVAD', 'ChangeNickname', 'ManageNicknames', 'ManageRoles', 'ManageWebhooks',
  'ManageEmojisAndStickers', 'UseApplicationCommands', 'RequestToSpeak', 'ManageEvents',
  'ManageThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'UseExternalStickers',
  'SendMessagesInThreads', 'UseEmbeddedActivities', 'ModerateMembers', 'UseSoundboard',
  'SendVoiceMessages', 'SendPolls', 'AddReactions', 'UseExternalSounds', 'CreateEvents', 'ViewCreatorMonetizationAnalytics',
] as const;

export type PermName = (typeof PERM_NAMES)[number];

/* ------------------------------------------------------------------------ roles */

export type RoleKey =
  | 'notifGiveaway' | 'notifPartenaire' | 'booster' | 'partenaire' | 'membre'
  | 'animateur' | 'helper' | 'manager' | 'mod' | 'admin' | 'fondateur';

export interface RoleDef {
  key: RoleKey;
  /** Nom Discord exact, tel qu'il doit être écrit sur le serveur. */
  name: string;
  /** 0 = tout en bas de la hiérarchie. Sert SEULEMENT d'ordre logique Edge. */
  order: number;
  color: string;
  hoist: boolean;
  mentionable: boolean;
  perms: PermName[];
  /** Jamais attribuable/retirable par une commande publique. */
  protected?: boolean;
  /** Propose dans « 🎭│・Choisir-ses-rôles » : le membre l'ajoute lui-meme. */
  selfAssignable?: boolean;
  /** Auto-attribué par Edge, jamais par un humain via la selfrole panel. */
  autoOnly?: boolean;
}

/** Bas -> haut, exactement la table que tu as fournie (11 rôles). */
export const ROLE_DEFS: readonly RoleDef[] = [
  { key: 'notifGiveaway',   name: '🎁│ Notification Giveaway',   order: 0,  color: '#F1C40F', hoist: false, mentionable: false, perms: [], selfAssignable: true },
  { key: 'notifPartenaire', name: '🤝│ Notification Partenariat', order: 1, color: '#1ABC9C', hoist: false, mentionable: false, perms: [], selfAssignable: true },
  { key: 'booster',         name: '✨│ Booster',                 order: 2,  color: '#F47FFF', hoist: false, mentionable: false, perms: [] },
  { key: 'partenaire',      name: '🤝│ Partenaire',              order: 3,  color: '#2ECC71', hoist: false, mentionable: false, perms: [] },
  { key: 'membre',          name: '👤│ Membre',                  order: 4,  color: '#95A5A6', hoist: false, mentionable: false, perms: [] },
  { key: 'animateur',       name: '🎉│ Animateur',               order: 5,  color: '#FEE75C', hoist: true,  mentionable: false, perms: ['ManageEvents', 'MuteMembers', 'MoveMembers', 'ManageMessages', 'ManageThreads', 'MentionEveryone'] },
  { key: 'helper',          name: '🧰│ Helper',                  order: 6,  color: '#3498DB', hoist: true,  mentionable: false, perms: [], protected: true },
  { key: 'manager',         name: '💼│ Manager Partenariat',     order: 7,  color: '#E67E22', hoist: true,  mentionable: false, perms: ['MentionEveryone'], protected: true },
  { key: 'mod',             name: '⚔️│ Modérateur',              order: 8,  color: '#E67E22', hoist: true,  mentionable: false, perms: ['ViewAuditLog', 'ManageMessages', 'ManageThreads', 'ModerateMembers', 'KickMembers', 'BanMembers'], protected: true },
  { key: 'admin',           name: '🛡️│ Administrateur',          order: 9,  color: '#ED4245', hoist: true,  mentionable: false, perms: ['Administrator'], protected: true },
  { key: 'fondateur',       name: '👑│ Fondateur',               order: 10, color: '#FFD700', hoist: true,  mentionable: false, perms: ['Administrator'], protected: true },
];

export const ROLE_BY_KEY = new Map(ROLE_DEFS.map((r) => [r.key, r]));
export const roleDef = (k: RoleKey): RoleDef => ROLE_BY_KEY.get(k)!;
/** Niveau hiérarchique logique d'un rôle (-1 = inconnu, 0 = @everyone). */
export const roleLevel = (k: RoleKey | 'everyone'): number => (k === 'everyone' ? -1 : roleDef(k).order);

/** Rôles qu'Edge peut donner/retirer. Whitelist volontairement minuscule. */
export const ASSIGNABLE_ROLES: readonly RoleKey[] = ['membre', 'booster', 'partenaire', 'notifGiveaway', 'notifPartenaire'];

/** Rôles auto : l'humain ne peut jamais les poser via le panneau selfroles. */
export const SELF_ASSIGNABLE_ROLES: readonly RoleKey[] = ['notifGiveaway', 'notifPartenaire'];

/* ------------------------------------------------------------------- categories */

export type CategoryKey = 'info' | 'grotte' | 'activites' | 'vocal' | 'support' | 'tickets' | 'staff';

export interface CategoryDef {
  key: CategoryKey;
  name: string;
  /** Tout le monde voit (sauf tickets/staff). */
  private?: boolean;
  /** Salon publics : @everyone peut écrire. */
  overwrites?: { deny?: PermName[] };
}

export const CATEGORY_DEFS: readonly CategoryDef[] = [
  { key: 'info',      name: '📄│↦ INFORMATIONS' },
  { key: 'grotte',    name: '⛺│↦ LA GROTTE' },
  { key: 'activites', name: '🎪│↦ ACTIVITÉS' },
  { key: 'vocal',     name: '🔊│↦ VOCAUX' },
  { key: 'support',   name: '🎫│↦ SUPPORT' },
  { key: 'tickets',   name: '📁│↦ TICKETS', private: true },
  { key: 'staff',     name: '🔐│↦ STAFF', private: true },
];

/* ---------------------------------------------------------------------- salons */

export type ChannelKey =
  | 'reglement' | 'annonces' | 'giveaway' | 'boosts' | 'selfroles' | 'bienvenue'
  | 'invitations' | 'discussion' | 'presentations' | 'histoire' | 'media' | 'suggestions'
  | 'sondages' | 'graphisme' | 'musique' | 'montage' | 'gaming' | 'dev'
  | 'vGeneral' | 'vGaming' | 'vChill' | 'vMusique'
  | 'ticketOpen' | 'recrutement'
  | 'staffChat' | 'modLogs' | 'ticketLogs' | 'auditStaff' | 'signalements' | 'consignes';

export interface ChannelDef {
  key: ChannelKey;
  name: string;
  cat: CategoryKey;
  kind: 'text' | 'voice';
  /** 🔒 = SendMessages refusé à @everyone. */
  locked?: boolean;
  /** En plus du staff, qui a le droit d'écrire ici. */
  allow?: Partial<Record<RoleKey, PermName[]>>;
  topic?: string;
  /** Interdiction de poster autre chose que du média (media/gaming...). Réservé à du conseil humain. */
  slowmode?: number;
}

/** Le top du staff, par ordre : tout rôle >= mod peut écrire dans un salon 🔒. */
export const STAFF_SPEAK: readonly RoleKey[] = ['mod', 'admin', 'fondateur'];
/** Qui peut voir/écrire dans les tickets et le staff. */
export const TICKET_ACCESS: readonly RoleKey[] = ['helper', 'manager', 'mod', 'admin', 'fondateur'];
export const STAFF_ACCESS: readonly RoleKey[] = ['helper', 'manager', 'mod', 'admin', 'fondateur'];

export const CHANNEL_DEFS: readonly ChannelDef[] = [
  // 📄│↦ INFORMATIONS — lecture seule
  { key: 'reglement',   name: '📌│・Règlement', cat: 'info', kind: 'text', locked: true, topic: 'Le règlement d’Edge. Un bouton en bas pour dire que tu as compris.' },
  { key: 'annonces',    name: '📣│・Annonces', cat: 'info', kind: 'text', locked: true, topic: 'Annonces du serveur. Rien d’autre.' },
  { key: 'giveaway',    name: '🎁│・Giveaway', cat: 'info', kind: 'text', locked: true, allow: { animateur: ['SendMessages', 'SendMessagesInThreads'] }, topic: 'Giveaways. Réagis, gagne, sois poli.' },
  { key: 'boosts',      name: '✨│・Boosts', cat: 'info', kind: 'text', locked: true, topic: 'Merci aux boosters.' },
  { key: 'selfroles',   name: '🎭│・Choisir-ses-rôles', cat: 'info', kind: 'text', locked: true, topic: 'Clique pour choisir tes notifications.' },
  { key: 'bienvenue',   name: '👋│・Bienvenue', cat: 'info', kind: 'text', locked: true, topic: 'Les arrivants, en texte simple.' },

  // ⛺│↦ LA GROTTE — communauté
  { key: 'invitations',  name: '💌│・Invitations', cat: 'grotte', kind: 'text', topic: 'Tes liens d’invite, tes stats.' },
  { key: 'discussion',   name: '💬│・Discussion', cat: 'grotte', kind: 'text', slowmode: 3 },
  { key: 'presentations', name: '👋│・Présentations', cat: 'grotte', kind: 'text', topic: 'Bouton « Se présenter », pas de commande.' },
  { key: 'histoire',     name: '📖│・Histoire-sans-fin', cat: 'grotte', kind: 'text' },
  { key: 'media',        name: '👀│・Média', cat: 'grotte', kind: 'text' },
  { key: 'suggestions',  name: '🗳️│・Suggestions', cat: 'grotte', kind: 'text', topic: 'Une idée = un post. Vote, ne rale pas en silence.' },

  // 🎪│↦ ACTIVITÉS
  { key: 'sondages',  name: '📊│・Sondages', cat: 'activites', kind: 'text' },
  { key: 'graphisme', name: '🎨│・Graphisme', cat: 'activites', kind: 'text' },
  { key: 'musique',   name: '🎵│・Musique', cat: 'activites', kind: 'text' },
  { key: 'montage',   name: '🎬│・Montage', cat: 'activites', kind: 'text' },
  { key: 'gaming',    name: '🎮│・Gaming', cat: 'activites', kind: 'text' },
  { key: 'dev',       name: '💻│・Dev', cat: 'activites', kind: 'text' },

  // 🔊│↦ VOCAUX
  { key: 'vGeneral',  name: '🔊│ Général', cat: 'vocal', kind: 'voice' },
  { key: 'vGaming',   name: '🎮│ Gaming', cat: 'vocal', kind: 'voice' },
  { key: 'vChill',    name: '🌙│ Chill', cat: 'vocal', kind: 'voice' },
  { key: 'vMusique',  name: '🎵│ Musique', cat: 'vocal', kind: 'voice' },

  // 🎫│↦ SUPPORT
  { key: 'ticketOpen', name: '🎫│・Ouvrir-un-ticket', cat: 'support', kind: 'text', locked: true, topic: 'Un panneau, un menu, un ticket.' },
  { key: 'recrutement', name: '📖│・Recrutement Staff', cat: 'support', kind: 'text', locked: true, topic: 'Candidatures staff.' },

  // 🔐│↦ STAFF (privé)
  { key: 'staffChat',     name: '💬│・Staff-chat', cat: 'staff', kind: 'text' },
  { key: 'modLogs',       name: '🛡️│・Modération-logs', cat: 'staff', kind: 'text', locked: true },
  { key: 'ticketLogs',     name: '🎫│・Tickets-logs', cat: 'staff', kind: 'text', locked: true },
  { key: 'auditStaff',    name: '📋│・Audit-staff', cat: 'staff', kind: 'text', locked: true },
  { key: 'signalements',  name: '🚨│・Signalements', cat: 'staff', kind: 'text' },
  { key: 'consignes',     name: '📌│・Consignes-staff', cat: 'staff', kind: 'text', locked: true },
];

export const CHANNEL_BY_KEY = new Map(CHANNEL_DEFS.map((c) => [c.key, c]));
export const channelDef = (k: ChannelKey): ChannelDef => CHANNEL_BY_KEY.get(k)!;
export const channelsOf = (c: CategoryKey): ChannelDef[] => CHANNEL_DEFS.filter((x) => x.cat === c);
export const CATEGORY_BY_KEY = new Map(CATEGORY_DEFS.map((c) => [c.key, c]));
export const categoryDef = (k: CategoryKey): CategoryDef => CATEGORY_BY_KEY.get(k)!;

/* --------------------------------------------------- droits effectifs attendus */

export interface OverwriteSpec { allow: PermName[]; deny: PermName[] }
export interface ChannelAcl { everyone: OverwriteSpec; roles: Partial<Record<RoleKey, OverwriteSpec>>; bot?: OverwriteSpec }

const PUBLIC_SEND: PermName[] = ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'AddReactions', 'UseExternalEmojis'];
const VOICE_ACCESS: PermName[] = ['ViewChannel', 'Connect', 'Speak', 'UseVAD', 'Stream'];

/** L'ACL qu'Edge ATTEND pour chaque salon. Sert à l'audit de drift ET aux calculs de droits. */
export function expectedAcl(def: ChannelDef): ChannelAcl {
  const acl: ChannelAcl = { everyone: { allow: [], deny: [] }, roles: {} };
  const priv = def.cat === 'tickets' || def.cat === 'staff';

  if (def.kind === 'voice') {
    acl.everyone.allow.push(...VOICE_ACCESS);
  } else if ((def.cat === 'grotte' || def.cat === 'activites') && !priv) {
    acl.everyone.allow.push(...PUBLIC_SEND);
  } else {
    acl.everyone.allow.push('ViewChannel', 'ReadMessageHistory');
    acl.everyone.deny.push('SendMessages', 'SendMessagesInThreads', 'AddReactions');
  }

  if (priv) {
    acl.everyone.deny.push('ViewChannel');
    acl.everyone.allow = acl.everyone.allow.filter((p) => p !== 'ViewChannel' && p !== 'ReadMessageHistory');
    const targets = def.cat === 'tickets' ? TICKET_ACCESS : STAFF_ACCESS;
    // qui a le droit d'ecrire : tous les acces cotes dans les tickets, seulement
    // Mod+ / Admin / Fondateur dans un salon staff 🔒, tout le staff ailleurs.
    const writers: RoleKey[] = def.cat === 'tickets' ? [...targets] : def.locked ? [...STAFF_SPEAK] : [...STAFF_ACCESS];
    const staffSend: PermName[] = ['ViewChannel', 'ManageThreads', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'UseExternalEmojis'];
    for (const r of targets) {
      const canWrite = writers.includes(r);
      acl.roles[r] = canWrite
        ? { allow: [...new Set<PermName>([...staffSend, ...(def.cat === 'staff' ? (['ManageMessages'] as PermName[]) : [])])], deny: [] }
        : { allow: ['ViewChannel', 'ReadMessageHistory', 'AddReactions'] as PermName[], deny: ['SendMessages'] as PermName[] };
    }
  }

  // Edge doit pouvoir parler LA OU @everyone est muet : une autorite sur @everyone
  // s'applique aussi au bot, donc sans overwrite le salon 🔒 est infrequentable.
  if (def.kind === 'text') {
    acl.bot = {
      allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'AddReactions', 'UseExternalEmojis', ...(priv ? ['ManageMessages', 'ManageThreads', 'MentionEveryone'] : def.locked ? ['ManageMessages'] : [])] as PermName[],
      deny: [] as PermName[],
    };
  }

  // Un salon 🔒 n'est pas « muet pour tout le monde » : le staff qui doit parler y est
  // autorise explicitement (sinon Modere, qui n'a pas Administrator, ne peut plus rien poster).
  if (def.locked && !priv) {
    for (const r of STAFF_SPEAK) {
      const cur: OverwriteSpec = (acl.roles[r] ??= { allow: [], deny: [] });
      for (const p of ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ManageMessages'] as PermName[]) {
        if (!cur.allow.includes(p)) cur.allow.push(p);
      }
      cur.deny = cur.deny.filter((p) => !['SendMessages', 'SendMessagesInThreads', 'ViewChannel', 'ReadMessageHistory'].includes(p));
    }
  }

  for (const [role, perms] of Object.entries(def.allow ?? {}) as [RoleKey, PermName[]][]) {
    const cur = (acl.roles[role] ??= { allow: [], deny: [] });
    cur.allow.push(...perms);
    cur.deny = cur.deny.filter((p) => !perms.includes(p));
  }
  return acl;
}

/* --------------------------------------------------------------------- tickets */

export interface TicketOptionDef {
  key: string;
  label: string;
  emoji?: string;
  /** Rôle pingué à l'ouverture, selon l'option choisie. */
  ping: RoleKey;
  /** Rôles qui doivent pouvoir répondre en plus du staff classique. */
  extraAccess?: RoleKey[];
  description?: string;
  modalIntro: string;
}

/** UN SEUL panneau, UN SEUL menu déroulant, le bon rôle pingué selon l'option. */
export const TICKET_OPTIONS: readonly TicketOptionDef[] = [
  { key: 'support', label: '💬 Support général', ping: 'helper', description: 'Un souci, une question, un truc cassé.', modalIntro: 'Décris ton problème en quelques lignes.' },
  { key: 'partenariat', label: '🤝 Partenariat', ping: 'manager', extraAccess: ['manager'], description: 'Proposer ou gérer un partenariat.', modalIntro: 'Nom du serveur, membre visé, ce que tu proposes.' },
  { key: 'signalement', label: '🚨 Signaler un membre', ping: 'mod', description: 'Comportement problématique, en privé.', modalIntro: 'Qui, quoi, quand, preuve (lien de message).' },
  { key: 'sanction', label: '⚖️ Contester une sanction', ping: 'mod', description: 'Tu trouves un warn/timeout/ban injuste.', modalIntro: 'Sanction contestée, ce que tu veux corriger.' },
  { key: 'tech', label: '🛠️ Bug / technique', ping: 'helper', description: 'Un rôle qui saute, un lien mort, un bot muet.', modalIntro: 'Quel salon/rôle/commande, ce qui devait arriver.' },
  { key: 'autre', label: '❔ Autre demande', ping: 'helper', description: 'Tout le reste.', modalIntro: 'C’est quoi ta demande ?' },
];
export const ticketOption = (k: string): TicketOptionDef | undefined => TICKET_OPTIONS.find((o) => o.key === k);

/* ------------------------------------------------------------- permissions bot */

/** Ce qu'Edge doit avoir. PAS Administrator : granulaire uniquement. */
export const BOT_PERMISSIONS: PermName[] = [
  'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory',
  'AddReactions', 'UseExternalEmojis', 'ManageMessages', 'ManageThreads', 'MentionEveryone',
  'ManageChannels', 'ManageRoles', 'ManageNicknames', 'ChangeNickname',
  'ModerateMembers', 'KickMembers', 'BanMembers', 'ViewAuditLog',
  'ManageEvents', 'MoveMembers', 'MuteMembers', 'DeafenMembers',
  'Connect', 'Speak', 'UseApplicationCommands', 'ManageGuild', 'UseExternalSounds',
];

/** Le rôle Edge doit être placé entre 💼│ Manager Partenariat et ⚔️│ Modérateur. */
export const EDGE_ROLE_NAME = 'Edge';
export const EDGE_ROLE_MIN_ORDER: number = roleLevel('manager');
export const EDGE_ROLE_MAX_ORDER: number = roleLevel('mod');

/* ------------------------------------------------------------------ couleurs */

export const COLORS = {
  edge: 0x5865f2,
  ok: 0x57f287,
  warn: 0xfee75c,
  bad: 0xed4245,
  info: 0x3498db,
  ticket: 0x1abc9c,
  giveaway: 0xf1c40f,
  mod: 0xe67e22,
} as const;
