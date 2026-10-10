const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonStyle,
  ChannelType,
  ChannelSelectMenuBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { getModuleConfig, updateModuleConfig, getGuildModule, uploadAsset, deleteAsset } = require('../store');
const { embed, button, row, toggleButton, truncate, moduleSelectRow, ephemeralPayload } = require('../ui');
const { MODULE_LIST } = require('./registry');

const ID = 'ticket';
const MAX_FILE_BYTES = 8 * 1024 * 1024; // limite d'upload Discord (salon standard)
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
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
const HINTS = {
  panel_title: 'Ex : 🎫 Support',
  panel_description: 'Texte affiché sous le titre du panneau',
  panel_button: 'Texte du bouton qui ouvre un ticket',
  panel_footer: 'Petit texte en bas du panneau',
  channel_name: 'Variables : {user}, {number}, {type}. Espaces → tirets',
  welcome_title: 'Variables : {user}, {number}, {type}',
  welcome_description: 'Variables : {user}, {number}, {channel}, {type}',
  welcome_footer: 'Variables : {user}, {number}',
  close_button: 'Texte du bouton de fermeture',
  msg_opened: 'Variables : {user}, {channel}',
  msg_already_open: 'Variables : {user}, {channel}',
  msg_closed: 'Affiché juste avant la suppression du salon',
  msg_disabled: 'Affiché quand le système de tickets est désactivé',
};
for (const t of TEXTS) t.hint = HINTS[t.key];
const TEXT_BY_KEY = Object.fromEntries(TEXTS.map((t) => [t.key, t]));

// Groupes : une seule fenêtre (modale) pour plusieurs textes à la fois.
const GROUPS = [
  {
    id: 'panel',
    label: 'Panneau',
    emoji: '🎫',
    title: 'Panneau Ouvrir un ticket',
    keys: ['panel_title', 'panel_description', 'panel_button', 'panel_footer'],
  },
  {
    id: 'welcome',
    label: 'Accueil du ticket',
    emoji: '💬',
    title: 'Accueil du ticket',
    keys: ['welcome_title', 'welcome_description', 'welcome_footer', 'close_button', 'channel_name'],
  },
  {
    id: 'messages',
    label: 'Messages',
    emoji: '📩',
    title: 'Messages du bot',
    keys: ['msg_opened', 'msg_already_open', 'msg_closed', 'msg_disabled'],
  },
];
const GROUP_BY_ID = Object.fromEntries(GROUPS.map((g) => [g.id, g]));

const MAX_TYPES = 25; // limite Discord : 25 options de menu / 25 boutons

function newTypeId() {
  return 't' + Math.random().toString(36).slice(2, 10);
}

