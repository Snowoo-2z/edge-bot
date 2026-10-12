// Module « Économie » : monnaie du serveur, l'Edge Dollar (symbole $). Monnaie virtuelle uniquement.
//  - /play   : panneau PUBLIC (visible de tous) : présentation et banque du serveur. Le bouton « Ouvrir mon compte »
//              ouvre le tableau de bord personnel (privé) : solde, rang, récompense quotidienne, emprunt.
//              Le premier /play ouvre la banque du serveur avec son montant initial (300 000 $ par défaut).
//  - Compte sans solde : animation qui donne le solde de départ (tiré entre startMin et startMax, une seule fois).
//  - Emprunt : on emprunte à la banque (un seul emprunt ouvert à la fois), on rembourse à l'échéance ou avant.
//  - /daily  : récompense quotidienne (montant de base + bonus de série, plafonné). Le bouton devient rouge une fois
//              récupérée.
//  - /profile: carte PNG privée (solde, rang, série).
//  - /rob @membre : voler le solde « sur soi » d'un membre (une fois toutes les 3 h). L'argent à la banque est protégé.
//  - Entreprises (bouton du tableau de bord) : créer une banque, proposer des abonnements, déposer et retirer.
//    Module-entreprises dans economy-companies.js ; prélèvement quotidien des banques (runBankDaily).
//  - Réglages (monnaie, montants, banque, emprunts, vols, banques) : tableau de bord. Activation : /config.
// Les soldes, la banque, les emprunts et les entreprises sont dans Supabase (sections 12 à 14 de schema.sql) : chaque
// mouvement est verrouillé côté base.
const crypto = require('crypto');
const { AttachmentBuilder, ButtonStyle, Events, MessageFlags } = require('discord.js');
const store = require('../store');
const { embed, button, row, toggleButton, moduleSelectRow, ephemeralPayload, textModal } = require('../ui');
const { MODULE_LIST } = require('./registry');
const levelsModule = require('./levels');
const { renderProfileCard, renderEconomyLeaderboardCard, ECONOMY_DEFAULT_THEME } = require('../economy-card');
const { formatMoney, parseAmount } = require('../economy-money');
const companies = require('./economy-companies');
const { handleRob } = require('./economy-rob');

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
  bankInitial: 300000, // montant initial de la banque du serveur (ouverte au premier /play)
  loanMax: 10000, // emprunt maximum par membre et par emprunt
  loanRatePercent: 10, // intérêts forfaitaires, en pourcentage du montant emprunté
  loanDays: 7, // délai de remboursement
  robCooldownHours: 3, // délai entre deux vols d'un même membre
  robSuccessPercent: 50, // chance de réussite de base (ajustée selon le solde de la victime)
  robMaxPercent: 20, // un vol réussi prend entre 1 % et ce pourcentage du solde de la victime
  robFailMin: 50, // amende d'un vol raté : tirée entre ces deux montants, payée à la victime
  robFailMax: 100,
  bankFeePercent: 0.1, // frais du serveur : part du total stocké dans chaque banque, prélevée chaque jour
};
const LIMITS = { amount: 100000000, streakBonus: 10000, currencyName: 30, symbol: 4 };
// /daily : un passage toutes les 22 h ; la série continue si le passage précédent date de moins de 48 h.
const DAILY_TIMING = { cooldownHours: 22, windowHours: 48 };
const LEADERBOARD_SIZE = 10;

let frameDelayMs = 700; // délai entre deux images de l'animation (réduit dans les tests)
function setFrameDelay(ms) {
  frameDelayMs = ms;
}

const cfgOf = (guildId) => store.getModuleConfig(guildId, ID, DEFAULTS);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Montants (formatMoney, parseAmount : voir economy-money.js)
// ---------------------------------------------------------------------------

