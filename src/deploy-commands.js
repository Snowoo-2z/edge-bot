// Enregistre la commande /config auprès de Discord.
// - Si GUILD_ID est défini : enregistrement instantané sur ce serveur (idéal pour tester).
// - Sinon : enregistrement global (peut prendre jusqu'à 1 h à apparaître).
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
// Accepte CLIENT_ID ou DISCORD_CLIENT_ID (les deux noms sont courants).
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("DISCORD_TOKEN et CLIENT_ID sont requis (variables d'environnement).");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Ouvre le panneau de configuration Edge')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('level')
    .setDescription('Affiche ta carte de niveau (ou celle d’un membre)')
    .addUserOption((option) =>
      option.setName('membre').setDescription('Le membre dont afficher le niveau').setRequired(false),
    )
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Affiche le classement vocal du serveur')
    .setDMPermission(false)
    .toJSON(),
];

(async () => {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Commandes /config, /level et /leaderboard enregistrées ${GUILD_ID ? `sur le serveur ${GUILD_ID}` : 'globalement'}.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
