// Module « Rôles par réaction » : panneaux de rôles attribués par réaction emoji.
//  - Un panneau = un message du bot (texte + embed violet) dans un salon, avec une réaction par rôle.
//  - Réagir donne le rôle ; retirer sa réaction retire le rôle.
//  - Limites : 10 panneaux par serveur, 20 rôles par panneau (limite de réactions d'un message Discord).
//  - Un message de panneau supprimé à la main est signalé : « Publier » le recrée.
const { ButtonStyle, ChannelSelectMenuBuilder, ChannelType, Events, RoleSelectMenuBuilder } = require('discord.js');
const crypto = require('crypto');
const store = require('../store');
const { embed, button, row, selectMenu, moduleSelectRow, textModal, ephemeralPayload, truncate } = require('../ui');
const { MODULE_LIST } = require('./registry');

const ID = 'reaction_roles';
const DEFAULTS = { panels: [] };
const MAX_PANELS = 10;
const MAX_PAIRS = 20;
const REACT_DELAY_MS = 350;
const PENDING_TTL_MS = 10 * 60 * 1000;
const TEXT_KINDS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const CUSTOM_EMOJI = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/;
const UNICODE_EMOJI = /^\p{Extended_Pictographic}(\uFE0F|\u20E3|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*$/u;

const cfgOf = (guildId) => {
  const cfg = store.getModuleConfig(guildId, ID, DEFAULTS);
  cfg.panels = Array.isArray(cfg.panels) ? cfg.panels : [];
  return cfg;
};
const save = (guildId, cfg) => store.updateModuleConfig(guildId, ID, cfg);

class ReactionRoleError extends Error {}
const fail = (message) => {
  throw new ReactionRoleError(message);
};

// ---------------------------------------------------------------------------
// Emojis : clé de comparaison (id pour un emoji serveur, caractère sinon)
// ---------------------------------------------------------------------------
const stripVariation = (s) => s.replace(/\uFE0F/g, '');

// Lit l'emoji saisi. Retourne { key, display, reactArg }, ou lève une erreur.
function parseEmoji(guild, input) {
  const text = String(input ?? '').trim();
  const custom = text.match(CUSTOM_EMOJI);
  if (custom) {
    const id = custom[3];
    const emoji = guild.emojis.cache.get(id);
    if (!emoji) fail('Cet emoji personnalisé n’appartient pas à ce serveur. Utilise un emoji du serveur ou un emoji classique.');
    // reactArg : forme « nom:id » attendue par discord.js pour réagir avec un emoji serveur.
    return { key: id, display: `<${custom[1]}:${custom[2]}:${id}>`, reactArg: `${custom[2]}:${emoji.id}` };
  }
  if (UNICODE_EMOJI.test(text)) return { key: stripVariation(text), display: text, reactArg: text };
  fail('Emoji non reconnu. Exemples : 🎮, ✅, ou un emoji personnalisé du serveur.');
}

// Clé d'une réaction reçue (ou d'une réaction du message).
const keyOfReaction = (reaction) => reaction.emoji.id ?? stripVariation(reaction.emoji.name ?? '');

// ---------------------------------------------------------------------------
// Panneau : embed et publication
// ---------------------------------------------------------------------------
function panelEmbed(panel) {
  const lines = panel.pairs.length
    ? panel.pairs.map((p) => `${p.display} → <@&${p.roleId}>`).join('\n')
    : '*Aucun rôle pour l’instant.*';
  return embed(`${panel.description ?? ''}\n\n${lines}`.trim()).setTitle(truncate(panel.title, 256));
}

async function resolveChannel(guild, channelId) {
  return guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
}

// Publie (ou met à jour) le message du panneau et réagit avec chaque emoji manquant.
async function publish(guild, panel) {
  if (!panel.channelId) fail('Choisis d’abord un salon pour ce panneau.');
  if (!panel.pairs.length) fail('Ajoute au moins un rôle avant de publier.');
  const channel = await resolveChannel(guild, panel.channelId);
  if (!channel || !channel.isTextBased() || channel.type === ChannelType.GuildForum) {
    fail('Le salon choisi est introuvable ou n’accepte pas de messages.');
  }
  let message = panel.messageId ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
  if (message) await message.edit({ embeds: [panelEmbed(panel)] });
  else message = await channel.send({ embeds: [panelEmbed(panel)], allowedMentions: { parse: [] } });
  panel.messageId = message.id;
  for (const pair of panel.pairs) {
    const present = message.reactions.cache.find((r) => keyOfReaction(r) === pair.key);
    if (present?.me) continue;
    await message.react(pair.reactArg).catch((err) => console.error('[rôles réaction] réaction impossible :', err.message));
    await new Promise((r) => setTimeout(r, REACT_DELAY_MS));
  }
  // Retire les réactions du bot qui ne correspondent plus à un rôle.
  for (const reaction of message.reactions.cache.values()) {
    if (reaction.me && !panel.pairs.some((p) => p.key === keyOfReaction(reaction))) {
      await reaction.users.remove(guild.client.user.id).catch(() => {});
    }
  }
  return message;
}

// ---------------------------------------------------------------------------
// Événements : donner ou retirer le rôle
// ---------------------------------------------------------------------------
function findPanel(guildId, messageId) {
  return cfgOf(guildId).panels.find((p) => p.messageId === messageId) ?? null;
}

async function applyReaction(reaction, user, add) {
  if (reaction.partial) await reaction.fetch().catch(() => null);
  if (user?.partial) await user.fetch().catch(() => null);
  if (!user || user.bot) return;
  const message = reaction.message;
  const guild = message?.guild;
  if (!guild) return;
  const panel = findPanel(guild.id, message.id);
  if (!panel) return;
  const key = keyOfReaction(reaction);
  const pair = panel.pairs.find((p) => p.key === key);
  if (!pair) return;
  const role = guild.roles.cache.get(pair.roleId);
  const member = guild.members.cache.get(user.id) ?? (await guild.members.fetch(user.id).catch(() => null));
  if (!role || !member) return;
  if (!role.editable) {
    console.warn(`[rôles réaction] rôle ${role.name} au-dessus du rôle du bot : impossible de l'attribuer.`);
    return;
  }
  if (add) await member.roles.add(role, 'Rôle par réaction').catch((err) => console.error('[rôles réaction] ajout :', err.message));
  else await member.roles.remove(role, 'Rôle par réaction retiré').catch((err) => console.error('[rôles réaction] retrait :', err.message));
}

function registerEvents(client) {
  client.on(Events.MessageReactionAdd, (reaction, user) =>
    applyReaction(reaction, user, true).catch((e) => console.error('[rôles réaction]', e)),
  );
  client.on(Events.MessageReactionRemove, (reaction, user) =>
    applyReaction(reaction, user, false).catch((e) => console.error('[rôles réaction]', e)),
  );
  client.on(Events.MessageDelete, (message) => {
    if (!message.guildId) return;
    const cfg = cfgOf(message.guildId);
    const panel = cfg.panels.find((p) => p.messageId === message.id);
    if (!panel) return;
    panel.messageId = null;
    save(message.guildId, cfg);
  });
}

// ---------------------------------------------------------------------------
// Interface /config
// ---------------------------------------------------------------------------
const pending = new Map(); // "guild:user:panel" -> { roleId: string|null, at: number }
const pendingKey = (guildId, userId, panelId) => `${guildId}:${userId}:${panelId}`;
function getPending(guildId, userId, panelId) {
  const p = pending.get(pendingKey(guildId, userId, panelId));
  if (!p || Date.now() - p.at > PENDING_TTL_MS) return null;
  return p;
}

const findPanelById = (cfg, id) => cfg.panels.find((p) => p.id === id) ?? null;

function renderMain(cfg) {
  const list = cfg.panels.length
    ? cfg.panels
        .map(
          (p) =>
            `**${p.title}** · ${p.channelId ? `<#${p.channelId}>` : 'salon non défini'} · ${p.pairs.length} rôle(s) · ${p.messageId ? '🟢 publié' : '⚪ non publié'}`,
        )
        .join('\n')
    : 'Aucun panneau. Crée-en un pour commencer.';
  const components = [
    moduleSelectRow(MODULE_LIST, ID),
    row(button('cfg:reaction_roles:new', 'Nouveau panneau', ButtonStyle.Success, '➕')),
  ];
  if (cfg.panels.length) {
    components.push(
      selectMenu(
        'cfg:reaction_roles:pick:panel',
        'Ouvrir un panneau',
        cfg.panels.map((p) => ({ label: p.title, value: p.id, description: `${p.pairs.length} rôle(s)` })),
      ),
    );
  }
  return {
    content: '🎭 **Rôles par réaction** · les membres réagissent à un message pour recevoir un rôle.',
    embeds: [embed(list)],
    components,
  };
}

function renderPanel(guildId, userId, cfg, panel) {
  const pend = getPending(guildId, userId, panel.id);
  const rows = [moduleSelectRow(MODULE_LIST, ID)];
  rows.push(
    row(
      new ChannelSelectMenuBuilder()
        .setCustomId(`cfg:reaction_roles:setchan:${panel.id}`)
        .setPlaceholder(panel.channelId ? 'Changer le salon du panneau' : 'Choisir le salon du panneau')
        .setChannelTypes(...TEXT_KINDS)
        .setMinValues(1)
        .setMaxValues(1),
    ),
  );
  rows.push(
    row(
      button(`cfg:reaction_roles:publish:${panel.id}`, panel.messageId ? 'Mettre à jour' : 'Publier', ButtonStyle.Success, '📨'),
      button(`cfg:reaction_roles:open:texts:${panel.id}`, 'Textes', ButtonStyle.Primary, '✏️'),
      button(`cfg:reaction_roles:addrole:${panel.id}`, 'Ajouter un rôle', ButtonStyle.Primary, '➕'),
      button(`cfg:reaction_roles:delete:${panel.id}`, 'Supprimer', ButtonStyle.Danger, '🗑️'),
      button('cfg:reaction_roles:view:main', 'Retour', ButtonStyle.Secondary, '⬅️'),
    ),
  );
  if (pend && pend.roleId === null) {
    rows.push(
      new RoleSelectMenuBuilder()
        .setCustomId(`cfg:reaction_roles:pickrole:${panel.id}`)
        .setPlaceholder('Choisir le rôle à donner')
        .setMinValues(1)
        .setMaxValues(1),
    );
  } else if (pend && pend.roleId) {
    rows.push(
      row(
        button(`cfg:reaction_roles:emoji:${panel.id}`, 'Choisir l’emoji de ce rôle', ButtonStyle.Success, '😀'),
        button(`cfg:reaction_roles:cancel:${panel.id}`, 'Annuler', ButtonStyle.Secondary),
      ),
    );
  }
  if (panel.pairs.length) {
    rows.push(
      selectMenu(
        `cfg:reaction_roles:delpair:${panel.id}`,
        'Retirer un rôle du panneau',
        panel.pairs.map((p) => ({ label: `${p.display} → ${roleName(p.roleId)}`, value: p.key, description: 'Retirer cette réaction' })),
      ),
    );
  }
  const pairsText = panel.pairs.length ? panel.pairs.map((p) => `${p.display} → <@&${p.roleId}>`).join('\n') : 'Aucun rôle.';
  const pendingText = pend?.roleId ? `\n\n➡️ Rôle choisi : <@&${pend.roleId}>. Clique « Choisir l’emoji de ce rôle ».` : '';
  return {
    content: `🎭 **${panel.title}** · ${panel.channelId ? `<#${panel.channelId}>` : 'salon non défini'} · ${panel.messageId ? '🟢 publié' : '⚪ non publié'}${pendingText}`,
    embeds: [embed(`${panel.description ?? ''}\n\n**Rôles :**\n${pairsText}`.trim())],
    components: rows.slice(0, 5),
  };
}

// Nom d'un rôle pour les menus (le menu ne rend pas les mentions).
let currentGuild = null;
const roleName = (id) => currentGuild?.roles.cache.get(id)?.name ?? 'rôle';

function render(view, guild, userId, arg) {
  const cfg = cfgOf(guild.id);
  currentGuild = guild;
  if (view === 'panel') {
    const panel = findPanelById(cfg, arg);
    if (panel) return renderPanel(guild.id, userId, cfg, panel);
  }
  return renderMain(cfg);
}

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  currentGuild = guild;
  const [, , action, ...rest] = interaction.customId.split(':');
  const arg = rest.join(':');
  const cfg = cfgOf(guild.id);
  const userId = interaction.user.id;
  const showPanel = (id) => interaction.update(renderPanel(guild.id, userId, cfg, findPanelById(cfg, id)));

  switch (action) {
    case 'view':
      return interaction.update(renderMain(cfg));

    case 'new':
      if (cfg.panels.length >= MAX_PANELS) return interaction.reply(ephemeralPayload(`Maximum ${MAX_PANELS} panneaux par serveur.`));
      return interaction.showModal(
        textModal('cfg:reaction_roles:modal:new', 'Nouveau panneau de rôles', [
          { key: 'title', label: 'Titre', max: 80, required: true, placeholder: 'Ex. : Choisis tes rôles' },
          { key: 'description', label: 'Texte d’introduction', max: 800, paragraph: true, required: false, placeholder: 'Explique ce que donne chaque réaction.' },
        ]),
      );

    case 'pick':
      if (arg !== 'panel') return;
      return showPanel(interaction.values[0]);

    case 'open': {
      const [what, panelId] = rest;
      const panel = findPanelById(cfg, panelId);
      if (what !== 'texts' || !panel) return;
      return interaction.showModal(
        textModal(`cfg:reaction_roles:modal:texts:${panel.id}`, 'Textes du panneau', [
          { key: 'title', label: 'Titre', max: 80, required: true, value: panel.title },
          { key: 'description', label: 'Texte d’introduction', max: 800, paragraph: true, required: false, value: panel.description ?? '' },
        ]),
      );
    }

    case 'setchan': {
      const panel = findPanelById(cfg, arg);
      if (!panel) return;
      panel.channelId = interaction.values[0];
      save(guild.id, cfg);
      return showPanel(panel.id);
    }

    case 'publish': {
      const panel = findPanelById(cfg, arg);
      if (!panel) return;
      await interaction.deferUpdate();
      try {
        await publish(guild, panel);
        save(guild.id, cfg);
        return interaction.editReply(renderPanel(guild.id, userId, cfg, panel));
      } catch (err) {
        if (err instanceof ReactionRoleError) return interaction.followUp(ephemeralPayload(`❌ ${err.message}`));
        console.error('[rôles réaction] publication :', err);
        return interaction.followUp(
          ephemeralPayload('❌ Publication impossible. Vérifie les permissions du bot dans ce salon (Voir le salon, Envoyer des messages, Ajouter des réactions).'),
        );
      }
    }

    case 'addrole': {
      const panel = findPanelById(cfg, arg);
      if (!panel) return;
      if (panel.pairs.length >= MAX_PAIRS) return interaction.reply(ephemeralPayload(`Maximum ${MAX_PAIRS} rôles par panneau.`));
      pending.set(pendingKey(guild.id, userId, panel.id), { roleId: null, at: Date.now() });
      return showPanel(panel.id);
    }

    case 'pickrole': {
      const panel = findPanelById(cfg, arg);
      const roleId = interaction.values[0];
      const role = guild.roles.cache.get(roleId);
      if (!panel || !role) return interaction.reply(ephemeralPayload('Rôle introuvable.'));
      if (!role.editable) {
        return interaction.reply(ephemeralPayload('Je ne peux pas attribuer ce rôle : il est au-dessus du mien ou géré par une intégration.'));
      }
      pending.set(pendingKey(guild.id, userId, panel.id), { roleId, at: Date.now() });
      return showPanel(panel.id);
    }

    case 'cancel':
      pending.delete(pendingKey(guild.id, userId, arg));
      return showPanel(arg);

    case 'emoji': {
      const panel = findPanelById(cfg, arg);
      const pend = getPending(guild.id, userId, arg);
      if (!panel || !pend?.roleId) return interaction.reply(ephemeralPayload('Choisis d’abord un rôle.'));
      return interaction.showModal(
        textModal(`cfg:reaction_roles:modal:emoji:${panel.id}`, 'Emoji du rôle', [
          { key: 'emoji', label: 'Emoji (classique ou du serveur)', max: 60, required: true, placeholder: 'Ex. : 🎮' },
        ]),
      );
    }

    case 'delpair': {
      const panel = findPanelById(cfg, arg);
      if (!panel) return;
      const key = interaction.values[0];
      panel.pairs = panel.pairs.filter((p) => p.key !== key);
      save(guild.id, cfg);
      return showPanel(panel.id);
    }

    case 'delete': {
      const panel = findPanelById(cfg, arg);
      if (!panel) return;
      if (panel.messageId && panel.channelId) {
        const channel = await resolveChannel(guild, panel.channelId);
        await channel?.messages.delete(panel.messageId).catch(() => {});
      }
      cfg.panels = cfg.panels.filter((p) => p.id !== panel.id);
      pending.delete(pendingKey(guild.id, userId, panel.id));
      save(guild.id, cfg);
      return interaction.update(renderMain(cfg));
    }

    default:
      return;
  }
}

