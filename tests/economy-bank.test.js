// Tests : entreprises (banques), coffres, abonnements, vols (/rob) et prélèvement quotidien.
// Les fonctions SQL sont remplacées par des bouchons (store.*) ; les règles SQL sont vérifiées à part (voir README).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const economy = require('../src/modules/economy');
const companies = require('../src/modules/economy-companies');
const { robSettings } = require('../src/modules/economy-rob');
const validate = require('../src/dashboard/validate');

const G = '830000000000000001';
const U = '851000000000000001'; // patron / membre qui agit
const V = '851000000000000002'; // victime

// Réglages en mémoire.
const configs = new Map();
store.getModuleConfig = (g, m, defaults) => ({ ...structuredClone(defaults), ...(configs.get(`${g}:${m}`) ?? {}) });
store.updateModuleConfig = (g, m, cfg) => {
  configs.set(`${g}:${m}`, structuredClone(cfg));
  return cfg;
};

// État simulé de la base.
let account = null;
let companiesList = [];
let membership = null;
const calls = {};
const answers = {};
const record = (name, args) => {
  (calls[name] ??= []).push(args);
  return answers[name];
};
const callsOf = (name) => calls[name] ?? [];

store.getEconomyAccount = async () => (account ? { ...account } : null);
store.economyCompanies = async () => structuredClone(companiesList);
store.economyMemberBank = async () => (membership ? { ...membership } : null);
store.economyBankReserve = async () => 300000;
store.economyBankFund = async () => ({ reserve: 300000 });
store.economyRank = async () => 1;
store.economyOpenLoan = async () => null;
store.economyTop = async () => [];
store.economyStart = async () => ({ status: 'ok' });
store.economyDaily = async () => ({ status: 'ok' });
store.economyCompanyCreate = async (...a) => record('create', a);
store.economyPlanAdd = async (...a) => record('planAdd', a);
store.economyPlanRemove = async (...a) => record('planRemove', a);
store.economyCompanyCapacity = async (...a) => record('capacity', a);
store.economyTreasuryWithdraw = async (...a) => record('treasury', a);
store.economySubscribe = async (...a) => record('subscribe', a);
store.economyUnsubscribe = async (...a) => record('unsubscribe', a);
store.economyDeposit = async (...a) => record('deposit', a);
store.economyWithdraw = async (...a) => record('withdraw', a);
store.economyRob = async (...a) => record('rob', a);
store.economyBankDaily = async (...a) => record('daily', a);

function fake({ customId, commandName, modal = false, values = {}, select = false, target = null, userId = U } = {}) {
  const log = { replies: [], updates: [], edits: [], modals: [] };
  return {
    log,
    customId,
    commandName,
    values: values.list ?? [],
    guild: { id: G, members: { fetch: async () => new Map() } },
    user: { id: userId, username: 'lea', displayName: 'Léa', displayAvatarURL: () => null },
    isModalSubmit: () => modal,
    isStringSelectMenu: () => select,
    fields: { getTextInputValue: (k) => values[k] ?? '' },
    options: { getUser: () => target },
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
    deferReply: async () => {},
    deferUpdate: async () => {},
    editReply: async (p) => {
      log.edits.push(p);
      return p;
    },
  };
}

const textOf = (p) => p.embeds?.[0]?.data?.description ?? '';
const rowsOf = (p) => (p.components ?? []).map((r) => r.toJSON().components);
const buttonIds = (p) => rowsOf(p).flat().filter((c) => c.type === 2).map((c) => c.custom_id);
const selectIds = (p) => rowsOf(p).flat().filter((c) => c.type === 3).map((c) => c.custom_id);
const firstMessage = (it) => it.log.replies[0] ?? it.log.updates[0];
const enabled = () => configs.set(`${G}:${economy.ID}`, { ...structuredClone(economy.DEFAULTS), enabled: true });

const bankCompany = (over = {}) => ({
  id: 7,
  kind: 'bank',
  name: 'Banque du Port',
  owner_id: U,
  treasury: 500,
  max_storage: 100000,
  stored: 1000,
  subscribers: 2,
  plans: [{ id: 11, name: 'Coffre Or', daily_price: 50, storage: 5000 }],
  ...over,
});

