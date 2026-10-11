// Module « Logs » : journal détaillé du serveur.
//  - Six catégories activables une à une : messages, membres, vocal, salons, rôles, modération.
//  - Chaque catégorie peut envoyer ses événements dans son propre salon (sinon : salon par défaut).
//  - Les salons ignorés ne sont pas journalisés (messages et vocal).
//  - Envois groupés : plusieurs événements proches partent dans un seul message (10 embeds max).
//  - Tout événement est aussi enregistré dans Supabase (table edge_logs) pour le tableau de bord,
//    purgé après 30 jours. Pas de données sur disque.
const { ButtonStyle, ChannelType, ChannelSelectMenuBuilder } = require('discord.js');
const store = require('../store');
const { embed, button, row, selectMenu, toggleButton, moduleSelectRow, ephemeralPayload, truncate } = require('../ui');
const { MODULE_LIST } = require('./registry');

const ID = 'logs';
const CATEGORIES = [
  { key: 'messages', label: 'Messages', emoji: '💬', description: 'Messages modifiés ou supprimés' },
  { key: 'members', label: 'Membres', emoji: '👥', description: 'Arrivées, départs, pseudos et rôles' },
  { key: 'voice', label: 'Vocal', emoji: '🎙️', description: 'Connexions, déconnexions et déplacements' },
  { key: 'channels', label: 'Salons', emoji: '📁', description: 'Création, suppression et renommage de salons' },
  { key: 'roles', label: 'Rôles', emoji: '🏷️', description: 'Création, suppression et modification de rôles' },
  { key: 'moderation', label: 'Modération', emoji: '🛡️', description: 'Bans, expulsions, timeouts, avertissements, commandes' },
];
const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

const DEFAULTS = {
  enabled: false,
  channelId: null,
  categories: Object.fromEntries(CATEGORY_KEYS.map((k) => [k, true])),
  channels: Object.fromEntries(CATEGORY_KEYS.map((k) => [k, null])),
  ignoredChannelIds: [],
};

const RETENTION_DAYS = 30;
const SEND_DELAY_MS = 1500;
const MAX_EMBEDS_PER_MESSAGE = 10;
const DB_FLUSH_MS = 5000;
const DB_BATCH = 500;
const DB_QUEUE_LIMIT = 10000;
const BOT_ACTION_TTL_MS = 30_000;

// Fusion des objets imbriqués : une catégorie absente de la base reste sur sa valeur par défaut.
const cfgOf = (guildId) => {
  const cfg = store.getModuleConfig(guildId, ID, DEFAULTS);
  cfg.categories = { ...DEFAULTS.categories, ...cfg.categories };
  cfg.channels = { ...DEFAULTS.channels, ...cfg.channels };
  cfg.ignoredChannelIds = Array.isArray(cfg.ignoredChannelIds) ? cfg.ignoredChannelIds : [];
  return cfg;
};

// ---------------------------------------------------------------------------
// Actions faites par le bot (commandes de modération) : l'événement Discord correspondant
// ne doit pas être journalisé une seconde fois.
// ---------------------------------------------------------------------------
const botActions = new Map(); // "kind:guildId:targetId" -> expiration (ms)

function markBotAction(kind, guildId, targetId) {
  botActions.set(`${kind}:${guildId}:${targetId}`, Date.now() + BOT_ACTION_TTL_MS);
}

function consumeBotAction(kind, guildId, targetId) {
  const key = `${kind}:${guildId}:${targetId}`;
  const expires = botActions.get(key);
  botActions.delete(key);
  return expires !== undefined && expires > Date.now();
}

// ---------------------------------------------------------------------------
// Entrées : écriture Supabase par lots et envoi Discord groupé par salon.
// ---------------------------------------------------------------------------
const dbQueue = [];
const outbox = new Map(); // channelId -> { guild, items, timer }
let dbTimer = null;
let pruneTimer = null;

