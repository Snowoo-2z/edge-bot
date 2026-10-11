// Module « Niveaux » de /config : thème de la carte de niveau (commande /level).
// Les règles d'XP (20 XP par minute en vocal) sont dans src/leveling.js.
const { AttachmentBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { getModuleConfig, updateModuleConfig } = require('../store');
const { embed, button, row, selectMenu, moduleSelectRow, ephemeralPayload } = require('../ui');
const { MODULE_LIST } = require('./registry');
const { THEMES, THEME_LIST } = require('../welcome-image');
const { renderLevelCard, LEVEL_DEFAULT_THEME } = require('../level-card');

const ID = 'levels';
const DEFAULTS = {
  theme: LEVEL_DEFAULT_THEME,
};

function cfgOf(guildId) {
  return getModuleConfig(guildId, ID, DEFAULTS);
}

function themeLabel(id) {
  const t = THEMES[id] ?? THEMES[LEVEL_DEFAULT_THEME];
  return `${t.emoji} ${t.label}`;
}

function renderMain(guild) {
  const cfg = cfgOf(guild.id);
  return {
    content: '🏅 **Module Niveaux** · le temps passé en vocal rapporte de l’XP (AFK compris).',
    embeds: [
      embed().addFields(
        { name: 'Thème de la carte /level', value: themeLabel(cfg.theme), inline: true },
        { name: 'Gain', value: '20 XP par minute en vocal', inline: true },
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
      row(button('cfg:levels:preview', 'Aperçu de la carte', ButtonStyle.Success, '👁️')),
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
      return interaction.update(renderMain(guild));

    case 'pick': {
      if (arg !== 'theme') return;
      const theme = interaction.values[0];
      if (!THEMES[theme]) return;
      cfg.theme = theme;
      updateModuleConfig(guild.id, ID, cfg);
      return interaction.update(renderMain(guild));
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

module.exports = { ID, DEFAULTS, render: (_view, guild) => renderMain(guild), handleComponent };
