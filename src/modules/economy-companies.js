// Module « Économie » → Entreprises (menu « 🏦 Entreprises » du tableau de bord).
//  - Un membre crée une entreprise (pour l'instant : une banque). Une entreprise par membre.
//  - La banque propose des abonnements (5 au maximum) : prix par jour et stockage par abonné.
//  - Un membre s'abonne à un plan, dépose de l'argent dans le coffre (plafonné par le plan et par la banque),
//    et retire quand il veut. L'argent au coffre ne peut pas être volé (/rob ne touche que le solde « sur soi »).
//  - Chaque jour, le prix du plan est prélevé sur le coffre et versé à la trésorerie de la banque. Le patron retire
//    la trésorerie sur son compte. Le serveur prélève aussi un petit pourcentage (réglage du tableau de bord).
// Tout l'argent passe par des fonctions SQL verrouillées (section 14 de supabase/schema.sql).
const { ButtonStyle, MessageFlags } = require('discord.js');
const store = require('../store');
const { embed, button, row, selectMenu, textModal } = require('../ui');
const { formatMoney, parseAmount, parseAmountOrZero } = require('../economy-money');

// Types d'entreprise. Pour ajouter un type (ex. casino) : une entrée ici, la valeur acceptée par SQL, et ses règles.
const COMPANY_KINDS = {
  bank: { label: 'Banque', emoji: '🏦', description: 'Stocke l’argent des membres abonnés. Prélèvement quotidien.' },
};
const MAX_PLANS = 5;
const MAX_COMPANY_NAME = 40;
const MAX_PLAN_NAME = 30;
const AMOUNT_CAP = 1000000000000; // garde-fou pour les montants saisis

const privateReply = (description, components = []) => ({
  embeds: [embed(description)],
  components,
  flags: MessageFlags.Ephemeral,
});
const backToHome = () => row(button('eco:co:home', 'Entreprises', ButtonStyle.Secondary, '🏦'));
const backToDashboard = () => row(button('eco:open', 'Tableau de bord', ButtonStyle.Secondary, '💰'));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Lecture de l'état du membre : entreprises, son coffre, son entreprise, sa banque et son abonnement.
async function loadState(guildId, userId) {
  const [companies, membership] = await Promise.all([
    store.economyCompanies(guildId),
    store.economyMemberBank(guildId, userId),
  ]);
  const mine = companies.find((c) => c.owner_id === userId) ?? null;
  const bank = membership ? (companies.find((c) => c.id === membership.company_id) ?? null) : null;
  const plan = membership?.plan_id && bank ? (bank.plans.find((p) => p.id === membership.plan_id) ?? null) : null;
  return { companies, membership, mine, bank, plan };
}

function membershipText(st, cfg) {
  const { membership, bank, plan } = st;
  if (!membership) return 'Aucun coffre. Abonne-toi à une banque pour y mettre ton argent à l’abri des voleurs.';
  const bankName = bank?.name ?? 'banque inconnue';
  if (!plan) {
    return `Coffre chez **${bankName}** : ${formatMoney(membership.stored, cfg)}. Non abonné : plus de prélèvement, mais ton argent reste protégé. Tu peux le retirer.`;
  }
  return (
    `Coffre chez **${bankName}** : ${formatMoney(membership.stored, cfg)}\n` +
    `Abonnement **${plan.name}** : ${formatMoney(plan.daily_price, cfg)} par jour, plafond ${formatMoney(plan.storage, cfg)}.`
  );
}

function companyLine(c, cfg) {
  return (
    `**${c.name}** · trésorerie ${formatMoney(c.treasury, cfg)} · stocké ${formatMoney(c.stored, cfg)} / ${formatMoney(c.max_storage, cfg)} · ` +
    `${c.subscribers} abonné(s) · ${c.plans.length} abonnement(s)`
  );
}