beforeEach(() => {
  configs.clear();
  account = { started: true, balance: 900, daily_streak: 0, last_daily: null };
  companiesList = [];
  membership = null;
  for (const k of Object.keys(calls)) delete calls[k];
  for (const k of Object.keys(answers)) delete answers[k];
  economy.setFrameDelay(0);
  enabled();
});

// ---------------------------------------------------------------------------
// Vue « Entreprises »
// ---------------------------------------------------------------------------

test('entreprises : sans entreprise ni coffre, on propose de créer et de s’abonner', async () => {
  companiesList = [bankCompany({ owner_id: V })];
  const it = fake({ customId: 'eco:co:home' });
  await companies.handleInteraction(it, economy.DEFAULTS);
  const p = firstMessage(it);
  const fields = Object.fromEntries(p.embeds[0].data.fields.map((f) => [f.name, f.value]));
  assert.match(fields['Ton coffre'], /Aucun coffre/);
  assert.match(fields['Ton entreprise'], /Aucune\. Crée la tienne/);
  assert.match(fields['Abonnements disponibles'], /Coffre Or\*\* · Banque du Port/);
  assert.deepEqual(buttonIds(p), ['eco:co:create', 'eco:open']);
  assert.deepEqual(selectIds(p), ['eco:co:pick']);
});

test('entreprises : le hub affiche le coffre protégé et le bouton Entreprises', async () => {
  membership = { company_id: 7, plan_id: 11, stored: 800 };
  companiesList = [bankCompany()];
  const it = fake({ customId: 'eco:open' });
  await economy.handleInteraction(it);
  const p = it.log.replies[0];
  assert.ok(p.embeds[0].data.fields.some((f) => f.name.includes('À l’abri') && f.value.includes('800')));
  assert.ok(buttonIds(p).includes('eco:co:home'));
});

// ---------------------------------------------------------------------------
// Création d’entreprise
// ---------------------------------------------------------------------------

test('créer : refusé sans compte, puis choix du type et formulaire', async () => {
  account = null;
  const none = fake({ customId: 'eco:co:create' });
  await companies.handleInteraction(none, economy.DEFAULTS);
  assert.match(textOf(none.log.replies[0]), /\/play/);

  account = { started: true, balance: 900, daily_streak: 0, last_daily: null };
  const it = fake({ customId: 'eco:co:create' });
  await companies.handleInteraction(it, economy.DEFAULTS);
  assert.deepEqual(selectIds(it.log.updates[0]), ['eco:co:kind']);

  const pick = fake({ customId: 'eco:co:kind', select: true, values: { list: ['bank'] } });
  await companies.handleInteraction(pick, economy.DEFAULTS);
  assert.equal(pick.log.modals[0].data.custom_id, 'eco:co:create:modal:bank');
});

test('créer : nom et capacité validés, puis réponses selon le résultat', async () => {
  const bad = fake({ customId: 'eco:co:create:modal:bank', modal: true, values: { name: '   ', max: '1000' } });
  await companies.handleInteraction(bad, economy.DEFAULTS);
  assert.match(textOf(bad.log.replies[0]), /Nom invalide/);
  assert.equal(callsOf('create').length, 0);

  answers.create = { status: 'ok', id: 9 };
  const ok = fake({ customId: 'eco:co:create:modal:bank', modal: true, values: { name: '  Banque du Port ', max: '1 000 000' } });
  await companies.handleInteraction(ok, economy.DEFAULTS);
  assert.deepEqual(callsOf('create')[0], [G, U, { kind: 'bank', name: 'Banque du Port', max: 1000000 }]);
  assert.match(textOf(ok.log.replies[0]), /est ouverte/);

  answers.create = { status: 'name_taken' };
  const taken = fake({ customId: 'eco:co:create:modal:bank', modal: true, values: { name: 'Doublon', max: '1000' } });
  await companies.handleInteraction(taken, economy.DEFAULTS);
  assert.match(textOf(taken.log.replies[0]), /déjà pris/);
});

// ---------------------------------------------------------------------------
// Abonnements
// ---------------------------------------------------------------------------