// Enregistre un événement. entry = { category, event, title, description?, fields?, actorId?, targetId?, channelId?, user? }
function log(guild, entry) {
  if (!guild || !entry?.category) return;
  const cfg = cfgOf(guild.id);
  if (!cfg.enabled || !cfg.categories[entry.category]) return;
  if (entry.channelId && cfg.ignoredChannelIds.includes(entry.channelId)) return;

  if (dbQueue.length < DB_QUEUE_LIMIT) {
    dbQueue.push({
      guild_id: guild.id,
      category: entry.category,
      event: entry.event,
      title: truncate(entry.title, 200),
      description: truncate(entry.description ?? '', 2000),
      actor_id: entry.actorId ?? null,
      target_id: entry.targetId ?? null,
      channel_id: entry.channelId ?? null,
      created_at: new Date().toISOString(),
    });
  }

  const destination = cfg.channels[entry.category] || cfg.channelId;
  if (!destination) return;
  try {
    enqueueEmbed(guild, destination, buildEmbed(entry));
  } catch (err) {
    console.error('[logs] embed impossible :', err.message);
  }
}

function buildEmbed(entry) {
  const cat = CATEGORY_BY_KEY[entry.category];
  const e = embed(truncate(entry.description ?? '', 4000) || null)
    .setTitle(truncate(`${cat?.emoji ?? '📝'} ${entry.title}`, 250))
    .setTimestamp(new Date());
  if (entry.user?.name) {
    const icon = typeof entry.user.iconURL === 'string' && /^https?:\/\//.test(entry.user.iconURL) ? entry.user.iconURL : undefined;
    e.setAuthor({ name: truncate(entry.user.name, 250), ...(icon ? { iconURL: icon } : {}) });
  }
  const fields = (entry.fields ?? [])
    .filter((f) => f && f.value !== undefined && f.value !== null && f.value !== '')
    .slice(0, 25)
    .map((f) => ({ name: truncate(f.name, 250), value: truncate(f.value, 1000), inline: Boolean(f.inline) }));
  if (fields.length) e.addFields(fields);
  e.setFooter({ text: truncate(`${cat?.label ?? entry.category} · ${entry.event}`, 200) });
  return e;
}

function enqueueEmbed(guild, channelId, embedBuilder) {
  let box = outbox.get(channelId);
  if (!box) {
    box = { guild, items: [], timer: null };
    outbox.set(channelId, box);
  }
  box.guild = guild;
  box.items.push(embedBuilder);
  if (!box.timer) box.timer = setTimeout(() => flushChannel(channelId), SEND_DELAY_MS);
}

async function flushChannel(channelId) {
  const box = outbox.get(channelId);
  if (!box) return;
  box.timer = null;
  const items = box.items.splice(0, MAX_EMBEDS_PER_MESSAGE);
  if (box.items.length) box.timer = setTimeout(() => flushChannel(channelId), SEND_DELAY_MS);
  else outbox.delete(channelId);
  if (!items.length) return;

  try {
    const channel = box.guild.channels.cache.get(channelId) ?? (await box.guild.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isTextBased()) return;
    await channel.send({ embeds: items, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(`[logs] envoi impossible dans ${channelId} :`, err.message);
  }
}

async function flushRows() {
  if (!dbQueue.length) return;
  const rows = dbQueue.splice(0, DB_BATCH);
  try {
    await store.insertLogs(rows);
  } catch (err) {
    console.error('[logs] écriture du journal échouée :', err.message);
    // On garde les lignes pour une nouvelle tentative, sans dépasser la limite.
    const room = DB_QUEUE_LIMIT - dbQueue.length;
    if (room > 0) dbQueue.unshift(...rows.slice(0, room));
  }
}

async function prune() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    await store.pruneLogs(cutoff);
  } catch (err) {
    console.error('[logs] purge du journal échouée :', err.message);
  }
}

// Démarre les écritures périodiques et la purge (appelé après store.init).
function start() {
  if (!dbTimer) dbTimer = setInterval(flushRows, DB_FLUSH_MS);
  dbTimer.unref?.();
  if (!pruneTimer) {
    prune();
    pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000);
    pruneTimer.unref?.();
  }
}

// Appelé au SIGTERM : écrit ce qui reste en attente.
async function flushOnExit() {
  const deadline = Date.now() + 4000;
  while (dbQueue.length && Date.now() < deadline) await flushRows();
}

