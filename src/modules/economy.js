// Module « Économie » : monnaie du serveur, l'Edge Dollar (symbole $). Monnaie virtuelle uniquement.
//  - /play   : point d'entrée. Sans compte : présentation puis animation qui donne le solde de départ
//              (tiré au hasard entre startMin et startMax, une seule fois). Avec compte : tableau de bord personnel.
//  - /daily  : récompense quotidienne (montant de base + bonus de série, plafonné).
//  - /profile: solde, rang, série. Réponse privée.
//  - Réglages (nom et symbole de la monnaie, montants) : tableau de bord. Activation : /config.
// Les soldes sont dans Supabase (section 12 de schema.sql) : chaque mouvement est verrouillé côté base.
const crypto = require('crypto');
const { AttachmentBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const store = require('../store');
const { embed, button, row, toggleButton, moduleSelectRow, ephemeralPayload } = require('../ui');
const { MODULE_LIST } = require('./registry');
const levelsModule = require('./levels');
const { renderProfileCard, renderEconomyLeaderboardCard, ECONOMY_DEFAULT_THEME } = require('../economy-card');

const ID = 'economy';
const DEFAULTS = {
  enabled: false,
  currencyName: 'Edge Dollar',
  symbol: '$',
  startMin: 100, // solde de départ : tirage entre startMin et startMax
  startMax: 500,
  dailyAmount: 100, // /daily : montant de base
  dailyStreakBonus: 10, // ajouté par jour de série supplémentaire
  dailyStreakMax: 100, // plafond du bonus de série
};
const LIMITS = { amount: 100000, streakBonus: 10000, currencyName: 30, symbol: 4 };
// /daily : un passage toutes les 22 h ; la série continue si le passage précédent date de moins de 48 h.
const DAILY_TIMING = { cooldownHours: 22, windowHours: 48 };
const LEADERBOARD_SIZE = 10;
const NBSP = '\u00a0';

let frameDelayMs = 700; // délai entre deux images de l'animation (réduit dans les tests)
function setFrameDelay(ms) {
  frameDelayMs = ms;
}

const cfgOf = (guildId) => store.getModuleConfig(guildId, ID, DEFAULTS);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Montants
// ---------------------------------------------------------------------------

// 1250 -> « 1 250 » (espace insécable, lisible en français).
function formatNumber(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

// 1250 -> « 1 250 $ » (symbole après le montant, à la française).
function formatMoney(n, cfg = DEFAULTS) {
  return `${formatNumber(n)}${NBSP}${cfg.symbol}`;
}

// Tirage du solde de départ, dans l'intervalle configuré (bornes incluses), avec un générateur cryptographique.
function drawStart(cfg) {
  const min = Math.max(0, Math.trunc(cfg.startMin));
  const max = Math.max(min, Math.trunc(cfg.startMax));
  return crypto.randomInt(min, max + 1);
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

const hubButtons = () => row(
  button('eco:daily', 'Récompense quotidienne', ButtonStyle.Primary, '🎁'),
  button('eco:profile', 'Profil', ButtonStyle.Secondary, '👤'),
);

function introPayload(cfg) {
  return {
    embeds: [
      embed(
        `💰 **Bienvenue dans l’économie du serveur.**\n\nTon compte en **${cfg.currencyName}** (${cfg.symbol}) n’existe pas encore. ` +
          `Clique sur le bouton pour recevoir ton solde de départ : un montant tiré au hasard entre ` +
          `**${formatMoney(cfg.startMin, cfg)}** et **${formatMoney(cfg.startMax, cfg)}**. Une seule fois.`,
      ),
    ],
    components: [row(button('eco:start', 'Recevoir mon solde', ButtonStyle.Success, '💵'))],
    flags: MessageFlags.Ephemeral,
  };
}

function hubPayload(cfg, account, rank) {
  const e = embed(`💰 **${cfg.currencyName}** · ton tableau de bord`).addFields(
    { name: 'Solde', value: formatMoney(account.balance, cfg), inline: true },
    { name: 'Rang', value: `#${rank} sur le serveur`, inline: true },
    { name: 'Série', value: `${account.daily_streak ?? 0} jour(s)`, inline: true },
  );
  return { embeds: [e], components: [hubButtons()], flags: MessageFlags.Ephemeral };
}

function privateReply(description, components = []) {
  return { embeds: [embed(description)], components, flags: MessageFlags.Ephemeral };
}

// Charge utile d'une édition de message : Discord ne change pas l'indicateur « privé » après coup.
function editPayload({ flags, ...rest }) {
  return rest;
}

// Thème des cartes : celui du module Niveaux (violet par défaut).
function themeOf(guildId) {
  return store.getModuleConfig(guildId, levelsModule.ID, levelsModule.DEFAULTS).theme ?? ECONOMY_DEFAULT_THEME;
}

// Prochaine récompense : « disponible » ou un repère Discord relatif (« dans 3 heures »).
function nextDailyText(account) {
  if (!account.last_daily) return 'Disponible maintenant';
  const next = Date.parse(account.last_daily) + DAILY_TIMING.cooldownHours * 3600 * 1000;
  if (next <= Date.now()) return 'Disponible maintenant';
  return `<t:${Math.floor(next / 1000)}:R>`;
}

// ---------------------------------------------------------------------------
// Commandes et composants
// ---------------------------------------------------------------------------

async function handleCommand(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply(ephemeralPayload('Cette commande ne fonctionne que sur un serveur.'));
  const cfg = cfgOf(guild.id);
  if (!cfg.enabled) return interaction.reply(ephemeralPayload('L’économie n’est pas activée sur ce serveur.'));
  switch (interaction.commandName) {
    case 'play':
      return playAction(interaction, cfg);
    case 'daily':
      return dailyAction(interaction, cfg);
    case 'profile':
      return profileAction(interaction, cfg);
    default:
      return;
  }
}

// Boutons « eco:<action> » (messages privés de /play).
async function handleInteraction(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const cfg = cfgOf(guild.id);
  if (!cfg.enabled) return interaction.reply(ephemeralPayload('L’économie n’est pas activée sur ce serveur.'));
  const [, action] = interaction.customId.split(':');
  switch (action) {
    case 'start':
      return startAction(interaction, cfg);
    case 'daily':
      return dailyAction(interaction, cfg);
    case 'profile':
      return profileAction(interaction, cfg);
    default:
      return;
  }
}

async function playAction(interaction, cfg) {
  const account = await store.getEconomyAccount(interaction.guild.id, interaction.user.id);
  if (!account?.started) return interaction.reply(introPayload(cfg));
  const rank = await store.economyRank(interaction.guild.id, account.balance);
  return interaction.reply(hubPayload(cfg, account, rank));
}

// Animation puis solde de départ. Le bouton disparaît pendant le tirage.
async function startAction(interaction, cfg) {
  const guildId = interaction.guild.id;
  const existing = await store.getEconomyAccount(guildId, interaction.user.id);
  if (existing?.started) {
    return interaction.update(editPayload(privateReply('Tu as déjà reçu ton solde de départ.', [hubButtons()])));
  }
  await interaction.deferUpdate();
  const amount = drawStart(cfg);
  for (const frame of ['🎰 Ouverture du coffre…', '💵 On compte les billets…', '✨ Presque…']) {
    await interaction.editReply({ embeds: [embed(frame)], components: [] });
    await sleep(frameDelayMs);
  }
  const res = await store.economyStart(guildId, interaction.user.id, amount);
  if (res.status === 'already') {
    return interaction.editReply(editPayload(privateReply('Tu as déjà reçu ton solde de départ.', [hubButtons()])));
  }
  return interaction.editReply(
    editPayload(
      privateReply(
        `🎉 Bienvenue ! Tu reçois **${formatMoney(amount, cfg)}**. Ton solde est de **${formatMoney(res.balance, cfg)}**.`,
        [hubButtons()],
      ),
    ),
  );
}

async function dailyAction(interaction, cfg) {
  const res = await store.economyDaily(interaction.guild.id, interaction.user.id, {
    base: cfg.dailyAmount,
    bonus: cfg.dailyStreakBonus,
    cap: cfg.dailyStreakMax,
    ...DAILY_TIMING,
  });
  if (res.status === 'not_started') {
    return interaction.reply(privateReply('Lance d’abord **/play** pour recevoir ton solde de départ.'));
  }
  if (res.status === 'cooldown') {
    const unix = Math.floor(Date.parse(res.next_at) / 1000);
    return interaction.reply(privateReply(`Tu as déjà récupéré ta récompense. Reviens <t:${unix}:R>.`));
  }
  return interaction.reply(
    privateReply(
      `🎁 Récompense quotidienne : **+${formatMoney(res.amount, cfg)}**. Série de **${res.streak}** jour(s). ` +
        `Ton solde est de **${formatMoney(res.balance, cfg)}**.`,
    ),
  );
}

// Prochaine récompense, en millisecondes (0 ou moins = disponible).
function msUntilDaily(account) {
  if (!account.last_daily) return 0;
  return Date.parse(account.last_daily) + DAILY_TIMING.cooldownHours * 3600 * 1000 - Date.now();
}

// /profile : carte PNG privée (solde, rang, série, prochaine récompense). Aucun montant d'XP.
async function profileAction(interaction, cfg) {
  const guildId = interaction.guild.id;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const account = await store.getEconomyAccount(guildId, interaction.user.id);
  if (!account?.started) {
    return interaction.editReply({ embeds: [embed('Tu n’as pas encore de compte. Lance **/play**.')] });
  }
  const rank = await store.economyRank(guildId, account.balance);
  const png = await renderProfileCard({
    name: interaction.user.displayName ?? interaction.user.username,
    avatarUrl: interaction.user.displayAvatarURL?.({ extension: 'png', size: 256 }) ?? null,
    balance: account.balance,
    currencyName: cfg.currencyName,
    symbol: cfg.symbol,
    rank,
    streak: account.daily_streak ?? 0,
    nextDailyMs: msUntilDaily(account),
    theme: themeOf(guildId),
  });
  return interaction.editReply({ files: [new AttachmentBuilder(png, { name: 'profil.png' })] });
}

// /leaderboard : classement en Edge Dollar, en PNG (public). Le classement XP est sur /leaderboard type:XP.
async function handleLeaderboard(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply(ephemeralPayload('Cette commande ne fonctionne que sur un serveur.'));
  const cfg = cfgOf(guild.id);
  if (!cfg.enabled) {
    return interaction.reply(
      ephemeralPayload('L’économie n’est pas activée sur ce serveur. Pour le classement XP : `/leaderboard type:XP`.'),
    );
  }
  await interaction.deferReply();
  const top = await store.economyTop(guild.id, LEADERBOARD_SIZE);
  const ids = top.map((r) => r.user_id);
  const members = ids.length ? await guild.members.fetch({ user: ids }).catch(() => null) : null;
  const rows = top.map((r, i) => ({
    rank: i + 1,
    name: members?.get(r.user_id)?.displayName ?? `Membre ${r.user_id.slice(-4)}`,
    balance: r.balance,
  }));
  const png = await renderEconomyLeaderboardCard({
    rows,
    currencyName: cfg.currencyName,
    symbol: cfg.symbol,
    theme: themeOf(guild.id),
    subtitle: `Top ${LEADERBOARD_SIZE} · ${cfg.currencyName}`,
  });
  return interaction.editReply({
    files: [new AttachmentBuilder(png, { name: 'classement.png' })],
    allowedMentions: { parse: [] },
  });
}

// ---------------------------------------------------------------------------
// Config (/config → Économie) : activation seulement ; les montants se règlent sur le tableau de bord.
// ---------------------------------------------------------------------------

function render(view, guild) {
  return renderMain(guild);
}

function renderMain(guild) {
  const cfg = cfgOf(guild.id);
  return {
    content:
      '💰 **Module Économie** · la monnaie du serveur, avec les commandes `/play`, `/daily` et `/profile`.',
    embeds: [
      embed().addFields(
        { name: 'Module', value: cfg.enabled ? '🟢 Activé' : '⚪ Désactivé', inline: true },
        { name: 'Monnaie', value: `${cfg.currencyName} (${cfg.symbol})`, inline: true },
        {
          name: 'Solde de départ',
          value: `${formatMoney(cfg.startMin, cfg)} à ${formatMoney(cfg.startMax, cfg)}`,
          inline: true,
        },
        {
          name: 'Réglages',
          value: 'Nom et symbole de la monnaie, montants du solde de départ et de la récompense quotidienne : tableau de bord.',
        },
      ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(toggleButton('cfg:economy:toggle:enabled', 'Module', cfg.enabled)),
    ],
  };
}

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , action, arg] = interaction.customId.split(':');
  if (action === 'view') return interaction.update(renderMain(guild));
  if (action === 'toggle' && arg === 'enabled') {
    const cfg = cfgOf(guild.id);
    cfg.enabled = !cfg.enabled;
    store.updateModuleConfig(guild.id, ID, cfg);
    return interaction.update(renderMain(guild));
  }
}

// Ce module n'a pas de modale.
async function handleModal() {}

module.exports = {
  ID,
  DEFAULTS,
  LIMITS,
  DAILY_TIMING,
  render,
  handleComponent,
  handleModal,
  handleCommand,
  handleInteraction,
  handleLeaderboard,
  drawStart,
  formatMoney,
  setFrameDelay,
};