// Vue principale « Entreprises » (éphémère).
async function homeView(guildId, userId, cfg, notice = '') {
  const st = await loadState(guildId, userId);
  const { companies, membership, mine } = st;
  const offers = companies.flatMap((c) => c.plans.map((p) => ({ company: c, plan: p })));

  const head = '🏦 **Entreprises** · une banque garde ton argent à l’abri des vols (`/rob`).';
  const e = embed(notice ? `${notice}\n\n${head}` : head);
  e.addFields(
    { name: 'Ton coffre', value: clip(membershipText(st, cfg), 1000) },
    { name: 'Ton entreprise', value: clip(mine ? companyLine(mine, cfg) : 'Aucune. Crée la tienne avec le bouton ci-dessous.', 1000) },
  );
  if (offers.length) {
    const lines = offers.map(
      ({ company, plan }) =>
        `**${plan.name}** · ${company.name} · ${formatMoney(plan.daily_price, cfg)} / jour · jusqu’à ${formatMoney(plan.storage, cfg)}`,
    );
    e.addFields({ name: 'Abonnements disponibles', value: clip(lines.join('\n'), 1000) });
  } else {
    e.addFields({ name: 'Abonnements disponibles', value: 'Aucun pour l’instant.' });
  }

  const actions = [];
  if (!mine) actions.push(button('eco:co:create', 'Créer une entreprise', ButtonStyle.Primary, '➕'));
  else actions.push(button('eco:co:mine', 'Gérer mon entreprise', ButtonStyle.Primary, '🏦'));
  if (membership?.plan_id) actions.push(button('eco:co:dep', 'Déposer', ButtonStyle.Success, '⬇️'));
  if (membership?.stored > 0) actions.push(button('eco:co:wd', 'Retirer', ButtonStyle.Secondary, '⬆️'));
  if (membership?.plan_id) actions.push(button('eco:co:unsub', 'Résilier', ButtonStyle.Danger, '✖️'));

  const components = [row(...actions)];
  if (offers.length) {
    components.push(
      selectMenu(
        'eco:co:pick',
        'Choisir un abonnement',
        offers.slice(0, 25).map(({ company, plan }) => ({
          label: `${plan.name} · ${company.name}`,
          value: plan.id,
          description: `${formatMoney(plan.daily_price, cfg)} / jour · stockage ${formatMoney(plan.storage, cfg)}`,
        })),
      ),
    );
  }
  components.push(backToDashboard());
  return { embeds: [e], components };
}

// Vue « Gérer mon entreprise » (éphémère), réservée au patron.
async function mineView(guildId, userId, cfg, notice = '') {
  const companies = await store.economyCompanies(guildId);
  const mine = companies.find((c) => c.owner_id === userId);
  if (!mine) return homeView(guildId, userId, cfg, notice);
  const plans = mine.plans.length
    ? mine.plans.map((p) => `• **${p.name}** · ${formatMoney(p.daily_price, cfg)} / jour · stockage ${formatMoney(p.storage, cfg)}`).join('\n')
    : 'Aucun abonnement. Ajoute-en un pour que les membres puissent s’abonner.';
  const head = `🏦 **Ma banque · ${mine.name}**`;
  const e = embed(notice ? `${notice}\n\n${head}` : head).addFields(
    { name: 'Trésorerie', value: `${formatMoney(mine.treasury, cfg)} (revenus des abonnements, retirables)`, inline: true },
    { name: 'Stockage', value: `${formatMoney(mine.stored, cfg)} / ${formatMoney(mine.max_storage, cfg)}`, inline: true },
    { name: 'Abonnés', value: String(mine.subscribers), inline: true },
    { name: `Abonnements (${mine.plans.length}/${MAX_PLANS})`, value: clip(plans, 1000) },
  );
  return {
    embeds: [e],
    components: [
      row(
        button('eco:co:plan:add', 'Ajouter un abonnement', ButtonStyle.Primary, '➕'),
        button('eco:co:plan:del', 'Supprimer un abonnement', ButtonStyle.Secondary, '🗑️'),
        button('eco:co:cap', 'Capacité max', ButtonStyle.Secondary, '📦'),
        button('eco:co:tre', 'Retirer la trésorerie', ButtonStyle.Success, '💰'),
      ),
      backToHome(),
    ],
  };
}

// ---------------------------------------------------------------------------
// Boutons
// ---------------------------------------------------------------------------

async function onHome(interaction, cfg) {
  return interaction.update(await homeView(interaction.guild.id, interaction.user.id, cfg));
}

