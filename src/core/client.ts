/** Demarrage d'Edge : client, structure, BDD, modules, commandes, listeners, ordonnanceur. */
import { ActivityType, Client, GatewayIntentBits, Partials } from 'discord.js';
import { dbUrlProblem, env } from '../env.js';
import {
  BOT_PERMISSIONS, GUILD_ID, type CategoryKey, type ChannelKey, type PermName, type RoleKey,
  categoryDef, channelDef, roleDef,
} from '../manifest.js';
import { Db } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { Logger } from './logger.js';
import { driftReport, resolveStructure, type Drift, type Resolved } from './structure.js';
import { Scheduler } from './scheduler.js';
import { buildDispatch, handleInteraction, syncCommands, type Dispatch } from './dispatch.js';
import { bits } from './perms.js';
import { onLog, type LogKind } from './logs.js';
import type { Ctx, EdgeModule } from './module.js';
import { type TextChannel, type VoiceChannel, ChannelType } from 'discord.js';

const log = new Logger('boot');

export const INVITE_SCOPES = 'bot%20applications.commands';
export const inviteUrl = (clientId: string): string =>
  `https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=${INVITE_SCOPES}&permissions=${bits(BOT_PERMISSIONS).toString()}`;

export function makeClient(content: boolean): Client {
  const intents = [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildVoiceStates,
  ];
  if (content) intents.push(GatewayIntentBits.MessageContent);
  return new Client({
    intents,
    partials: [Partials.Message, Partials.GuildScheduledEvent, Partials.Reaction, Partials.User],
    allowedMentions: { parse: ['users'], repliedUser: false },
  });
}

export interface Boot {
  client: Client<true>;
  ctx: Ctx;
  dispatch: Dispatch;
  sched: Scheduler;
  drift: Drift[];
  disabled: Map<string, string>;
  db: Db;
}

/** Le seul serveur que Edge accepte. */
const ONLY_GUILD = env.GUILD_ID || GUILD_ID;

export async function boot(modules: EdgeModule[], onProgress?: (why: string) => void): Promise<Boot> {
  const client = makeClient(env.contentIntent);
  client.on('error', (e) => log.error('client', e.message));
  client.on('shardDisconnect', () => log.warn('shard déconnecté, reconnexion en cours…'));
  client.rest.on('rateLimited', (info) => log.warn(`rate limit ${info.route} : pause ${info.timeToReset}ms`));

  let echec: (e: Error) => void = () => void 0;
  const pret = new Promise<Boot>((resolve, reject) => {
    echec = reject;
    client.once('ready', (c) => {
      onProgress?.('structure, base de données, commandes…');
      start(c as Client<true>, modules, onProgress).then(resolve, (e) => reject(e instanceof Error ? e : new Error(String(e))));
    });
  });

  onProgress?.('connexion à Discord…');
  try {
    await client.login(env.DISCORD_TOKEN);
  } catch (e) {
    await client.destroy().catch(() => void 0);
    const m = (e as Error).message ?? String(e);
    throw new Error(/401|invalid session|Unauthorized/i.test(m)
      ? 'DISCORD_TOKEN refusé par Discord (401). Regenerate-le dans le Developer Portal, puis redémarre.'
      : `Discord injoignable : ${m}`);
  }
  try {
    // Un bot qui ne voit aucun serveur en 25 s est en fait un bot pas invite, ou des
    // intents non coches : on le dit, on se deconnecte, et le lanceur reessaiera.
    return await Promise.race([pret, echecApres(25_000, 'aucun serveur visible en 25 s : Edge est-il invite sur le serveur (GUILD_ID) ? les 3 intents sont-ils coches ?')]);
  } catch (e) {
    await client.destroy().catch(() => void 0);
    throw e;
  }
}

function echecApres(ms: number, msg: string): Promise<never> {
  return new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error(msg)), ms); t.unref?.(); });
}

