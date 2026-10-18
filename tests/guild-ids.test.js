// Lecture des identifiants de serveurs pour l'enregistrement des commandes (serveurs intégrés + GUILD_IDS / GUILD_ID).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGuildIds, BUILTIN_GUILD_IDS } = require('../src/guild-ids');

test('serveur intégré dans le code : toujours présent, même sans variable', () => {
  assert.deepEqual(BUILTIN_GUILD_IDS, ['1546113304932655224']);
  assert.deepEqual(parseGuildIds({}), ['1546113304932655224']);
});

test('GUILD_IDS accepte plusieurs serveurs, séparés par virgules, espaces ou retours à la ligne', () => {
  const ids = parseGuildIds({ GUILD_IDS: '123456789012345678, 999999999999999999\n888888888888888888' });
  assert.deepEqual(ids, ['1546113304932655224', '123456789012345678', '999999999999999999', '888888888888888888']);
});

test('GUILD_ID (ancienne variable) reste pris en compte, sans doublon avec le serveur intégré', () => {
  assert.deepEqual(parseGuildIds({ GUILD_IDS: '1546113304932655224', GUILD_ID: '1546113304932655224' }), ['1546113304932655224']);
  assert.deepEqual(parseGuildIds({ GUILD_ID: '123456789012345678' }), ['1546113304932655224', '123456789012345678']);
});

test('identifiant invalide : erreur explicite', () => {
  assert.throws(() => parseGuildIds({ GUILD_IDS: '123 abc' }), /invalide/);
  assert.throws(() => parseGuildIds({ GUILD_IDS: '12345' }), /invalide/);
});
