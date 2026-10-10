const {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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

// Menu déroulant générique. options = [{ label, value, description?, emoji? }]
function selectMenu(customId, placeholder, options) {
  return row(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(truncate(placeholder, 150))
      .addOptions(
        options.map((o) => ({
          label: truncate(o.label, 100),
          value: String(o.value),
          ...(o.description ? { description: truncate(o.description, 100) } : {}),
          ...(o.emoji ? { emoji: o.emoji } : {}),
          ...(o.default ? { default: true } : {}),
        })),
      ),
  );
}

// Sélecteur de module (menu déroulant) présent dans /config.
function moduleSelectRow(modules, selectedId) {
  return selectMenu(
    'cfg:select',
    'Choisis un module à configurer',
    modules.map((m) => ({
      label: m.label,
      value: m.id,
      description: m.description,
      emoji: m.emoji,
      default: m.id === selectedId,
    })),
  );
}

// Fenêtre de saisie (modale) générique.
// fields = [{ key, label, max, paragraph?, required?, value?, placeholder? }]
function textModal(customId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(truncate(title, 45));
  for (const f of fields) {
    const input = new TextInputBuilder()
      .setCustomId(f.key)
      .setLabel(truncate(f.label, 45))
      .setStyle(f.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setMaxLength(f.max)
      .setRequired(Boolean(f.required));
    if (f.value) input.setValue(truncate(f.value, f.max));
    if (f.placeholder) input.setPlaceholder(truncate(f.placeholder, 100));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
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
  selectMenu,
  moduleSelectRow,
  textModal,
  truncate,
  ephemeralPayload,
};
