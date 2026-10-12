// Validation des données envoyées par le tableau de bord.
// Chaque fonction reçoit le serveur Discord (guild) et la charge utile, et ne retourne que les champs
// acceptés. Les limites reprennent celles de Discord et des modales de /config.
const { ChannelType } = require('discord.js');
const { THEMES } = require('../welcome-image');
const ticket = require('../modules/ticket');
const logs = require('../modules/logs');
const moderation = require('../modules/moderation');
const ai = require('../modules/ai');
const AiGraph = require('./public/ai-graph');

const SNOWFLAKE = /^\d{17,20}$/;
const TEXT_KINDS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const FORUM_KINDS = [...TEXT_KINDS, ChannelType.GuildForum];
const CATEGORY_KINDS = [ChannelType.GuildCategory];
const MAX_LIST = 25;
const { PermissionFlagsBits } = require('discord.js');

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

// Économie : nom et symbole de la monnaie, solde de départ (min/max), récompense quotidienne.
function sanitizeEconomy(guild, input, current = {}) {
  const patch = pick(
    input,
    [
      'enabled',
      'currencyName',
      'symbol',
      'startMin',
      'startMax',
      'dailyAmount',
      'dailyStreakBonus',
      'dailyStreakMax',
      'bankInitial',
      'loanMax',
      'loanRatePercent',
      'loanDays',
      'robCooldownHours',
      'robSuccessPercent',
      'robMaxPercent',
      'robFailMin',
      'robFailMax',
      'bankFeePercent',
    ],
    (key, value) => {
      switch (key) {
        case 'enabled':
          return bool(value, 'Module Économie');
        case 'currencyName':
          return text(value, 'Nom de la monnaie', 30, { required: true });
        case 'symbol':
          return text(value, 'Symbole', 4, { required: true });
        case 'startMin':
          return integer(value, 'Solde de départ minimum', 0, 100000);
        case 'startMax':
          return integer(value, 'Solde de départ maximum', 0, 100000);
        case 'dailyAmount':
          return integer(value, 'Récompense quotidienne', 0, 100000);
        case 'dailyStreakBonus':
          return integer(value, 'Bonus par jour de série', 0, 10000);
        case 'dailyStreakMax':
          return integer(value, 'Plafond du bonus de série', 0, 100000);
        case 'bankInitial':
          return integer(value, 'Montant initial de la banque', 0, 100000000);
        case 'loanMax':
          return integer(value, 'Emprunt maximum', 1, 1000000);
        case 'loanRatePercent':
          return integer(value, 'Intérêts des emprunts (%)', 0, 100);
        case 'loanDays':
          return integer(value, 'Délai de remboursement (jours)', 1, 30);
        case 'robCooldownHours':
          return integer(value, 'Délai entre deux vols (heures)', 1, 24);
        case 'robSuccessPercent':
          return integer(value, 'Chance de réussite d’un vol (%)', 1, 100);
        case 'robMaxPercent':
          return integer(value, 'Part maximum volée (%)', 1, 100);
        case 'robFailMin':
          return integer(value, 'Amende minimum (vol raté)', 0, 100000);
        case 'robFailMax':
          return integer(value, 'Amende maximum (vol raté)', 0, 100000);
        case 'bankFeePercent':
          return Math.round(number(value, 'Frais du serveur sur les banques (%)', 0, 5) * 100) / 100;
        default:
          return undefined;
      }
    },
  );
  const merged = { ...current, ...patch };
  if (merged.startMin > merged.startMax) fail('Solde de départ : le minimum ne peut pas dépasser le maximum.');
  if (merged.robFailMin > merged.robFailMax) fail('Amende d’un vol raté : le minimum ne peut pas dépasser le maximum.');
  return patch;
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

const NUKE_KEYS = ['channelDelete', 'roleDelete', 'channelCreate', 'ban', 'kick'];

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} : nombre entier entre ${min} et ${max}.`);
  return value;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} : réglages attendus.`);
  return value;
}

// Liste d'identifiants de membres (snowflakes), sans doublon.
function userIds(value, label, max = 50) {
  if (!Array.isArray(value)) fail(`${label} : liste attendue.`);
  if (value.length > max) fail(`${label} : ${max} éléments maximum.`);
  const unique = [...new Set(value)];
  for (const id of unique) {
    if (!isSnowflake(id)) fail(`${label} : identifiant de membre invalide (${String(id).slice(0, 30)}).`);
  }
  return unique;
}

// Réglages de sécurité. Les objets imbriqués sont complétés avec la configuration actuelle,
// pour qu'une mise à jour partielle ne retire aucune valeur.
function sanitizeSecurity(guild, input, current) {
  return pick(input, ['raid', 'nuke', 'alertChannelId', 'whitelistUserIds', 'whitelistRoleIds'], (key, value) => {
    switch (key) {
      case 'raid': {
        const v = plainObject(value, 'Anti-raid');
        const base = current.raid ?? {};
        return {
          enabled: bool(v.enabled ?? base.enabled ?? false, 'Anti-raid'),
          joinThreshold: integer(v.joinThreshold ?? base.joinThreshold, 'Arrivées (anti-raid)', 2, 100),
          windowSeconds: integer(v.windowSeconds ?? base.windowSeconds, 'Fenêtre (anti-raid)', 5, 120),
        };
      }
      case 'nuke': {
        const v = plainObject(value, 'Anti-nuke');
        const base = current.nuke ?? {};
        const limits = plainObject(v.limits ?? {}, 'Seuils anti-nuke');
        const baseLimits = base.limits ?? {};
        const out = {
          enabled: bool(v.enabled ?? base.enabled ?? false, 'Anti-nuke'),
          windowSeconds: integer(v.windowSeconds ?? base.windowSeconds, 'Fenêtre (anti-nuke)', 5, 120),
          limits: {},
        };
        for (const k of NUKE_KEYS) out.limits[k] = integer(limits[k] ?? baseLimits[k], `Seuil « ${k} »`, 1, 50);
        return out;
      }
      case 'alertChannelId':
        return channelId(guild, value, 'Salon d’alerte', TEXT_KINDS);
      case 'whitelistUserIds':
        return userIds(value, 'Membres de confiance');
      case 'whitelistRoleIds':
        return roleIds(guild, value, 'Rôles de confiance', 25);
    }
  });
}

