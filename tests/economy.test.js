// Tests du module Économie (Edge Dollar, $) : montants, /play, /daily, /profile, /config, validation.
// Les appels Supabase sont remplacés par des fonctions en mémoire (store.*).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const economy = require('../src/modules/economy');
const validate = require('../src/dashboard/validate');

const G = '830000000000000001';
const U = '851000000000000001';

// Stubs : réglages et comptes en mémoire (pas d'écriture Supabase pendant les tests).
const configs = new Map();
store.getModuleConfig = (g, m, defaults) => ({ ...structuredClone(defaults), ...(configs.get(`${g}:${m}`) ?? {}) });
store.updateModuleConfig = (g, m, cfg) => {
  configs.set(`${g}:${m}`, structuredClone(cfg));
  return cfg;
};
let account = null;
let startCalls = [];
let dailyResult = null;
let dailyArgs = null;
let rankValue = 1;

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

// Faux objet d'interaction : enregistre ce que le bot renvoie.
function fake({ customId, commandName } = {}) {
  const log = { replies: [], updates: [], edits: [], deferred: 0 };
  return {
    log,
    customId,
    commandName,
    guild: { id: G },
    user: { id: U, username: 'lea', displayName: 'Léa' },
    reply: async (p) => {
      log.replies.push(p);
      return p;
    },
    update: async (p) => {
      log.updates.push(p);
      return p;
    },
    deferUpdate: async () => {
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
// Identifiants des boutons d'une réponse.
const buttonIds = (p) => (p.components ?? []).flatMap((r) => r.toJSON().components.map((c) => c.custom_id));

function enable(extra = {}) {
  store.updateModuleConfig(G, economy.ID, { ...structuredClone(economy.DEFAULTS), enabled: true, ...extra });
}

beforeEach(() => {
  account = null;
  startCalls = [];
  dailyResult = null;
  dailyArgs = null;
  rankValue = 1;
  economy.setFrameDelay(0);
  configs.clear();
});

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

test('/play sans compte : présentation avec le bouton de départ et les montants', async () => {
  enable();
  const it = fake({ commandName: 'play' });
  await economy.handleCommand(it);
  const p = it.log.replies[0];
  assert.match(textOf(p), /Bienvenue dans l’économie/);
  assert.match(textOf(p), /100\u00a0\$/);
  assert.deepEqual(buttonIds(p), ['eco:start']);
});

test('/play : le solde de départ est tiré, animé, puis versé une seule fois', async () => {
  enable();
  const start = fake({ customId: 'eco:start' });
  await economy.handleInteraction(start);
  assert.equal(start.log.deferred, 1);
  assert.equal(start.log.edits.length, 4, 'trois images puis le résultat');
  assert.deepEqual(start.log.edits[0].components, [], 'le bouton disparaît pendant le tirage');
  const finalText = textOf(start.log.edits.at(-1));
  assert.match(finalText, /Bienvenue ! Tu reçois/);
  assert.equal(startCalls.length, 1);
  const amount = startCalls[0].amount;
  assert.ok(amount >= 100 && amount <= 500);
  assert.match(finalText, new RegExp(`${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0\\$`));

  // Deuxième clic : pas de nouveau tirage, message « déjà reçu ».
  const again = fake({ customId: 'eco:start' });
  await economy.handleInteraction(again);
  assert.equal(startCalls.length, 1, 'aucun second versement');
  assert.equal(again.log.updates.length, 1);
  assert.match(textOf(again.log.updates[0]), /déjà reçu/);
});

test('/play avec compte : tableau de bord (solde, rang, série) et boutons', async () => {
  enable();
  account = { started: true, balance: 730, daily_streak: 4, last_daily: null };
  rankValue = 3;
  const it = fake({ commandName: 'play' });
  await economy.handleCommand(it);
  const p = it.log.replies[0];
  assert.deepEqual(buttonIds(p), ['eco:daily', 'eco:profile']);
  const fields = p.embeds[0].data.fields.map((f) => f.value);
  assert.ok(fields.includes('730\u00a0$'));
  assert.ok(fields.includes('#3 sur le serveur'));
  assert.ok(fields.includes('4 jour(s)'));
});

test('/daily : récompense avec la série, paramètres transmis à la base', async () => {
  enable({ dailyAmount: 120, dailyStreakBonus: 15, dailyStreakMax: 60 });
  account = { started: true, balance: 300, daily_streak: 2, last_daily: null };
  dailyResult = { status: 'ok', amount: 135, streak: 3, balance: 435 };
  const it = fake({ commandName: 'daily' });
  await economy.handleCommand(it);
  assert.deepEqual(dailyArgs, { base: 120, bonus: 15, cap: 60, cooldownHours: 22, windowHours: 48 });
  const text = textOf(it.log.replies[0]);
  assert.match(text, /\+135\u00a0\$/);
  assert.match(text, /Série de \*\*3\*\* jour/);
});

test('/daily : passage déjà fait → repère Discord de la prochaine fois', async () => {
  enable();
  account = { started: true, balance: 300, daily_streak: 2, last_daily: null };
  const next = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  dailyResult = { status: 'cooldown', next_at: next };
  const it = fake({ commandName: 'daily' });
  await economy.handleCommand(it);
  assert.match(textOf(it.log.replies[0]), /Reviens <t:\d+:R>/);
});

test('/daily sans compte : renvoie vers /play', async () => {
  enable();
  dailyResult = { status: 'not_started' };
  const it = fake({ commandName: 'daily' });
  await economy.handleCommand(it);
  assert.match(textOf(it.log.replies[0]), /\/play/);
});

test('/profile : solde, rang et prochaine récompense ; réponse privée', async () => {
  enable();
  account = { started: true, balance: 900, daily_streak: 1, last_daily: new Date().toISOString() };
  rankValue = 2;
  const it = fake({ commandName: 'profile' });
  await economy.handleCommand(it);
  const p = it.log.replies[0];
  assert.equal(p.flags & 64, 64, 'message éphémère (privé)');
  const values = p.embeds[0].data.fields.map((f) => f.value);
  assert.ok(values.includes('900\u00a0$'));
  assert.ok(values.includes('#2'));
  assert.match(values[3], /<t:\d+:R>/, 'prochaine récompense datée');
});

test('/profile sans compte : invitation à lancer /play', async () => {
  enable();
  const it = fake({ commandName: 'profile' });
  await economy.handleCommand(it);
  assert.match(textOf(it.log.replies[0]), /\/play/);
});

test('module désactivé : commandes refusées avec un message clair', async () => {
  // DEFAULTS.enabled est false
  const it = fake({ commandName: 'play' });
  await economy.handleCommand(it);
  assert.match(textOf(it.log.replies[0]), /pas activée/);
  assert.equal(startCalls.length, 0);
});

test('/config : bascule du module (activation seulement)', async () => {
  const it = fake({ customId: 'cfg:economy:toggle:enabled' });
  await economy.handleComponent(it);
  assert.equal(it.log.updates.length, 1);
  const stored = store.getModuleConfig(G, economy.ID, economy.DEFAULTS);
  assert.equal(stored.enabled, true);
});

test('réglages du tableau de bord : bornes et cohérence du solde de départ', () => {
  const ok = validate.sanitizeEconomy(null, { currencyName: 'Edge Dollar', symbol: '$', startMin: 100, startMax: 500 }, {});
  assert.equal(ok.symbol, '$');
  assert.throws(() => validate.sanitizeEconomy(null, { startMin: 600 }, { startMax: 500 }), /minimum ne peut pas dépasser/);
  assert.throws(() => validate.sanitizeEconomy(null, { symbol: '   ' }, {}), /Symbole/);
  assert.throws(() => validate.sanitizeEconomy(null, { dailyAmount: -1 }, {}), /Récompense quotidienne/);
});
