// Module « Giveaways » : /giveaway publie un tirage au sort dans un salon, avec un bouton de participation.
//  - Qui peut créer : les rôles choisis dans /config → Giveaways, plus les membres « Gérer le serveur ».
//  - Participation : un clic sur « Participer », un nouveau clic annule.
//  - Fin : à la date prévue, les gagnants sont tirés au sort parmi les participants (sans doublon).
//  - Les giveaways sont enregistrés dans Supabase (table edge_giveaways) : ils restent actifs après un redémarrage.
const crypto = require('crypto');
const {
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChannelSelectMenuBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
} = require('discord.js');
const store = require('../store');
const { getModuleConfig, updateModuleConfig } = store;
const { embed, button, row, toggleButton, moduleSelectRow, ephemeralPayload, truncate } = require('../ui');
const { MODULE_LIST } = require('./registry');

const ID = 'giveaways';
const DEFAULTS = { enabled: false, channelId: null, creatorRoleIds: [] };
const MIN_MS = 60_000; // 1 minute
const MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const MAX_WINNERS = 20;
const SWEEP_MS = 15_000;

const giveaways = new Map(); // id -> giveaway (miroir de la table edge_giveaways)
let discordClient = null;
let sweeperStarted = false;

const cfgOf = (guildId) => getModuleConfig(guildId, ID, DEFAULTS);

// ---------------------------------------------------------------------------
// Fonctions pures (testées séparément)
// ---------------------------------------------------------------------------

// Durée lisible : « 30m », « 2h », « 3j », « 1j 12h ». Retourne des millisecondes, ou null.
function parseDuration(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;
  const re = /(\d+)\s*(jours?|j|days?|d|heures?|hours?|h|minutes?|mins?|min|m)/g;
  let total = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    const n = Number(match[1]);
    const unit = match[2];
    let unitMs;
    if (/^(j|jours?|d|days?)$/.test(unit)) unitMs = 24 * 60 * 60 * 1000;
    else if (/^(h|heures?|hours?)$/.test(unit)) unitMs = 60 * 60 * 1000;
    else unitMs = 60 * 1000;
    total += n * unitMs;
  }
  // Rien d'autre que des nombres, des unités, des espaces et « et » ne doit rester.
  const rest = text.replace(/(\d+)\s*(jours?|j|days?|d|heures?|hours?|h|minutes?|mins?|min|m)/g, '').replace(/[\s,]|et/g, '');
  if (rest.length > 0 || total === 0) return null;
  if (total < MIN_MS || total > MAX_MS) return null;
  return total;
}

// Tire au sort `count` gagnants, sans doublon, parmi les identifiants.
function pickWinners(ids, count) {
  const pool = [...new Set(ids)];
  const winners = [];
  while (winners.length < count && pool.length > 0) {
    const index = crypto.randomInt(pool.length);
    winners.push(pool.splice(index, 1)[0]);
  }
  return winners;
}

// Peut créer : membre « Gérer le serveur » ou porteur d'un rôle autorisé.
function canCreate({ cfg, roleIds, isManager }) {
  return Boolean(isManager) || cfg.creatorRoleIds.some((id) => roleIds.includes(id));
}

