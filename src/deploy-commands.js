// Enregistre les commandes auprès de Discord.
// - Si GUILD_IDS (ou GUILD_ID) est défini : enregistrement instantané sur chacun de ces serveurs
//   (ex. GUILD_IDS=111…,222…). Tous les serveurs listés reçoivent les mêmes commandes.
// - Sinon : enregistrement global (peut prendre jusqu'à 1 h à apparaître).
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { buildModerationCommands } = require('./moderation-commands');
const { buildServerCommand } = require('./server-info');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
// Accepte CLIENT_ID ou DISCORD_CLIENT_ID (les deux noms sont courants).
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const { parseGuildIds } = require('./guild-ids');
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
    .setDescription('Classement du serveur en image (Edge Dollar par défaut, ou XP)')
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Quel classement afficher (par défaut : Edge Dollar)')
        .setRequired(false)
        .addChoices({ name: 'Edge Dollar ($)', value: 'argent' }, { name: 'XP (niveau et vocal)', value: 'xp' }),
    )
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('suggestion')
    .setDescription('Propose une suggestion, publiée avec des votes pendant 3 jours')
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Lance un giveaway (tirage au sort avec bouton de participation)')
    .addStringOption((option) =>
      option.setName('prix').setDescription('Ce qui est à gagner').setRequired(true).setMaxLength(200),
    )
    .addStringOption((option) =>
      option.setName('duree').setDescription('Durée : 30m, 2h, 3j, 1j 12h (1 min à 30 jours)').setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName('gagnants').setDescription('Nombre de gagnants (1 à 20, 1 par défaut)').setMinValue(1).setMaxValue(20).setRequired(false),
    )
    .addChannelOption((option) =>
      option
        .setName('salon')
        .setDescription('Salon du giveaway (par défaut : le salon configuré, ou celui-ci)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    )
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Ouvre ton compte Edge Dollar ($) : solde de départ, récompense et profil')
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Récupère ta récompense quotidienne en Edge Dollar ($)')
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Affiche ta carte : solde, rang, série (réponse privée, en image)')
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('rob')
    .setDescription('Tente de voler l’argent que ce membre a sur lui (toutes les 3 h, chance de réussite variable)')
    .addUserOption((option) =>
      option.setName('membre').setDescription('Le membre à voler').setRequired(true),
    )
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('agent')
    .setDescription('Lance l’agent IA qui lit, crée et modifie le serveur selon ton objectif')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName('objectif')
        .setDescription('Ce que l’agent doit faire, ex. : créer une section Annonces et une section Discussion')
        .setRequired(true)
        .setMaxLength(1000),
    )
    .toJSON(),
  buildServerCommand(),
  ...buildModerationCommands(),
];

(async () => {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const guildIds = parseGuildIds();
  const routes = guildIds.length
    ? guildIds.map((id) => Routes.applicationGuildCommands(CLIENT_ID, id))
    : [Routes.applicationCommands(CLIENT_ID)];
  for (const route of routes) {
    await rest.put(route, { body: commands });
  }
  const where = guildIds.length ? `sur ${guildIds.length} serveur(s) : ${guildIds.join(', ')}` : 'globalement';
  console.log(`${commands.length} commandes enregistrées ${where} (config, level, leaderboard, suggestion, giveaway, play, daily, profile, rob, server, ban, unban, kick, timeout, untimeout, warn, warnings, unwarn, purge, slowmode).`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
