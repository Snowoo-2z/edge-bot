// Tests du module Économie (Edge Dollar, $) : montants, /play public, tableau de bord, /daily, emprunts, /config.
// Les appels Supabase sont remplacés par des fonctions en mémoire (store.*).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const economy = require('../src/modules/economy');
const validate = require('../src/dashboard/validate');

const G = '830000000000000001';
const U = '851000000000000001';

// Stubs : réglages, comptes, banque et emprunts en mémoire (pas d'écriture Supabase pendant les tests).
const configs = new Map();
store.getModuleConfig = (g, m, defaults) => ({ ...structuredClone(defaults), ...(configs.get(`${g}:${m}`) ?? {}) });
store.updateModuleConfig = (g, m, cfg) => {
  configs.set(`${g}:${m}`, structuredClone(cfg));
  return cfg;
};

let account = null;
let loan = null;
let reserve = 300000;
let startCalls = [];
let bankFundCalls = [];
let dailyResult = null;
let dailyArgs = null;
let rankValue = 1;
let borrowResult = null;
let borrowArgs = null;
let repayResult = null;
let repayArgs = null;

store.getEconomyAccount = async () => (account ? { ...account } : null);
store.economyStart = async (g, u, amount) => {
  startCalls.push({ g, u, amount });
  if (account?.started) return { status: 'already', balance: account.balance };
  account = { started: true, balance: amount, daily_streak: 0, last_daily: null };
  return { status: 'ok', amount, balance: amount };
};
store.economyDaily = async (g, u, args) => {
  dailyArgs = args;
  return dailyResult;
};
store.economyRank = async () => rankValue;
store.economyBankFund = async (g, initial) => {
  bankFundCalls.push(initial);
  return { reserve };
};
store.economyBankReserve = async () => reserve;
store.economyOpenLoan = async () => (loan ? { ...loan } : null);
store.economyBorrow = async (g, u, args) => {
  borrowArgs = args;
  return borrowResult;
};
store.economyRepay = async (g, u, amount) => {
  repayArgs = { amount };
  return repayResult;
};
store.economyTop = async () => [];

// Faux objet d'interaction : enregistre ce que le bot renvoie.
function fake({ customId, commandName, modal = false, values = {} } = {}) {
  const log = { replies: [], updates: [], edits: [], modals: [], deferred: 0 };
  return {
    log,
    customId,
    commandName,
    guild: { id: G, members: { fetch: async () => new Map() } },
    user: { id: U, username: 'lea', displayName: 'Léa', displayAvatarURL: () => null },
    isModalSubmit: () => modal,
    fields: { getTextInputValue: (k) => values[k] ?? '' },
    reply: async (p) => {
      log.replies.push(p);
      return p;
    },
    update: async (p) => {
      log.updates.push(p);
      return p;
    },
    showModal: async (m) => {
      log.modals.push(m);
      return m;
    },
    deferUpdate: async () => {
      log.deferred += 1;
    },
    deferReply: async () => {
      log.deferred += 1;
    },
    editReply: async (p) => {
      log.edits.push(p);
      return p;
    },
  };
}

// Texte de la première carte d'une réponse.
const textOf = (p) => p.embeds?.[0]?.data?.description ?? '';
// Boutons d'une réponse : identifiant, libellé, style.
const buttonsOf = (p) =>
  (p.components ?? []).flatMap((r) => r.toJSON().components.map((c) => ({ id: c.custom_id, label: c.label, style: c.style })));
const buttonIds = (p) => buttonsOf(p).map((b) => b.id);
// Champs de la carte (valeurs).
const fieldValues = (p) => (p.embeds?.[0]?.data?.fields ?? []).map((f) => f.value);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const STYLE_PRIMARY = 1;
const STYLE_DANGER = 4;

function enable(extra = {}) {
  store.updateModuleConfig(G, economy.ID, { ...structuredClone(economy.DEFAULTS), enabled: true, ...extra });
}

