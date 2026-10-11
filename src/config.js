const { MessageFlags } = require('discord.js');
const { embed, moduleSelectRow, ephemeralPayload } = require('./ui');
const { MODULE_LIST } = require('./modules/registry');
const ticket = require('./modules/ticket');
const embedModule = require('./modules/embed');
const welcome = require('./modules/welcome');
const levels = require('./modules/levels');
const suggestions = require('./modules/suggestions');
const links = require('./modules/links');

// Modules réellement implémentés (id -> module).
const MODULES = {
  [ticket.ID]: ticket,
  [embedModule.ID]: embedModule,
  [welcome.ID]: welcome,
  [levels.ID]: levels,
  [suggestions.ID]: suggestions,
  [links.ID]: links,
};

// Panneau d'accueil de /config : choix du module.
function rootPayload() {
  return {
    embeds: [
      embed(
        '⚙️ **Edge — Configuration**\n\nChoisis un module dans le menu ci-dessous, puis configure-le avec les boutons.',
      ),
    ],
    components: [moduleSelectRow(MODULE_LIST, null)],
    flags: MessageFlags.Ephemeral,
  };
}

// /config
async function handleConfigCommand(interaction) {
  if (!interaction.guild) {
    return interaction.reply(ephemeralPayload('Cette commande ne fonctionne que sur un serveur.'));
  }
  return interaction.reply(rootPayload());
}

// Composants et modales dont le customId commence par "cfg:"
//   cfg:select                   -> choix du module (menu déroulant)
//   cfg:<module>:<action>:<arg>  -> délégué au module concerné
async function handleConfigInteraction(interaction) {
  const [, target] = interaction.customId.split(':');

  if (target === 'select') {
    const mod = MODULES[interaction.values[0]];
    if (!mod) return interaction.reply(ephemeralPayload('Module introuvable.'));
    return interaction.update(mod.render('main', interaction.guild));
  }

  const mod = MODULES[target];
  if (!mod) return interaction.reply(ephemeralPayload('Module introuvable.'));

  if (interaction.isModalSubmit()) return mod.handleModal(interaction);
  return mod.handleComponent(interaction);
}

module.exports = { handleConfigCommand, handleConfigInteraction, MODULES, rootPayload };