test('ajouter un abonnement : formulaire, limite de 5, prix gratuit accepté', async () => {
  companiesList = [bankCompany({ owner_id: U })];
  const open = fake({ customId: 'eco:co:plan:add' });
  await companies.handleInteraction(open, economy.DEFAULTS);
  assert.equal(open.log.modals[0].data.custom_id, 'eco:co:plan:add:modal');

  answers.planAdd = { status: 'ok', id: 12 };
  const free = fake({ customId: 'eco:co:plan:add:modal', modal: true, values: { name: 'Gratuit', price: '0', storage: '500' } });
  await companies.handleInteraction(free, economy.DEFAULTS);
  assert.deepEqual(callsOf('planAdd')[0], [G, U, { name: 'Gratuit', price: 0, storage: 500 }]);
  assert.match(textOf(free.log.replies[0]), /ajouté/);

  answers.planAdd = { status: 'too_many', max: 5 };
  const full = fake({ customId: 'eco:co:plan:add:modal', modal: true, values: { name: 'Six', price: '5', storage: '5' } });
  await companies.handleInteraction(full, economy.DEFAULTS);
  assert.match(textOf(full.log.replies[0]), /déjà 5 abonnements/);

  const badPrice = fake({ customId: 'eco:co:plan:add:modal', modal: true, values: { name: 'X', price: '-5', storage: '5' } });
  const before = callsOf('planAdd').length;
  await companies.handleInteraction(badPrice, economy.DEFAULTS);
  assert.match(textOf(badPrice.log.replies[0]), /Prix par jour invalide/);
  assert.equal(callsOf('planAdd').length, before);
});

test('ajouter un abonnement : impossible sans entreprise, et refus à 5 abonnements dans le formulaire', async () => {
  const none = fake({ customId: 'eco:co:plan:add' });
  await companies.handleInteraction(none, economy.DEFAULTS);
  assert.match(textOf(none.log.replies[0]), /pas encore d’entreprise/);

  companiesList = [bankCompany({ owner_id: U, plans: [1, 2, 3, 4, 5].map((id) => ({ id, name: `P${id}`, daily_price: 1, storage: 10 })) })];
  const full = fake({ customId: 'eco:co:plan:add' });
  await companies.handleInteraction(full, economy.DEFAULTS);
  assert.match(textOf(full.log.replies[0]), /déjà 5 abonnements/);
  assert.equal(full.log.modals.length, 0);
});

test('supprimer un abonnement : menu de choix puis suppression', async () => {
  companiesList = [bankCompany({ owner_id: U })];
  const open = fake({ customId: 'eco:co:plan:del' });
  await companies.handleInteraction(open, economy.DEFAULTS);
  assert.deepEqual(selectIds(open.log.updates[0]), ['eco:co:plan:del:pick']);

  answers.planRemove = { status: 'ok' };
  const pick = fake({ customId: 'eco:co:plan:del:pick', select: true, values: { list: ['11'] } });
  await companies.handleInteraction(pick, economy.DEFAULTS);
  assert.deepEqual(callsOf('planRemove')[0], [G, U, 11]);
  assert.match(textOf(pick.log.replies[0]), /Abonnement supprimé/);
});

test('s’abonner : réussite, banque différente avec de l’argent, plan disparu', async () => {
  companiesList = [bankCompany()];
  answers.subscribe = { status: 'ok', company_id: 7, plan_id: 11 };
  const ok = fake({ customId: 'eco:co:pick', select: true, values: { list: ['11'] } });
  await companies.handleInteraction(ok, economy.DEFAULTS);
  assert.deepEqual(callsOf('subscribe')[0], [G, U, 11]);
  assert.match(textOf(ok.log.updates[0]), /Abonnement souscrit/);

  answers.subscribe = { status: 'other_bank' };
  const other = fake({ customId: 'eco:co:pick', select: true, values: { list: ['11'] } });
  await companies.handleInteraction(other, economy.DEFAULTS);
  assert.match(textOf(other.log.updates[0]), /autre banque/);

  answers.subscribe = { status: 'not_found' };
  const gone = fake({ customId: 'eco:co:pick', select: true, values: { list: ['11'] } });
  await companies.handleInteraction(gone, economy.DEFAULTS);
  assert.match(textOf(gone.log.updates[0]), /n’existe plus/);
});