// Montant à rembourser : principal + intérêts forfaitaires, arrondis à l'unité supérieure.
function loanTotal(amount, ratePercent) {
  return amount + Math.ceil((amount * ratePercent) / 100);
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

// Prochaine récompense, en millisecondes (0 ou moins = disponible).
function msUntilDaily(account) {
  if (!account.last_daily) return 0;
  return Date.parse(account.last_daily) + DAILY_TIMING.cooldownHours * 3600 * 1000 - Date.now();
}

// Bouton de la récompense : bleu quand elle est disponible, rouge une fois récupérée.
function dailyButton(account) {
  if (msUntilDaily(account) <= 0) {
    return button('eco:daily', 'Récompense quotidienne', ButtonStyle.Primary, '🎁');
  }
  return button('eco:daily', 'Récompense quotidienne déjà récupérée', ButtonStyle.Danger, '🎁');
}

// Données du tableau de bord (un seul aller-retour par action).
async function loadHub(guildId, userId) {
  const account = await store.getEconomyAccount(guildId, userId);
  if (!account?.started) return null;
  const [rank, loan, reserve, membership] = await Promise.all([
    store.economyRank(guildId, account.balance),
    store.economyOpenLoan(guildId, userId),
    store.economyBankReserve(guildId),
    store.economyMemberBank(guildId, userId),
  ]);
  return { account, rank, loan, reserve, membership };
}

// Vue du tableau de bord (sans indicateur « privé » : il est fixé à la réponse d'origine).
function hubView(cfg, hub, notice = '') {
  const { account, rank, loan, reserve, membership } = hub;
  const title = `💰 **${cfg.currencyName}** · ton tableau de bord`;
  const e = embed(notice ? `${notice}\n\n${title}` : title).addFields(
    { name: 'Solde', value: formatMoney(account.balance, cfg), inline: true },
    { name: 'Rang', value: `#${rank} sur le serveur`, inline: true },
    { name: 'Série', value: `${account.daily_streak ?? 0} jour(s)`, inline: true },
    { name: '🏦 Banque du serveur', value: formatMoney(reserve ?? 0, cfg), inline: true },
  );
  if (membership?.stored > 0) {
    e.addFields({ name: '🔒 À l’abri en banque', value: formatMoney(membership.stored, cfg), inline: true });
  }
  if (loan) {
    const remaining = loan.total_due - loan.repaid;
    const unix = Math.floor(Date.parse(loan.due_at) / 1000);
    const overdue = Date.parse(loan.due_at) < Date.now();
    e.addFields({
      name: 'Emprunt en cours',
      value: `Reste à rembourser : **${formatMoney(remaining, cfg)}**\n${overdue ? '⚠️ En retard' : `Échéance : <t:${unix}:f>`}`,
    });
  }
  const loanButton = loan
    ? button('eco:repay', 'Rembourser', ButtonStyle.Success, '💳')
    : button('eco:borrow', 'Emprunter', ButtonStyle.Secondary, '🏦');
  return {
    embeds: [e],
    components: [
      row(dailyButton(account), button('eco:profile', 'Profil', ButtonStyle.Secondary, '👤')),
      row(loanButton, button('eco:co:home', 'Entreprises', ButtonStyle.Secondary, '🏦')),
    ],
  };
}

function privateReply(description, components = []) {
  return { embeds: [embed(description)], components, flags: MessageFlags.Ephemeral };
}

// Thème des cartes : celui du module Niveaux (violet par défaut).
function themeOf(guildId) {
  return store.getModuleConfig(guildId, levelsModule.ID, levelsModule.DEFAULTS).theme ?? ECONOMY_DEFAULT_THEME;
}

// Prochaine récompense pour la carte /profile (texte non utilisé ici).
function nextDailyText(account) {
  if (!account.last_daily) return 'Disponible maintenant';
  const next = Date.parse(account.last_daily) + DAILY_TIMING.cooldownHours * 3600 * 1000;
  if (next <= Date.now()) return 'Disponible maintenant';
  return `<t:${Math.floor(next / 1000)}:R>`;
}

// ---------------------------------------------------------------------------
// Commandes
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
    case 'rob':
      return handleRob(interaction, cfg);
    default:
      return;
  }
}