async function onMine(interaction, cfg) {
  return interaction.update(await mineView(interaction.guild.id, interaction.user.id, cfg));
}

async function onCreate(interaction, cfg) {
  const guildId = interaction.guild.id;
  const st = await loadState(guildId, interaction.user.id);
  if (st.mine) {
    return interaction.update(await homeView(guildId, interaction.user.id, cfg, `Tu as déjà une entreprise : **${st.mine.name}**.`));
  }
  const account = await store.getEconomyAccount(guildId, interaction.user.id);
  if (!account?.started) {
    return interaction.reply(privateReply('Ouvre d’abord ton compte avec **/play**.'));
  }
  const kinds = Object.entries(COMPANY_KINDS).map(([value, k]) => ({
    value,
    label: k.label,
    emoji: k.emoji,
    description: k.description,
  }));
  return interaction.update({
    embeds: [embed('➕ **Créer une entreprise** · choisis le type. Chaque membre ne peut en avoir qu’une.')],
    components: [selectMenu('eco:co:kind', 'Type d’entreprise', kinds), backToHome()],
  });
}

async function onPlanAdd(interaction) {
  const st = await loadState(interaction.guild.id, interaction.user.id);
  if (!st.mine) return interaction.reply(privateReply('Tu n’as pas encore d’entreprise.'));
  if (st.mine.plans.length >= MAX_PLANS) {
    return interaction.reply(privateReply(`Tu as déjà ${MAX_PLANS} abonnements. Supprime-en un pour en créer un autre.`));
  }
  return interaction.showModal(
    textModal('eco:co:plan:add:modal', 'Ajouter un abonnement', [
      { key: 'name', label: 'Nom de l’abonnement', max: MAX_PLAN_NAME, required: true, placeholder: 'Coffre Or' },
      { key: 'price', label: 'Prix par jour (0 = gratuit)', max: 12, required: true, value: '50' },
      { key: 'storage', label: 'Stockage maximum par abonné', max: 12, required: true, value: '5000' },
    ]),
  );
}

async function onPlanDel(interaction, cfg) {
  const st = await loadState(interaction.guild.id, interaction.user.id);
  if (!st.mine) return interaction.reply(privateReply('Tu n’as pas encore d’entreprise.'));
  if (!st.mine.plans.length) return interaction.reply(privateReply('Aucun abonnement à supprimer.'));
  return interaction.update({
    embeds: [embed('🗑️ **Supprimer un abonnement** · les abonnés ne seront plus prélevés, mais leur argent reste à la banque.')],
    components: [
      selectMenu(
        'eco:co:plan:del:pick',
        'Abonnement à supprimer',
        st.mine.plans.map((p) => ({
          label: p.name,
          value: p.id,
          description: `${formatMoney(p.daily_price, cfg)} / jour · stockage ${formatMoney(p.storage, cfg)}`,
        })),
      ),
      row(button('eco:co:mine', 'Ma banque', ButtonStyle.Secondary, '🏦')),
    ],
  });
}

async function onCapacity(interaction, cfg) {
  const companies = await store.economyCompanies(interaction.guild.id);
  const mine = companies.find((c) => c.owner_id === interaction.user.id);
  if (!mine) return interaction.reply(privateReply('Tu n’as pas encore d’entreprise.'));
  return interaction.showModal(
    textModal('eco:co:cap:modal', 'Capacité de la banque', [
      {
        key: 'amount',
        label: `Montant maximum stocké (${mine.max_storage} ${cfg.symbol} actuellement)`,
        max: 12,
        required: true,
        value: String(mine.max_storage),
      },
    ]),
  );
}

async function onTreasury(interaction, cfg) {
  const companies = await store.economyCompanies(interaction.guild.id);
  const mine = companies.find((c) => c.owner_id === interaction.user.id);
  if (!mine) return interaction.reply(privateReply('Tu n’as pas encore d’entreprise.'));
  if (mine.treasury <= 0) return interaction.reply(privateReply('La trésorerie est vide pour l’instant.'));
  return interaction.showModal(
    textModal('eco:co:tre:modal', 'Retirer la trésorerie', [
      { key: 'amount', label: `Montant (trésorerie : ${mine.treasury} ${cfg.symbol})`, max: 12, required: true, value: String(mine.treasury) },
    ]),
  );
}

