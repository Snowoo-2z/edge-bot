const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonStyle,
  ChannelType,
  ChannelSelectMenuBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { DATA_DIR, getModuleConfig, updateModuleConfig, getGuildModule } = require('../store');
const { embed, button, row, toggleButton, truncate, moduleSelectRow, ephemeralPayload } = require('../ui');
const { MODULE_LIST } = require('./registry');

const ID = 'ticket';
const ASSETS_DIR = path.join(DATA_DIR, 'assets');
const MAX_FILE_BYTES = 8 * 1024 * 1024; // limite d'upload Discord (salon standard)
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const EXT_ALLOWED = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  gif: ['.gif'],
};
const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// Tous les textes modifiables. "max" = limite Discord du champ.
const TEXTS = [
  { key: 'panel_title', label: 'Titre panneau', style: 'short', max: 256, default: '🎫 Support' },
  {
    key: 'panel_description',
    label: 'Description panneau',
    style: 'long',
    max: 4000,
    default: 'Clique sur le bouton ci-dessous pour ouvrir un ticket.',
  },
  { key: 'panel_button', label: 'Bouton ouvrir', style: 'short', max: 80, default: 'Ouvrir un ticket' },
  { key: 'panel_footer', label: 'Footer panneau', style: 'short', max: 2048, default: 'Edge • Tickets' },
  { key: 'channel_name', label: 'Nom des salons', style: 'short', max: 100, default: 'ticket-{user}' },
  { key: 'welcome_title', label: 'Titre accueil', style: 'short', max: 256, default: 'Bienvenue {user} !' },
  {
    key: 'welcome_description',
    label: 'Description accueil',
    style: 'long',
    max: 4000,
    default: 'Décris ta demande, un membre du staff va te répondre.',
  },
  { key: 'welcome_footer', label: 'Footer accueil', style: 'short', max: 2048, default: 'Ticket #{number}' },
  { key: 'close_button', label: 'Bouton fermer', style: 'short', max: 80, default: '🔒 Fermer le ticket' },
  {
    key: 'msg_opened',
    label: 'Msg ticket créé',
    style: 'long',
    max: 1000,
    default: 'Ton ticket a été créé : {channel}',
  },
  {
    key: 'msg_already_open',
    label: 'Msg déjà ouvert',
    style: 'long',
    max: 1000,
    default: 'Tu as déjà un ticket ouvert : {channel}',
  },
  {
    key: 'msg_closed',
    label: 'Msg fermeture',
    style: 'long',
    max: 1000,
    default: 'Ticket fermé. Le salon sera supprimé dans 5 secondes.',
  },
  {
    key: 'msg_disabled',
    label: 'Msg désactivé',
    style: 'long',
    max: 1000,
    default: 'Le système de tickets est désactivé sur ce serveur.',
  },
];
const TEXT_BY_KEY = Object.fromEntries(TEXTS.map((t) => [t.key, t]));

const DEFAULTS = {
  enabled: true,
  image: false, // image affichée sur le panneau
  gif: false, // GIF affiché dans le salon du ticket
  categoryId: null,
  counter: 0,
  assets: { image: null, gif: null }, // nom de fichier stocké dans data/assets/<guild>/
  open: {}, // channelId -> userId
  texts: Object.fromEntries(TEXTS.map((t) => [t.key, t.default])),
};

// Uploads en attente : clé "guild:user" -> { collector, interaction }
const pendingUploads = new Map();
// Anti double-clic lors de l'ouverture d'un ticket
const openingUsers = new Set();

function cfgOf(guildId) {
  return getModuleConfig(guildId, ID, DEFAULTS);
}

function save(guildId, cfg) {
  updateModuleConfig(guildId, ID, cfg);
}

