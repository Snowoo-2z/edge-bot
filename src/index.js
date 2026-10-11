const { Client, GatewayIntentBits, Events } = require('discord.js');
const { handleConfigCommand, handleConfigInteraction } = require('./config');
const ticket = require('./modules/ticket');
const welcome = require('./modules/welcome');
const { ephemeralPayload } = require('./ui');
const { startServer } = require('./server');
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

function buildClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // GuildMembers : arrivée des membres (module Bienvenue). Intent privilégié à activer.
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      // MessageContent : pièces jointes (import image / GIF). Intent privilégié à activer.
      GatewayIntentBits.MessageContent,
    ],
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
  client.on(Events.Error, (error) => console.error('[discord] erreur client :', error?.message ?? error));

  client.on(Events.InteractionCreate, handleInteraction);

  ticket.registerEvents(client);
  welcome.registerEvents(client);
}

// Journal des interactions reçues : permet de voir si Discord les transmet au bot.
function describeInteraction(interaction) {
  if (interaction.isChatInputCommand()) return `commande /${interaction.commandName}`;
  if (interaction.isModalSubmit()) return `modale ${interaction.customId}`;
  return `${interaction.componentType ? 'composant' : 'interaction'} ${interaction.customId ?? ''}`;
}

async function handleInteraction(interaction) {
  const started = Date.now();
  console.log(`[interaction] reçue : ${describeInteraction(interaction)} (${interaction.guildId ?? 'MP'})`);
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'config') return await handleConfigCommand(interaction);
      return;
    }

    const id = interaction.customId ?? '';
    if (id.startsWith('cfg:')) return await handleConfigInteraction(interaction);
    if (id.startsWith('tkt:')) return await ticket.handlePublicInteraction(interaction);
  } catch (err) {
    console.error('Erreur interaction :', err);
    const payload = ephemeralPayload('❌ Une erreur est survenue.');
    const reply = interaction.deferred || interaction.replied
      ? interaction.followUp(payload)
      : interaction.reply(payload);
    reply.catch(() => {});
  } finally {
    const ms = Date.now() - started;
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
startServer(() => ({ bot: bot?.isReady() ? 'connected' : 'connecting' }));
startKeepAlive();

async function main() {
  // Charge les réglages depuis Supabase avant d'accepter les interactions.
  console.log('[startup] Chargement des réglages depuis Supabase…');
  await withTimeout(store.init(), 20_000, 'Supabase ne répond pas après 20 s (vérifie SUPABASE_URL).');
  console.log('[startup] Réglages chargés. Connexion à Discord…');
  // Si Discord impose une limite de débit, on attend sa fin avant toute tentative :
  // chaque demande envoyée pendant la limite la prolonge.
  const retryAfterS = await probeDiscord();
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

main().catch((err) => {
  console.error('Démarrage impossible :', err.message);
  process.exit(1);
});
