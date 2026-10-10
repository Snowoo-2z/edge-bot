// Enregistre la commande /config auprès de Discord.
// - Si GUILD_ID est défini : enregistrement instantané sur ce serveur (idéal pour tester).
// - Sinon : enregistrement global (peut prendre jusqu'à 1 h à apparaître).
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
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
];

(async () => {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Commande /config enregistrée ${GUILD_ID ? `sur le serveur ${GUILD_ID}` : 'globalement'}.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