// /play : panneau public. Ouvre aussi la banque du serveur avec son montant initial (sans effet si elle existe).
async function playAction(interaction, cfg) {
  const guildId = interaction.guild.id;
  await store.economyBankFund(guildId, cfg.bankInitial);
  const reserve = await store.economyBankReserve(guildId);
  const panel = embed(
    `💰 **${cfg.currencyName}** (${cfg.symbol}) · la monnaie du serveur.\n\n` +
      'Ouvre ton compte pour voir ton solde, récupérer ta récompense quotidienne, emprunter à la banque du serveur ' +
        'et mettre ton argent à l’abri dans une banque (les voleurs ne touchent pas à l’argent déposé).',
  ).addFields({ name: '🏦 Banque du serveur', value: formatMoney(reserve ?? 0, cfg), inline: true });
  // Pas d'indicateur « privé » : le panneau est visible de tous.
  return interaction.reply({
    embeds: [panel],
    components: [row(button('eco:open', 'Ouvrir mon compte', ButtonStyle.Primary, '💰'))],
    allowedMentions: { parse: [] },
  });
}

// Boutons « eco:<action> » et formulaires « eco:<action>:modal ».
async function handleInteraction(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const cfg = cfgOf(guild.id);
  if (!cfg.enabled) return interaction.reply(ephemeralPayload('L’économie n’est pas activée sur ce serveur.'));
  const [, action] = interaction.customId.split(':');
  if (action === 'co') return companies.handleInteraction(interaction, cfg);
  if (interaction.isModalSubmit?.()) {
    if (action === 'borrow') return borrowSubmitAction(interaction, cfg);
    if (action === 'repay') return repaySubmitAction(interaction, cfg);
    return;
  }
  switch (action) {
    case 'open':
      return openAction(interaction, cfg);
    case 'start':
      return startAction(interaction, cfg);
    case 'daily':
      return dailyAction(interaction, cfg);
    case 'profile':
      return profileAction(interaction, cfg);
    case 'borrow':
      return borrowAction(interaction, cfg);
    case 'repay':
      return repayAction(interaction, cfg);
    default:
      return;
  }
}

// « Ouvrir mon compte » : tableau de bord privé, ou présentation si le compte n'existe pas encore.
async function openAction(interaction, cfg) {
  const hub = await loadHub(interaction.guild.id, interaction.user.id);
  if (!hub) return interaction.reply(introPayload(cfg));
  return interaction.reply({ ...hubView(cfg, hub), flags: MessageFlags.Ephemeral });
}

// Animation puis solde de départ. Le bouton disparaît pendant le tirage.
async function startAction(interaction, cfg) {
  const guildId = interaction.guild.id;
  const existing = await store.getEconomyAccount(guildId, interaction.user.id);
  if (existing?.started) {
    const hub = await loadHub(guildId, interaction.user.id);
    return interaction.update(hubView(cfg, hub, 'Tu as déjà reçu ton solde de départ.'));
  }
  await interaction.deferUpdate();
  const amount = drawStart(cfg);
  for (const frame of ['🎰 Ouverture du coffre…', '💵 On compte les billets…', '✨ Presque…']) {
    await interaction.editReply({ embeds: [embed(frame)], components: [] });
    await sleep(frameDelayMs);
  }
  const res = await store.economyStart(guildId, interaction.user.id, amount);
  const hub = await loadHub(guildId, interaction.user.id);
  const notice =
    res.status === 'already'
      ? 'Tu as déjà reçu ton solde de départ.'
      : `🎉 Bienvenue ! Tu reçois **${formatMoney(amount, cfg)}**.`;
  return interaction.editReply(hubView(cfg, hub, notice));
}