beforeEach(() => {
  account = null;
  loan = null;
  reserve = 300000;
  startCalls = [];
  bankFundCalls = [];
  dailyResult = null;
  dailyArgs = null;
  rankValue = 1;
  borrowResult = null;
  borrowArgs = null;
  repayResult = null;
  repayArgs = null;
  economy.setFrameDelay(0);
  configs.clear();
});

// ---------------------------------------------------------------------------
// Montants et règles
// ---------------------------------------------------------------------------

test('montants : espaces entre les milliers et symbole après le montant', () => {
  assert.equal(economy.formatMoney(1250, { symbol: '$' }), '1\u00a0250\u00a0$');
  assert.equal(economy.formatMoney(100, { symbol: '$' }), '100\u00a0$');
  assert.equal(economy.formatMoney(1234567, { symbol: '$' }), '1\u00a0234\u00a0567\u00a0$');
});

test('solde de départ : tirage entre les bornes, bornes incluses', () => {
  const seen = new Set();
  for (let k = 0; k < 500; k++) {
    const v = economy.drawStart({ startMin: 100, startMax: 500 });
    assert.ok(v >= 100 && v <= 500, `hors bornes : ${v}`);
    seen.add(v);
  }
  assert.ok(seen.size > 50, 'le tirage varie');
  assert.equal(economy.drawStart({ startMin: 42, startMax: 42 }), 42);
});

test('saisie et intérêts : espaces et symbole tolérés, intérêts arrondis au-dessus', () => {
  assert.equal(economy.parseAmount('2 500'), 2500);
  assert.equal(economy.parseAmount('$1000'), 1000);
  assert.equal(economy.parseAmount('2\u00a0500'), 2500);
  assert.equal(economy.parseAmount('abc'), null);
  assert.equal(economy.parseAmount('0'), null);
  assert.equal(economy.parseAmount('-5'), null);
  assert.equal(economy.loanTotal(10000, 10), 11000);
  assert.equal(economy.loanTotal(333, 10), 367);
});

// ---------------------------------------------------------------------------
// /play : panneau public
// ---------------------------------------------------------------------------

test('/play : panneau public (visible de tous), banque ouverte avec son montant initial', async () => {
  enable();
  const it = fake({ commandName: 'play' });
  await economy.handleCommand(it);
  const p = it.log.replies[0];
  assert.equal(p.flags, undefined, 'pas d’indicateur « privé » : visible de tous');
  assert.deepEqual(buttonIds(p), ['eco:open']);
  assert.deepEqual(bankFundCalls, [300000]);
  assert.ok(fieldValues(p).some((v) => v.includes('300\u00a0000')), 'la banque est affichée');
});

test('ouvrir mon compte sans compte : présentation privée avec le bouton de départ', async () => {
  enable();
  const it = fake({ customId: 'eco:open' });
  await economy.handleInteraction(it);
  const p = it.log.replies[0];
  assert.match(textOf(p), /Bienvenue dans l’économie/);
  assert.deepEqual(buttonIds(p), ['eco:start']);
  assert.ok(p.flags & 64, 'message privé');
});

// ---------------------------------------------------------------------------
// Solde de départ et tableau de bord
// ---------------------------------------------------------------------------

test('solde de départ : animé, versé une seule fois, puis tableau de bord', async () => {
  enable();
  const start = fake({ customId: 'eco:start' });
  await economy.handleInteraction(start);
  assert.equal(start.log.deferred, 1);
  assert.equal(start.log.edits.length, 4, 'trois images puis le résultat');
  assert.deepEqual(start.log.edits[0].components, [], 'le bouton disparaît pendant le tirage');
  const final = start.log.edits.at(-1);
  assert.match(textOf(final), /Bienvenue ! Tu reçois/);
  assert.deepEqual(buttonIds(final), ['eco:daily', 'eco:profile', 'eco:borrow']);
  assert.equal(startCalls.length, 1);
  const amount = startCalls[0].amount;
  assert.ok(amount >= 100 && amount <= 500);

  // Deuxième clic : pas de nouveau versement.
  const again = fake({ customId: 'eco:start' });
  await economy.handleInteraction(again);
  assert.equal(startCalls.length, 1, 'aucun second versement');
  assert.match(textOf(again.log.updates[0]), /déjà reçu/);
});