function fmt(template, vars) {
  return String(template).replace(/\{(user|number|channel)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function assetFile(guildId, filename) {
  return path.join(ASSETS_DIR, guildId, filename);
}

function assetExists(guildId, filename) {
  return Boolean(filename) && fs.existsSync(assetFile(guildId, filename));
}

function countOpen(guild, cfg) {
  return Object.keys(cfg.open).filter((id) => guild.channels.cache.has(id)).length;
}

// ---------------------------------------------------------------------------
// Vues (rendu du panneau /config)
// ---------------------------------------------------------------------------

function render(view, guild) {
  const cfg = cfgOf(guild.id);
  switch (view) {
    case 'texts':
      return renderTexts(cfg);
    case 'publish':
      return renderChannelPicker(
        'Choisis le salon où publier le panneau **Ouvrir un ticket**.',
        'cfg:ticket:pick:publish',
        [ChannelType.GuildText],
        null,
      );
    case 'category':
      return renderChannelPicker(
        'Choisis la **catégorie** dans laquelle seront créés les tickets.',
        'cfg:ticket:pick:category',
        [ChannelType.GuildCategory],
        'clear:category',
      );
    case 'upload-image':
      return renderUpload('image');
    case 'upload-gif':
      return renderUpload('gif');
    case 'main':
    default:
      return renderMain(guild, cfg);
  }
}

function renderMain(guild, cfg) {
  const e = embed()
    .setTitle('🎫 Module Ticket')
    .setDescription(
      'Utilise les boutons pour activer/désactiver les options.\nLes textes se modifient via **✏️ Textes**.',
    )
    .addFields(
      { name: 'Module', value: cfg.enabled ? '🟢 Activé' : '⚪ Désactivé', inline: true },
      {
        name: 'Image du panneau',
        value: `${cfg.image ? '🟢 ON' : '⚪ OFF'} • ${assetExists(guild.id, cfg.assets.image) ? '✅ fichier' : '❌ aucun fichier'}`,
        inline: true,
      },
      {
        name: 'GIF du ticket',
        value: `${cfg.gif ? '🟢 ON' : '⚪ OFF'} • ${assetExists(guild.id, cfg.assets.gif) ? '✅ fichier' : '❌ aucun fichier'}`,
        inline: true,
      },
      { name: 'Catégorie', value: cfg.categoryId ? `<#${cfg.categoryId}>` : 'Aucune', inline: true },
      { name: 'Tickets ouverts', value: String(countOpen(guild, cfg)), inline: true },
    );

  return {
    embeds: [e],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        toggleButton('cfg:ticket:toggle:enabled', 'Module', cfg.enabled),
        toggleButton('cfg:ticket:toggle:image', 'Image', cfg.image),
        toggleButton('cfg:ticket:toggle:gif', 'GIF', cfg.gif),
        button('cfg:ticket:view:category', 'Catégorie', ButtonStyle.Secondary, '📁'),
        button('cfg:ticket:view:publish', 'Publier le panneau', ButtonStyle.Primary, '📌'),
      ),
      row(
        button('cfg:ticket:view:upload-image', 'Importer image', ButtonStyle.Secondary, '🖼️'),
        button('cfg:ticket:remove:image', 'Retirer image', ButtonStyle.Secondary, '🗑️'),
        button('cfg:ticket:view:upload-gif', 'Importer GIF', ButtonStyle.Secondary, '🎞️'),
        button('cfg:ticket:remove:gif', 'Retirer GIF', ButtonStyle.Secondary, '🗑️'),
        button('cfg:ticket:view:texts', 'Textes', ButtonStyle.Primary, '✏️'),
      ),
    ],
  };
}

function renderTexts(cfg) {
  const e = embed()
    .setTitle('✏️ Textes du module Ticket')
    .setDescription(
      'Clique sur un bouton pour modifier le texte.\n' +
        'Variables : `{user}` (pseudo), `{number}` (n° du ticket), `{channel}` (salon du ticket).',
    )
    .addFields(
      TEXTS.map((t) => ({
        name: t.label,
        value: truncate(cfg.texts[t.key], 200) || '—',
        inline: false,
      })),
    );

  const rows = [];
  for (let i = 0; i < TEXTS.length; i += 5) {
    rows.push(
      row(
        ...TEXTS.slice(i, i + 5).map((t) => button(`cfg:ticket:text:${t.key}`, t.label, ButtonStyle.Secondary)),
      ),
    );
  }
  rows.push(row(button('cfg:ticket:view:main', '◀ Retour', ButtonStyle.Danger)));
  return { embeds: [e], components: rows };
}

function renderChannelPicker(description, customId, types, clearId) {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Sélectionne un salon')
    .setChannelTypes(...types)
    .setMinValues(1)
    .setMaxValues(1);
  const buttons = [];
  if (clearId) buttons.push(button(`cfg:ticket:${clearId}`, 'Retirer la catégorie', ButtonStyle.Secondary, '🗑️'));
  buttons.push(button('cfg:ticket:view:main', '◀ Retour', ButtonStyle.Danger));
  return {
    embeds: [embed(description)],
    components: [row(menu), row(...buttons)],
  };
}

function renderUpload(kind) {
  const label = kind === 'image' ? 'image' : 'GIF';
  const formats = kind === 'image' ? 'PNG, JPG, WEBP ou GIF' : 'GIF';
  return {
    embeds: [
      embed(
        `📥 **Envoie ton ${label}** en pièce jointe **dans ce salon** (format : ${formats}, max 8 Mo).\n` +
          `Tu as 2 minutes. Clique sur Annuler pour revenir.`,
      ),
    ],
    components: [row(button('cfg:ticket:view:main', 'Annuler', ButtonStyle.Danger))],
  };
}

// ---------------------------------------------------------------------------
// Interactions du panneau /config
// ---------------------------------------------------------------------------

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , action, arg] = interaction.customId.split(':');
  const userId = interaction.user.id;

  // Toute navigation annule un import en attente de cet utilisateur.
  cancelPendingUpload(guild.id, userId);

  const cfg = cfgOf(guild.id);

  switch (action) {
    case 'view': {
      if (arg.startsWith('upload-')) {
        const kind = arg.slice('upload-'.length);
        await interaction.update(render(arg, guild));
        return startUpload(interaction, guild, kind);
      }
      return interaction.update(render(arg, guild));
    }

    case 'toggle': {
      if (!['enabled', 'image', 'gif'].includes(arg)) return;
      cfg[arg] = !cfg[arg];
      save(guild.id, cfg);
      return interaction.update(render('main', guild));
    }

    case 'remove': {
      if (!['image', 'gif'].includes(arg)) return;
      const filename = cfg.assets[arg];
      if (filename) {
        fs.rmSync(assetFile(guild.id, filename), { force: true });
      }
      cfg.assets[arg] = null;
      save(guild.id, cfg);
      return interaction.update(render('main', guild));
    }

    case 'text': {
      const def = TEXT_BY_KEY[arg];
      if (!def) return;
      const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(truncate(def.label, 45))
        .setStyle(def.style === 'long' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setValue(truncate(cfg.texts[arg], def.max))
        .setMinLength(1)
        .setMaxLength(def.max)
        .setRequired(true);
      const modal = new ModalBuilder()
        .setCustomId(`cfg:ticket:modal:${arg}`)
        .setTitle(truncate(`Modifier : ${def.label}`, 45))
        .addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    case 'pick': {
      const value = interaction.values[0];
      if (arg === 'category') {
        cfg.categoryId = value;
        save(guild.id, cfg);
        return interaction.update(render('main', guild));
      }
      if (arg === 'publish') {
        await interaction.deferUpdate();
        try {
          const channel = guild.channels.cache.get(value) ?? (await guild.channels.fetch(value));
          await publishPanel(guild, cfg, channel);
          await interaction.editReply(render('main', guild));
          return interaction.followUp(ephemeralPayload(`✅ Panneau publié dans <#${channel.id}>.`));
        } catch (err) {
          console.error('[ticket] publication du panneau :', err);
          await interaction.editReply(render('main', guild));
          return interaction.followUp(
            ephemeralPayload("❌ Impossible de publier le panneau ici. Vérifie que j'ai la permission d'envoyer des messages dans ce salon."),
          );
        }
      }
      return;
    }

    case 'clear': {
      if (arg === 'category') {
        cfg.categoryId = null;
        save(guild.id, cfg);
        return interaction.update(render('main', guild));
      }
      return;
    }

    default:
      return;
  }
}

async function handleModal(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , , key] = interaction.customId.split(':');
  if (!TEXT_BY_KEY[key]) return;

  const value = interaction.fields.getTextInputValue('value').trim();
  const cfg = cfgOf(guild.id);
  cfg.texts[key] = value;
  save(guild.id, cfg);

  await interaction.deferUpdate();
  return interaction.editReply(render('texts', guild));
}

