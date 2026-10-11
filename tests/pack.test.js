// Compression des sauvegardes (src/pack.js).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { packJson, unpackJson } = require('../src/pack');

describe('pack : compression JSON -> gzip -> base64', () => {
  const snapshot = {
    roles: Array.from({ length: 300 }, (_, i) => ({ id: '9' + String(i).padStart(17, '0'), name: 'Rôle ' + i, position: i })),
    channels: Array.from({ length: 150 }, (_, i) => ({ name: 'salon-' + i, topic: 'Discussion générale ' + i })),
    messages: [{ content: 'Bienvenue sur le serveur 🎉', embeds: [{ title: 'Règlement', color: 0x9b59b6 }] }],
  };

  it('aller-retour sans perte (accents et emoji compris)', () => {
    assert.deepEqual(unpackJson(packJson(snapshot)), snapshot);
  });

  it('réduit nettement la taille d’un instantané répétitif', () => {
    const raw = Buffer.byteLength(JSON.stringify(snapshot));
    const packed = Buffer.byteLength(packJson(snapshot));
    assert.ok(packed * 4 < raw, `gain insuffisant : ${raw} -> ${packed}`);
  });
});