// Salons de journal : un message du journal n'est jamais journalisé à son tour.
function isLogChannel(guildId, channelId) {
  const cfg = cfgOf(guildId);
  return Boolean(channelId) && (cfg.channelId === channelId || Object.values(cfg.channels).includes(channelId));
}

// ---------------------------------------------------------------------------
// Interface /config
// ---------------------------------------------------------------------------
const TEXT_KINDS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function categoryLine(cfg, cat) {
  const state = cfg.categories[cat.key] ? '🟢' : '⚪';
  const channelId = cfg.channels[cat.key] || cfg.channelId;
  const where = channelId ? `<#${channelId}>` : 'aucun salon';
  return `${state} ${cat.emoji} **${cat.label}** → ${where}`;
}

function render(view, guild, arg) {
  const cfg = cfgOf(guild.id);
  if (view === 'channel') return renderChannel(cfg);
  if (view === 'cats') return renderCategories(cfg);
  if (view === 'cat') return renderCategory(cfg, arg);
  if (view === 'ignored') return renderIgnored(cfg);
  return renderMain(cfg);
}

function renderMain(cfg) {
  const ignored = cfg.ignoredChannelIds.length ? cfg.ignoredChannelIds.map((id) => `<#${id}>`).join(' ') : 'aucun';
  return {
    content:
      '📜 **Module Logs** · journal détaillé du serveur : messages, membres, vocal, salons, rôles et modération.',
    embeds: [
      embed()
        .addFields(
          { name: 'Module', value: cfg.enabled ? '🟢 Activé' : '⚪ Désactivé', inline: true },
          { name: 'Salon par défaut', value: cfg.channelId ? `<#${cfg.channelId}>` : '⚠️ non défini', inline: true },
          { name: 'Catégories actives', value: `${CATEGORY_KEYS.filter((k) => cfg.categories[k]).length} / ${CATEGORY_KEYS.length}`, inline: true },
          { name: 'Catégories', value: CATEGORIES.map((c) => categoryLine(cfg, c)).join('\n'), inline: false },
          { name: 'Salons ignorés', value: truncate(ignored, 1000), inline: false },
          { name: 'Journal', value: 'Consultable dans le tableau de bord. Conservé 30 jours.', inline: false },
        ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        toggleButton('cfg:logs:toggle:enabled', 'Module', cfg.enabled),
        button('cfg:logs:view:channel', 'Salon par défaut', ButtonStyle.Primary, '📍'),
        button('cfg:logs:view:cats', 'Catégories', ButtonStyle.Primary, '🗂️'),
        button('cfg:logs:view:ignored', 'Salons ignorés', ButtonStyle.Secondary, '🚫'),
      ),
    ],
  };
}

function renderChannel(cfg) {
  return {
    content: '📍 **Salon par défaut du journal** · reçoit les catégories qui n’ont pas de salon dédié.',
    embeds: [embed(cfg.channelId ? `Salon actuel : <#${cfg.channelId}>` : '⚠️ Aucun salon choisi. Les événements ne sont envoyés nulle part tant qu’un salon n’est pas défini.')],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(new ChannelSelectMenuBuilder().setCustomId('cfg:logs:pick:channel').setPlaceholder('Choisir le salon par défaut').setChannelTypes(...TEXT_KINDS).setMinValues(1).setMaxValues(1)),
      row(button('cfg:logs:view:main', 'Retour', ButtonStyle.Secondary, '⬅️')),
    ],
  };
}

function renderCategories(cfg) {
  return {
    content: '🗂️ **Catégories du journal** · choisis une catégorie pour l’activer ou changer son salon.',
    embeds: [embed(CATEGORIES.map((c) => categoryLine(cfg, c)).join('\n'))],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      selectMenu(
        'cfg:logs:pick:cat',
        'Choisir une catégorie',
        CATEGORIES.map((c) => ({ label: c.label, value: c.key, emoji: c.emoji, description: c.description })),
      ),
      row(button('cfg:logs:view:main', 'Retour', ButtonStyle.Secondary, '⬅️')),
    ],
  };
}