// ---------------------------------------------------------------------------
// Images / GIF : import par pièce jointe dans le salon
// ---------------------------------------------------------------------------

function uploadKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function cancelPendingUpload(guildId, userId) {
  const key = uploadKey(guildId, userId);
  const pending = pendingUploads.get(key);
  if (pending) {
    pendingUploads.delete(key);
    pending.collector.stop('navigate');
  }
}

function startUpload(interaction, guild, kind) {
  const userId = interaction.user.id;
  const key = uploadKey(guild.id, userId);

  const collector = interaction.channel.createMessageCollector({
    filter: (m) => m.author.id === userId && m.attachments.size > 0,
    time: UPLOAD_TIMEOUT_MS,
  });
  pendingUploads.set(key, { collector, interaction });

  collector.on('collect', async (msg) => {
    const result = await saveAsset(guild, kind, msg.attachments.first());
    if (!result.ok) {
      const warn = await msg
        .reply({ embeds: [embed(`❌ ${result.reason}`)] })
        .catch(() => null);
      if (warn) setTimeout(() => warn.delete().catch(() => {}), 10_000);
      return; // on continue d'attendre un fichier valide
    }
    msg.delete().catch(() => {});
    collector.stop('ok');
  });

  collector.on('end', async (_collected, reason) => {
    if (pendingUploads.get(key)?.collector === collector) pendingUploads.delete(key);
    if (reason === 'navigate') return;
    try {
      await interaction.editReply(render('main', guild));
      if (reason === 'ok') {
        await interaction.followUp(ephemeralPayload(`✅ ${kind === 'image' ? 'Image' : 'GIF'} enregistré(e).`));
      } else if (reason === 'time') {
        await interaction.followUp(ephemeralPayload('⌛ Temps écoulé, aucun fichier reçu.'));
      }
    } catch (err) {
      console.error('[ticket] fin d’import :', err);
    }
  });
}

