// Validation des données envoyées par le tableau de bord.
// Chaque fonction reçoit le serveur Discord (guild) et la charge utile, et ne retourne que les champs
// acceptés. Les limites reprennent celles de Discord et des modales de /config.
const { ChannelType } = require('discord.js');
const { THEMES } = require('../welcome-image');
const ticket = require('../modules/ticket');
const logs = require('../modules/logs');
const moderation = require('../modules/moderation');

const SNOWFLAKE = /^\d{17,20}$/;
const TEXT_KINDS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const FORUM_KINDS = [...TEXT_KINDS, ChannelType.GuildForum];
const CATEGORY_KINDS = [ChannelType.GuildCategory];
const MAX_LIST = 25;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const fail = (message) => {
  throw new ValidationError(message);
};

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

function text(value, label, max, { required = false } = {}) {
  if (typeof value !== 'string') fail(`${label} : texte attendu.`);
  const clean = value.trim();
  if (required && !clean) fail(`${label} : ce champ ne peut pas être vide.`);
  if ([...clean].length > max) fail(`${label} : ${max} caractères maximum.`);
  return clean;
}

function bool(value, label) {
  if (typeof value !== 'boolean') fail(`${label} : oui ou non attendu.`);
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} : valeur inconnue.`);
  return value;
}

// Salon : null accepté (aucun salon). Le salon doit exister sur ce serveur et être d'un type accepté.
function channelId(guild, value, label, kinds) {
  if (value === null || value === '') return null;
  if (!isSnowflake(value)) fail(`${label} : identifiant de salon invalide.`);
  const channel = guild.channels.cache.get(value);
  if (!channel || !kinds.includes(channel.type)) fail(`${label} : salon introuvable ou type de salon non accepté.`);
  return value;
}

// Liste d'identifiants de rôles existants sur ce serveur (sans @everyone, sans doublon).
function roleIds(guild, value, label, max = MAX_LIST) {
  if (!Array.isArray(value)) fail(`${label} : liste attendue.`);
  if (value.length > max) fail(`${label} : ${max} éléments maximum.`);
  const unique = [...new Set(value)];
  for (const id of unique) {
    if (!isSnowflake(id) || id === guild.id || !guild.roles.cache.has(id)) {
      fail(`${label} : rôle introuvable sur ce serveur.`);
    }
  }
  return unique;
}

function channelIds(guild, value, label, kinds, max = MAX_LIST) {
  if (!Array.isArray(value)) fail(`${label} : liste attendue.`);
  if (value.length > max) fail(`${label} : ${max} salons maximum.`);
  return [...new Set(value)].map((id) => {
    const clean = channelId(guild, id, label, kinds);
    if (!clean) fail(`${label} : salon introuvable.`);
    return clean;
  });
}

// Ne garde que les clés présentes dans la charge utile (mise à jour partielle).
function pick(input, keys, build) {
  const out = {};
  for (const key of keys) {
    if (input[key] !== undefined) out[key] = build(key, input[key]);
  }
  return out;
}

function sanitizeWelcome(guild, input) {
  const patch = pick(input, ['enabled', 'channelId', 'showAvatar', 'theme', 'texts'], (key, value) => {
    switch (key) {
      case 'enabled':
      case 'showAvatar':
        return bool(value, key);
      case 'channelId':
        return channelId(guild, value, 'Salon', TEXT_KINDS);
      case 'theme':
        return oneOf(value, Object.keys(THEMES), 'Thème');
      case 'texts': {
        if (typeof value !== 'object' || value === null) fail('Textes : objet attendu.');
        return {
          title: text(value.title, 'Titre', 80, { required: true }),
          subtitle: text(value.subtitle, 'Sous-titre', 100, { required: true }),
          message: text(value.message, 'Message', 500, { required: true }),
        };
      }
    }
  });
  return patch;
}

function sanitizeLevels(guild, input) {
  return pick(input, ['enabled', 'channelId', 'theme', 'texts'], (key, value) => {
    switch (key) {
      case 'enabled':
        return bool(value, key);
      case 'channelId':
        return channelId(guild, value, 'Salon des annonces', TEXT_KINDS);
      case 'theme':
        return oneOf(value, Object.keys(THEMES), 'Thème');
      case 'texts':
        if (typeof value !== 'object' || value === null) fail('Textes : objet attendu.');
        return { levelUp: text(value.levelUp, 'Message d’annonce', 300, { required: true }) };
    }
  });
}

function sanitizeSuggestions(guild, input) {
  return pick(input, ['enabled', 'channelId'], (key, value) =>
    key === 'enabled' ? bool(value, key) : channelId(guild, value, 'Salon', TEXT_KINDS),
  );
}

function sanitizeGiveaways(guild, input) {
  return pick(input, ['enabled', 'channelId', 'creatorRoleIds'], (key, value) => {
    switch (key) {
      case 'enabled':
        return bool(value, key);
      case 'channelId':
        return channelId(guild, value, 'Salon par défaut', TEXT_KINDS);
      case 'creatorRoleIds':
        return roleIds(guild, value, 'Rôles créateurs');
    }
  });
}

function sanitizeLinks(guild, input) {
  return pick(input, ['enabled', 'allowedRoleIds', 'allowedChannelIds', 'warning'], (key, value) => {
    switch (key) {
      case 'enabled':
        return bool(value, key);
      case 'allowedRoleIds':
        return roleIds(guild, value, 'Rôles autorisés');
      case 'allowedChannelIds':
        return channelIds(guild, value, 'Salons libres', FORUM_KINDS);
      case 'warning':
        return text(value, 'Avertissement', 300, { required: true });
    }
  });
}

function sanitizeTypes(guild, value) {
  if (!Array.isArray(value)) fail('Types de ticket : liste attendue.');
  if (value.length > ticket.MAX_TYPES) fail(`Types de ticket : ${ticket.MAX_TYPES} maximum.`);
  const seen = new Set();
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) fail('Type de ticket invalide.');
    const id = typeof item.id === 'string' && /^t[a-z0-9]{1,12}$/.test(item.id) ? item.id : ticket.newTypeId();
    if (seen.has(id)) fail('Type de ticket en double.');
    seen.add(id);
    const out = { id, label: text(item.label, 'Nom du type', 80, { required: true }) };
    if (item.emoji) {
      const emoji = text(item.emoji, 'Emoji', 64);
      if (!ticket.EMOJI_RE.test(emoji)) fail('Emoji invalide : un seul emoji, sans texte autour.');
      out.emoji = emoji;
    }
    if (item.description) out.description = text(item.description, 'Description', 100);
    if (item.roleId) {
      out.roleId = roleIds(guild, [item.roleId], 'Rôle à mentionner')[0];
    }
    return out;
  });
}

function sanitizeTicket(guild, input, current) {
  const patch = pick(
    input,
    ['enabled', 'panelStyle', 'textMode', 'image', 'gif', 'categoryId', 'types', 'texts'],
    (key, value) => {
      switch (key) {
        case 'enabled':
        case 'image':
        case 'gif':
          return bool(value, key);
        case 'panelStyle':
          return oneOf(value, ['buttons', 'select'], 'Style du panneau');
        case 'textMode':
          return oneOf(value, ['buttons', 'select'], 'Affichage des textes');
        case 'categoryId':
          return channelId(guild, value, 'Catégorie des tickets', CATEGORY_KINDS);
        case 'types':
          return sanitizeTypes(guild, value);
        case 'texts': {
          if (typeof value !== 'object' || value === null) fail('Textes : objet attendu.');
          const out = {};
          for (const def of ticket.TEXTS) {
            if (value[def.key] === undefined) continue;
            out[def.key] = text(value[def.key], def.label, def.max, { required: true });
          }
          return out;
        }
      }
    },
  );
  // Les textes sont fusionnés avec ceux déjà enregistrés : rien n'est réinitialisé.
  if (patch.texts) patch.texts = { ...(current.texts ?? {}), ...patch.texts };
  return patch;
}

// Brouillon de l'embed : mêmes champs que le créateur d'embed de /config.
function sanitizeDraft(input) {
  if (typeof input !== 'object' || input === null) fail('Brouillon : objet attendu.');
  const url = (value, label) => {
    const clean = text(value ?? '', label, 2048);
    if (!clean) return '';
    try {
      const parsed = new URL(clean);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
    } catch {
      fail(`${label} : adresse http(s) valide attendue.`);
    }
    return clean;
  };
  const fields = Array.isArray(input.fields) ? input.fields : [];
  if (fields.length > 25) fail('Embed : 25 champs maximum.');
  const draft = {
    title: text(input.title ?? '', 'Titre', 256),
    url: url(input.url, 'Lien du titre'),
    description: text(input.description ?? '', 'Description', 4096),
    authorName: text(input.authorName ?? '', 'Nom de l’auteur', 256),
    authorIcon: url(input.authorIcon, 'Icône de l’auteur'),
    footerText: text(input.footerText ?? '', 'Pied de page', 2048),
    image: url(input.image, 'Grande image'),
    thumbnail: url(input.thumbnail, 'Miniature'),
    fields: fields.map((f) => ({
      name: text(f?.name ?? '', 'Nom du champ', 256, { required: true }),
      value: text(f?.value ?? '', 'Valeur du champ', 1024, { required: true }),
      inline: Boolean(f?.inline),
    })),
  };
  const total =
    draft.title.length +
    draft.description.length +
    draft.authorName.length +
    draft.footerText.length +
    draft.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  if (total > 6000) fail('Embed trop long : Discord accepte 6000 caractères au total.');
  return draft;
}

// Dictionnaire { clé connue : valeur } ; les clés inconnues sont ignorées.
function mapOf(value, keys, build, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} : objet attendu.`);
  const out = {};
  for (const key of Object.keys(value)) {
    if (keys.includes(key)) out[key] = build(value[key], `${label} (${key})`);
  }
  return out;
}

