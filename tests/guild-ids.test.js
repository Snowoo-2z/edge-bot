// Lecture des identifiants de serveurs pour l'enregistrement des commandes (GUILD_IDS / GUILD_ID).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGuildIds } = require('../src/guild-ids');

test('aucune variable : enregistrement global (liste vide)', () => {
  assert.deepEqual(parseGuildIds({}), []);
});

test('GUILD_IDS accepte plusieurs serveurs, séparés par virgules, espaces ou retours à la ligne', () => {
  const ids = parseGuildIds({ GUILD_IDS: '1546113304932655224, 123456789012345678\n999999999999999999' });
  assert.deepEqual(ids, ['1546113304932655224', '123456789012345678', '999999999999999999']);
});

test('GUILD_ID (ancienne variable) reste pris en compte et sans doublon', () => {
  const ids = parseGuildIds({ GUILD_IDS: '1546113304932655224', GUILD_ID: '1546113304932655224' });
  assert.deepEqual(ids, ['1546113304932655224']);
  assert.deepEqual(parseGuildIds({ GUILD_ID: '123456789012345678' }), ['123456789012345678']);
});

test('identifiant invalide : erreur explicite', () => {
  assert.throws(() => parseGuildIds({ GUILD_IDS: '123 abc' }), /invalide/);
  assert.throws(() => parseGuildIds({ GUILD_IDS: '12345' }), /invalide/);
});