test('résilier : l’argent reste à la banque et le message le dit', async () => {
  membership = { company_id: 7, plan_id: 11, stored: 300 };
  companiesList = [bankCompany()];
  answers.unsubscribe = { status: 'ok', stored: 300 };
  const it = fake({ customId: 'eco:co:unsub' });
  await companies.handleInteraction(it, economy.DEFAULTS);
  assert.equal(callsOf('unsubscribe').length, 1);
  assert.match(textOf(it.log.updates[0]), /Abonnement résilié\. Ton argent reste à la banque/);
});

// ---------------------------------------------------------------------------
// Coffre : dépôts et retraits
// ---------------------------------------------------------------------------

test('déposer : refusé sans abonnement, puis plafond du plan et banque pleine', async () => {
  const none = fake({ customId: 'eco:co:dep' });
  await companies.handleInteraction(none, economy.DEFAULTS);
  assert.match(textOf(none.log.replies[0]), /Abonne-toi d’abord/);

  membership = { company_id: 7, plan_id: 11, stored: 1000 };
  companiesList = [bankCompany()];
  const open = fake({ customId: 'eco:co:dep' });
  await companies.handleInteraction(open, economy.DEFAULTS);
  assert.equal(open.log.modals[0].data.custom_id, 'eco:co:dep:modal');

  answers.deposit = { status: 'over_plan', limit: 5000, stored: 1000 };
  const over = fake({ customId: 'eco:co:dep:modal', modal: true, values: { amount: '6000' } });
  await companies.handleInteraction(over, economy.DEFAULTS);
  assert.deepEqual(callsOf('deposit')[0], [G, U, 6000]);
  assert.match(textOf(over.log.replies[0]), /limite ton coffre à 5\u00a0000/);

  answers.deposit = { status: 'bank_full' };
  const full = fake({ customId: 'eco:co:dep:modal', modal: true, values: { amount: '10' } });
  await companies.handleInteraction(full, economy.DEFAULTS);
  assert.match(textOf(full.log.replies[0]), /ne peut plus rien stocker/);

  answers.deposit = { status: 'ok', stored: 1200, balance: 700 };
  const ok = fake({ customId: 'eco:co:dep:modal', modal: true, values: { amount: '200' } });
  await companies.handleInteraction(ok, economy.DEFAULTS);
  assert.match(textOf(ok.log.replies[0]), /déposés/);
});

test('retirer : vide refusé, sinon formulaire puis retrait', async () => {
  const empty = fake({ customId: 'eco:co:wd' });
  await companies.handleInteraction(empty, economy.DEFAULTS);
  assert.match(textOf(empty.log.replies[0]), /vide/);

  membership = { company_id: 7, plan_id: null, stored: 300 };
  companiesList = [bankCompany()];
  const open = fake({ customId: 'eco:co:wd' });
  await companies.handleInteraction(open, economy.DEFAULTS);
  assert.equal(open.log.modals[0].data.custom_id, 'eco:co:wd:modal');

  answers.withdraw = { status: 'funds', stored: 300 };
  const short = fake({ customId: 'eco:co:wd:modal', modal: true, values: { amount: '999' } });
  await companies.handleInteraction(short, economy.DEFAULTS);
  assert.match(textOf(short.log.replies[0]), /ne contient que 300/);
});

// ---------------------------------------------------------------------------
// Patron : trésorerie, capacité
// ---------------------------------------------------------------------------

test('patron : trésorerie retirable, capacité modifiable sans passer sous le stock', async () => {
  companiesList = [bankCompany({ owner_id: U, treasury: 0 })];
  const empty = fake({ customId: 'eco:co:tre' });
  await companies.handleInteraction(empty, economy.DEFAULTS);
  assert.match(textOf(empty.log.replies[0]), /trésorerie est vide/);

  companiesList = [bankCompany({ owner_id: U, treasury: 500 })];
  answers.treasury = { status: 'ok', balance: 1100, treasury: 300 };
  const tre = fake({ customId: 'eco:co:tre:modal', modal: true, values: { amount: '200' } });
  await companies.handleInteraction(tre, economy.DEFAULTS);
  assert.deepEqual(callsOf('treasury')[0], [G, U, 200]);
  assert.match(textOf(tre.log.replies[0]), /versés sur ton compte/);

  answers.capacity = { status: 'below_stored', stored: 1000 };
  const cap = fake({ customId: 'eco:co:cap:modal', modal: true, values: { amount: '500' } });
  await companies.handleInteraction(cap, economy.DEFAULTS);
  assert.match(textOf(cap.log.replies[0]), /Impossible : il reste 1\u00a0000/);
});

