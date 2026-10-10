require('dotenv').config({ quiet: true });

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { handleConfigCommand, handleConfigInteraction } = require('./config');
const ticket = require('./modules/ticket');
const { ephemeralPayload } = require('./ui');
const { startServer } = require('./server');
const { startKeepAlive } = require('./keepalive');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN manquant : copie .env.example vers .env et renseigne ton token.');
  process.exit(1);
}

// MessageContent : nécessaire pour recevoir les pièces jointes (import image / GIF).
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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

// Serveur HTTP (health check Render) + auto-ping anti-veille.
startServer(() => ({ bot: client.isReady() ? 'connected' : 'connecting' }));
startKeepAlive();

client.login(token).catch((err) => {
  console.error('Connexion à Discord impossible (token invalide ou réseau) :', err.message);
  process.exit(1);
});