const DEFAULTS = {
  panelStyle: 'buttons', // affichage des types sur le panneau : 'buttons' ou 'select'
  types: [], // [{ id, label, emoji?, description? }] ; vide = un seul bouton "Ouvrir un ticket"
  enabled: true,
  textMode: 'buttons', // 'buttons' (sections) ou 'select' (menu déroulant, un texte à la fois)
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
  return String(template).replace(/\{(user|number|channel|type)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}


function countOpen(guild, cfg) {
  return Object.keys(cfg.open).filter((id) => guild.channels.cache.has(id)).length;
}

// ---------------------------------------------------------------------------
// Vues (rendu du panneau /config)
// ---------------------------------------------------------------------------

function render(view, guild) {
  const cfg = cfgOf(guild.id);
  if (view.startsWith('type:')) return renderType(cfg, view.slice('type:'.length));
  switch (view) {
    case 'types':
      return renderTypes(cfg);
    case 'texts':
      return renderTexts(cfg);
    case 'preview':
      return renderPreview(guild, cfg);
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
        value: `${cfg.image ? '🟢 ON' : '⚪ OFF'} • ${cfg.assets.image ? '✅ fichier' : '❌ aucun fichier'}`,
        inline: true,
      },
      {
        name: 'GIF du ticket',
        value: `${cfg.gif ? '🟢 ON' : '⚪ OFF'} • ${cfg.assets.gif ? '✅ fichier' : '❌ aucun fichier'}`,
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
      row(button('cfg:ticket:view:types', `Types de ticket (${cfg.types.length})`, ButtonStyle.Primary, '🗂️')),
    ],
  };
}

function renderTexts(cfg) {
  const selectMode = cfg.textMode === 'select';
  const e = embed()
    .setTitle('✏️ Textes du module Ticket')
    .setDescription(
      (selectMode
        ? '**Choisis un texte dans le menu** : une fenêtre s’ouvre avec ce texte, rempli avec ta valeur actuelle.\n'
        : '**Clique sur une section** : une fenêtre s’ouvre avec tous ses textes, déjà remplis avec tes valeurs actuelles.\n') +
        'Variables : `{user}` pseudo • `{number}` n° du ticket • `{channel}` salon du ticket.',
    )
    .addFields(
      TEXTS.map((t) => ({
        name: `${GROUPS.find((g) => g.keys.includes(t.key)).emoji} ${t.label}`,
        value: truncate(cfg.texts[t.key], 200) || '—',
        inline: false,
      })),
    );

  const modeButton = button(
    'cfg:ticket:mode:toggle',
    selectMode ? 'Mode : Sélecteur' : 'Mode : Boutons',
    ButtonStyle.Primary,
    selectMode ? '📋' : '🔘',
  );
  const actions = row(
    modeButton,
    button('cfg:ticket:view:preview', 'Aperçu', ButtonStyle.Success, '👁️'),
    button('cfg:ticket:view:main', '◀ Retour', ButtonStyle.Danger),
  );

  if (selectMode) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('cfg:ticket:pick:text')
      .setPlaceholder('Choisis le texte à modifier')
      .addOptions(
        TEXTS.map((t) => ({
          label: truncate(t.label, 100),
          value: t.key,
          description: truncate(t.hint || t.label, 100),
          emoji: GROUPS.find((g) => g.keys.includes(t.key)).emoji,
        })),
      );
    return { embeds: [e], components: [row(menu), actions] };
  }

  return {
    embeds: [e],
    components: [
      row(...GROUPS.map((g) => button(`cfg:ticket:text:${g.id}`, g.label, ButtonStyle.Secondary, g.emoji))),
      actions,
    ],
  };
}

// Vue Types de ticket : liste + ajout + choix du style du panneau.
function renderTypes(cfg) {
  const types = cfg.types;
  const selectStyle = cfg.panelStyle === 'select';
  const e = embed()
    .setTitle('🗂️ Types de ticket')
    .setDescription(
      (types.length
        ? 'Ces types apparaissent sur le panneau. Choisis-en un pour le modifier ou le supprimer.'
        : 'Aucun type : le panneau affiche un seul bouton **Ouvrir un ticket**. Ajoute des types (ex. Support, Plainte, Partenariat) pour proposer plusieurs catégories.') +
        `\n\nAffichage sur le panneau : **${selectStyle ? 'Menu déroulant' : 'Boutons'}**`,
    );
  if (types.length) {
    e.addFields(
      types.map((ty) => ({
        name: `${ty.emoji ?? '•'} ${ty.label}`,
        value: truncate(ty.description ?? '—', 200),
        inline: false,
      })),
    );
  }

  const components = [];
  if (types.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('cfg:ticket:typepick')
      .setPlaceholder('Choisis un type à modifier')
      .addOptions(
        types.map((ty) => ({
          label: truncate(ty.label, 100),
          value: ty.id,
          ...(ty.description ? { description: truncate(ty.description, 100) } : {}),
          ...(ty.emoji ? { emoji: ty.emoji } : {}),
        })),
      );
    components.push(row(menu));
  }
  components.push(
    row(
      button('cfg:ticket:typeadd', 'Ajouter un type', ButtonStyle.Success, '➕'),
      button(
        'cfg:ticket:panelstyle:toggle',
        selectStyle ? 'Affichage : Menu' : 'Affichage : Boutons',
        ButtonStyle.Primary,
        selectStyle ? '📋' : '🔘',
      ),
      button('cfg:ticket:view:main', '◀ Retour', ButtonStyle.Danger),
    ),
  );
  return { embeds: [e], components };
}

// Vue d'un type : modifier / supprimer.
function renderType(cfg, id) {
  const ty = cfg.types.find((x) => x.id === id);
  if (!ty) return renderTypes(cfg);
  const e = embed()
    .setTitle(`${ty.emoji ? ty.emoji + ' ' : ''}${ty.label}`)
    .setDescription(ty.description ? truncate(ty.description, 300) : '_Pas de description_');
  return {
    embeds: [e],
    components: [
      row(
        button(`cfg:ticket:typeedit:${id}`, 'Modifier', ButtonStyle.Primary, '✏️'),
        button(`cfg:ticket:typedel:${id}`, 'Supprimer', ButtonStyle.Danger, '🗑️'),
        button('cfg:ticket:view:types', '◀ Retour aux types', ButtonStyle.Secondary),
      ),
    ],
  };
}

