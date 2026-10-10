/**
 * Faux serveur Discord, fabrique a la main a partir du manifeste.
 * Sert a tester le resolveur et le rapport d'ecart sans token ni reseau
 * (npm run dry, npm test). Seules les methodes lues par structure.ts sont simulees.
 */
import { Collection, PermissionFlagsBits } from 'discord.js';
import {
  BOT_PERMISSIONS, CATEGORY_DEFS, CHANNEL_DEFS, EDGE_ROLE_NAME, PERM_NAMES, ROLE_DEFS,
  expectedAcl, type ChannelKey, type PermName, type RoleKey,
} from '../manifest.js';

/** Meme valeurs de bits que Discord (PermissionFlagsBits) : le rapport d'ecart compare des bigint. */
const toBits = (names: PermName[]): bigint => names.reduce<bigint>((acc, n) => acc | (PermissionFlagsBits as unknown as Record<string, bigint>)[n]!, 0n);
const NAME_OF = new Map<string, PermName>(PERM_NAMES.map((p) => [String((PermissionFlagsBits as unknown as Record<string, bigint>)[p]), p]));

const mkPerms = (input: readonly string[]) => {
  const names = input.filter((x): x is PermName => (PERM_NAMES as readonly string[]).includes(x));
  const bits = toBits(names);
  return {
    bitfield: names.includes('Administrator') ? (1n << 63n) - 1n : bits,
    has: (p: PermName | bigint) => names.includes('Administrator') || (typeof p === 'string' ? names.includes(p) : (bits & p) === p),
    toArray: () => names,
  };
};

export interface FakeOpts {
  /** Renommer un salon (name -> newName) pour simuler un humain qui touche a la structure. */
  renameChannel?: [ChannelKey, string];
  /** Oublier un role. */
  dropRole?: RoleKey;
  /** Oublier un salon. */
  dropChannel?: ChannelKey;
  /** Enlever ViewChannel refuse a @everyone dans une categorie privee (la fuite classique). */
  leakPrivate?: boolean;
  /** Role Edge au-dessus de Modérateur. */
  edgeTooHigh?: boolean;
  /** Edge sans MentionEveryone. */
  edgeNoMention?: boolean;
  /** Salon en plus, hors manifeste. */
  extraChannel?: string;
}