test('tableau de bord : solde, rang, série, banque et boutons ; récompense bleue si disponible', async () => {
  enable();
  account = { started: true, balance: 730, daily_streak: 4, last_daily: null };
  rankValue = 3;
  const it = fake({ customId: 'eco:open' });
  await economy.handleInteraction(it);
  const p = it.log.replies[0];
  assert.ok(p.flags & 64, 'tableau de bord privé');
  const daily = buttonsOf(p).find((b) => b.id === 'eco:daily');
  assert.equal(daily.label, 'Récompense quotidienne');
  assert.equal(daily.style, STYLE_PRIMARY);
  const fields = fieldValues(p);
  assert.ok(fields.includes('730\u00a0$'));
  assert.ok(fields.includes('#3 sur le serveur'));
  assert.ok(fields.includes('4 jour(s)'));
  assert.ok(buttonIds(p).includes('eco:borrow'));
});

test('récompense déjà prise : bouton rouge « déjà récupérée »', async () => {
  enable();
  account = { started: true, balance: 730, daily_streak: 2, last_daily: new Date().toISOString() };
  const it = fake({ customId: 'eco:open' });
  await economy.handleInteraction(it);
  const daily = buttonsOf(it.log.replies[0]).find((b) => b.id === 'eco:daily');
  assert.equal(daily.label, 'Récompense quotidienne déjà récupérée');
  assert.equal(daily.style, STYLE_DANGER);
});

test('bouton quotidien : mise à jour du tableau de bord sur place (rouge après le passage)', async () => {
  enable();
  account = { started: true, balance: 300, daily_streak: 2, last_daily: null };
  dailyResult = { status: 'ok', amount: 120, streak: 3, balance: 420 };
  const it = fake({ customId: 'eco:daily' });
  // Après le passage, le compte porte la date du jour : le bouton doit devenir rouge.
  store.economyDaily = async (g, u, args) => {
    dailyArgs = args;
    account = { ...account, balance: 420, daily_streak: 3, last_daily: new Date().toISOString() };
    return dailyResult;
  };
  await economy.handleInteraction(it);
  assert.equal(it.log.updates.length, 1, 'le tableau de bord est mis à jour');
  const p = it.log.updates[0];
  assert.match(textOf(p), /\+120\u00a0\$/);
  assert.equal(buttonsOf(p).find((b) => b.id === 'eco:daily').style, STYLE_DANGER);
  assert.deepEqual(dailyArgs, { base: 100, bonus: 10, cap: 100, cooldownHours: 22, windowHours: 48 });
});

test('/daily (commande) : réponse privée, sans toucher au tableau de bord', async () => {
  enable({ dailyAmount: 120, dailyStreakBonus: 15, dailyStreakMax: 60 });
  account = { started: true, balance: 300, daily_streak: 2, last_daily: null };
  dailyResult = { status: 'ok', amount: 135, streak: 3, balance: 435 };
  const it = fake({ commandName: 'daily' });
  await economy.handleCommand(it);
  assert.deepEqual(dailyArgs, { base: 120, bonus: 15, cap: 60, cooldownHours: 22, windowHours: 48 });
  assert.match(textOf(it.log.replies[0]), /\+135\u00a0\$/);
  assert.ok(it.log.replies[0].flags & 64);
});

test('/daily : passage déjà fait → repère Discord de la prochaine fois', async () => {
  enable();
  account = { started: true, balance: 300, daily_streak: 2, last_daily: null };
  dailyResult = { status: 'cooldown', next_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString() };
  const it = fake({ commandName: 'daily' });
  await economy.handleCommand(it);
  assert.match(textOf(it.log.replies[0]), /Reviens <t:\d+:R>/);
});

