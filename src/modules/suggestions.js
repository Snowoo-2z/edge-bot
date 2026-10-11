// Module « Suggestions » : commande /suggestion, publication dans le salon choisi, votes pendant 3 jours.
//  - Le membre écrit sa suggestion dans une modale ; le bot la publie avec deux boutons de vote.
//  - Un membre vote Pour ou Contre (un seul vote par membre ; cliquer à nouveau retire son vote).
//  - Les votes se ferment automatiquement 3 jours après la publication (vérification toutes les minutes).
//  - Les suggestions sont enregistrées dans Supabase (table edge_suggestions) : elles restent actives après un redémarrage.
const crypto = require('crypto');
const { ButtonBuilder, ButtonStyle, ChannelType, ChannelSelectMenuBuilder, Events, MessageFlags } = require('discord.js');
const store = require('../store');
const { getModuleConfig, updateModuleConfig } = store;
const { embed, button, row, toggleButton, textModal, moduleSelectRow, ephemeralPayload, truncate } = require('../ui');
const { MODULE_LIST } = require('./registry');

const ID = 'suggestions';
const DEFAULTS = { enabled: false, channelId: null };
const VOTE_MS = 3 * 24 * 60 * 60 * 1000; // 3 jours
const SWEEP_MS = 60_000;

const suggestions = new Map(); // id -> suggestion (miroir de la table edge_suggestions)
let discordClient = null;
let sweeperStarted = false;

const cfgOf = (guildId) => getModuleConfig(guildId, ID, DEFAULTS);

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------

// Charge les suggestions encore ouvertes (au démarrage).
async function init() {
  const rows = await store.loadOpenSuggestions();
  for (const row of rows) {
    suggestions.set(row.id, { ...row, up_ids: row.up_ids ?? [], down_ids: row.down_ids ?? [] });
  }
  console.log(`[suggestions] ${rows.length} suggestion(s) ouverte(s) chargée(s) depuis Supabase.`);
}