export function fakeGuild(o: FakeOpts = {}): any {
  const everyonePerms: PermName[] = ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'AddReactions', 'UseExternalEmojis', 'Connect', 'Speak', 'UseVAD', 'Stream', 'UseApplicationCommands', 'RequestToSpeak', 'CreatePublicThreads', 'CreatePrivateThreads'];
  const botPerms: PermName[] = o.edgeNoMention ? BOT_PERMISSIONS.filter((p) => p !== 'MentionEveryone') : BOT_PERMISSIONS;
  const roles: any[] = [];
  const rolesCache = new Collection<string, any>();
  rolesCache.set('1558076024778919946', { id: '1558076024778919946', name: '@everyone', permissions: mkPerms(everyonePerms), position: 0 });

  ROLE_DEFS.forEach((def, i) => {
    if (o.dropRole === def.key) return;
    const r = {
      id: `role-${def.key}`, name: def.name, color: parseInt(def.color.slice(1), 16), hexColor: def.color,
      hoist: def.hoist, mentionable: def.mentionable, permissions: mkPerms(def.perms), position: (i + 1) * 10,
      members: new Collection<string, any>(),
    };
    if (def.key === 'membre') r.members.set('u-membre', {});
    if (def.key === 'animateur') r.members.set('u-anim', {});
    if (def.key === 'helper') r.members.set('u-helper', {});
    if (def.key === 'manager') r.members.set('u-manager', {});
    if (def.key === 'mod') r.members.set('u-mod', {});
    if (def.key === 'admin') r.members.set('u-admin', {});
    roles.push(r);
    rolesCache.set(r.id, r);
  });

  const edgeRole = { id: 'role-edge', name: EDGE_ROLE_NAME, permissions: mkPerms(botPerms), position: o.edgeTooHigh ? 9999 : (ROLE_DEFS.findIndex((r) => r.key === 'manager') + 1) * 10 + 5, hoist: true, color: 0x5865f2, hexColor: '#5865f2', mentionable: false, members: new Collection<string, any>() };
  rolesCache.set(edgeRole.id, edgeRole);

  const GUILD = '1558076024778919946';
  const channels = new Collection<string, any>();
  for (const cat of CATEGORY_DEFS) {
    channels.set(`cat-${cat.key}`, { id: `cat-${cat.key}`, name: cat.name, type: 4, parentId: null, permissionOverwrites: { cache: new Map() } });
  }
  const ov = (id: string, allow: PermName[], deny: PermName[]) => ({ id, type: 0, allow: mkPerms(allow), deny: mkPerms(deny) });

  for (const def of CHANNEL_DEFS) {
    if (o.dropChannel === def.key) continue;
    const acl = expectedAcl(def);
    const name = o.renameChannel && o.renameChannel[0] === def.key ? o.renameChannel[1] : def.name;
    const ovCache = new Map<string, any>([[GUILD, ov(GUILD, acl.everyone.allow, acl.everyone.deny)]]);
    if (o.leakPrivate && (def.cat === 'tickets' || def.cat === 'staff')) {
      ovCache.set(GUILD, ov(GUILD, [...acl.everyone.allow, 'ViewChannel'], acl.everyone.deny.filter((p) => p !== 'ViewChannel')));
    }
    if (acl.bot) ovCache.set(edgeRole.id, ov(edgeRole.id, acl.bot.allow, acl.bot.deny));
    for (const [rk, spec] of Object.entries(acl.roles) as [RoleKey, { allow: PermName[]; deny: PermName[] }][]) {
      const role = rolesCache.get(`role-${rk}`);
      if (role) ovCache.set(role.id, { id: role.id, type: 0, allow: mkPerms(spec.allow), deny: mkPerms(spec.deny) });
    }
    const ch: any = {
      id: `ch-${def.key}`, name, type: def.kind === 'voice' ? 2 : 0, parentId: `cat-${def.cat}`, rateLimitPerUser: def.slowmode ?? 0,
      permissionOverwrites: { cache: ovCache, edit: async () => ch, delete: async () => ch },
      permissionsFor: (who: any) => {
        const key: string = typeof who === 'string' ? who : (who?.id ?? '');
        const isEdge = key === edgeRole.id || key === 'bot';
        const names = new Set<PermName>([...everyonePerms, ...(isEdge ? botPerms : [])]);
        const applyOv = (id: string): void => {
          const entry = ovCache.get(id);
          if (!entry) return;
          for (const p of entry.allow.toArray() as PermName[]) names.add(p);
          for (const p of entry.deny.toArray() as PermName[]) names.delete(p);
        };
        applyOv(GUILD);
        if (isEdge) { applyOv(edgeRole.id); return mkPerms([...names]); }
        // un Role ne porte que SA propre overwrite ; un membre cumule @everyone + ses roles
        if (!o && typeof who === 'object' && who?.roles?.cache) {
          const owned = new Set<string>([...who.roles.cache.keys() as Iterable<string>]);
          const sorted = [...ovCache.keys()].sort((a, b) => (rolesCache.get(a)?.position ?? -1) - (rolesCache.get(b)?.position ?? -1));
          for (const id of sorted) if (id !== GUILD && owned.has(id)) applyOv(id);
        } else if (key !== GUILD && !isEdge) {
          applyOv(key);
        }
        return mkPerms([...names]);
      },
    };
    channels.set(ch.id, ch);
  }
  if (o.extraChannel) {
    const id = `ch-extra`;
    channels.set(id, { id, name: o.extraChannel, type: 0, parentId: 'cat-grotte', permissionOverwrites: { cache: new Map() }, permissionsFor: () => mkPerms(everyonePerms) });
  }

  const me = { id: 'bot', roles: { highest: edgeRole, cache: new Collection<string, any>([[edgeRole.id, edgeRole]]), add: async () => me, remove: async () => me }, permissions: mkPerms(botPerms), send: async () => ({}) };
  for (const [, ch] of channels) if (ch.type !== 4) { /* rien */ }

  const guild: any = {
    id: GUILD, name: 'Edge (serveur)', ownerId: 'u-owner', memberCount: 128, vanityURLCode: null,
    roles: { cache: rolesCache, highest: { position: 99 }, create: async () => ({}), everyone: rolesCache.get(GUILD) },
    channels: { cache: channels },
    members: {
      me,
      fetch: async (who: string) => {
        const cache = new Collection<string, any>();
        cache.set(edgeRole.id, edgeRole);
        const m = rolesCache.get('role-membre');
        if (m) cache.set(m.id, m);
        return {
          id: who,
          user: { id: who, username: who, bot: false, tag: `${who}#0`, createdTimestamp: Date.now() },
          roles: { cache, add: async () => undefined, remove: async () => undefined, highest: edgeRole },
          permissions: mkPerms(everyonePerms),
          send: async () => ({}),
          timeout: async () => undefined,
          kick: async () => undefined,
          ban: async () => undefined,
          joinedAt: new Date(),
          voice: { setChannel: async () => undefined, setMute: async () => undefined },
        };
      },
    },
    invites: { cache: new Map<string, any>() },
    scheduledEvents: { create: async () => ({}), fetch: async () => null },
    fetchAuditLogs: async () => ({ entries: [] }),
  };
  guild.channels.cache.filter = (fn: (c: any) => boolean) => {
    const out = new Collection<string, any>();
    for (const [k, v] of channels) if (fn(v)) out.set(k, v);
    return out;
  };
  for (const [, ch] of channels) if (ch.type !== 4) {
    const cat = channels.get(ch.parentId);
    if (cat) { cat.children ??= { cache: new Collection<string, any>() }; cat.children.cache.set(ch.id, ch); }
  }
  return guild;
}
