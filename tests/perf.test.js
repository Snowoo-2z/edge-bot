// Tests des optimisations de réactivité : file d'écriture du store, cache mémoire IA,
// vidange du journal par lots et cache des avatars. Supabase et le réseau sont remplacés.
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Faux client Supabase, injecté avant le chargement de store.js (chaque fichier de test a son propre processus).
const upserts = [];
const selects = [];
let failNextUpsert = false;
const fakeSupabase = {
  from(table) {
    return {
      select(columns) {
        selects.push({ table, columns });
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({ data: { notes: [`note de ${table}`] }, error: null }),
          then: (ok) => ok({ data: [], error: null }),
        };
        return chain;
      },
      upsert(row) {
        upserts.push({ table, row });
        if (failNextUpsert) {
          failNextUpsert = false;
          return Promise.reject(new Error('réseau coupé')); // exception, pas une erreur renvoyée
        }
        return Promise.resolve({ error: null });
      },
      delete() {
        const chain = { eq: () => chain, then: (ok) => ok({ error: null }) };
        return chain;
      },
    };
  },
};
require.cache[require.resolve('@supabase/supabase-js')] = {
  id: require.resolve('@supabase/supabase-js'),
  filename: require.resolve('@supabase/supabase-js'),
  loaded: true,
  exports: { createClient: () => fakeSupabase },
};
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';

const store = require('../src/store');
const logs = require('../src/modules/logs');
const welcomeImage = require('../src/welcome-image');
const { createCanvas } = require('@napi-rs/canvas');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('une écriture en exception ne bloque pas les écritures suivantes', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    await store.init();
    upserts.length = 0;
    failNextUpsert = true;
    store.updateModuleConfig('G1', 'welcome', { a: 1 }); // échoue (exception)
    store.updateModuleConfig('G1', 'welcome', { a: 2 }); // doit quand même partir
    for (let i = 0; i < 50 && upserts.length < 2; i++) await wait(10);
    assert.equal(upserts.length, 2);
    assert.deepEqual(upserts[1].row.config, { a: 2 });
  } finally {
    console.error = origError;
  }
});

test('la mémoire IA est relue depuis le cache, puis mise à jour à l’écriture', async () => {
  selects.length = 0;
  const first = await store.loadAiMemory('G2', 'U1');
  assert.deepEqual(first, ['note de edge_ai_memories']);
  assert.equal(selects.length, 1);

  const again = await store.loadAiMemory('G2', 'U1');
  assert.deepEqual(again, first);
  assert.equal(selects.length, 1, 'deuxième lecture servie par le cache');

  // Copie défensive : modifier le résultat ne change pas le cache.
  again.push('modifié');
  assert.deepEqual(await store.loadAiMemory('G2', 'U1'), first);

  await store.saveAiMemory('G2', 'U1', ['nouvelle note']);
  assert.deepEqual(await store.loadAiMemory('G2', 'U1'), ['nouvelle note']);
  assert.equal(selects.length, 1, 'après écriture, pas de relecture Supabase');

  await store.deleteAiMemory('G2', 'U1');
  const afterDelete = await store.loadAiMemory('G2', 'U1');
  assert.equal(selects.length, 2, 'après suppression, le cache est vidé');
  assert.deepEqual(afterDelete, ['note de edge_ai_memories']);
});

test('le journal est vidé par lots successifs, dans l’ordre, sans rien perdre', async () => {
  const sent = [];
  const originalInsert = store.insertLogs;
  store.insertLogs = async (rows) => {
    sent.push(...rows.map((r) => r.n));
  };
  try {
    const { dbQueue } = logs._queues;
    dbQueue.length = 0;
    for (let n = 0; n < 1200; n++) dbQueue.push({ n });
    await logs.flushOnExit();
    assert.equal(dbQueue.length, 0);
    assert.equal(sent.length, 1200);
    assert.deepEqual(sent, Array.from({ length: 1200 }, (_, n) => n));
  } finally {
    store.insertLogs = originalInsert;
  }
});

test('un avatar déjà téléchargé est réutilisé sans nouvel appel réseau', async () => {
  const png = await createCanvas(4, 4).encode('png');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).includes('absent')) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
  };
  try {
    const url = 'https://cdn.test/avatars/1/abc.png';
    const a = await welcomeImage.fetchAvatar(url);
    const b = await welcomeImage.fetchAvatar(url);
    assert.ok(a && b);
    assert.equal(calls, 1);

    // Un échec n'est pas mis en cache : la prochaine demande réessaie.
    assert.equal(await welcomeImage.fetchAvatar('https://cdn.test/absent.png'), null);
    assert.equal(await welcomeImage.fetchAvatar('https://cdn.test/absent.png'), null);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
