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

client.once(Events.ClientReady, (c) => {
  console.log(`Edge connecté en tant que ${c.user.tag}`);
});

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
  await store.init();
  await client.login(token);
}

main().catch((err) => {
  console.error('Démarrage impossible :', err.message);
  process.exit(1);
});