async function handleModal(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  currentGuild = guild;
  const [, , , kind, panelId] = interaction.customId.split(':');
  const cfg = cfgOf(guild.id);
  const userId = interaction.user.id;
  const show = async (id) => {
    await interaction.deferUpdate();
    return interaction.editReply(renderPanel(guild.id, userId, cfg, findPanelById(cfg, id)));
  };

  try {
    if (kind === 'new') {
      if (cfg.panels.length >= MAX_PANELS) return interaction.reply(ephemeralPayload(`Maximum ${MAX_PANELS} panneaux par serveur.`));
      const title = interaction.fields.getTextInputValue('title').trim();
      if (!title) fail('Le titre ne peut pas être vide.');
      const panel = {
        id: crypto.randomBytes(4).toString('hex'),
        channelId: null,
        messageId: null,
        title,
        description: interaction.fields.getTextInputValue('description').trim(),
        pairs: [],
      };
      cfg.panels.push(panel);
      save(guild.id, cfg);
      return show(panel.id);
    }

    const panel = findPanelById(cfg, panelId);
    if (!panel) return interaction.reply(ephemeralPayload('Ce panneau n’existe plus.'));

    if (kind === 'texts') {
      panel.title = interaction.fields.getTextInputValue('title').trim() || panel.title;
      panel.description = interaction.fields.getTextInputValue('description').trim();
      save(guild.id, cfg);
      return show(panel.id);
    }

    if (kind === 'emoji') {
      const pend = getPending(guild.id, userId, panel.id);
      if (!pend?.roleId) return interaction.reply(ephemeralPayload('Le choix du rôle a expiré. Recommence par « Ajouter un rôle ».'));
      const parsed = parseEmoji(guild, interaction.fields.getTextInputValue('emoji'));
      if (panel.pairs.some((p) => p.key === parsed.key)) fail('Cet emoji est déjà utilisé dans ce panneau.');
      if (panel.pairs.some((p) => p.roleId === pend.roleId)) fail('Ce rôle est déjà dans ce panneau.');
      panel.pairs.push({ key: parsed.key, display: parsed.display, reactArg: parsed.reactArg, roleId: pend.roleId });
      pending.delete(pendingKey(guild.id, userId, panel.id));
      save(guild.id, cfg);
      return show(panel.id);
    }
    return interaction.reply(ephemeralPayload('Action inconnue.'));
  } catch (err) {
    if (err instanceof ReactionRoleError) return interaction.reply(ephemeralPayload(`❌ ${err.message}`));
    throw err;
  }
}

module.exports = {
  ID,
  DEFAULTS,
  MAX_PANELS,
  MAX_PAIRS,
  parseEmoji,
  keyOfReaction,
  render,
  handleComponent,
  handleModal,
  registerEvents,
  publish,
};
