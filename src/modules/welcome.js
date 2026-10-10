const { AttachmentBuilder, ButtonStyle, ChannelType, ChannelSelectMenuBuilder, MessageFlags } = require('discord.js');
const { getModuleConfig, updateModuleConfig } = require('../store');
const { embed, button, row, toggleButton, textModal, moduleSelectRow, ephemeralPayload, truncate } = require('../ui');
const { MODULE_LIST } = require('./registry');
const { renderWelcomeCard } = require('../welcome-image');

const ID = 'welcome';
const DEFAULTS = {
  enabled: false,
  channelId: null,
  showAvatar: true,
  texts: {
    title: 'Bienvenue {user} !',
    subtitle: 'Membre n°{count} · {server}',
    message: '{user} vient d’arriver sur **{server}** !',
  },
};

const TEXT_FIELDS = (t) => [
  { key: 'title', label: 'Titre de l’image', max: 80, required: true, value: t.title, placeholder: 'Variables : {user}' },
  { key: 'subtitle', label: 'Sous-titre de l’image', max: 100, required: true, value: t.subtitle, placeholder: 'Variables : {count}, {server}' },
  {
    key: 'message',
    label: 'Message au-dessus de l’image',
    max: 500,
    paragraph: true,
    required: true,
    value: t.message,
    placeholder: 'Variables : {user} (mention), {server}, {count}',
  },
];

function cfgOf(guildId) {
  return getModuleConfig(guildId, ID, DEFAULTS);
}

// {user} : pseudo (pour l'image) ou mention (pour le message). {server}, {count}.
function fill(template, vars) {
  return String(template).replace(/\{(user|server|count)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function render(view, guild) {
  const cfg = cfgOf(guild.id);
  if (view === 'channel') return renderChannel();
  return renderMain(guild, cfg);
}

function renderMain(guild, cfg) {
  const channel = cfg.channelId ? `<#${cfg.channelId}>` : '⚠️ non défini';
  return {
    content:
      '👋 **Module Bienvenue** · à chaque arrivée, le bot envoie une carte de bienvenue violette dans le salon choisi.',
    embeds: [
      embed()
        .addFields(
          { name: 'Module', value: cfg.enabled ? '🟢 Activé' : '⚪ Désactivé', inline: true },
          { name: 'Salon', value: channel, inline: true },
          { name: 'Avatar', value: cfg.showAvatar ? '🟢 Affiché' : '⚪ Masqué', inline: true },
          { name: 'Titre', value: truncate(cfg.texts.title, 200), inline: false },
          { name: 'Sous-titre', value: truncate(cfg.texts.subtitle, 200), inline: false },
          { name: 'Message', value: truncate(cfg.texts.message, 300), inline: false },
        ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        toggleButton('cfg:welcome:toggle:enabled', 'Module', cfg.enabled),
        toggleButton('cfg:welcome:toggle:showAvatar', 'Avatar', cfg.showAvatar),
        button('cfg:welcome:view:channel', 'Salon', ButtonStyle.Primary, '📍'),
        button('cfg:welcome:open:texts', 'Textes', ButtonStyle.Primary, '✏️'),
        button('cfg:welcome:preview', 'Aperçu', ButtonStyle.Success, '👁️'),
      ),
    ],
  };
}

function renderChannel() {
  return {
    embeds: [embed('Choisis le salon où envoyer les messages de bienvenue.')],
    components: [
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:welcome:pick:channel')
          .setPlaceholder('Sélectionne un salon')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1),
      ),
      row(button('cfg:welcome:view:main', '◀ Retour', ButtonStyle.Danger)),
    ],
  };
}

async function buildCard(guild, user, displayName, cfg) {
  const vars = { user: displayName, server: guild.name, count: guild.memberCount };
  return renderWelcomeCard({
    title: fill(cfg.texts.title, vars),
    subtitle: fill(cfg.texts.subtitle, vars),
    avatarUrl: user.displayAvatarURL({ extension: 'png', size: 256 }),
    initial: displayName,
    showAvatar: cfg.showAvatar,
  });
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
      if (!['enabled', 'showAvatar'].includes(arg)) return;
      cfg[arg] = !cfg[arg];
      updateModuleConfig(guild.id, ID, cfg);
      return interaction.update(renderMain(guild, cfg));
    }

    case 'pick': {
      cfg.channelId = interaction.values[0];
      updateModuleConfig(guild.id, ID, cfg);
      return interaction.update(renderMain(guild, cfg));
    }

    case 'open': {
      if (arg !== 'texts') return;
      return interaction.showModal(textModal('cfg:welcome:modal:texts', 'Textes de bienvenue', TEXT_FIELDS(cfg.texts)));
    }

    case 'preview': {
      await interaction.deferUpdate();
      try {
        const member = interaction.member;
        const displayName = member?.displayName ?? interaction.user.username;
        const png = await buildCard(guild, interaction.user, displayName, cfg);
        return interaction.followUp({
          embeds: [embed().setImage('attachment://welcome.png')],
          files: [new AttachmentBuilder(png, { name: 'welcome.png' })],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        console.error('[welcome] aperçu :', err);
        return interaction.followUp(ephemeralPayload('❌ Impossible de générer l’aperçu.'));
      }
    }

    default:
      return;
  }
}

async function handleModal(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const cfg = cfgOf(guild.id);
  for (const key of ['title', 'subtitle', 'message']) {
    const value = interaction.fields.getTextInputValue(key).trim();
    if (value) cfg.texts[key] = value;
  }
  updateModuleConfig(guild.id, ID, cfg);
  await interaction.deferUpdate();
  return interaction.editReply(renderMain(guild, cfg));
}

// Envoi automatique à l'arrivée d'un membre.
function registerEvents(client) {
  client.on('guildMemberAdd', async (member) => {
    try {
      const cfg = getModuleConfig(member.guild.id, ID, DEFAULTS);
      if (!cfg.enabled || !cfg.channelId) return;

      const channel =
        member.guild.channels.cache.get(cfg.channelId) ?? (await member.guild.channels.fetch(cfg.channelId));
      if (!channel) return;

      const png = await buildCard(member.guild, member.user, member.displayName, cfg);
      const vars = { user: `<@${member.id}>`, server: member.guild.name, count: member.guild.memberCount };
      await channel.send({
        content: fill(cfg.texts.message, vars),
        embeds: [embed().setImage('attachment://welcome.png')],
        files: [new AttachmentBuilder(png, { name: 'welcome.png' })],
        allowedMentions: { users: [member.id] },
      });
    } catch (err) {
      console.error('[welcome] envoi de bienvenue :', err);
    }
  });
}

module.exports = { ID, DEFAULTS, render, handleComponent, handleModal, registerEvents, fill };
