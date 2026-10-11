// Commande /server : fiche d'identité du serveur (membres, date de création, salons, rôles, boosts).
const { ChannelType, MessageFlags, SlashCommandBuilder, GuildVerificationLevel } = require('discord.js');
const { embed } = require('./ui');

const VERIFICATION = {
  [GuildVerificationLevel.None]: 'Aucune',
  [GuildVerificationLevel.Low]: 'Faible (e-mail vérifié)',
  [GuildVerificationLevel.Medium]: 'Moyenne (inscrit depuis 5 min)',
  [GuildVerificationLevel.High]: 'Élevée (membre du serveur depuis 10 min)',
  [GuildVerificationLevel.VeryHigh]: 'Très élevée (téléphone vérifié)',
};

const TIER = ['Aucun', 'Niveau 1', 'Niveau 2', 'Niveau 3'];

function buildServerCommand() {
  return new SlashCommandBuilder()
    .setName('server')
    .setDescription('Affiche les informations du serveur (membres, date de création, salons…)')
    .setDMPermission(false)
    .toJSON();
}

function countChannels(guild) {
  const counts = { text: 0, voice: 0, forum: 0, categories: 0, threads: 0 };
  for (const c of guild.channels.cache.values()) {
    if (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) counts.text++;
    else if (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) counts.voice++;
    else if (c.type === ChannelType.GuildForum) counts.forum++;
    else if (c.type === ChannelType.GuildCategory) counts.categories++;
  }
  counts.threads = guild.channels.cache.filter((c) => c.isThread?.()).size;
  return counts;
}

function buildServerEmbed(guild) {
  const ch = countChannels(guild);
  const created = Math.floor(guild.createdTimestamp / 1000);
  const roles = guild.roles.cache.filter((r) => r.id !== guild.id).size;
  const boosts = guild.premiumSubscriptionCount ?? 0;
  const e = embed(guild.description ?? null)
    .setTitle(`🏠 ${guild.name}`)
    .addFields(
      { name: '👥 Membres', value: String(guild.memberCount ?? 0), inline: true },
      { name: '📅 Créé le', value: `<t:${created}:D> (<t:${created}:R>)`, inline: true },
      { name: '👑 Propriétaire', value: guild.ownerId ? `<@${guild.ownerId}>` : 'inconnu', inline: true },
      { name: '💬 Salons', value: `${ch.text} texte · ${ch.voice} vocal · ${ch.forum} forum · ${ch.categories} catégories`, inline: false },
      { name: '🏷️ Rôles', value: String(roles), inline: true },
      { name: '😀 Emojis', value: `${guild.emojis.cache.size} / ${guild.maximumEmojis ?? '?'}`, inline: true },
      { name: '🚀 Boosts', value: `${boosts} (${TIER[guild.premiumTier] ?? 'Aucun'})`, inline: true },
      { name: '🔒 Vérification', value: VERIFICATION[guild.verificationLevel] ?? 'inconnue', inline: false },
      { name: '🆔 Identifiant', value: guild.id, inline: true },
    )
    .setFooter({ text: 'Informations à jour au moment de la commande' });
  const icon = guild.iconURL({ size: 256 });
  if (icon) e.setThumbnail(icon);
  return e;
}

async function handleServerCommand(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ embeds: [embed('Cette commande ne fonctionne que sur un serveur.')], flags: MessageFlags.Ephemeral });
  await interaction.deferReply();
  // Données fraîches : le nombre de membres et les boosts peuvent avoir changé depuis le cache.
  await guild.fetch().catch(() => null);
  return interaction.editReply({ embeds: [buildServerEmbed(guild)] });
}

module.exports = { buildServerCommand, handleServerCommand, buildServerEmbed };
