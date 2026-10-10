const {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');

// Couleur unique pour TOUS les embeds du bot (violet).
const EMBED_COLOR = 0x9b59b6;

function embed(description) {
  const e = new EmbedBuilder().setColor(EMBED_COLOR);
  if (description) e.setDescription(description);
  return e;
}

function button(customId, label, style = ButtonStyle.Secondary, emoji) {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(truncate(label, 80)).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

// Bouton ON (vert) / OFF (gris) : un clic = bascule.
function toggleButton(customId, label, value) {
  return button(customId, `${label} : ${value ? 'ON' : 'OFF'}`, value ? ButtonStyle.Success : ButtonStyle.Secondary);
}

// Sélecteur de module (menu déroulant) présent dans /config.
function moduleSelectRow(modules, selectedId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('cfg:select')
    .setPlaceholder('Choisis un module à configurer')
    .addOptions(
      modules.map((m) => ({
        label: m.label,
        value: m.id,
        description: m.description,
        emoji: m.emoji,
        default: m.id === selectedId,
      })),
    );
  return row(menu);
}

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Réponse éphémère (visible seulement par l'utilisateur) avec un embed violet.
function ephemeralPayload(description) {
  return { embeds: [embed(description)], flags: MessageFlags.Ephemeral };
}

module.exports = {
  EMBED_COLOR,
  embed,
  button,
  row,
  toggleButton,
  moduleSelectRow,
  truncate,
  ephemeralPayload,
};