test('/profile : carte PNG privée ; sans compte, message pour lancer /play', async () => {
  enable();
  account = { started: true, balance: 900, daily_streak: 1, last_daily: new Date().toISOString() };
  rankValue = 2;
  const it = fake({ commandName: 'profile' });
  await economy.handleCommand(it);
  assert.equal(it.log.deferred, 1);
  const file = it.log.edits[0].files[0];
  assert.equal(file.name, 'profil.png');
  assert.deepEqual([...file.attachment.subarray(0, 4)], PNG_MAGIC);

  account = null;
  const none = fake({ commandName: 'profile' });
  await economy.handleCommand(none);
  assert.match(textOf(none.log.edits[0]), /\/play/);
});

test('module désactivé : commandes refusées avec un message clair', async () => {
  const it = fake({ commandName: 'play' });
  await economy.handleCommand(it);
  assert.match(textOf(it.log.replies[0]), /pas activée/);
  assert.equal(bankFundCalls.length, 0, 'la banque n’est pas ouverte quand le module est désactivé');
});

// ---------------------------------------------------------------------------
// Emprunts
// ---------------------------------------------------------------------------

test('emprunter : formulaire, puis emprunt accepté avec intérêts', async () => {
  enable();
  account = { started: true, balance: 300, daily_streak: 0, last_daily: null };
  const open = fake({ customId: 'eco:borrow' });
  await economy.handleInteraction(open);
  assert.equal(open.log.modals.length, 1);
  assert.equal(open.log.modals[0].data.custom_id, 'eco:borrow:modal');

  borrowResult = { status: 'ok', balance: 2800, total_due: 2750, due_at: new Date(Date.now() + 7 * 86400e3).toISOString() };
  const submit = fake({ customId: 'eco:borrow:modal', modal: true, values: { amount: '2 500' } });
  await economy.handleInteraction(submit);
  assert.deepEqual(borrowArgs, { amount: 2500, total: 2750, max: 10000, days: 7 });
  const text = textOf(submit.log.replies[0]);
  assert.match(text, /Emprunt accepté/);
  assert.match(text, /2\u00a0750\u00a0\$/, 'le montant à rembourser est affiché');
});

test('emprunter : refus clairs (montant hors limite, emprunt déjà ouvert, banque vide)', async () => {
  enable();
  account = { started: true, balance: 300, daily_streak: 0, last_daily: null };

  const tooBig = fake({ customId: 'eco:borrow:modal', modal: true, values: { amount: '50000' } });
  await economy.handleInteraction(tooBig);
  assert.match(textOf(tooBig.log.replies[0]), /entre 1 et/);
  assert.equal(borrowArgs, null, 'pas d’appel à la base pour un montant invalide');

  borrowResult = { status: 'open_loan' };
  const dup = fake({ customId: 'eco:borrow:modal', modal: true, values: { amount: '100' } });
  await economy.handleInteraction(dup);
  assert.match(textOf(dup.log.replies[0]), /déjà un emprunt/);

  borrowResult = { status: 'bank_short', reserve: 40 };
  const short = fake({ customId: 'eco:borrow:modal', modal: true, values: { amount: '1000' } });
  await economy.handleInteraction(short);
  assert.match(textOf(short.log.replies[0]), /ne peut prêter que/);
});

test('emprunt en cours : le bouton propose de rembourser, avec le reste à payer', async () => {
  enable();
  account = { started: true, balance: 2800, daily_streak: 0, last_daily: null };
  loan = { principal: 2500, total_due: 2750, repaid: 500, due_at: new Date(Date.now() + 86400e3).toISOString() };
  const it = fake({ customId: 'eco:open' });
  await economy.handleInteraction(it);
  const p = it.log.replies[0];
  assert.ok(buttonIds(p).includes('eco:repay'));
  assert.ok(fieldValues(p).some((v) => v.includes('2\u00a0250\u00a0$')), 'reste à rembourser affiché');

  const form = fake({ customId: 'eco:repay' });
  await economy.handleInteraction(form);
  assert.equal(form.log.modals[0].data.custom_id, 'eco:repay:modal');
});