function sanitizeLogs(guild, input) {
  return pick(input, ['enabled', 'channelId', 'categories', 'channels', 'ignoredChannelIds'], (key, value) => {
    switch (key) {
      case 'enabled':
        return bool(value, 'Module Logs');
      case 'channelId':
        return channelId(guild, value, 'Salon par défaut du journal', TEXT_KINDS);
      case 'categories':
        return mapOf(value, logs.CATEGORY_KEYS, (v, label) => bool(v, label), 'Catégories du journal');
      case 'channels':
        return mapOf(value, logs.CATEGORY_KEYS, (v, label) => channelId(guild, v, label, TEXT_KINDS), 'Salons des catégories');
      case 'ignoredChannelIds':
        return channelIds(guild, value, 'Salons ignorés', [...FORUM_KINDS, ChannelType.GuildVoice]);
    }
  });
}

function sanitizeModeration(guild, input) {
  return pick(input, ['enabled', 'notifyTarget', 'texts', 'roles'], (key, value) => {
    switch (key) {
      case 'enabled':
      case 'notifyTarget':
        return bool(value, key === 'enabled' ? 'Module Modération' : 'MP au membre');
      case 'texts':
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Textes : objet attendu.');
        return pick(value, ['dm'], (k, v) => text(v, 'Message au membre', 500));
      case 'roles':
        return mapOf(value, moderation.COMMAND_KEYS, (v, label) => roleIds(guild, v, label), 'Rôles par commande');
    }
  });
}

module.exports = {
  ValidationError,
  isSnowflake,
  text,
  channelId,
  sanitizeWelcome,
  sanitizeLevels,
  sanitizeSuggestions,
  sanitizeGiveaways,
  sanitizeLinks,
  sanitizeLogs,
  sanitizeModeration,
  sanitizeTicket,
  sanitizeDraft,
  TEXT_KINDS,
  FORUM_KINDS,
};
