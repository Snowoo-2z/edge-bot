/** Demarrage d'Edge : client, structure, BDD, modules, commandes, listeners, ordonnanceur. */
import { ActivityType, Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { dbUrlProblem, env, jwtRole, supabaseProblem } from '../env.js';
import {
  BOT_PERMISSIONS, GUILD_ID, type CategoryKey, type ChannelKey, type PermName, type RoleKey,
  categoryDef, channelDef, roleDef,
} from '../manifest.js';
import { Db } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { Logger } from './logger.js';
import { Config, construireRegistre, REGLAGES_GENERAL } from './settings.js';
import { driftReport, resolveStructure, type Drift, type Resolved } from './structure.js';
import { Scheduler } from './scheduler.js';
import { buildDispatch, handleInteraction, syncCommands, type Dispatch } from './dispatch.js';
import { bits } from './perms.js';
import { onLog, type LogKind } from './logs.js';
import { canalSelon, definirStyle } from './send.js';
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
    // Events.ClientReady (et pas la chaine 'ready') : v14.16 a renomme l'evenement, l'ancien
    // nom emet encore mais pollue les logs d'un DeprecationWarning a chaque demarrage.
    client.once(Events.ClientReady, (c) => {
      onProgress?.('structure, base de données, commandes…');
      start(c, modules, onProgress).then(resolve, (e) => reject(e instanceof Error ? e : new Error(String(e))));
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
  const db = ouvrirBase(log);
  if (!db.isPersisted) {
    log.warn('aucune base joignable => stockage en mémoire uniquement (tout se perd au restart).');
  } else if (db.mode === 'rest') {
    // Le schema vient du fichier SQL colle dans l'editeur : on ne migre pas, on VERIFIE.
    const etat = await verifierSchemaSupabase(db, log);
    if (etat && etat.manquantes?.length) {
      log.error(`schéma incomplet dans Supabase : ${etat.manquantes.join(', ')} — recolle supabase/schema.sql dans l'éditeur SQL puis relance.`);
    } else if (etat) {
      const total = Object.values(etat.lignes ?? {}).reduce((a, b) => a + Number(b), 0);
      log.ok(`base : API Supabase · ${Object.keys(etat.lignes ?? {}).length} tables · ${total} lignes`);
    }
  } else {
    await migrate(db);
  }

  const s = resolveStructure(guild);
  const sched = new Scheduler(() => ctx!);
  const disabled = new Map<string, string>();

  const needsCache = new Map<string, Promise<boolean>>();
  const flagCache = new Map<string, { v: boolean; t: number }>();
  const registre = construireRegistre(modules);
  registre.set('general', new Map(REGLAGES_GENERAL.map((d) => [d.cle, d])));
  const cfg = new Config(db, registre, (m) => {
    if (m === 'general') void appliquerStyle();
    // Un texte de panneau regle depuis /edge config doit se voir dans le salon, pas seulement
    // dans la base : on redemande le panneau du module concerne (idempotent, a chaud).
    const mod = modules.find((x) => x.key === m);
    if (mod?.panels) void safeRun('panneaux ' + m, () => mod.panels!(ctx));
  });

  /**
   * Le style global (couleur, pied de page, pings de roles) est lu au demarrage puis re-pose a
   * chaque reglage de `general` : les modules passent tous par embed()/say(), donc ils heritent
   * du choix sans avoir a le connatre.
   */
  const appliquerStyle = async (): Promise<void> => {
    const g = cfg.pour('general');
    definirStyle({
      couleur: await g.couleur('couleur'),
      pied: (await g.str('pied_de_page')) || `${guild.name} · Edge`,
      pingsRoles: await g.bool('pings_roles'),
    });
  };

  const ctx: Ctx = {
    client, guild, db, sched, s, log: new Logger('edge'), content: env.contentIntent, disabled,
    cfg, reglages: (m: string) => cfg.pour(m),
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
  for (const d of drift) {
    const ligne = `[${d.area}] ${d.what}${d.expected ? ` (attendu ${d.expected}, réel ${d.got ?? '?'})` : ''}`;
    if (d.level === 'error') log.error(ligne);
    else if (d.level === 'warn') log.warn(ligne);
    else log.info(ligne);
  }

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

  await appliquerStyle();
  wireLogSinks(ctx);
  sched.start();
  await client.user.setPresence({ activities: [{ name: `${guild.name} · /aide`, type: ActivityType.Watching }], status: 'online' });
  onProgress?.('');
  log.ok(`${modules.length - disabled.size}/${modules.length} modules actifs · ${s.guild.channels.cache.size} salons vus · ${s.missingChannels.length} manquant(s)`);
  return { client, ctx, dispatch, sched, drift, disabled, db };
}

/**
 * Un code d'erreur Discord seul ne sert a rien a distance : on dit quoi regler.
 * 50013 = « Missing Permissions » = presque toujours la position du role Edge dans la hierarchie,
 * ou une autorisation de salon ou le role n'est pas cite.
 */
export function decrire(e: unknown): string {
  const err = e as { message?: string; code?: number };
  const msg = err?.message ?? String(e);
  if (err?.code === 50013 || /missing permissions/i.test(msg)) {
    return msg + ' — permission manquante pour le rôle Edge : vérifie sa position (Server Settings →'
      + ' Roles → Edge juste sous ⚔️│ Modérateur) et qu’il est bien autorisé dans le salon visé'
      + ' (la liste complète des écarts est dans /audit structure)';
  }
  return err?.code ? `${msg} (code API ${err.code})` : msg;
}

function safeRun(scope: string, fn?: () => unknown, once?: boolean): Promise<void> {
  return Promise.resolve()
    .then(async () => { await fn?.(); })
    .catch((e: unknown) => { log.error(`${scope}${once ? ' (once)' : ''} : ${decrire(e)}`); });
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
    // En mode API il n'y a pas de SQL brut : la fonction edge_prune_events fait le menage.
    if (ctx.db.isPersisted) await ctx.db.rpc('edge_prune_events', { p_older_than: cut.toISOString() }).catch(() => void 0);
  });
  await ctx.db.delete('automod_hits', {} as never).catch(() => void 0);
}

/** Ou chaque sorte de ligne de log doit atterrir : reglable sans redemarrer (/edge config). */
const ROUTES_LOG: Record<LogKind, [string, ChannelKey, string]> = {
  moderation: ['salon_moderation', 'modLogs', 'journal_moderation'],
  ticket: ['salon_tickets', 'ticketLogs', 'journal_tickets'],
  staff: ['salon_audit', 'auditStaff', 'journal_staff'],
  ops: ['salon_journal', 'staffChat', 'journal_bot'],
};

function wireLogSinks(ctx: Ctx): void {
  for (const [kind, [cle, defaut, active]] of Object.entries(ROUTES_LOG) as [LogKind, [string, ChannelKey, string]][]) {
    onLog(kind, async (_k, line) => {
      if (line.length < 3) return;
      // Une seule bascule pour les 23 modules, dans /edge config voir general (cle de flags
      // historique log:<kind> conservee : ce qui etait coupe le reste).
      if (!(await ctx.cfg.valeur('general', active))) return;
      let ch: TextChannel | null = null;
      try { ch = await canalSelon(ctx, await ctx.cfg.valeur('general', cle), defaut); } catch { return; }
      if (!ch) return;
      await ch.send({ content: line.slice(0, 1990), allowedMentions: { parse: [] } }).catch(() => void 0);
    });
  }
}


/**
 * Choix du moteur de persistance, dans l'ordre : API Supabase (SUPABASE_URL + cle), puis
 * connexion directe (DATABASE_URL), puis memoire. Chaque rejet est EXPLIQUE dans les logs :
 * une variable mal remplie ne doit jamais ressembler a une panne de Discord.
 */
export function ouvrirBase(log: Logger): Db {
  const pbSupa = supabaseProblem({ SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY, SUPABASE_KEY: process.env.SUPABASE_KEY });
  if (pbSupa) {
    log.error(`config Supabase incomplète : ${pbSupa}\n   → Edge démarre quand même${env.DATABASE_URL ? ', sur DATABASE_URL.' : ' en mémoire : tout est oublié au redémarrage (tickets, points, giveaways, dossiers).'}`);
  }
  if (env.supabase && !pbSupa) {
    const role = jwtRole(env.supabase.key);
    log.info(`base : API Supabase · ${env.supabase.url.replace(/^https:\/\//, '')} · schéma ${env.supabase.schema}${role && role !== 'service_role' ? ` · ⚠ clé de rôle ${role}` : ''}`);
    return Db.rest({ ...env.supabase, log: (m: string) => log.warn(m) });
  }
  const souci = dbUrlProblem(env.DATABASE_URL);
  if (souci) {
    log.error(`DATABASE_URL invalide : ${souci}\n   → Edge démarre quand même, en mémoire : tout est oublié au redémarrage (tickets, points, giveaways, dossiers).`);
    return Db.memory();
  }
  if (env.DATABASE_URL) { log.info('base : Postgres direct (pg)'); return Db.pool(env.DATABASE_URL); }
  return Db.memory();
}



/** `edge_schema_check()` — renvoie null si la fonction n'existe pas encore (vieux schema). */
async function verifierSchemaSupabase(db: Db, log: Logger): Promise<{ manquantes?: string[]; lignes?: Record<string, number> } | null> {
  try {
    return await db.rpc1<{ manquantes?: string[]; lignes?: Record<string, number> }>('edge_schema_check');
  } catch (e) {
    log.error(`je n'ai pas pu vérifier le schéma (${(e as Error).message})`);
    return null;
  }
}
