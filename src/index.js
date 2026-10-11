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

// Alerte si Discord ne confirme pas la connexion (token, intents privilégiés…).
const readyWatchdog = setTimeout(() => {
  console.error(
    '[discord] Toujours pas connecté 60 s après le démarrage. Vérifie le token et les intents privilégiés (portail développeur).',
  );
}, 60_000);

client.once(Events.ClientReady, (c) => {
  clearTimeout(readyWatchdog);
  console.log(`Edge connecté en tant que ${c.user.tag}`);
});

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

client.on(Events.InteractionCreate, async (interaction) => {
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
  }
});

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