// Modale d'un type. "id" = "new" pour un ajout.
function buildTypeModal(id, ty) {
  const modal = new ModalBuilder()
    .setCustomId(`cfg:ticket:typemodal:${id}`)
    .setTitle(ty ? 'Modifier le type de ticket' : 'Nouveau type de ticket');
  const fields = [
    { key: 'label', label: 'Nom du type', max: 80, required: true, value: ty?.label, hint: 'Ex : Support, Plainte, Partenariat' },
    { key: 'emoji', label: 'Emoji (optionnel)', max: 60, required: false, value: ty?.emoji, hint: 'Ex : 🛠️' },
    {
      key: 'description',
      label: 'Description (optionnel)',
      max: 100,
      required: false,
      value: ty?.description,
      hint: 'Ex : Problème technique ou question',
    },
  ];
  for (const f of fields) {
    const input = new TextInputBuilder()
      .setCustomId(f.key)
      .setLabel(truncate(f.label, 45))
      .setStyle(TextInputStyle.Short)
      .setMaxLength(f.max)
      .setPlaceholder(truncate(f.hint, 100))
      .setRequired(f.required);
    if (f.value) input.setValue(truncate(f.value, f.max));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

// Aperçu : rendu réel des messages avec des valeurs d'exemple.
function renderPreview(guild, cfg) {
  const vars = { user: 'Alice', number: 1, channel: '#ticket-alice', type: 'Support' };
  const t = cfg.texts;
  const panel = embed()
    .setTitle(truncate(fmt(t.panel_title, vars), 256))
    .setDescription(fmt(t.panel_description, vars))
    .setFooter({ text: fmt(t.panel_footer, vars) });
  if (cfg.image && cfg.assets.image?.url) panel.setImage(cfg.assets.image.url);

  const welcome = embed()
    .setTitle(truncate(fmt(t.welcome_title, vars), 256))
    .setDescription(fmt(t.welcome_description, vars))
    .setFooter({ text: fmt(t.welcome_footer, vars) });
  if (cfg.gif && cfg.assets.gif?.url) welcome.setImage(cfg.assets.gif.url);

  const messages = embed()
    .setTitle('📩 Messages')
    .setDescription(
      [
        `**Ticket créé** : ${fmt(t.msg_opened, vars)}`,
        `**Déjà ouvert** : ${fmt(t.msg_already_open, vars)}`,
        `**Fermeture** : ${fmt(t.msg_closed, vars)}`,
        `**Désactivé** : ${fmt(t.msg_disabled, vars)}`,
      ].join('\n\n'),
    );

  return {
    content: '**Aperçu** (valeurs d’exemple) : voici ce que verront les membres.',
    embeds: [panel, welcome, messages],
    components: [
      ...panelComponents(cfg, { disabled: true }).slice(0, 3),
      row(button('noop:close', t.close_button, ButtonStyle.Danger).setDisabled(true)),
      row(button('cfg:ticket:view:texts', '◀ Retour aux textes', ButtonStyle.Secondary)),
    ],
  };
}

// Fenêtre (modale) avec un ou plusieurs champs, pré-remplis avec les textes actuels.
function buildTextModal(cfg, id, keys, title) {
  const modal = new ModalBuilder().setCustomId(`cfg:ticket:modal:${id}`).setTitle(truncate(title, 45));
  for (const key of keys) {
    const def = TEXT_BY_KEY[key];
    const input = new TextInputBuilder()
      .setCustomId(key)
      .setLabel(truncate(def.label, 45))
      .setStyle(def.style === 'long' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setValue(truncate(cfg.texts[key], def.max))
      .setPlaceholder(truncate(def.hint || def.label, 100))
      .setMinLength(1)
      .setMaxLength(def.max)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
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

    case 'typeadd': {
      if (cfg.types.length >= MAX_TYPES) {
        return interaction.reply(ephemeralPayload(`Maximum ${MAX_TYPES} types de ticket.`));
      }
      return interaction.showModal(buildTypeModal('new', null));
    }

    case 'typeedit': {
      const ty = cfg.types.find((x) => x.id === arg);
      if (!ty) return interaction.update(render('types', guild));
      return interaction.showModal(buildTypeModal(arg, ty));
    }

    case 'typedel': {
      cfg.types = cfg.types.filter((x) => x.id !== arg);
      save(guild.id, cfg);
      return interaction.update(render('types', guild));
    }

    case 'typepick': {
      return interaction.update(render(`type:${interaction.values[0]}`, guild));
    }

    case 'type': {
      return interaction.update(render(`type:${arg}`, guild));
    }

    case 'panelstyle': {
      cfg.panelStyle = cfg.panelStyle === 'select' ? 'buttons' : 'select';
      save(guild.id, cfg);
      return interaction.update(render('types', guild));
    }

    case 'mode': {
      cfg.textMode = cfg.textMode === 'select' ? 'buttons' : 'select';
      save(guild.id, cfg);
      return interaction.update(render('texts', guild));
    }

    case 'toggle': {
      if (!['enabled', 'image', 'gif'].includes(arg)) return;
      cfg[arg] = !cfg[arg];
      save(guild.id, cfg);
      return interaction.update(render('main', guild));
    }

    case 'remove': {
      if (!['image', 'gif'].includes(arg)) return;
      const asset = cfg.assets[arg];
      if (asset?.path) await deleteAsset(asset.path);
      cfg.assets[arg] = null;
      save(guild.id, cfg);
      return interaction.update(render('main', guild));
    }

    case 'text': {
      const group = GROUP_BY_ID[arg];
      if (group) {
        return interaction.showModal(buildTextModal(cfg, group.id, group.keys, group.title));
      }
      const def = TEXT_BY_KEY[arg];
      if (!def) return;
      return interaction.showModal(buildTextModal(cfg, arg, [arg], def.label));
    }

    case 'pick': {
      const value = interaction.values[0];
      if (arg === 'text') {
        const def = TEXT_BY_KEY[value];
        if (!def) return;
        return interaction.showModal(buildTextModal(cfg, value, [value], def.label));
      }
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

// Emoji Unicode (seul), emoji personnalisé <:nom:id> ou <a:nom:id>, ou emoji keycap (1️⃣).
const EMOJI_RE = /^(<a?:\w+:\d+>|[0-9#*]\uFE0F?\u20E3|(\p{Extended_Pictographic}|\p{Regional_Indicator}){1,2}(\uFE0F|\u200D|\p{Emoji_Modifier}|\p{Extended_Pictographic})*)$/u;

async function handleTypeModal(interaction, guild, id) {
  const cfg = cfgOf(guild.id);
  const label = interaction.fields.getTextInputValue('label').trim();
  const emoji = interaction.fields.getTextInputValue('emoji').trim() || undefined;
  const description = interaction.fields.getTextInputValue('description').trim() || undefined;
  if (!label) return;
  if (emoji && !EMOJI_RE.test(emoji)) {
    return interaction.reply(ephemeralPayload('Emoji invalide : mets un seul emoji (ex : 🛠️), sans texte autour.'));
  }

  if (id === 'new') {
    if (cfg.types.length >= MAX_TYPES) {
      return interaction.reply(ephemeralPayload(`Maximum ${MAX_TYPES} types de ticket.`));
    }
    cfg.types.push({ id: newTypeId(), label, emoji, description });
  } else {
    const ty = cfg.types.find((x) => x.id === id);
    if (!ty) return interaction.reply(ephemeralPayload('Ce type de ticket n’existe plus.'));
    ty.label = label;
    ty.emoji = emoji;
    ty.description = description;
  }
  save(guild.id, cfg);

  await interaction.deferUpdate();
  return interaction.editReply(render('types', guild));
}

async function handleModal(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const parts = interaction.customId.split(':');
  if (parts[2] === 'typemodal') return handleTypeModal(interaction, guild, parts[3]);
  const id = parts[3];
  const group = GROUP_BY_ID[id];
  const keys = group ? group.keys : [id];
  if (!keys.every((k) => TEXT_BY_KEY[k])) return;

  const cfg = cfgOf(guild.id);
  for (const key of keys) {
    const value = interaction.fields.getTextInputValue(key).trim();
    if (value) cfg.texts[key] = value;
  }
  save(guild.id, cfg);

  await interaction.deferUpdate();
  await interaction.editReply(render('texts', guild));
  return interaction.followUp(ephemeralPayload(`✅ ${group ? group.label : TEXT_BY_KEY[id].label} : textes enregistrés.`));
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

    const cfg = cfgOf(guild.id);
    const filePath = `${guild.id}/${kind}${ext}`;
    // Envoi dans Supabase Storage (écrase le fichier précédent du même emplacement).
    const url = await uploadAsset(filePath, buffer, MIME_BY_EXT[ext]);
    // Supprime l'ancien fichier de ce slot s'il avait un autre chemin (ex : autre extension).
    const previous = cfg.assets[kind];
    if (previous?.path && previous.path !== filePath) await deleteAsset(previous.path);

    cfg.assets[kind] = { path: filePath, url };
    save(guild.id, cfg);
    return { ok: true };
  } catch (err) {
    console.error('[ticket] upload asset :', err);
    return { ok: false, reason: 'Impossible d’enregistrer le fichier, réessaie.' };
  }
}

// ---------------------------------------------------------------------------
// Panneau public + ouverture / fermeture des tickets
// ---------------------------------------------------------------------------

// Composants du panneau public.
//  - aucun type : un bouton "Ouvrir un ticket" (comportement d'origine)
//  - types en boutons ou en menu déroulant (style choisi dans la config)
function panelComponents(cfg, { disabled = false } = {}) {
  const t = cfg.texts;
  const types = cfg.types ?? [];

  if (!types.length) {
    const b = button('tkt:open', t.panel_button, ButtonStyle.Primary, '🎫');
    return [row(disabled ? b.setDisabled(true) : b)];
  }

  if (cfg.panelStyle === 'select') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('tkt:open-select')
      .setPlaceholder(truncate(t.panel_button, 100))
      .addOptions(
        types.map((ty) => ({
          label: truncate(ty.label, 100),
          value: ty.id,
          ...(ty.description ? { description: truncate(ty.description, 100) } : {}),
          ...(ty.emoji ? { emoji: ty.emoji } : {}),
        })),
      );
    if (disabled) menu.setDisabled(true);
    return [row(menu)];
  }

  const buttons = types.map((ty) => {
    const b = button(`tkt:open:${ty.id}`, ty.label, ButtonStyle.Primary, ty.emoji);
    return disabled ? b.setDisabled(true) : b;
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
  return rows;
}

async function publishPanel(guild, cfg, channel) {
  const t = cfg.texts;
  const e = embed().setTitle(t.panel_title).setDescription(t.panel_description).setFooter({ text: t.panel_footer });
  if (cfg.image && cfg.assets.image?.url) e.setImage(cfg.assets.image.url);
  await channel.send({ embeds: [e], components: panelComponents(cfg) });
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

async function openTicket(interaction, typeId) {
  const guild = interaction.guild;
  const user = interaction.user;
  const cfg = cfgOf(guild.id);
  const t = cfg.texts;
  const displayName = interaction.member?.displayName ?? user.username;

  if (!cfg.enabled) return interaction.reply(ephemeralPayload(t.msg_disabled));
  const type = typeId ? cfg.types.find((x) => x.id === typeId) : null;
  if (typeId && !type) {
    return interaction.reply(ephemeralPayload('Ce type de ticket n’existe plus. Demande au staff de republier le panneau.'));
  }
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
    const vars = { user: displayName, number, channel: '', type: type?.label ?? '' };
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
      topic: `Ticket ${type ? type.label + ' ' : ''}de ${user.tag ?? user.username} (${user.id})`,
      permissionOverwrites: overwrites,
    });

    cfg.open[channel.id] = user.id;
    save(guild.id, cfg);

    vars.channel = `<#${channel.id}>`;
    const welcome = embed()
      .setTitle(truncate(fmt(t.welcome_title, vars), 256))
      .setDescription(fmt(t.welcome_description, vars))
      .setFooter({ text: fmt(t.welcome_footer, vars) });
    if (cfg.gif && cfg.assets.gif?.url) welcome.setImage(cfg.assets.gif.url);

    await channel.send({
      content: `<@${user.id}>`,
      embeds: [welcome],
      components: [row(button('tkt:close', t.close_button, ButtonStyle.Danger))],
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
  const id = interaction.customId;
  if (id === 'tkt:close') return closeTicket(interaction);
  if (id === 'tkt:open') return openTicket(interaction, null);
  if (id.startsWith('tkt:open:')) return openTicket(interaction, id.slice('tkt:open:'.length));
  if (id === 'tkt:open-select') return openTicket(interaction, interaction.values[0]);
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