async function saveAsset(guild, kind, attachment) {
  if (!attachment) return { ok: false, reason: 'Aucune pièce jointe.' };
  const name = (attachment.name || '').toLowerCase();
  let ext = path.extname(name);
  if (!ext && attachment.contentType) ext = MIME_TO_EXT[attachment.contentType.split(';')[0]] ?? '';

  if (!EXT_ALLOWED[kind].includes(ext)) {
    return { ok: false, reason: `Format non supporté. Formats acceptés : ${EXT_ALLOWED[kind].join(', ')}` };
  }
  if (attachment.size > MAX_FILE_BYTES) {
    return { ok: false, reason: 'Fichier trop lourd (max 8 Mo).' };
  }

  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_FILE_BYTES) return { ok: false, reason: 'Fichier trop lourd (max 8 Mo).' };

    const dir = path.join(ASSETS_DIR, guild.id);
    fs.mkdirSync(dir, { recursive: true });

    const cfg = cfgOf(guild.id);
    const filename = `${kind}${ext}`;
    // Supprime l'ancien fichier de ce slot (ex : extension différente).
    if (cfg.assets[kind] && cfg.assets[kind] !== filename) {
      fs.rmSync(assetFile(guild.id, cfg.assets[kind]), { force: true });
    }
    fs.writeFileSync(assetFile(guild.id, filename), buffer);
    cfg.assets[kind] = filename;
    save(guild.id, cfg);
    return { ok: true, filename };
  } catch (err) {
    console.error('[ticket] téléchargement asset :', err);
    return { ok: false, reason: 'Impossible de télécharger le fichier, réessaie.' };
  }
}

// ---------------------------------------------------------------------------
// Panneau public + ouverture / fermeture des tickets
// ---------------------------------------------------------------------------

function attachmentFor(guildId, filename) {
  return new AttachmentBuilder(assetFile(guildId, filename), { name: filename });
}

async function publishPanel(guild, cfg, channel) {
  const t = cfg.texts;
  const e = embed().setTitle(t.panel_title).setDescription(t.panel_description).setFooter({ text: t.panel_footer });
  const files = [];
  if (cfg.image && assetExists(guild.id, cfg.assets.image)) {
    files.push(attachmentFor(guild.id, cfg.assets.image));
    e.setImage(`attachment://${cfg.assets.image}`);
  }
  const btn = button('tkt:open', t.panel_button, ButtonStyle.Primary, '🎫');
  await channel.send({ embeds: [e], components: [row(btn)], files });
}