test('rembourser : partiel puis solde remboursé ; solde insuffisant refusé', async () => {
  enable();
  account = { started: true, balance: 2800, daily_streak: 0, last_daily: null };
  loan = { principal: 2500, total_due: 2750, repaid: 0, due_at: new Date(Date.now() + 86400e3).toISOString() };

  repayResult = { status: 'ok', paid: 1000, remaining: 1750, balance: 1800 };
  const partial = fake({ customId: 'eco:repay:modal', modal: true, values: { amount: '1000' } });
  await economy.handleInteraction(partial);
  assert.deepEqual(repayArgs, { amount: 1000 });
  assert.match(textOf(partial.log.replies[0]), /Reste à payer/);

  repayResult = { status: 'ok', paid: 1750, remaining: 0, balance: 50 };
  const full = fake({ customId: 'eco:repay:modal', modal: true, values: { amount: '99999' } });
  await economy.handleInteraction(full);
  assert.match(textOf(full.log.replies[0]), /entièrement remboursé/);

  repayResult = { status: 'funds', balance: 10 };
  const broke = fake({ customId: 'eco:repay:modal', modal: true, values: { amount: '500' } });
  await economy.handleInteraction(broke);
  assert.match(textOf(broke.log.replies[0]), /Solde insuffisant/);
});

test('rembourser sans emprunt : message clair, pas de formulaire', async () => {
  enable();
  account = { started: true, balance: 300, daily_streak: 0, last_daily: null };
  const it = fake({ customId: 'eco:repay' });
  await economy.handleInteraction(it);
  assert.equal(it.log.modals.length, 0);
  assert.match(textOf(it.log.replies[0]), /aucun emprunt/);
});

// ---------------------------------------------------------------------------
// Classement et /config
// ---------------------------------------------------------------------------

test('/leaderboard : classement Edge Dollar en PNG, du plus riche au moins riche', async () => {
  enable();
  const seen = {};
  store.economyTop = async (g, limit) => {
    seen.limit = limit;
    return [
      { user_id: '851000000000000009', balance: 12450 },
      { user_id: '851000000000000001', balance: 9800 },
    ];
  };
  const it = fake({ commandName: 'leaderboard' });
  it.guild.members.fetch = async () => new Map([['851000000000000009', { displayName: 'Max' }]]);
  await economy.handleLeaderboard(it);
  assert.equal(seen.limit, 10);
  const file = it.log.edits[0].files[0];
  assert.equal(file.name, 'classement.png');
  assert.deepEqual([...file.attachment.subarray(0, 4)], PNG_MAGIC);
});

test('/leaderboard : module désactivé → renvoie vers /leaderboard type:XP', async () => {
  const it = fake({ commandName: 'leaderboard' });
  await economy.handleLeaderboard(it);
  assert.match(textOf(it.log.replies[0]), /type:XP/);
});

test('/config : bascule du module (activation seulement)', async () => {
  const it = fake({ customId: 'cfg:economy:toggle:enabled' });
  await economy.handleComponent(it);
  assert.equal(it.log.updates.length, 1);
  assert.equal(store.getModuleConfig(G, economy.ID, economy.DEFAULTS).enabled, true);
});

test('réglages du tableau de bord : bornes, cohérence du solde de départ, banque et emprunts', () => {
  const ok = validate.sanitizeEconomy(null, { currencyName: 'Edge Dollar', symbol: '$', startMin: 100, startMax: 500 }, {});
  assert.equal(ok.symbol, '$');
  assert.throws(() => validate.sanitizeEconomy(null, { startMin: 600 }, { startMax: 500 }), /minimum ne peut pas dépasser/);
  assert.throws(() => validate.sanitizeEconomy(null, { symbol: '   ' }, {}), /Symbole/);
  assert.throws(() => validate.sanitizeEconomy(null, { dailyAmount: -1 }, {}), /Récompense quotidienne/);
  assert.deepEqual(
    validate.sanitizeEconomy(null, { bankInitial: 300000, loanMax: 10000, loanRatePercent: 10, loanDays: 7 }, {}),
    { bankInitial: 300000, loanMax: 10000, loanRatePercent: 10, loanDays: 7 },
  );
  assert.throws(() => validate.sanitizeEconomy(null, { loanRatePercent: 150 }, {}), /Intérêts/);
  assert.throws(() => validate.sanitizeEconomy(null, { loanDays: 0 }, {}), /Délai/);
});