function sanitizeBackups(guild, input) {
  return pick(input, ['enabled'], (key, value) => bool(value, 'Sauvegarde quotidienne'));
}

// ---------------------------------------------------------------------------
// Module IA : prompt, abréviations et nœuds
// ---------------------------------------------------------------------------

function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} : valeur entre ${min} et ${max} attendue.`);
  }
  return value;
}

function abbreviationsList(value) {
  if (!Array.isArray(value)) fail('Abréviations : liste attendue.');
  if (value.length > ai.LIMITS.abbrCount) fail(`Abréviations : ${ai.LIMITS.abbrCount} maximum.`);
  const seen = new Set();
  return value.map((item, i) => {
    const short = text(item?.short, `Abréviation ${i + 1}`, ai.LIMITS.abbrShort, { required: true });
    const meaning = text(item?.meaning, `Signification de « ${short} »`, ai.LIMITS.abbrMeaning, { required: true });
    const key = short.toLowerCase();
    if (seen.has(key)) fail(`Abréviation en double : « ${short} ».`);
    seen.add(key);
    return { short, meaning };
  });
}

// Graphe de nœuds : validé par le moteur partagé (types, fils, boucles, salons existants).
function graphOf(guild, value) {
  try {
    return AiGraph.parseGraph(value, {
      channelOk: (id) => {
        const channel = guild.channels.cache.get(id);
        return Boolean(channel) && TEXT_KINDS.includes(channel.type);
      },
      // Rôles : doivent exister. Un rôle que l'IA peut attribuer ne doit être ni géré par une intégration
      // ni administrateur (le bot refuse de toute façon, mais on le signale dès l'enregistrement).
      roleOk: (id, type) => {
        const role = guild.roles.cache.get(id);
        if (!role || id === guild.id) return false;
        if (type === 'grant' && (role.managed || role.permissions?.has?.(PermissionFlagsBits.Administrator))) return false;
        return true;
      },
    });
  } catch (err) {
    fail(`Graphe : ${err.message}`);
  }
}

// Notes de mémoire d'une personne (tableau de bord) : texte court, une ligne, nombre borné.
function aiNotes(value, max = ai.LIMITS.memoryMaxNotes) {
  if (!Array.isArray(value)) fail('Notes : liste attendue.');
  if (value.length > max) fail(`Notes : ${max} maximum par personne.`);
  return value
    .map((note) => {
      if (typeof note !== 'string') fail('Note : texte attendu.');
      return ai.sanitizeNote(note);
    })
    .filter(Boolean);
}

function sanitizeAi(guild, input, current = {}) {
  const patch = pick(
    input,
    [
      'enabled',
      'model',
      'systemPrompt',
      'temperature',
      'maxReplyTokens',
      'channelIds',
      'cooldownSeconds',
      'abbreviations',
      'graph',
      'memoryEnabled',
      'memoryMaxNotes',
      'silenceEnabled',
      'silenceRules',
    ],
    (key, value) => {
      switch (key) {
        case 'enabled':
          return bool(value, 'Module IA');
        case 'model':
          return oneOf(value, ai.MODELS, 'Modèle');
        case 'systemPrompt':
          return text(value, 'Prompt système', ai.LIMITS.promptChars, { required: true });
        case 'temperature':
          return number(value, 'Créativité', 0, 1);
        case 'maxReplyTokens':
          return integer(value, 'Longueur de réponse (tokens)', 50, 1000);
        case 'channelIds':
          return channelIds(guild, value, 'Salons de réponse libre', TEXT_KINDS, 10);
        case 'cooldownSeconds':
          return integer(value, 'Délai entre deux réponses (secondes)', 0, 600);
        case 'abbreviations':
          return abbreviationsList(value);
        case 'graph':
          return graphOf(guild, value);
        case 'memoryEnabled':
          return bool(value, 'Mémoire des membres');
        case 'memoryMaxNotes':
          return integer(value, 'Notes par personne', 5, ai.LIMITS.memoryMaxNotes);
        case 'silenceEnabled':
          return bool(value, 'Silence dans les salons libres');
        case 'silenceRules':
          return text(value, 'Règles de silence', ai.LIMITS.silenceChars);
        default:
          return undefined;
      }
    },
  );
  const merged = { ...current, ...patch };
  if (ai.promptBudget(merged) > ai.LIMITS.maxPromptChars) {
    fail(`Prompt complet trop long (${ai.LIMITS.maxPromptChars} caractères maximum, prompt + abréviations + consignes). Raccourcis une consigne.`);
  }
  return patch;
}

module.exports = {
  sanitizeAi,
  sanitizeEconomy,
  aiNotes,
  ValidationError,
  sanitizeBackups,
  sanitizeSecurity,
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
