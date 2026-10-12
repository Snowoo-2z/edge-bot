// Cartes PNG de l'économie : /profile et /leaderboard. Vérifie le format et les cas limites (pas d'avatar, classement vide).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../src/economy-card');

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const isPng = (buf) => Buffer.isBuffer(buf) && PNG_MAGIC.every((b, i) => buf[i] === b);

test('carte profil : PNG sans avatar, pseudo long accepté', async () => {
  const png = await cards.renderProfileCard({
    name: 'Un pseudo extrêmement long qui doit être tronqué proprement sur la carte',
    avatarUrl: null,
    balance: 1250,
    currencyName: 'Edge Dollar',
    symbol: '$',
    rank: 3,
    streak: 4,
    nextDailyMs: 3 * 3600e3,
    theme: 'violet_sombre',
  });
  assert.ok(isPng(png));
});

test('carte profil : récompense disponible et thème inconnu (repli sur le thème par défaut)', async () => {
  const png = await cards.renderProfileCard({
    name: 'Léa',
    avatarUrl: null,
    balance: 0,
    currencyName: 'Edge Dollar',
    symbol: '$',
    rank: 1,
    streak: 0,
    nextDailyMs: 0,
    theme: 'inexistant',
  });
  assert.ok(isPng(png));
});

test('classement : PNG avec lignes, et PNG pour un classement vide', async () => {
  const rows = [
    { rank: 1, name: 'Max', balance: 12450 },
    { rank: 2, name: 'Léa', balance: 9800 },
  ];
  assert.ok(isPng(await cards.renderEconomyLeaderboardCard({ rows, currencyName: 'Edge Dollar', symbol: '$' })));
  assert.ok(isPng(await cards.renderEconomyLeaderboardCard({ rows: [], currencyName: 'Edge Dollar', symbol: '$' })));
});

test('montants : espaces entre milliers, rendu d’attente', () => {
  assert.equal(cards.formatNumber(1250), '1 250');
  assert.equal(cards.formatNumber(999), '999');
  assert.equal(cards.formatRemaining(0), 'disponible maintenant');
  assert.equal(cards.formatRemaining(3 * 3600e3 + 5 * 60e3), 'dans 3 h 05 min');
  assert.equal(cards.formatRemaining(25 * 60e3), 'dans 25 min');
});
