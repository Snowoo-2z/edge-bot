// Module « Liens » de /config : supprime les messages contenant un lien, sauf pour les rôles autorisés.
// Le membre reçoit un avertissement dans le salon. Le texte d'avertissement est modifiable.
const { ButtonStyle, RoleSelectMenuBuilder } = require('discord.js');
const { getModuleConfig, updateModuleConfig } = require('../store');
const { embed, button, row, toggleButton, textModal, moduleSelectRow, truncate } = require('../ui');
const { MODULE_LIST } = require('./registry');

const ID = 'links';
const DEFAULT_WARNING = 'Avertissement, vous n’êtes pas autorisé à poster des liens sur ce serveur Discord.';
const DEFAULTS = {
  enabled: false,
  allowedRoleIds: [],
  warning: DEFAULT_WARNING,
};

// Liens « complets » (http, https, www) et domaines nus usuels (discord.gg/xxx, exemple.com…).
const TLDS =
  'com|net|org|gg|io|fr|xyz|top|click|link|site|online|store|shop|info|app|dev|tv|ly|eu|ru|cc|co|me|to|ai';
const LINK_RE = new RegExp(`(?:https?:\\/\\/|www\\.)\\S+|\\b(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b(?:\\/\\S*)?`, 'i');

function containsLink(text) {
  return LINK_RE.test(String(text ?? ''));
}

function cfgOf(guildId) {
  return getModuleConfig(guildId, ID, DEFAULTS);
}

function render(view, guild) {
  if (view === 'roles') return renderRoles(guild);
  return renderMain(guild);
}

function renderMain(guild) {
  const cfg = cfgOf(guild.id);
  const roles = cfg.allowedRoleIds.length ? cfg.allowedRoleIds.map((id) => `<@&${id}>`).join(' ') : 'aucun';
  return {
    content: '🔗 **Module Liens** · supprime les messages contenant un lien, sauf pour les rôles autorisés.',
    embeds: [
      embed().addFields(
        { name: 'Blocage des liens', value: cfg.enabled ? '🟢 Activé' : '⚪ Désactivé', inline: true },
        { name: 'Rôles autorisés à poster des liens', value: truncate(roles, 500), inline: false },
        { name: 'Avertissement envoyé', value: truncate(cfg.warning, 300), inline: false },
      ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        toggleButton('cfg:links:toggle:enabled', 'Blocage', cfg.enabled),
        button('cfg:links:view:roles', 'Rôles autorisés', ButtonStyle.Primary, '🎭'),
        button('cfg:links:open:texts', 'Avertissement', ButtonStyle.Primary, '✏️'),
      ),
    ],
  };
}

function renderRoles(guild) {
  const cfg = cfgOf(guild.id);
  const select = new RoleSelectMenuBuilder()
    .setCustomId('cfg:links:pick:roles')
    .setPlaceholder('Sélectionne les rôles autorisés')
    .setMinValues(0)
    .setMaxValues(25);
  if (cfg.allowedRoleIds.length) select.setDefaultRoles(...cfg.allowedRoleIds);
  return {
    embeds: [
      embed(
        'Choisis les rôles autorisés à poster des liens. Les autres membres voient leurs liens supprimés. ' +
          'Vide la sélection pour n’autoriser aucun rôle.',
      ),
    ],
    components: [row(select), row(button('cfg:links:view:main', '◀ Retour', ButtonStyle.Danger))],
  };
}

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , action, arg] = interaction.customId.split(':');
  const cfg = cfgOf(guild.id);

  switch (action) {
    case 'view':
      return interaction.update(render(arg, guild));

    case 'toggle': {
      if (arg !== 'enabled') return;
      cfg.enabled = !cfg.enabled;
      updateModuleConfig(guild.id, ID, cfg);
      return interaction.update(renderMain(guild));
    }

    case 'pick': {
      if (arg !== 'roles') return;
      cfg.allowedRoleIds = [...interaction.values];
      updateModuleConfig(guild.id, ID, cfg);
      return interaction.update(renderMain(guild));
    }

    case 'open': {
      if (arg !== 'texts') return;
      return interaction.showModal(
        textModal('cfg:links:modal:texts', 'Avertissement', [
          {
            key: 'warning',
            label: 'Message envoyé au membre',
            max: 300,
            required: true,
            value: cfg.warning,
            placeholder: 'Précédé de la mention du membre',
          },
        ]),
      );
    }

    default:
      return;
  }
}

async function handleModal(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const cfg = cfgOf(guild.id);
  const value = interaction.fields.getTextInputValue('warning').trim();
  if (value) cfg.warning = value;
  updateModuleConfig(guild.id, ID, cfg);
  await interaction.deferUpdate();
  return interaction.editReply(renderMain(guild));
}

// Un message est contrôlé s'il contient un lien et si son auteur n'a pas un rôle autorisé.
async function checkMessage(message) {
  if (!message.guild || !message.author || message.author.bot) return;
  const cfg = cfgOf(message.guild.id);
  if (!cfg.enabled || !containsLink(message.content)) return;

  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (member && cfg.allowedRoleIds.some((roleId) => member.roles.cache.has(roleId))) return;

  try {
    await message.delete();
  } catch (err) {
    console.error('[liens] suppression impossible (permission « Gérer les messages » ?) :', err.message);
    return;
  }
  await message.channel
    .send({
      content: `<@${message.author.id}> ${cfg.warning}`,
      allowedMentions: { users: [message.author.id] },
    })
    .catch((err) => console.error('[liens] avertissement impossible :', err.message));
}

function registerEvents(client) {
  client.on('messageCreate', (message) => {
    checkMessage(message).catch((err) => console.error('[liens] erreur :', err));
  });
  // Un message peut être modifié pour ajouter un lien : on le contrôle aussi.
  client.on('messageUpdate', (_oldMessage, message) => {
    if (message.partial) return;
    checkMessage(message).catch((err) => console.error('[liens] erreur :', err));
  });
}

module.exports = { ID, DEFAULTS, render, handleComponent, handleModal, registerEvents, containsLink, checkMessage };