test('patron : « Gérer mon entreprise » affiche trésorerie, stockage et abonnements', async () => {
  companiesList = [bankCompany({ owner_id: U })];
  const it = fake({ customId: 'eco:co:mine' });
  await companies.handleInteraction(it, economy.DEFAULTS);
  const p = it.log.updates[0];
  assert.ok(buttonIds(p).includes('eco:co:plan:add'));
  assert.ok(buttonIds(p).includes('eco:co:tre'));
  const fields = p.embeds[0].data.fields.map((f) => f.name);
  assert.ok(fields.includes('Trésorerie') && fields.includes('Stockage') && fields.some((n) => n.startsWith('Abonnements')));
});

// ---------------------------------------------------------------------------
// /rob
// ---------------------------------------------------------------------------

const robCmd = (target, extra = {}) => fake({ commandName: 'rob', target, ...extra });

test('/rob : réglages transmis à la base (cadence 3 h, chance 50 %, 20 %, amende 50–100)', async () => {
  answers.rob = { status: 'empty' };
  await economy.handleCommand(robCmd({ id: V, bot: false, username: 'max' }));
  assert.deepEqual(robSettings(economy.DEFAULTS), {
    cooldownHours: 3,
    base: 50,
    ref: 1000,
    slope: 5,
    clamp: 20,
    maxPercent: 20,
    fineMin: 50,
    fineMax: 100,
  });
  assert.equal(callsOf('rob')[0][0], G);
  assert.equal(callsOf('rob')[0][1], U);
  assert.equal(callsOf('rob')[0][2], V);
});

test('/rob : refus avant tout appel (soi-même, bot)', async () => {
  const self = robCmd({ id: U, bot: false });
  await economy.handleCommand(self);
  assert.match(textOf(self.log.replies[0]), /toi-même/);
  const bot = robCmd({ id: V, bot: true });
  await economy.handleCommand(bot);
  assert.match(textOf(bot.log.replies[0]), /bots/);
  assert.equal(callsOf('rob').length, 0);
});

test('/rob : réussite publique avec montant, pourcentage et chance', async () => {
  answers.rob = { status: 'ok', success: true, amount: 300, pct: 6, chance: 53, thief_balance: 1200, victim_balance: 4700 };
  const it = robCmd({ id: V, bot: false, username: 'max' });
  await economy.handleCommand(it);
  const p = it.log.replies[0];
  assert.equal(p.flags, undefined, 'réponse publique');
  assert.match(textOf(p), /a volé \*\*300\u00a0\$\*\* à <@851000000000000002> \(6 % de son solde\)\. Chance de réussite : 53 %/);
});

test('/rob : échec public, amende versée ; amende limitée au solde ; plus rien à verser', async () => {
  answers.rob = { status: 'ok', success: false, fine: 80, paid: 80, chance: 40, thief_balance: 820, victim_balance: 2000 };
  const ok = robCmd({ id: V, bot: false });
  await economy.handleCommand(ok);
  assert.match(textOf(ok.log.replies[0]), /raté son coup et verse \*\*80\u00a0\$\*\*/);

  answers.rob = { status: 'ok', success: false, fine: 100, paid: 30, chance: 40, thief_balance: 0, victim_balance: 2030 };
  const low = robCmd({ id: V, bot: false });
  await economy.handleCommand(low);
  assert.match(textOf(low.log.replies[0]), /limitée à son solde/);

  answers.rob = { status: 'ok', success: false, fine: 60, paid: 0, chance: 40, thief_balance: 0, victim_balance: 2000 };
  const broke = robCmd({ id: V, bot: false });
  await economy.handleCommand(broke);
  assert.match(textOf(broke.log.replies[0]), /n’a plus rien à verser/);
});