function renderCategory(cfg, key) {
  const cat = CATEGORY_BY_KEY[key];
  if (!cat) return renderCategories(cfg);
  const own = cfg.channels[key];
  return {
    content: `${cat.emoji} **Catégorie ${cat.label}** · ${cat.description}.`,
    embeds: [
      embed()
        .addFields(
          { name: 'Statut', value: cfg.categories[key] ? '🟢 Activée' : '⚪ Désactivée', inline: true },
          { name: 'Salon', value: own ? `<#${own}>` : `Salon par défaut${cfg.channelId ? ` (<#${cfg.channelId}>)` : ' (non défini)'}`, inline: true },
        ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        toggleButton(`cfg:logs:togglecat:${key}`, 'Catégorie', cfg.categories[key]),
        button(`cfg:logs:resetcat:${key}`, 'Salon par défaut', ButtonStyle.Secondary, '↩️'),
        button('cfg:logs:view:cats', 'Retour', ButtonStyle.Secondary, '⬅️'),
      ),
      row(new ChannelSelectMenuBuilder().setCustomId(`cfg:logs:pickcat:${key}`).setPlaceholder('Salon dédié à cette catégorie').setChannelTypes(...TEXT_KINDS).setMinValues(1).setMaxValues(1)),
    ],
  };
}

function renderIgnored(cfg) {
  return {
    content: '🚫 **Salons ignorés** · les messages et les événements vocaux de ces salons ne sont pas journalisés.',
    embeds: [embed(cfg.ignoredChannelIds.length ? cfg.ignoredChannelIds.map((id) => `<#${id}>`).join(' ') : 'Aucun salon ignoré.')],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:logs:pick:ignored')
          .setPlaceholder('Choisir les salons à ignorer')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum)
          .setMinValues(0)
          .setMaxValues(25)
          .setDefaultChannels(cfg.ignoredChannelIds),
      ),
      row(button('cfg:logs:view:main', 'Retour', ButtonStyle.Secondary, '⬅️')),
    ],
  };
}

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , action, ...rest] = interaction.customId.split(':');
  const arg = rest.join(':');
  const cfg = cfgOf(guild.id);
  const save = () => store.updateModuleConfig(guild.id, ID, cfg);

  switch (action) {
    case 'view':
      return interaction.update(render(arg, guild));

    case 'toggle':
      if (arg !== 'enabled') return;
      cfg.enabled = !cfg.enabled;
      save();
      return interaction.update(renderMain(cfg));

    case 'pick': {
      if (arg === 'channel') {
        cfg.channelId = interaction.values[0] ?? null;
        save();
        return interaction.update(renderMain(cfg));
      }
      if (arg === 'ignored') {
        cfg.ignoredChannelIds = [...interaction.values].slice(0, 25);
        save();
        return interaction.update(renderIgnored(cfg));
      }
      if (arg === 'cat') {
        const key = interaction.values[0];
        if (!CATEGORY_BY_KEY[key]) return;
        return interaction.update(renderCategory(cfg, key));
      }
      return;
    }

    case 'pickcat': {
      if (!CATEGORY_BY_KEY[arg]) return;
      cfg.channels[arg] = interaction.values[0] ?? null;
      save();
      return interaction.update(renderCategory(cfg, arg));
    }

    case 'togglecat': {
      if (!CATEGORY_BY_KEY[arg]) return;
      cfg.categories[arg] = !cfg.categories[arg];
      save();
      return interaction.update(renderCategory(cfg, arg));
    }

    case 'resetcat': {
      if (!CATEGORY_BY_KEY[arg]) return;
      cfg.channels[arg] = null;
      save();
      return interaction.update(renderCategory(cfg, arg));
    }

    default:
      return;
  }
}

// Le module n'a pas de modale : les réglages passent par les menus et boutons.
async function handleModal(interaction) {
  return interaction.reply(ephemeralPayload('Ce formulaire n’existe plus. Rouvre `/config`.'));
}

module.exports = {
  ID,
  DEFAULTS,
  CATEGORIES,
  CATEGORY_KEYS,
  log,
  start,
  flushOnExit,
  isLogChannel,
  markBotAction,
  consumeBotAction,
  handleComponent,
  handleModal,
  render,
  // Exposé pour les tests.
  _buildEmbed: buildEmbed,
  _renderers: { renderMain, renderCategories, renderCategory, renderIgnored, renderChannel },
  _queues: { dbQueue, outbox },
};