async function start(client: Client<true>, modules: EdgeModule[], onProgress?: (why: string) => void): Promise<Boot> {
  log.info(`connecté en ${client.user.tag}`);
  const guild = client.guilds.cache.get(ONLY_GUILD) ?? (await client.guilds.fetch(ONLY_GUILD).catch(() => null));
  if (!guild) {
    log.error(`Edge n'est pas sur ${ONLY_GUILD}. Invite-le avec : ${inviteUrl(client.application.id)}`);
    throw new Error('guild absente');
  }
  if (!guild.available) { await guild.fetch(); }

  onProgress?.('base de données…');
  const souci = dbUrlProblem(env.DATABASE_URL);
  if (souci) log.error(`DATABASE_URL invalide : ${souci}\n   → Edge démarre quand même, en mémoire : tout est oublié au redémarrage (tickets, points, giveaways, dossiers).`);
  const db = env.DATABASE_URL && !souci ? Db.pool(env.DATABASE_URL) : Db.memory();
  if (!db.isPersisted) log.warn(souci ? 'stockage en mémoire (DATABASE_URL rejetée).' : 'DATABASE_URL absente => stockage en mémoire uniquement (tout se perd au restart).');
  else await migrate(db);

  const s = resolveStructure(guild);
  const sched = new Scheduler(() => ctx!);
  const disabled = new Map<string, string>();

  const needsCache = new Map<string, Promise<boolean>>();
  const flagCache = new Map<string, { v: boolean; t: number }>();
  const ctx: Ctx = {
    client, guild, db, sched, s, log: new Logger('edge'), content: env.contentIntent, disabled,
    on: (key: string) => {
      if (disabled.has(key)) return Promise.resolve(false);
      const hit = flagCache.get(key);
      if (hit && hit.t > Date.now()) return Promise.resolve(hit.v);
      const p = db.flags.isOn(`module:${key}`, true).then((v) => ({ v, t: Date.now() + 20_000 })).then((x) => { flagCache.set(key, x); return x.v; });
      needsCache.set(key, p);
      return p;
    },
  };

  // 1) ecarts de structure
  const drift = driftReport(s);
  for (const d of drift) (d.level === 'error' ? log.error : d.level === 'warn' ? log.warn : log.info)(`[${d.area}] ${d.what}${d.expected ? ` (attendu ${d.expected}, réel ${d.got ?? '?'})` : ''}`);

  // 2) modules dont une dependance manque => desactives avec motif
  for (const m of modules) {
    const why = reason(m, s, ctx);
    if (why) { disabled.set(m.key, why); log.warn(`module « ${m.label} » désactivé : ${why}`); }
  }

  // 3) commandes
  onProgress?.(`${modules.length} modules : commandes…`);
  const dispatch = buildDispatch(ctx, modules);
  const { n, skipped } = await syncCommands(ctx, dispatch);
  log.ok(`${n} commandes synchronisées sur la guilde ${skipped ? '(inchangées)' : ''}`);

  // 4) listeners + jobs + panneaux + rattrapage
  client.on('interactionCreate', (i) => void handleInteraction(ctx, dispatch, i));
  for (const m of modules) {
    if (disabled.has(m.key)) continue;
    for (const l of m.listeners?.(ctx) ?? []) (client as unknown as { on: (e: string, f: (...a: never[]) => void) => void }).on(l.event, (...a: never[]) => void safeRun(m.key, () => l.run(ctx, ...a), l.once));
    for (const j of m.jobs?.(ctx) ?? []) sched.register(j);
  }
  sched.register({ kind: 'sweep', everyMs: 15 * 60_000, run: async () => { await sweep(ctx); } });

  for (const m of modules) {
    if (disabled.has(m.key)) continue;
    await safeRun(m.key, () => m.panels?.(ctx));
    await safeRun(m.key, () => m.sync?.(ctx));
  }

  wireLogSinks(ctx);
  sched.start();
  await client.user.setPresence({ activities: [{ name: `${guild.name} · /aide`, type: ActivityType.Watching }], status: 'online' });
  onProgress?.('');
  log.ok(`${modules.length - disabled.size}/${modules.length} modules actifs · ${s.guild.channels.cache.size} salons vus · ${s.missingChannels.length} manquant(s)`);
  return { client, ctx, dispatch, sched, drift, disabled, db };
}

function safeRun(scope: string, fn?: () => unknown, once?: boolean): Promise<void> {
  return Promise.resolve()
    .then(async () => { await fn?.(); })
    .catch((e: Error) => { log.error(`${scope}${once ? ' (once)' : ''} : ${e.message}`); });
}

/** Une dependance manquante => on coupe le module, on ne plante pas le bot. */
export function reason(m: EdgeModule, s: Resolved, ctx: Ctx): string | null {
  const n = m.needs ?? {};
  const missR = (n.roles ?? []).filter((k: RoleKey) => !s.roles[k]).map((k: RoleKey) => roleDef(k).name);
  if (missR.length) return `rôles absents : ${missR.join(', ')}`;
  const missC = (n.channels ?? []).filter((k: ChannelKey) => !s.channels[k]).map((k: ChannelKey) => channelDef(k).name);
  if (missC.length) return `salons absents : ${missC.join(', ')}`;
  const missCat = (n.categories ?? []).filter((k: CategoryKey) => !s.categories[k]).map((k: CategoryKey) => categoryDef(k).name);
  if (missCat.length) return `catégories absentes : ${missCat.join(', ')}`;
  const missP = (n.perms ?? []).filter((p: PermName) => !s.guild.members.me?.permissions.has(bits([p])));
  if (missP.length) return `permissions bot manquantes : ${missP.join(', ')}`;
  if (n.content && !ctx.content) return 'intent MessageContent non accordé (automod/XP coupés)';
  return null;
}

/** Nettoyage periodique : tables qui sinuent sinon. */
async function sweep(ctx: Ctx): Promise<void> {
  const cut = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
  await ctx.db.delete('bot_events', {} as never).catch(() => void 0).finally(async () => {
    // bot_events: on ne garde que 30 jours (les lignes plus vieilles sont virees en SQL reel)
    if (ctx.db.isPersisted) await ctx.db.raw('DELETE FROM bot_events WHERE created_at < $1', [cut.toISOString()]).catch(() => void 0);
  });
  await ctx.db.delete('automod_hits', {} as never).catch(() => void 0);
}

function wireLogSinks(ctx: Ctx): void {
  const route: Record<LogKind, ChannelKey | null> = { moderation: 'modLogs', ticket: 'ticketLogs', staff: 'auditStaff', ops: 'staffChat' };
  for (const [kind, chKey] of Object.entries(route) as [LogKind, ChannelKey | null][]) {
    if (!chKey) continue;
    onLog(kind, async (_k, line) => {
      if (line.length < 3) return;
      const ch = ctx.s.channel(chKey) as TextChannel | VoiceChannel | null;
      if (!ch || ch.type === ChannelType.GuildVoice) return;
      if (!(await ctx.db.flags.isOn(`log:${kind}`, true))) return;
      await ch.send({ content: line.slice(0, 1990), allowedMentions: { parse: [] } }).catch(() => void 0);
    });
  }
}