function memberRoleIds(member) {
  if (!member?.roles) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return [...(member.roles.cache?.keys() ?? [])];
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------

async function init() {
  const rows = await store.loadOpenGiveaways();
  for (const row of rows) {
    giveaways.set(row.id, { ...row, participant_ids: row.participant_ids ?? [], winner_ids: row.winner_ids ?? [] });
  }
  console.log(`[giveaways] ${rows.length} giveaway(s) en cours chargé(s) depuis Supabase.`);
}

function persist(g) {
  store.saveGiveaway(g).catch((err) => console.error('[giveaways] sauvegarde échouée :', err.message));
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

function giveawayPayload(g) {
  const ended = g.ended;
  const endUnix = Math.floor(Date.parse(g.ends_at) / 1000);
  const e = embed(`**${truncate(g.prize, 200)}**`).setTitle(ended ? '🎉 Giveaway terminé' : '🎉 Giveaway');
  e.addFields(
    { name: 'Organisé par', value: `<@${g.host_id}>`, inline: true },
    { name: 'Gagnant(s)', value: String(g.winners_count), inline: true },
    { name: 'Participants', value: String(g.participant_ids.length), inline: true },
  );
  if (ended) {
    e.addFields({
      name: 'Résultat',
      value: g.winner_ids.length ? g.winner_ids.map((id) => `<@${id}>`).join(' ') : 'Aucun participant',
      inline: false,
    });
  } else {
    e.addFields({ name: 'Fin', value: `<t:${endUnix}:f> (<t:${endUnix}:R>)`, inline: false });
  }
  const join = new ButtonBuilder()
    .setCustomId(`giveaway:join:${g.id}`)
    .setLabel(`Participer · ${g.participant_ids.length}`)
    .setStyle(ButtonStyle.Success)
    .setEmoji('🎉')
    .setDisabled(ended);
  return { embeds: [e], components: [row(join)], allowedMentions: { parse: [] } };
}

// ---------------------------------------------------------------------------
// Config (/config → Giveaways)
// ---------------------------------------------------------------------------

function render(view, guild) {
  if (view === 'roles') return renderRoles(guild);
  if (view === 'channel') return renderChannel();
  return renderMain(guild);
}

function renderMain(guild) {
  const cfg = cfgOf(guild.id);
  const roles = cfg.creatorRoleIds.length ? cfg.creatorRoleIds.map((id) => `<@&${id}>`).join(' ') : 'aucun';
  const channel = cfg.channelId ? `<#${cfg.channelId}>` : 'salon où la commande est tapée';
  return {
    content: '🎁 **Module Giveaways** · la commande `/giveaway` lance un tirage au sort. Les admins (« Gérer le serveur ») peuvent toujours en créer.',
    embeds: [
      embed().addFields(
        { name: 'Module', value: cfg.enabled ? '🟢 Activé' : '⚪ Désactivé', inline: true },
        { name: 'Salon par défaut', value: channel, inline: true },
        { name: 'Rôles autorisés à créer', value: truncate(roles, 500), inline: false },
      ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        toggleButton('cfg:giveaways:toggle:enabled', 'Module', cfg.enabled),
        button('cfg:giveaways:view:roles', 'Rôles créateurs', ButtonStyle.Primary, '🎭'),
        button('cfg:giveaways:view:channel', 'Salon', ButtonStyle.Primary, '📍'),
      ),
    ],
  };
}

function renderRoles(guild) {
  const cfg = cfgOf(guild.id);
  const select = new RoleSelectMenuBuilder()
    .setCustomId('cfg:giveaways:pick:roles')
    .setPlaceholder('Sélectionne les rôles qui peuvent créer un giveaway')
    .setMinValues(0)
    .setMaxValues(25);
  if (cfg.creatorRoleIds.length) select.setDefaultRoles(...cfg.creatorRoleIds);
  return {
    embeds: [
      embed(
        'Choisis les rôles autorisés à lancer un giveaway avec `/giveaway`. Vide la sélection pour ne laisser que les admins.',
      ),
    ],
    components: [row(select), row(button('cfg:giveaways:view:main', '◀ Retour', ButtonStyle.Danger))],
  };
}

function renderChannel() {
  return {
    embeds: [embed('Choisis le salon par défaut des giveaways. Si aucun n’est choisi, le giveaway part dans le salon où la commande est tapée.')],
    components: [
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:giveaways:pick:channel')
          .setPlaceholder('Sélectionne un salon')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1),
      ),
      row(button('cfg:giveaways:view:main', '◀ Retour', ButtonStyle.Danger)),
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
      if (arg === 'roles') cfg.creatorRoleIds = [...interaction.values];
      else if (arg === 'channel') cfg.channelId = interaction.values[0];
      else return;
      updateModuleConfig(guild.id, ID, cfg);
      return interaction.update(renderMain(guild));
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Commande /giveaway, participation et fin du tirage
// ---------------------------------------------------------------------------

async function fetchChannel(guild, channelId) {
  return guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
}

async function handleCommand(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply(ephemeralPayload('Cette commande ne fonctionne que sur un serveur.'));
  // Accusé de réception immédiat (Discord attend une réponse dans les 3 s) ; tout le reste est édité ensuite.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const say = (text) => interaction.editReply({ embeds: [embed(text)] });

  const cfg = cfgOf(guild.id);
  if (!cfg.enabled) return say('Les giveaways ne sont pas activés sur ce serveur.');

  const allowed = canCreate({
    cfg,
    roleIds: memberRoleIds(interaction.member),
    isManager: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  });
  if (!allowed) {
    return say('Tu n’as pas la permission de créer un giveaway. Demande à un admin de te donner un rôle autorisé.');
  }

  const prize = interaction.options.getString('prix', true).trim();
  const durationMs = parseDuration(interaction.options.getString('duree', true));
  if (!durationMs) {
    return say('Durée invalide. Exemples : `30m`, `2h`, `3j`, `1j 12h`. Minimum 1 minute, maximum 30 jours.');
  }
  const winnersCount = Math.min(MAX_WINNERS, Math.max(1, interaction.options.getInteger('gagnants') ?? 1));

  const chosenId = interaction.options.getChannel('salon')?.id ?? cfg.channelId ?? interaction.channelId;
  const channel = await fetchChannel(guild, chosenId);
  if (!channel?.isTextBased()) return say('Salon introuvable ou non textuel.');

  const now = Date.now();
  const g = {
    id: crypto.randomUUID().slice(0, 8),
    guild_id: guild.id,
    channel_id: channel.id,
    message_id: null,
    host_id: interaction.user.id,
    prize,
    winners_count: winnersCount,
    participant_ids: [],
    winner_ids: [],
    created_at: new Date(now).toISOString(),
    ends_at: new Date(now + durationMs).toISOString(),
    ended: false,
  };
  try {
    const message = await channel.send(giveawayPayload(g));
    g.message_id = message.id;
  } catch (err) {
    console.error('[giveaways] publication impossible :', err.message);
    return say('❌ Impossible de publier le giveaway (permissions du bot dans ce salon ?).');
  }
  giveaways.set(g.id, g);
  persist(g);
  const endUnix = Math.floor(Date.parse(g.ends_at) / 1000);
  return interaction.editReply({
    embeds: [embed(`✅ Giveaway publié dans <#${channel.id}>. Fin <t:${endUnix}:R>.`)],
  });
}

async function handleJoin(interaction) {
  const id = interaction.customId.split(':')[2];
  const g = giveaways.get(id);
  if (!g) return interaction.reply(ephemeralPayload('Giveaway introuvable.'));
  if (g.ended || Date.now() >= Date.parse(g.ends_at)) {
    return interaction.reply(ephemeralPayload('Ce giveaway est terminé.'));
  }

  const userId = interaction.user.id;
  let text;
  if (g.participant_ids.includes(userId)) {
    g.participant_ids = g.participant_ids.filter((x) => x !== userId);
    text = 'Tu ne participes plus à ce giveaway.';
  } else {
    g.participant_ids.push(userId);
    text = '🎉 Tu participes ! Bonne chance.';
  }
  persist(g);
  await interaction.update(giveawayPayload(g));
  return interaction.followUp(ephemeralPayload(text));
}

async function handleInteraction(interaction) {
  return handleJoin(interaction);
}

// Termine un giveaway : tire les gagnants, met à jour le message et annonce les gagnants.
async function endGiveaway(g) {
  g.ended = true;
  g.winner_ids = pickWinners(g.participant_ids, g.winners_count);
  persist(g);
  if (!discordClient) return;
  const guild = discordClient.guilds.cache.get(g.guild_id);
  const channel = guild ? await fetchChannel(guild, g.channel_id) : null;
  if (!channel) {
    console.error(`[giveaways] ${g.id} : salon introuvable, annonce impossible`);
    return;
  }
  try {
    const message = await channel.messages.fetch(g.message_id);
    await message.edit(giveawayPayload(g));
  } catch (err) {
    console.error(`[giveaways] ${g.id} : message non modifiable (${err.message})`);
  }
  const content = g.winner_ids.length
    ? `🏆 Félicitations ${g.winner_ids.map((id) => `<@${id}>`).join(' ')} ! Vous gagnez **${truncate(g.prize, 200)}**.`
    : `Aucun participant pour le giveaway **${truncate(g.prize, 200)}**.`;
  await channel
    .send({ content, allowedMentions: { users: g.winner_ids } })
    .catch((err) => console.error(`[giveaways] ${g.id} : annonce impossible (${err.message})`));
}

async function closeDue() {
  const now = Date.now();
  for (const g of giveaways.values()) {
    if (g.ended || Date.parse(g.ends_at) > now) continue;
    await endGiveaway(g);
  }
}

// Appelée au démarrage et à chaque connexion : le client sert à éditer les messages et annoncer les gagnants.
function registerEvents(client) {
  client.once(Events.ClientReady, (c) => {
    discordClient = c;
    if (!sweeperStarted) {
      sweeperStarted = true;
      setInterval(() => closeDue().catch((err) => console.error('[giveaways] erreur :', err)), SWEEP_MS).unref();
    }
  });
}

module.exports = {
  ID,
  DEFAULTS,
  MAX_WINNERS,
  init,
  render,
  handleComponent,
  handleCommand,
  handleInteraction,
  registerEvents,
  closeDue,
  endGiveaway, // utilisé par le tableau de bord web
  giveaways,
  giveawayPayload,
  parseDuration,
  pickWinners,
  canCreate,
};