// Récompense quotidienne. Depuis le tableau de bord, il est mis à jour sur place (bouton rouge après le passage).
async function dailyAction(interaction, cfg) {
  const fromHub = String(interaction.customId ?? '').startsWith('eco:');
  const guildId = interaction.guild.id;
  const res = await store.economyDaily(guildId, interaction.user.id, {
    base: cfg.dailyAmount,
    bonus: cfg.dailyStreakBonus,
    cap: cfg.dailyStreakMax,
    ...DAILY_TIMING,
  });
  if (res.status === 'not_started') {
    return interaction.reply(privateReply('Ouvre d’abord ton compte avec **/play**.'));
  }
  if (res.status === 'cooldown') {
    const unix = Math.floor(Date.parse(res.next_at) / 1000);
    const notice = `Tu as déjà récupéré ta récompense. Reviens <t:${unix}:R>.`;
    if (fromHub) {
      const hub = await loadHub(guildId, interaction.user.id);
      return interaction.update(hubView(cfg, hub, notice));
    }
    return interaction.reply(privateReply(notice));
  }
  const notice = `🎁 Récompense quotidienne : **+${formatMoney(res.amount, cfg)}**. Série de **${res.streak}** jour(s).`;
  if (fromHub) {
    const hub = await loadHub(guildId, interaction.user.id);
    return interaction.update(hubView(cfg, hub, notice));
  }
  return interaction.reply(privateReply(`${notice} Ton solde est de **${formatMoney(res.balance, cfg)}**.`));
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

// ---------------------------------------------------------------------------
// Emprunts
// ---------------------------------------------------------------------------

// Bouton « Emprunter » : formulaire de montant, ou explication si un emprunt est déjà ouvert.
async function borrowAction(interaction, cfg) {
  const guildId = interaction.guild.id;
  const hub = await loadHub(guildId, interaction.user.id);
  if (!hub) return interaction.reply(privateReply('Ouvre d’abord ton compte avec **/play**.'));
  if (hub.loan) return interaction.reply(privateReply('Tu as déjà un emprunt en cours. Rembourse-le avant d’en prendre un autre.'));
  const modal = textModal('eco:borrow:modal', 'Emprunter à la banque', [
    {
      key: 'amount',
      label: `Montant (1 à ${cfg.loanMax} ${cfg.symbol})`,
      max: 12,
      required: true,
      placeholder: `Intérêts : ${cfg.loanRatePercent} % · à rembourser sous ${cfg.loanDays} jour(s)`,
    },
  ]);
  return interaction.showModal(modal);
}

async function borrowSubmitAction(interaction, cfg) {
  const guildId = interaction.guild.id;
  const amount = parseAmount(interaction.fields.getTextInputValue('amount'));
  if (!amount || amount > cfg.loanMax) {
    return interaction.reply(privateReply(`Montant invalide : entre 1 et ${formatMoney(cfg.loanMax, cfg)}.`));
  }
  const total = loanTotal(amount, cfg.loanRatePercent);
  const res = await store.economyBorrow(guildId, interaction.user.id, {
    amount,
    total,
    max: cfg.loanMax,
    days: cfg.loanDays,
  });
  switch (res.status) {
    case 'ok': {
      const unix = Math.floor(Date.parse(res.due_at) / 1000);
      return interaction.reply(
        privateReply(
          `🏦 Emprunt accepté : **+${formatMoney(amount, cfg)}**. Tu rembourseras **${formatMoney(total, cfg)}** avant ` +
            `<t:${unix}:f> (<t:${unix}:R>). Ton solde est de **${formatMoney(res.balance, cfg)}**.`,
        ),
      );
    }
    case 'not_started':
      return interaction.reply(privateReply('Ouvre d’abord ton compte avec **/play**.'));
    case 'open_loan':
      return interaction.reply(privateReply('Tu as déjà un emprunt en cours. Rembourse-le avant d’en prendre un autre.'));
    case 'limit':
      return interaction.reply(privateReply(`Montant invalide : entre 1 et ${formatMoney(cfg.loanMax, cfg)}.`));
    case 'bank_short':
      return interaction.reply(
        privateReply(`La banque du serveur ne peut prêter que **${formatMoney(res.reserve, cfg)}** pour le moment.`),
      );
    case 'no_bank':
      return interaction.reply(privateReply('La banque du serveur n’est pas encore ouverte : un membre doit lancer **/play**.'));
    default:
      return interaction.reply(privateReply('L’emprunt n’a pas pu aboutir. Réessaie dans un instant.'));
  }
}

// Bouton « Rembourser » : formulaire pré-rempli avec ce qui reste dû.
async function repayAction(interaction, cfg) {
  const loan = await store.economyOpenLoan(interaction.guild.id, interaction.user.id);
  if (!loan) return interaction.reply(privateReply('Tu n’as aucun emprunt en cours.'));
  const remaining = loan.total_due - loan.repaid;
  const modal = textModal('eco:repay:modal', 'Rembourser l’emprunt', [
    {
      key: 'amount',
      label: `Montant (reste à payer : ${remaining} ${cfg.symbol})`,
      max: 12,
      required: true,
      value: String(remaining),
    },
  ]);
  return interaction.showModal(modal);
}

async function repaySubmitAction(interaction, cfg) {
  const guildId = interaction.guild.id;
  const amount = parseAmount(interaction.fields.getTextInputValue('amount'));
  if (!amount) return interaction.reply(privateReply('Montant invalide.'));
  const res = await store.economyRepay(guildId, interaction.user.id, amount);
  switch (res.status) {
    case 'ok':
      return interaction.reply(
        privateReply(
          res.remaining > 0
            ? `💳 Remboursé **${formatMoney(res.paid, cfg)}**. Reste à payer : **${formatMoney(res.remaining, cfg)}**.`
            : `✅ Emprunt entièrement remboursé (**${formatMoney(res.paid, cfg)}** versés). Ton solde est de **${formatMoney(res.balance, cfg)}**.`,
        ),
      );
    case 'no_loan':
      return interaction.reply(privateReply('Tu n’as aucun emprunt en cours.'));
    case 'funds':
      return interaction.reply(
        privateReply(`Solde insuffisant : tu as **${formatMoney(res.balance, cfg)}**. Essaie un montant plus petit.`),
      );
    default:
      return interaction.reply(privateReply('Montant invalide.'));
  }
}

// ---------------------------------------------------------------------------
// Classement
// ---------------------------------------------------------------------------

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
      '💰 **Module Économie** · la monnaie du serveur, avec les commandes `/play`, `/daily`, `/profile`, `/rob` et `/leaderboard`.',
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
          value:
            'Monnaie, solde de départ, récompense quotidienne, banque du serveur et emprunts : tableau de bord.',
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

// Ce module n'a pas de modale de configuration.
async function handleModal() {}

// ---------------------------------------------------------------------------
// Banques : prélèvement quotidien (abonnements et frais du serveur), une seule fois par jour et par serveur.
// ---------------------------------------------------------------------------

const BANK_TICK_MS = 10 * 60 * 1000; // le bot vérifie toutes les 10 min ; la base garantit un seul passage par jour
let bankTimerStarted = false;

// Jour civil à Paris (AAAA-MM-JJ) : les prélèvements ont lieu au changement de jour, heure de Paris.
function parisDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Frais du serveur en points de base : 0,1 % = 10 (la base attend un entier).
const feeBasisPoints = (cfg) => Math.round(Number(cfg.bankFeePercent) * 100);

async function runBankDaily(client, date = new Date()) {
  const day = parisDay(date);
  for (const guild of client.guilds.cache.values()) {
    try {
      const cfg = cfgOf(guild.id);
      if (!cfg.enabled) continue;
      const res = await store.economyBankDaily(guild.id, day, feeBasisPoints(cfg));
      if (res.status === 'ok' && (res.charged || res.cancelled || res.server_cut)) {
        console.log(
          `[economy] banques ${guild.id} (${day}) : ${res.charged} prélèvement(s), ${res.cancelled} résiliation(s), frais serveur ${res.server_cut}.`,
        );
      }
    } catch (err) {
      console.error(`[economy] prélèvement des banques impossible (${guild.id}) :`, err.message);
    }
  }
}

// Appelée au démarrage (comme les autres modules) : une seule boucle, quel que soit le nombre de connexions.
function registerEvents(client) {
  client.once(Events.ClientReady, () => {
    if (bankTimerStarted) return;
    bankTimerStarted = true;
    const tick = () => runBankDaily(client).catch((err) => console.error('[economy] erreur :', err));
    tick();
    setInterval(tick, BANK_TICK_MS).unref();
  });
}

module.exports = {
  ID,
  DEFAULTS,
  registerEvents,
  runBankDaily,
  parisDay,
  feeBasisPoints,
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
  parseAmount,
  loanTotal,
  setFrameDelay,
  nextDailyText,
};