async function findOpenTicket(guild, cfg, userId) {
  for (const [channelId, ownerId] of Object.entries(cfg.open)) {
    if (ownerId !== userId) continue;
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (channel) return channel;
    delete cfg.open[channelId]; // salon supprimé entre-temps
    save(guild.id, cfg);
  }
  return null;
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function openTicket(interaction) {
  const guild = interaction.guild;
  const user = interaction.user;
  const cfg = cfgOf(guild.id);
  const t = cfg.texts;
  const displayName = interaction.member?.displayName ?? user.username;

  if (!cfg.enabled) return interaction.reply(ephemeralPayload(t.msg_disabled));
  if (openingUsers.has(user.id)) return interaction.reply(ephemeralPayload('⏳ Ton ticket est en cours de création.'));

  openingUsers.add(user.id);
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const existing = await findOpenTicket(guild, cfg, user.id);
    if (existing) {
      return interaction.editReply(
        ephemeralPayload(fmt(t.msg_already_open, { user: displayName, channel: `<#${existing.id}>` })),
      );
    }

    cfg.counter += 1;
    const number = cfg.counter;
    const vars = { user: displayName, number, channel: '' };
    const name = truncate(slugify(fmt(t.channel_name, vars)), 100) || `ticket-${number}`;

    const me = guild.members.me;
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
    ];
    if (me) {
      overwrites.push({
        id: me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
        ],
      });
    }

    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: cfg.categoryId ?? undefined,
      topic: `Ticket de ${user.tag ?? user.username} (${user.id})`,
      permissionOverwrites: overwrites,
    });

    cfg.open[channel.id] = user.id;
    save(guild.id, cfg);

    vars.channel = `<#${channel.id}>`;
    const welcome = embed()
      .setTitle(truncate(fmt(t.welcome_title, vars), 256))
      .setDescription(fmt(t.welcome_description, vars))
      .setFooter({ text: fmt(t.welcome_footer, vars) });
    const files = [];
    if (cfg.gif && assetExists(guild.id, cfg.assets.gif)) {
      files.push(attachmentFor(guild.id, cfg.assets.gif));
      welcome.setImage(`attachment://${cfg.assets.gif}`);
    }

    await channel.send({
      content: `<@${user.id}>`,
      embeds: [welcome],
      components: [row(button('tkt:close', t.close_button, ButtonStyle.Danger))],
      files,
      allowedMentions: { users: [user.id] },
    });

    return interaction.editReply(ephemeralPayload(fmt(t.msg_opened, vars)));
  } catch (err) {
    console.error('[ticket] ouverture :', err);
    const payload = ephemeralPayload(
      '❌ Impossible de créer le ticket. Vérifie que j’ai la permission **Gérer les salons**.',
    );
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
    return interaction.reply(payload);
  } finally {
    openingUsers.delete(user.id);
  }
}

async function closeTicket(interaction) {
  const guild = interaction.guild;
  const cfg = cfgOf(guild.id);
  const channelId = interaction.channelId;

  if (!cfg.open[channelId]) {
    return interaction.reply(ephemeralPayload('Ce salon n’est pas un ticket.'));
  }

  delete cfg.open[channelId];
  save(guild.id, cfg);

  const vars = { user: interaction.member?.displayName ?? interaction.user.username, number: '', channel: `<#${channelId}>` };
  await interaction.reply({ embeds: [embed(fmt(cfg.texts.msg_closed, vars))] });
  setTimeout(() => {
    interaction.channel?.delete('Ticket fermé via Edge').catch((err) => console.error('[ticket] suppression :', err));
  }, 5000);
}

// Boutons publics du panneau (customId "tkt:...")
async function handlePublicInteraction(interaction) {
  if (!interaction.guild) return;
  if (interaction.customId === 'tkt:open') return openTicket(interaction);
  if (interaction.customId === 'tkt:close') return closeTicket(interaction);
}

function registerEvents(client) {
  // Si un salon ticket est supprimé à la main, on le retire de la liste.
  client.on('channelDelete', (channel) => {
    if (!channel.guildId) return;
    const cfg = getGuildModule(channel.guildId, ID);
    if (cfg?.open?.[channel.id]) {
      delete cfg.open[channel.id];
      save(channel.guildId, cfg);
    }
  });
}

module.exports = {
  ID,
  DEFAULTS,
  TEXTS,
  render,
  handleComponent,
  handleModal,
  handlePublicInteraction,
  registerEvents,
};
