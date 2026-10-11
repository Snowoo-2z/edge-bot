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

// MessageContent : nécessaire pour recevoir les pièces jointes (import image / GIF).
const client = new Client({
  // GuildMembers : nécessaire pour l'arrivée des membres (module Bienvenue). Intent privilégié à activer.
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Suivi de la connexion : depuis cet hébergement, Discord peut mettre 1 à 3 minutes à répondre.
// Le bot réessaie tout seul ; ce suivi indique seulement où en est la connexion.
const connectStarted = Date.now();
const connectWatch = setInterval(() => {
  const minutes = Math.floor((Date.now() - connectStarted) / 60_000);
  console.log(`[discord] Connexion toujours en cours après ${minutes} min (le bot continue d'essayer).`);
}, 60_000);

client.once(Events.ClientReady, (c) => {
  clearInterval(connectWatch);
  console.log(`Edge connecté en tant que ${c.user.tag}`);
});

// Cycle de vie de la connexion (utile pour voir les coupures et reconnexions).
client.on(Events.ShardReady, (id) => console.log(`[discord] shard ${id} prêt`));
client.on(Events.ShardDisconnect, (event, id) => console.warn(`[discord] shard ${id} déconnecté (code ${event?.code})`));
client.on(Events.ShardReconnecting, (id) => console.log(`[discord] shard ${id} : reconnexion…`));
client.on(Events.ShardResume, (id) => console.log(`[discord] shard ${id} : session reprise`));

// Erreurs de passerelle Discord. Un intent privilégié non activé dans le portail
// empêche la connexion sans planter le processus : on le signale explicitement.
client.on(Events.ShardError, (error) => {
  const message = error?.message ?? String(error);
  console.error('[discord] Erreur de connexion :', message);
  if (/disallowed intents/i.test(message)) {
    console.error(
      '[discord] Intent privilégié refusé. Portail développeur → Bot → Privileged Gateway Intents : ' +
        'active MESSAGE CONTENT INTENT et SERVER MEMBERS INTENT, puis redémarre le service Render.',
    );
  }
});

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Journal des interactions reçues : permet de voir si Discord les transmet au bot.
function describeInteraction(interaction) {
  if (interaction.isChatInputCommand()) return `commande /${interaction.commandName}`;
  if (interaction.isModalSubmit()) return `modale ${interaction.customId}`;
  return `${interaction.componentType ? 'composant' : 'interaction'} ${interaction.customId ?? ''}`;
}

client.on(Events.InteractionCreate, async (interaction) => {
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
});

// Messages internes de discord.js (avertissements, erreurs de client).
client.on(Events.Warn, (message) => console.warn('[discord] avertissement :', message));
client.on(Events.Error, (error) => console.error('[discord] erreur client :', error?.message ?? error));

ticket.registerEvents(client);
welcome.registerEvents(client);

// Serveur HTTP (health check Render) + auto-ping anti-veille.
startServer(() => ({ bot: client.isReady() ? 'connected' : 'connecting' }));
startKeepAlive();

async function main() {
  // Charge les réglages depuis Supabase avant d'accepter les interactions.
  console.log('[startup] Chargement des réglages depuis Supabase…');
  await withTimeout(store.init(), 20_000, 'Supabase ne répond pas après 20 s (vérifie SUPABASE_URL).');
  console.log('[startup] Réglages chargés. Connexion à Discord…');
  await client.login(token);
  console.log('[startup] Connexion à Discord demandée.');
}

main().catch((err) => {
  console.error('Démarrage impossible :', err.message);
  process.exit(1);
});
