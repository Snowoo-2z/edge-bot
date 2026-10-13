const { Client, GatewayIntentBits, Events, Partials, RESTEvents, Options } = require('discord.js');
const { handleConfigCommand, handleConfigInteraction } = require('./config');
const ticket = require('./modules/ticket');
const welcome = require('./modules/welcome');
const leveling = require('./leveling');
const suggestions = require('./modules/suggestions');
const economy = require('./modules/economy');
const links = require('./modules/links');
const ai = require('./modules/ai');
const giveaways = require('./modules/giveaways');
const logs = require('./modules/logs');
const moderation = require('./modules/moderation');
const { registerLogEvents } = require('./log-events');
const reactionRoles = require('./modules/reaction-roles');
const security = require('./modules/security');
const agent = require('./modules/agent');
const backups = require('./backup');
const { handleServerCommand } = require('./server-info');
const { buildModerationCommands } = require('./moderation-commands');
const { ephemeralPayload } = require('./ui');
const { startServer } = require('./server');
const { createDashboard } = require('./dashboard');
const { startKeepAlive } = require('./keepalive');

const store = require('./store');

// Variables d'environnement requises (à définir dans Render > Environment).
const REQUIRED_ENV = ['DISCORD_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Variables d'environnement manquantes : ${missing.join(', ')}`);
  process.exit(1);
}
const token = process.env.DISCORD_TOKEN;

// Une tentative de connexion dure au plus 2 min (discord.js attend lui-même une éventuelle limite de débit).
// Entre deux tentatives, on attend 60 s, puis le délai double à chaque échec (plafond 10 min)
// pour ne pas maintenir la limite de débit de Discord.
const LOGIN_TRY_MS = 120_000;
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 600_000;

// Client Discord courant (recréé à chaque tentative de connexion).
let bot = null;

const MODERATION_COMMANDS = new Set(buildModerationCommands().map((c) => c.name));

function buildClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // GuildMembers : arrivée des membres (module Bienvenue). Intent privilégié à activer.
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      // GuildModeration : bans et débans (journal + commandes). Intent non privilégié.
      GatewayIntentBits.GuildModeration,
      // GuildVoiceStates : suivi du temps passé en vocal (niveaux). Intent non privilégié.
      GatewayIntentBits.GuildVoiceStates,
      // GuildMessageReactions : panneaux de rôles par réaction (module Rôles par réaction).
      GatewayIntentBits.GuildMessageReactions,
      // MessageContent : pièces jointes (import image / GIF). Intent privilégié à activer.
      GatewayIntentBits.MessageContent,
    ],
    // Partials : messages et salons non présents en cache (suppressions et modifications
    // d'anciens messages restent journalisées).
    // Reaction et User : réactions sur d'anciens messages (panneaux de rôles après redémarrage).
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    // Mémoire bornée : le bot ne relit que les messages récents (journal des modifications, panneaux de rôles).
    // Membres, salons et rôles restent entièrement en cache (utilisés partout, sans appel réseau).
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 100,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 900, lifetime: 1800 }, // toutes les 15 min : messages de plus de 30 min
    },
  });
  registerHandlers(client);
  return client;
}

function registerHandlers(client) {
  // Détail de la connexion (gateway, shard, reconnexions). Les heartbeats et le token sont exclus.
  client.on(Events.Debug, (message) => {
    const firstLine = String(message).split('\n')[0].trim();
    if (/heartbeat|token/i.test(firstLine)) return;
    console.log(`[debug] ${firstLine.slice(0, 300)}`);
  });

  // Cycle de vie de la connexion (coupures et reconnexions).
  client.on(Events.ShardReady, (id) => console.log(`[discord] shard ${id} prêt`));
  client.on(Events.ShardDisconnect, (event, id) => console.warn(`[discord] shard ${id} déconnecté (code ${event?.code})`));
  client.on(Events.ShardReconnecting, (id) => console.log(`[discord] shard ${id} : reconnexion…`));
  client.on(Events.ShardResume, (id) => console.log(`[discord] shard ${id} : session reprise`));

  // Erreurs de passerelle. Un intent privilégié non activé dans le portail empêche la connexion
  // sans planter le processus : on le signale explicitement.
  client.on(Events.ShardError, (error) => {
    console.error('[discord] Erreur de connexion :', error);
    const message = error?.message ?? String(error);
    if (/disallowed intents/i.test(message)) {
      console.error(
        '[discord] Intent privilégié refusé. Portail développeur → Bot → Privileged Gateway Intents : ' +
          'active MESSAGE CONTENT INTENT et SERVER MEMBERS INTENT (le bot réessaiera automatiquement).',
      );
    }
  });

  client.on(Events.Warn, (message) => console.warn('[discord] avertissement :', message));
  // Limites de débit REST : une attente ici retarde toutes les réponses aux interactions.
  client.rest.on(RESTEvents.RateLimited, (info) =>
    console.warn(`[rest] limite de débit : ${info.method} ${info.route} (attente ${Math.ceil(info.timeToReset / 1000)} s, global ${info.global})`),
  );
  client.on(Events.Error, (error) => console.error('[discord] erreur client :', error?.message ?? error));

  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.VoiceStateUpdate, (oldState, newState) => leveling.onVoiceStateUpdate(oldState, newState));
  client.on(Events.MessageCreate, (message) => leveling.onMessage(message));
  client.once(Events.ClientReady, (c) => leveling.scanVoice(c));

  ticket.registerEvents(client);
  welcome.registerEvents(client);
  links.registerEvents(client);
  ai.registerEvents(client);
  suggestions.registerEvents(client);
  giveaways.registerEvents(client);
  economy.registerEvents(client);
  registerLogEvents(client);
  reactionRoles.registerEvents(client);
  security.registerEvents(client);
}

// Journal des interactions reçues : permet de voir si Discord les transmet au bot.
function describeInteraction(interaction) {
  if (interaction.isChatInputCommand()) return `commande /${interaction.commandName}`;
  if (interaction.isModalSubmit()) return `modale ${interaction.customId}`;
  return `${interaction.componentType ? 'composant' : 'interaction'} ${interaction.customId ?? ''}`;
}

async function handleInteraction(interaction) {
  const started = Date.now();
  const label = describeInteraction(interaction);
  console.log(`[interaction] reçue : ${label} (${interaction.guildId ?? 'MP'})`);
  // Discord annule une interaction sans réponse au bout de 3 s (« l'application ne répond pas »).
  const watchdog = setTimeout(() => {
    if (!interaction.replied && !interaction.deferred) {
      console.warn(`[interaction] pas encore acquittée après 2,5 s : ${label}`);
    }
  }, 2500);
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'config') return await handleConfigCommand(interaction);
      if (interaction.commandName === 'level') return await leveling.handleLevel(interaction);
      if (interaction.commandName === 'leaderboard') {
        // /leaderboard : Edge Dollar par défaut ; /leaderboard type:XP pour le classement XP (niveau et vocal).
        if (interaction.options.getString('type') === 'xp') return await leveling.handleLeaderboard(interaction);
        return await economy.handleLeaderboard(interaction);
      }
      if (interaction.commandName === 'suggestion') return await suggestions.handleCommand(interaction);
      if (interaction.commandName === 'giveaway') return await giveaways.handleCommand(interaction);
      if (['play', 'daily', 'profile', 'rob'].includes(interaction.commandName)) return await economy.handleCommand(interaction);
      if (interaction.commandName === 'server') return await handleServerCommand(interaction);
      if (interaction.commandName === 'agent') return await agent.handleCommand(interaction);
      if (MODERATION_COMMANDS.has(interaction.commandName)) return await moderation.handleCommand(interaction);
      return;
    }

    const id = interaction.customId ?? '';
    if (id.startsWith('cfg:')) return await handleConfigInteraction(interaction);
    if (id.startsWith('tkt:')) return await ticket.handlePublicInteraction(interaction);
    if (id.startsWith('suggest:')) return await suggestions.handleInteraction(interaction);
    if (id.startsWith('giveaway:')) return await giveaways.handleInteraction(interaction);
    if (id.startsWith('eco:')) return await economy.handleInteraction(interaction);
    if (id.startsWith('agent:')) return await agent.handleInteraction(interaction);
  } catch (err) {
    console.error('Erreur interaction :', err);
    const payload = ephemeralPayload('❌ Une erreur est survenue.');
    const reply = interaction.deferred || interaction.replied
      ? interaction.followUp(payload)
      : interaction.reply(payload);
    reply.catch(() => {});
  } finally {
    clearTimeout(watchdog);
    const ms = Date.now() - started;
    const acked = interaction.replied || interaction.deferred;
    console.log(`[interaction] ${label} traitée en ${ms} ms (acquittée : ${acked ? 'oui' : 'non'})`);
    if (ms > 2500) console.warn(`[interaction] traitement lent : ${ms} ms`);
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Erreurs qui ne se résoudront pas en réessayant (token invalide ou refusé).
function isAuthError(err) {
  return err?.code === 'TokenInvalid' || err?.status === 401 || /invalid token|401/i.test(err?.message ?? '');
}

// Diagnostic réseau (une seule fois au démarrage) : l'API Discord répond-elle, et sous quelle limite ?
// Retourne le délai (en secondes) imposé par Discord, ou 0.
async function probeDiscord() {
  const started = Date.now();
  try {
    const res = await fetch('https://discord.com/api/v10/gateway', { signal: AbortSignal.timeout(10_000) });
    const retryAfter = Number(res.headers.get('retry-after'));
    const scope = res.headers.get('x-ratelimit-scope');
    console.log(
      `[probe] discord.com/api/v10/gateway : HTTP ${res.status} en ${Date.now() - started} ms` +
        (res.status === 429 ? ` (limite de débit : retry-after ${retryAfter || '?'} s, portée ${scope ?? '?'})` : ''),
    );
    return res.status === 429 && retryAfter > 0 ? retryAfter : 0;
  } catch (err) {
    const cause = err.cause?.code ?? err.cause?.message ?? err.name ?? err.message;
    console.warn(`[probe] discord.com injoignable après ${Date.now() - started} ms : ${cause}`);
    return 0;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Essaie de se connecter à Discord, avec un client neuf à chaque tentative et une pause qui s'allonge.
async function connectWithRetry() {
  let pauseMs = RETRY_MIN_MS;
  for (let attempt = 1; ; attempt++) {
    const client = buildClient();
    bot = client;

    const readyP = new Promise((resolve) => {
      client.once(Events.ClientReady, (c) => {
        console.log(`Edge connecté en tant que ${c.user.tag} (tentative n°${attempt}).`);
        resolve('ready');
      });
    });
    const loginP = client.login(token).then(
      () => 'login-ok',
      (error) => ({ error }),
    );
    const timeoutP = new Promise((resolve) => setTimeout(() => resolve('timeout'), LOGIN_TRY_MS));

    console.log(`[discord] Tentative de connexion n°${attempt} (délai ${LOGIN_TRY_MS / 1000} s)…`);
    const result = await Promise.race([readyP, loginP, timeoutP]);

    if (result === 'ready' || result === 'login-ok') return client;

    if (result?.error) {
      console.error(`[discord] Connexion refusée (tentative n°${attempt}) :`, result.error.message);
      if (isAuthError(result.error)) throw result.error;
    } else {
      console.warn(`[discord] Pas connecté après ${LOGIN_TRY_MS / 1000} s (tentative n°${attempt}).`);
    }
    await client.destroy().catch(() => {});

    console.log(`[discord] Nouvel essai dans ${Math.round(pauseMs / 1000)} s.`);
    await sleep(pauseMs);
    pauseMs = Math.min(pauseMs * 2, RETRY_MAX_MS);
  }
}

// Serveur HTTP (health check Render) + auto-ping anti-veille.
// /health ne répond 200 qu'une fois connecté à Discord (voir server.js).
startServer(
  () => {
    const connected = Boolean(bot?.isReady());
    return { ready: connected, bot: connected ? 'connected' : 'connecting' };
  },
  // Tableau de bord web (désactivé tant que DASHBOARD_PASSWORD n'est pas défini).
  createDashboard({ getClient: () => bot }),
);
startKeepAlive();

async function main() {
  // Charge les réglages depuis Supabase avant d'accepter les interactions.
  console.log('[startup] Chargement des réglages depuis Supabase…');
  await withTimeout(store.init(), 20_000, 'Supabase ne répond pas après 20 s (vérifie SUPABASE_URL).');
  // Les chargements et la sonde Discord partent en même temps (au lieu de s'enchaîner).
  // Non bloquants : si une table n'existe pas encore, le bot démarre quand même.
  const probe = probeDiscord();
  await Promise.all([
    withTimeout(leveling.init(), 30_000, 'Lecture des niveaux trop lente (table edge_levels).').catch((err) =>
      console.error('[niveaux] chargement impossible (la table edge_levels existe-t-elle ? voir supabase/schema.sql) :', err.message),
    ),
    withTimeout(suggestions.init(), 30_000, 'Lecture des suggestions trop lente (table edge_suggestions).').catch((err) =>
      console.error('[suggestions] chargement impossible (la table edge_suggestions existe-t-elle ? voir supabase/schema.sql) :', err.message),
    ),
    withTimeout(giveaways.init(), 30_000, 'Lecture des giveaways trop lente (table edge_giveaways).').catch((err) =>
      console.error('[giveaways] chargement impossible (la table edge_giveaways existe-t-elle ? voir supabase/schema.sql) :', err.message),
    ),
  ]);
  leveling.startTimers();
  logs.start();
  // Sauvegarde quotidienne (vérifiée toutes les 10 min, une fois connecté à Discord).
  backups.start(() => bot);
  console.log('[startup] Réglages chargés. Connexion à Discord…');
  // Si Discord impose une limite de débit, on attend sa fin avant toute tentative :
  // chaque demande envoyée pendant la limite la prolonge.
  const retryAfterS = await probe;
  if (retryAfterS > 0) {
    const waitS = retryAfterS + 10;
    console.log(
      `[discord] Limite de débit active : aucune tentative avant ${waitS} s (environ ${Math.ceil(waitS / 60)} min). ` +
        'Évite de redéployer pendant ce délai.',
    );
    await sleep(waitS * 1000);
  }
  await connectWithRetry();
}

// Render envoie SIGTERM au redéploiement : on enregistre l'XP en attente avant de quitter.
process.on('SIGTERM', () => {
  Promise.all([leveling.flushOnExit(), logs.flushOnExit()]).finally(() => process.exit(0));
});

main().catch((err) => {
  console.error('Démarrage impossible :', err.message);
  process.exit(1);
});