async function onDeposit(interaction, cfg) {
  const st = await loadState(interaction.guild.id, interaction.user.id);
  if (!st.plan) return interaction.reply(privateReply('Abonne-toi d’abord à une banque pour y déposer de l’argent.'));
  const room = Math.max(0, st.plan.storage - st.membership.stored);
  return interaction.showModal(
    textModal('eco:co:dep:modal', 'Déposer à la banque', [
      {
        key: 'amount',
        label: `Montant (place disponible : ${room} ${cfg.symbol})`,
        max: 12,
        required: true,
        placeholder: `Plafond de ton abonnement : ${st.plan.storage} ${cfg.symbol}`,
      },
    ]),
  );
}

async function onWithdraw(interaction, cfg) {
  const st = await loadState(interaction.guild.id, interaction.user.id);
  if (!st.membership || st.membership.stored <= 0) {
    return interaction.reply(privateReply('Rien à retirer : ton coffre est vide.'));
  }
  return interaction.showModal(
    textModal('eco:co:wd:modal', 'Retirer de la banque', [
      { key: 'amount', label: `Montant (dans ton coffre : ${st.membership.stored} ${cfg.symbol})`, max: 12, required: true, value: String(st.membership.stored) },
    ]),
  );
}

async function onUnsubscribe(interaction, cfg) {
  const guildId = interaction.guild.id;
  const res = await store.economyUnsubscribe(guildId, interaction.user.id);
  const notice =
    res.status === 'ok'
      ? 'Abonnement résilié. Ton argent reste à la banque : tu peux le retirer à tout moment.'
      : 'Tu n’as aucun abonnement en cours.';
  return interaction.update(await homeView(guildId, interaction.user.id, cfg, notice));
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

// Choix du type d'entreprise : formulaire de création.
async function onKindPick(interaction) {
  const kind = interaction.values[0];
  if (!COMPANY_KINDS[kind]) return interaction.reply(privateReply('Type d’entreprise inconnu.'));
  return interaction.showModal(
    textModal(`eco:co:create:modal:${kind}`, `Créer : ${COMPANY_KINDS[kind].label}`, [
      { key: 'name', label: 'Nom', max: MAX_COMPANY_NAME, required: true, placeholder: 'Banque du Port' },
      { key: 'max', label: 'Montant maximum stocké', max: 12, required: true, value: '1000000' },
    ]),
  );
}

async function onSubscribePick(interaction, cfg) {
  const guildId = interaction.guild.id;
  const planId = Number(interaction.values[0]);
  const res = await store.economySubscribe(guildId, interaction.user.id, planId);
  const notice = {
    ok: '✅ Abonnement souscrit. Le prix du jour est prélevé sur ton coffre à chaque passage quotidien : pense à y déposer de l’argent.',
    not_found: 'Cet abonnement n’existe plus.',
    other_bank: 'Tu as déjà de l’argent dans une autre banque : retire-le d’abord.',
    not_started: 'Ouvre d’abord ton compte avec /play.',
  }[res.status] ?? 'L’abonnement n’a pas pu aboutir. Réessaie.';
  return interaction.update(await homeView(guildId, interaction.user.id, cfg, notice));
}

async function onPlanDelPick(interaction, cfg) {
  const planId = Number(interaction.values[0]);
  const res = await store.economyPlanRemove(interaction.guild.id, interaction.user.id, planId);
  if (res.status === 'ok') {
    return interaction.reply(privateReply('🗑️ Abonnement supprimé. Les abonnés ne sont plus prélevés ; leur argent reste à la banque.', [backToHome()]));
  }
  return interaction.reply(privateReply('Cet abonnement n’existe plus.', [backToHome()]));
}

// ---------------------------------------------------------------------------
// Formulaires
// ---------------------------------------------------------------------------

async function onCreateSubmit(interaction, cfg, kind) {
  const name = String(interaction.fields.getTextInputValue('name') ?? '').trim();
  const max = parseAmount(interaction.fields.getTextInputValue('max'));
  if (!name || name.length > MAX_COMPANY_NAME) {
    return interaction.reply(privateReply(`Nom invalide : 1 à ${MAX_COMPANY_NAME} caractères.`));
  }
  if (!max || max > AMOUNT_CAP) return interaction.reply(privateReply('Montant maximum invalide.'));
  const res = await store.economyCompanyCreate(interaction.guild.id, interaction.user.id, { kind, name, max });
  const messages = {
    ok: `🏦 Ta banque **${name}** est ouverte, avec un stockage maximum de ${formatMoney(max, cfg)}. Ajoute des abonnements dans **Gérer mon entreprise**.`,
    has_company: 'Tu as déjà une entreprise.',
    name_taken: 'Ce nom est déjà pris sur ce serveur.',
    not_started: 'Ouvre d’abord ton compte avec **/play**.',
    invalid: 'Informations invalides.',
    conflict: 'Une entreprise vient d’être créée à l’instant. Réessaie.',
  };
  return interaction.reply(privateReply(messages[res.status] ?? 'La création a échoué. Réessaie.', [backToHome()]));
}

async function onPlanAddSubmit(interaction, cfg) {
  const name = String(interaction.fields.getTextInputValue('name') ?? '').trim();
  const price = parseAmountOrZero(interaction.fields.getTextInputValue('price'));
  const storage = parseAmount(interaction.fields.getTextInputValue('storage'));
  if (!name || name.length > MAX_PLAN_NAME) return interaction.reply(privateReply(`Nom invalide : 1 à ${MAX_PLAN_NAME} caractères.`));
  if (price === null || price > AMOUNT_CAP) return interaction.reply(privateReply('Prix par jour invalide (0 ou plus).'));
  if (!storage || storage > AMOUNT_CAP) return interaction.reply(privateReply('Stockage invalide (1 ou plus).'));
  const res = await store.economyPlanAdd(interaction.guild.id, interaction.user.id, { name, price, storage });
  const messages = {
    ok: `➕ Abonnement **${name}** ajouté : ${formatMoney(price, cfg)} par jour, stockage ${formatMoney(storage, cfg)}.`,
    too_many: `Tu as déjà ${MAX_PLANS} abonnements. Supprime-en un pour en créer un autre.`,
    no_company: 'Tu n’as pas encore d’entreprise.',
    invalid: 'Informations invalides.',
  };
  return interaction.reply(privateReply(messages[res.status] ?? 'L’ajout a échoué. Réessaie.', [backToHome()]));
}

async function onCapacitySubmit(interaction, cfg) {
  const amount = parseAmount(interaction.fields.getTextInputValue('amount'));
  if (!amount || amount > AMOUNT_CAP) return interaction.reply(privateReply('Montant invalide.'));
  const res = await store.economyCompanyCapacity(interaction.guild.id, interaction.user.id, amount);
  const messages = {
    ok: `📦 Stockage maximum réglé à ${formatMoney(amount, cfg)}.`,
    below_stored: `Impossible : il reste ${formatMoney(res.stored ?? 0, cfg)} stockés dans la banque.`,
    invalid: 'Montant invalide.',
    no_company: 'Tu n’as pas encore d’entreprise.',
  };
  return interaction.reply(privateReply(messages[res.status] ?? 'Le réglage a échoué. Réessaie.', [backToHome()]));
}

async function onTreasurySubmit(interaction, cfg) {
  const amount = parseAmount(interaction.fields.getTextInputValue('amount'));
  if (!amount || amount > AMOUNT_CAP) return interaction.reply(privateReply('Montant invalide.'));
  const res = await store.economyTreasuryWithdraw(interaction.guild.id, interaction.user.id, amount);
  const messages = {
    ok: `💰 **${formatMoney(amount, cfg)}** versés sur ton compte. Ton solde est de ${formatMoney(res.balance, cfg)}.`,
    funds: `Trésorerie insuffisante : ${formatMoney(res.treasury ?? 0, cfg)} disponibles.`,
    invalid: 'Montant invalide.',
    no_company: 'Tu n’as pas encore d’entreprise.',
    not_started: 'Ouvre d’abord ton compte avec /play.',
  };
  return interaction.reply(privateReply(messages[res.status] ?? 'Le retrait a échoué. Réessaie.', [backToHome()]));
}

async function onDepositSubmit(interaction, cfg) {
  const amount = parseAmount(interaction.fields.getTextInputValue('amount'));
  if (!amount || amount > AMOUNT_CAP) return interaction.reply(privateReply('Montant invalide.'));
  const res = await store.economyDeposit(interaction.guild.id, interaction.user.id, amount);
  const messages = {
    ok: `🔒 **${formatMoney(amount, cfg)}** déposés. Ton coffre contient ${formatMoney(res.stored, cfg)}, à l’abri des voleurs.`,
    not_subscribed: 'Abonne-toi d’abord à une banque.',
    invalid: 'Montant invalide.',
    not_started: 'Ouvre d’abord ton compte avec /play.',
    funds: `Solde insuffisant : tu as ${formatMoney(res.balance ?? 0, cfg)} sur toi.`,
    over_plan: `Ton abonnement limite ton coffre à ${formatMoney(res.limit, cfg)} (il contient ${formatMoney(res.stored, cfg)}).`,
    bank_full: 'Cette banque ne peut plus rien stocker pour l’instant.',
  };
  return interaction.reply(privateReply(messages[res.status] ?? 'Le dépôt a échoué. Réessaie.', [backToHome()]));
}

async function onWithdrawSubmit(interaction, cfg) {
  const amount = parseAmount(interaction.fields.getTextInputValue('amount'));
  if (!amount || amount > AMOUNT_CAP) return interaction.reply(privateReply('Montant invalide.'));
  const res = await store.economyWithdraw(interaction.guild.id, interaction.user.id, amount);
  const messages = {
    ok: `🔓 **${formatMoney(amount, cfg)}** retirés vers ton solde (${formatMoney(res.balance, cfg)}).`,
    not_found: 'Tu n’as pas de coffre.',
    invalid: 'Montant invalide.',
    funds: `Ton coffre ne contient que ${formatMoney(res.stored ?? 0, cfg)}.`,
    not_started: 'Ouvre d’abord ton compte avec /play.',
  };
  return interaction.reply(privateReply(messages[res.status] ?? 'Le retrait a échoué. Réessaie.', [backToHome()]));
}

// ---------------------------------------------------------------------------
// Routage : customId « eco:co:… » (boutons, menus et formulaires)
// ---------------------------------------------------------------------------

async function handleInteraction(interaction, cfg) {
  const [, , a, b] = String(interaction.customId ?? '').split(':');
  if (interaction.isModalSubmit?.()) {
    if (a === 'create' && b === 'modal') return onCreateSubmit(interaction, cfg, String(interaction.customId).split(':')[4]);
    if (a === 'plan' && b === 'add') return onPlanAddSubmit(interaction, cfg);
    if (a === 'cap') return onCapacitySubmit(interaction, cfg);
    if (a === 'tre') return onTreasurySubmit(interaction, cfg);
    if (a === 'dep') return onDepositSubmit(interaction, cfg);
    if (a === 'wd') return onWithdrawSubmit(interaction, cfg);
    return;
  }
  if (interaction.isStringSelectMenu?.()) {
    if (a === 'kind') return onKindPick(interaction);
    if (a === 'pick') return onSubscribePick(interaction, cfg);
    if (a === 'plan' && b === 'del') return onPlanDelPick(interaction, cfg);
    return;
  }
  switch (a) {
    case 'home':
      return onHome(interaction, cfg);
    case 'mine':
      return onMine(interaction, cfg);
    case 'create':
      return onCreate(interaction, cfg);
    case 'plan':
      return b === 'add' ? onPlanAdd(interaction) : onPlanDel(interaction, cfg);
    case 'cap':
      return onCapacity(interaction, cfg);
    case 'tre':
      return onTreasury(interaction, cfg);
    case 'dep':
      return onDeposit(interaction, cfg);
    case 'wd':
      return onWithdraw(interaction, cfg);
    case 'unsub':
      return onUnsubscribe(interaction, cfg);
    default:
      return;
  }
}

module.exports = { COMPANY_KINDS, MAX_PLANS, homeView, handleInteraction };
