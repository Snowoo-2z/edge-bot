// Module « Niveaux » de /config : thème de la carte /level, annonces de passage de niveau.
// Les règles de gain d'XP ne sont volontairement pas affichées dans Discord (voir src/xp-rules.js).
const { AttachmentBuilder, ButtonStyle, ChannelType, ChannelSelectMenuBuilder, MessageFlags } = require('discord.js');
const { getModuleConfig, updateModuleConfig } = require('../store');
const { embed, button, row, selectMenu, toggleButton, textModal, moduleSelectRow, ephemeralPayload, truncate } = require('../ui');
const { MODULE_LIST } = require('./registry');
const { THEMES, THEME_LIST } = require('../welcome-image');
const { renderLevelCard, LEVEL_DEFAULT_THEME } = require('../level-card');

const ID = 'levels';
const DEFAULT_LEVEL_UP = 'Bravo à {user} qui passe {level}';
const DEFAULTS = {
  theme: LEVEL_DEFAULT_THEME,
  enabled: false, // annonces de passage de niveau
  channelId: null,
  texts: { levelUp: DEFAULT_LEVEL_UP },
};

function cfgOf(guildId) {
  return getModuleConfig(guildId, ID, DEFAULTS);
}

function levelUpText(cfg) {
  return cfg.texts?.levelUp || DEFAULT_LEVEL_UP;
}

// {user} : mention (pour les annonces). {level} : niveau atteint.
function fill(template, vars) {
  return String(template).replace(/\{(user|level)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function themeLabel(id) {
  const t = THEMES[id] ?? THEMES[LEVEL_DEFAULT_THEME];
  return `${t.emoji} ${t.label}`;
}

function render(view, guild) {
  if (view === 'channel') return renderChannel();
  return renderMain(guild);
}

function renderMain(guild) {
  const cfg = cfgOf(guild.id);
  const channel = cfg.channelId ? `<#${cfg.channelId}>` : '⚠️ non défini';
  return {
    content: '🏅 **Module Niveaux** · carte /level, classement et annonces de passage de niveau.',
    embeds: [
      embed().addFields(
        { name: 'Thème de la carte /level', value: themeLabel(cfg.theme), inline: true },
        { name: 'Annonces de niveau', value: cfg.enabled ? '🟢 Activées' : '⚪ Désactivées', inline: true },
        { name: 'Salon des annonces', value: channel, inline: true },
        { name: 'Message d’annonce', value: truncate(levelUpText(cfg), 300), inline: false },
        { name: 'Commandes', value: '`/level` · `/leaderboard`', inline: false },
      ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      selectMenu(
        'cfg:levels:pick:theme',
        'Choisir le thème de la carte',
        THEME_LIST.map((t) => ({
          label: t.label,
          value: t.id,
          emoji: t.emoji,
          description: t.description,
          default: t.id === cfg.theme,
        })),
      ),
      row(
        toggleButton('cfg:levels:toggle:enabled', 'Annonces', cfg.enabled),
        button('cfg:levels:view:channel', 'Salon', ButtonStyle.Primary, '📍'),
        button('cfg:levels:open:texts', 'Message', ButtonStyle.Primary, '✏️'),
        button('cfg:levels:preview', 'Aperçu de la carte', ButtonStyle.Success, '👁️'),
      ),
    ],
  };
}

function renderChannel() {
  return {
    embeds: [embed('Choisis le salon où sont annoncés les passages de niveau.')],
    components: [
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:levels:pick:channel')
          .setPlaceholder('Sélectionne un salon')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1),
      ),
      row(button('cfg:levels:view:main', '◀ Retour', ButtonStyle.Danger)),
    ],
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
      if (arg === 'theme') {
        const theme = interaction.values[0];
        if (!THEMES[theme]) return;
        cfg.theme = theme;
      } else if (arg === 'channel') {
        cfg.channelId = interaction.values[0];
      } else {
        return;
      }
      updateModuleConfig(guild.id, ID, cfg);
      return interaction.update(renderMain(guild));
    }

    case 'open': {
      if (arg !== 'texts') return;
      return interaction.showModal(
        textModal('cfg:levels:modal:texts', 'Message d’annonce', [
          {
            key: 'levelUp',
            label: 'Message de passage de niveau',
            max: 300,
            required: true,
            value: levelUpText(cfg),
            placeholder: 'Variables : {user} (mention), {level} (niveau atteint)',
          },
        ]),
      );
    }

    case 'preview': {
      await interaction.deferUpdate();
      try {
        const png = await renderLevelCard({
          name: interaction.member?.displayName ?? interaction.user.username,
          avatarUrl: interaction.user.displayAvatarURL({ extension: 'png', size: 256 }),
          level: 6,
          xp: 4321,
          levelStartXp: 3600,
          nextLevelXp: 4900,
          rank: 3,
          voiceSeconds: 11700,
          theme: cfg.theme,
        });
        return interaction.followUp({
          content: `👁️ Aperçu · thème : ${themeLabel(cfg.theme)} (valeurs d’exemple)`,
          files: [new AttachmentBuilder(png, { name: 'level.png' })],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        console.error('[niveaux] aperçu :', err);
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
  const value = interaction.fields.getTextInputValue('levelUp').trim();
  if (value) cfg.texts = { ...cfg.texts, levelUp: value };
  updateModuleConfig(guild.id, ID, cfg);
  await interaction.deferUpdate();
  return interaction.editReply(renderMain(guild));
}

module.exports = { ID, DEFAULTS, render, handleComponent, handleModal, fill, levelUpText };