test('/rob : cadence, victime vide (argent à la banque), comptes absents', async () => {
  answers.rob = { status: 'cooldown', next_at: new Date(Date.now() + 2 * 3600e3).toISOString() };
  const cd = robCmd({ id: V, bot: false });
  await economy.handleCommand(cd);
  assert.match(textOf(cd.log.replies[0]), /prochain vol <t:\d+:R>/);
  assert.ok(cd.log.replies[0].flags & 64, 'message privé');

  answers.rob = { status: 'empty' };
  const empty = robCmd({ id: V, bot: false });
  await economy.handleCommand(empty);
  assert.match(textOf(empty.log.replies[0]), /à l’abri des voleurs/);

  answers.rob = { status: 'not_started' };
  const thiefNo = robCmd({ id: V, bot: false });
  await economy.handleCommand(thiefNo);
  assert.match(textOf(thiefNo.log.replies[0]), /\/play/);

  answers.rob = { status: 'victim_not_started' };
  const victimNo = robCmd({ id: V, bot: false });
  await economy.handleCommand(victimNo);
  assert.match(textOf(victimNo.log.replies[0]), /pas encore de compte/);
});

// ---------------------------------------------------------------------------
// Prélèvement quotidien
// ---------------------------------------------------------------------------

test('jour civil : Paris, et frais du serveur en points de base', () => {
  assert.equal(economy.parisDay(new Date('2026-10-12T21:30:00Z')), '2026-10-12');
  assert.equal(economy.parisDay(new Date('2026-10-12T22:30:00Z')), '2026-10-13');
  assert.equal(economy.feeBasisPoints({ bankFeePercent: 0.1 }), 10);
  assert.equal(economy.feeBasisPoints({ bankFeePercent: 2.5 }), 250);
});

test('prélèvement : une fois par serveur activé, avec le jour de Paris et les frais configurés', async () => {
  configs.set(`${G}:${economy.ID}`, { ...structuredClone(economy.DEFAULTS), enabled: true, bankFeePercent: 0.1 });
  configs.set(`999:${economy.ID}`, { ...structuredClone(economy.DEFAULTS), enabled: false });
  answers.daily = { status: 'ok', charged: 2, cancelled: 0, server_cut: 5 };
  const client = { guilds: { cache: new Map([[G, { id: G }], ['999', { id: '999' }]]) } };
  await economy.runBankDaily(client, new Date('2026-10-12T22:30:00Z'));
  assert.deepEqual(callsOf('daily'), [[G, '2026-10-13', 10]]);
});

test('prélèvement : un échec sur un serveur n’empêche pas les autres', async () => {
  const other = '830000000000000002';
  configs.set(`${other}:${economy.ID}`, { ...structuredClone(economy.DEFAULTS), enabled: true });
  let calledFor = [];
  const original = store.economyBankDaily;
  store.economyBankDaily = async (g) => {
    calledFor.push(g);
    if (g === G) throw new Error('réseau');
    return { status: 'already' };
  };
  const client = { guilds: { cache: new Map([[G, { id: G }], [other, { id: other }]]) } };
  const errors = console.error;
  console.error = () => {};
  try {
    await economy.runBankDaily(client, new Date('2026-10-12T10:00:00Z'));
  } finally {
    console.error = errors;
    store.economyBankDaily = original;
  }
  assert.deepEqual(calledFor, [G, other]);
});

// ---------------------------------------------------------------------------
// Réglages du tableau de bord
// ---------------------------------------------------------------------------

test('réglages du vol et des frais : bornes et cohérence de l’amende', () => {
  const ok = validate.sanitizeEconomy(null, { robCooldownHours: 3, robSuccessPercent: 50, robMaxPercent: 20, robFailMin: 50, robFailMax: 100, bankFeePercent: 0.123 }, {});
  assert.equal(ok.bankFeePercent, 0.12);
  assert.throws(() => validate.sanitizeEconomy(null, { robCooldownHours: 0 }, {}), /Délai entre deux vols/);
  assert.throws(() => validate.sanitizeEconomy(null, { robSuccessPercent: 0 }, {}), /Chance de réussite/);
  assert.throws(() => validate.sanitizeEconomy(null, { bankFeePercent: 6 }, {}), /Frais du serveur/);
  assert.throws(() => validate.sanitizeEconomy(null, { robFailMin: 200 }, { robFailMax: 100 }), /Amende/);
});

test('entreprises : action inconnue ignorée sans réponse', async () => {
  const it = fake({ customId: 'eco:co:inconnu' });
  await companies.handleInteraction(it, economy.DEFAULTS);
  assert.equal(it.log.replies.length + it.log.updates.length + it.log.modals.length, 0);
});