function persist(s) {
  store.saveSuggestion(s).catch((err) => console.error('[suggestions] sauvegarde échouée :', err.message));
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

function suggestionPayload(s) {
  const closed = s.closed;
  const endUnix = Math.floor(Date.parse(s.ends_at) / 1000);
  const e = embed(truncate(s.content, 3500)).setTitle(closed ? '💡 Suggestion · vote terminé' : '💡 Suggestion');
  e.addFields(
    { name: 'Auteur', value: `<@${s.author_id}>`, inline: true },
    closed
      ? { name: 'Résultat', value: resultText(s), inline: true }
      : { name: 'Fin des votes', value: `<t:${endUnix}:f> (<t:${endUnix}:R>)`, inline: true },
  );
  const up = new ButtonBuilder()
    .setCustomId(`suggest:vote:up:${s.id}`)
    .setLabel(`Pour · ${s.up_ids.length}`)
    .setStyle(ButtonStyle.Success)
    .setEmoji('👍')
    .setDisabled(closed);
  const down = new ButtonBuilder()
    .setCustomId(`suggest:vote:down:${s.id}`)
    .setLabel(`Contre · ${s.down_ids.length}`)
    .setStyle(ButtonStyle.Danger)
    .setEmoji('👎')
    .setDisabled(closed);
  return { embeds: [e], components: [row(up, down)], allowedMentions: { parse: [] } };
}

function resultText(s) {
  const up = s.up_ids.length;
  const down = s.down_ids.length;
  if (up === 0 && down === 0) return 'Aucun vote';
  if (up > down) return `Majorité pour (${up} pour, ${down} contre)`;
  if (down > up) return `Majorité contre (${up} pour, ${down} contre)`;
  return `Égalité (${up} pour, ${down} contre)`;
}

// ---------------------------------------------------------------------------
// Config (/config → Suggestions)
// ---------------------------------------------------------------------------

function render(view, guild) {
  if (view === 'channel') return renderChannel();
  return renderMain(guild);
}

function renderMain(guild) {
  const cfg = cfgOf(guild.id);
  const channel = cfg.channelId ? `<#${cfg.channelId}>` : '⚠️ non défini';
  return {
    content:
      '💡 **Module Suggestions** · la commande `/suggestion` publie les idées dans le salon choisi, avec des votes ouverts pendant 3 jours.',
    embeds: [
      embed().addFields(
        { name: 'Module', value: cfg.enabled ? '🟢 Activé' : '⚪ Désactivé', inline: true },
        { name: 'Salon', value: channel, inline: true },
        { name: 'Durée des votes', value: '3 jours', inline: true },
      ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        toggleButton('cfg:suggestions:toggle:enabled', 'Module', cfg.enabled),
        button('cfg:suggestions:view:channel', 'Salon', ButtonStyle.Primary, '📍'),
      ),
    ],
  };
}

function renderChannel() {
  return {
    embeds: [embed('Choisis le salon où sont publiées les suggestions.')],
    components: [
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:suggestions:pick:channel')
          .setPlaceholder('Sélectionne un salon')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1),
      ),
      row(button('cfg:suggestions:view:main', '◀ Retour', ButtonStyle.Danger)),
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
      if (arg !== 'channel') return;
      cfg.channelId = interaction.values[0];
      updateModuleConfig(guild.id, ID, cfg);
      return interaction.update(renderMain(guild));
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Commande /suggestion, modale et votes
// ---------------------------------------------------------------------------

async function handleCommand(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply(ephemeralPayload('Cette commande ne fonctionne que sur un serveur.'));
  const cfg = cfgOf(guild.id);
  if (!cfg.enabled || !cfg.channelId) {
    return interaction.reply(ephemeralPayload('Les suggestions ne sont pas activées sur ce serveur.'));
  }
  return interaction.showModal(
    textModal('suggest:modal', 'Nouvelle suggestion', [
      {
        key: 'content',
        label: 'Ta suggestion',
        max: 1000,
        paragraph: true,
        required: true,
        placeholder: 'Décris ton idée. Les membres voteront pendant 3 jours.',
      },
    ]),
  );
}

async function handleSubmit(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  // Accusé de réception immédiat (Discord attend une réponse dans les 3 s) ; tout le reste est édité ensuite.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const say = (text) => interaction.editReply({ embeds: [embed(text)] });

  const cfg = cfgOf(guild.id);
  if (!cfg.enabled || !cfg.channelId) return say('Les suggestions ne sont pas activées sur ce serveur.');
  const channel =
    guild.channels.cache.get(cfg.channelId) ?? (await guild.channels.fetch(cfg.channelId).catch(() => null));
  if (!channel?.isTextBased()) return say('Le salon des suggestions est introuvable. Un admin doit le reconfigurer.');

  const content = interaction.fields.getTextInputValue('content').trim();
  const now = Date.now();
  const s = {
    id: crypto.randomUUID().slice(0, 8),
    guild_id: guild.id,
    channel_id: channel.id,
    message_id: null,
    author_id: interaction.user.id,
    content,
    up_ids: [],
    down_ids: [],
    created_at: new Date(now).toISOString(),
    ends_at: new Date(now + VOTE_MS).toISOString(),
    closed: false,
  };
  try {
    const message = await channel.send(suggestionPayload(s));
    s.message_id = message.id;
  } catch (err) {
    console.error('[suggestions] publication impossible :', err.message);
    return say('❌ Impossible de publier la suggestion (permissions du bot dans ce salon ?).');
  }
  suggestions.set(s.id, s);
  persist(s);
  return interaction.editReply({ embeds: [embed(`✅ Ta suggestion a été publiée dans <#${channel.id}>. Les votes durent 3 jours.`)] });
}

async function handleVote(interaction) {
  const [, , direction, id] = interaction.customId.split(':');
  const s = suggestions.get(id);
  if (!s) return interaction.reply(ephemeralPayload('Suggestion introuvable.'));
  if (s.closed || Date.now() >= Date.parse(s.ends_at)) {
    return interaction.reply(ephemeralPayload('Les votes pour cette suggestion sont terminés.'));
  }

  const userId = interaction.user.id;
  const wantUp = direction === 'up';
  const alreadyUp = s.up_ids.includes(userId);
  const alreadyDown = s.down_ids.includes(userId);
  s.up_ids = s.up_ids.filter((x) => x !== userId);
  s.down_ids = s.down_ids.filter((x) => x !== userId);

  let text;
  if (wantUp && !alreadyUp) {
    s.up_ids.push(userId);
    text = '👍 Ton vote « Pour » a été enregistré.';
  } else if (!wantUp && !alreadyDown) {
    s.down_ids.push(userId);
    text = '👎 Ton vote « Contre » a été enregistré.';
  } else {
    text = 'Ton vote a été retiré.';
  }

  persist(s);
  await interaction.update(suggestionPayload(s));
  return interaction.followUp(ephemeralPayload(text));
}

async function handleInteraction(interaction) {
  if (interaction.isModalSubmit()) return handleSubmit(interaction);
  return handleVote(interaction);
}

// ---------------------------------------------------------------------------
// Fermeture automatique des votes
// ---------------------------------------------------------------------------

async function closeDue() {
  if (!discordClient) return;
  const now = Date.now();
  for (const s of suggestions.values()) {
    if (s.closed || Date.parse(s.ends_at) > now) continue;
    s.closed = true;
    persist(s);
    try {
      const channel =
        discordClient.channels.cache.get(s.channel_id) ?? (await discordClient.channels.fetch(s.channel_id));
      const message = await channel.messages.fetch(s.message_id);
      await message.edit(suggestionPayload(s));
    } catch (err) {
      console.error(`[suggestions] fermeture de ${s.id} : message introuvable ou non modifiable (${err.message})`);
    }
  }
}

// Appelée au démarrage et à chaque connexion : le client sert à éditer les messages.
function registerEvents(client) {
  client.once(Events.ClientReady, (c) => {
    discordClient = c;
    if (!sweeperStarted) {
      sweeperStarted = true;
      setInterval(() => closeDue().catch((err) => console.error('[suggestions] erreur :', err)), SWEEP_MS).unref();
    }
  });
}

module.exports = {
  ID,
  DEFAULTS,
  VOTE_MS,
  init,
  render,
  handleComponent,
  handleCommand,
  handleInteraction,
  registerEvents,
  closeDue,
  suggestions,
  suggestionPayload,
  resultText,
};
