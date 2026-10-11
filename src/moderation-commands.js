// Définition des commandes de modération (utilisée par deploy-commands.js et par le module).
// Pas de permission Discord par défaut : c'est le module qui contrôle qui peut les utiliser
// (rôles choisis dans /config, ou permission Discord native à défaut).
const { ChannelType, SlashCommandBuilder } = require('discord.js');

const REASON_MAX = 400;

function buildModerationCommands() {
  const reason = (o, required = false) =>
    o.setName('raison').setDescription('Raison (visible dans le journal)').setMaxLength(REASON_MAX).setRequired(required);
  const member = (o, description = 'Membre concerné') => o.setName('membre').setDescription(description).setRequired(true);

  return [
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Bannir un membre du serveur')
      .addUserOption((o) => member(o, 'Membre à bannir'))
      .addStringOption((o) => reason(o))
      .addIntegerOption((o) =>
        o.setName('supprimer').setDescription('Jours de messages à supprimer (0 à 7)').setMinValue(0).setMaxValue(7),
      )
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Retirer le bannissement d’un membre')
      .addStringOption((o) =>
        o.setName('utilisateur').setDescription('Identifiant (ID) du membre à débannir').setRequired(true).setMaxLength(40),
      )
      .addStringOption((o) => reason(o))
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Expulser un membre du serveur')
      .addUserOption((o) => member(o, 'Membre à expulser'))
      .addStringOption((o) => reason(o))
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Mettre un membre en timeout (il ne peut plus écrire ni parler)')
      .addUserOption((o) => member(o))
      .addStringOption((o) =>
        o.setName('duree').setDescription('Durée : 10m, 2h, 1j, 1j 12h (1 min à 28 jours)').setRequired(true).setMaxLength(40),
      )
      .addStringOption((o) => reason(o))
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('untimeout')
      .setDescription('Retirer le timeout d’un membre')
      .addUserOption((o) => member(o))
      .addStringOption((o) => reason(o))
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Avertir un membre (l’avertissement est enregistré)')
      .addUserOption((o) => member(o))
      .addStringOption((o) => reason(o, true))
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('warnings')
      .setDescription('Voir les avertissements d’un membre')
      .addUserOption((o) => member(o))
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('unwarn')
      .setDescription('Supprimer un avertissement grâce à son numéro')
      .addIntegerOption((o) =>
        o.setName('id').setDescription('Numéro de l’avertissement (voir /warnings)').setRequired(true).setMinValue(1),
      )
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Supprimer des messages récents du salon')
      .addIntegerOption((o) =>
        o.setName('nombre').setDescription('Nombre de messages à examiner (1 à 100)').setRequired(true).setMinValue(1).setMaxValue(100),
      )
      .addUserOption((o) => o.setName('membre').setDescription('Ne supprimer que les messages de ce membre'))
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Régler le mode lent d’un salon (0 pour le désactiver)')
      .addIntegerOption((o) =>
        o.setName('secondes').setDescription('Délai entre deux messages, en secondes (0 à 21600)').setRequired(true).setMinValue(0).setMaxValue(21600),
      )
      .addChannelOption((o) =>
        o.setName('salon').setDescription('Salon concerné (par défaut : ce salon)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum),
      )
      .setDMPermission(false)
      .toJSON(),
  ];
}

module.exports = { buildModerationCommands };
