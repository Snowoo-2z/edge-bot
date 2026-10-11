// Tests du moteur de graphe partagé (navigateur et serveur) : édition, validation, évaluation.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/dashboard/public/ai-graph.js');

const empty = () => G.emptyGraph();

describe('graphe : édition (fonctions pures)', () => {
  it('ajout : identifiant unique, position entière, type connu', () => {
    const r1 = G.addNode(empty(), 'kw', 10.4, 20.6);
    assert.equal(r1.graph.n.length, 1);
    assert.deepEqual(r1.graph.n[0], { i: r1.id, t: 'kw', x: 10, y: 21 });
    const r2 = G.addNode(r1.graph, 'kw', 0, 0);
    assert.notEqual(r2.id, r1.id);
    assert.throws(() => G.addNode(empty(), 'script', 0, 0), /inconnu/);
  });

  it('limite de nœuds atteinte : refus', () => {
    let g = empty();
    for (let k = 0; k < G.LIMITS.nodes; k++) g = G.addNode(g, 'mention', k, 0).graph;
    assert.throws(() => G.addNode(g, 'mention', 0, 0), /maximum/);
  });

  it('connexion : sortie vers entrée, une entrée ne reçoit qu’un fil', () => {
    const s1 = G.addNode(empty(), 'kw', 0, 0);
    const s2 = G.addNode(s1.graph, 'kw', 0, 100);
    const s3 = G.addNode(s2.graph, 'add', 300, 0);
    const k1 = s1.id;
    const k2 = s2.id;
    const a = s3.id;
    let graph = G.connect(s3.graph, k1, 'out', a, 'when');
    assert.deepEqual(graph.w, [[k1, 'out', a, 'when']]);
    // Un second fil sur la même entrée remplace le premier.
    graph = G.connect(graph, k2, 'out', a, 'when');
    assert.deepEqual(graph.w, [[k2, 'out', a, 'when']]);
  });

  it('connexion refusée : sortie vers sortie, entrée inconnue, boucle, soi-même', () => {
    const g1 = G.addNode(empty(), 'and', 0, 0);
    const g2 = G.addNode(g1.graph, 'and', 300, 0);
    const x = g1.id;
    const y = g2.id;
    assert.throws(() => G.connect(g2.graph, x, 'out', y, 'out'), /entrée inconnue/, 'sortie vers sortie');
    assert.throws(() => G.connect(g2.graph, x, 'out', x, 'a'), /lui-même/, 'soi-même');
    assert.throws(() => G.connect(g2.graph, x, 'nope', y, 'a'), /sortie inconnue/);
    const linked = G.connect(g2.graph, x, 'out', y, 'a');
    assert.throws(() => G.connect(linked, y, 'out', x, 'a'), /Boucle/, 'cycle refusé');
  });

  it('suppression d’un nœud : ses fils disparaissent avec lui', () => {
    const a = G.addNode(empty(), 'kw', 0, 0);
    const b = G.addNode(a.graph, 'add', 300, 0);
    const linked = G.connect(b.graph, a.id, 'out', b.id, 'when');
    const cleaned = G.removeNode(linked, a.id);
    assert.equal(cleaned.n.length, 1);
    assert.deepEqual(cleaned.w, []);
  });

  it('suppression d’un fil par son index', () => {
    const a = G.addNode(empty(), 'kw', 0, 0);
    const b = G.addNode(a.graph, 'add', 300, 0);
    const linked = G.connect(b.graph, a.id, 'out', b.id, 'when');
    assert.equal(G.disconnect(linked, 0).w.length, 0);
  });

  it('géométrie : hauteur des nœuds et centre des broches', () => {
    const and = { i: 'x', t: 'and', x: 100, y: 50 };
    assert.equal(G.nodeHeight(and), G.HEADER_H + 2 * G.ROW_H + G.BODY_H);
    const aPin = G.pinPosition(and, 'a', 'in');
    assert.deepEqual(aPin, { x: 100, y: 50 + G.HEADER_H + 11 });
    const out = G.pinPosition(and, 'out', 'out');
    assert.equal(out.x, 100 + G.NODE_W);
    assert.equal(G.pinPosition(and, 'out', 'in'), null, 'broche inconnue');
  });
});

describe('graphe : validation (serveur)', () => {
  it('un graphe vide ou absent devient vide', () => {
    assert.deepEqual(G.parseGraph(null), { n: [], w: [] });
    assert.deepEqual(G.parseGraph({ n: [], w: [] }), { n: [], w: [] });
  });

  it('les champs inutiles sont retirés, `d` omis si vide', () => {
    const g = G.parseGraph({ n: [{ i: 'k', t: 'kw', x: 1, y: 2, d: { keywords: ['  ', ''] } }], w: [] });
    assert.deepEqual(g.n[0], { i: 'k', t: 'kw', x: 1, y: 2 });
  });

  it('mots-clés : 20 maximum, 50 caractères maximum', () => {
    const many = Array.from({ length: 21 }, (_, i) => 'mot' + i);
    assert.throws(() => G.parseGraph({ n: [{ i: 'k', t: 'kw', x: 0, y: 0, d: { keywords: many } }], w: [] }), /20 maximum/);
    const long = ['x'.repeat(51)];
    assert.throws(() => G.parseGraph({ n: [{ i: 'k', t: 'kw', x: 0, y: 0, d: { keywords: long } }], w: [] }), /50 caractères/);
  });

  it('consigne : 500 caractères maximum', () => {
    const n = [{ i: 'a', t: 'add', x: 0, y: 0, d: { text: 'a'.repeat(501) } }];
    assert.throws(() => G.parseGraph({ n, w: [] }), /500 caractères/);
  });

  it('salons : snowflakes uniquement, 10 maximum, contrôle optionnel', () => {
    const bad = { n: [{ i: 'c', t: 'channel', x: 0, y: 0, d: { channelIds: ['abc'] } }], w: [] };
    assert.throws(() => G.parseGraph(bad), /identifiant invalide/);
    const ok = { n: [{ i: 'c', t: 'channel', x: 0, y: 0, d: { channelIds: ['810000000000000001'] } }], w: [] };
    assert.throws(() => G.parseGraph(ok, { channelOk: () => false }), /introuvable/);
    assert.equal(G.parseGraph(ok, { channelOk: () => true }).n[0].d.channelIds[0], '810000000000000001');
  });

  it('coordonnées bornées à ±5000 ; identifiants en double refusés', () => {
    const g = G.parseGraph({ n: [{ i: 'a', t: 'mention', x: 99999, y: -99999 }], w: [] });
    assert.deepEqual([g.n[0].x, g.n[0].y], [5000, -5000]);
    assert.throws(() => G.parseGraph({ n: [{ i: 'a', t: 'mention', x: 0, y: 0 }, { i: 'a', t: 'mention', x: 0, y: 0 }], w: [] }), /double/);
    assert.throws(() => G.parseGraph({ n: [{ i: 'Bad Id', t: 'mention', x: 0, y: 0 }], w: [] }), /invalide/);
  });

  it('fil relié à un nœud inexistant ou entrée déjà occupée : refusé', () => {
    const n = [
      { i: 'k', t: 'kw', x: 0, y: 0 },
      { i: 'a', t: 'add', x: 0, y: 0 },
    ];
    assert.throws(() => G.parseGraph({ n, w: [['zz', 'out', 'a', 'when']] }), /inexistant/);
    assert.throws(() => G.parseGraph({ n: [...n, { i: 'k2', t: 'kw', x: 0, y: 0 }], w: [['k', 'out', 'a', 'when'], ['k2', 'out', 'a', 'when']] }), /un seul fil/);
  });
});

describe('graphe : évaluation', () => {
  it('mot-clé : insensible à la casse et aux accents, mot entier', () => {
    const g = G.parseGraph({
      n: [
        { i: 'k', t: 'kw', x: 0, y: 0, d: { keywords: ['crème'] } },
        { i: 'a', t: 'add', x: 0, y: 0, d: { text: 'OK' } },
      ],
      w: [['k', 'out', 'a', 'when']],
    });
    assert.equal(G.evaluate(g, { text: 'La CREME brûlée' }).active.length, 1);
    assert.equal(G.evaluate(g, { text: 'cremes' }).active.length, 0);
  });

  it('une entrée non branchée est fausse ; NON inverse', () => {
    const g = G.parseGraph({
      n: [
        { i: 'n', t: 'not', x: 0, y: 0 },
        { i: 'a', t: 'add', x: 0, y: 0, d: { text: 'OK' } },
      ],
      w: [['n', 'out', 'a', 'when']],
    });
    assert.equal(G.evaluate(g, {}).active.length, 1, 'NON d’une entrée vide = vrai');
  });

  it('les consignes non branchées ne sont jamais actives et sont signalées', () => {
    const g = G.parseGraph({ n: [{ i: 'a', t: 'add', x: 0, y: 0, d: { text: 'seule' } }], w: [] });
    assert.equal(G.evaluate(g, { text: 'x', mentioned: true }).active.length, 0);
    assert.deepEqual(G.unwiredActions(g).map((n) => n.i), ['a']);
  });

  it('ordre des consignes : de haut en bas, puis de gauche à droite', () => {
    const m = { i: 'm', t: 'mention', x: 0, y: 0 };
    const g = G.parseGraph({
      n: [
        m,
        { i: 'b', t: 'add', x: 500, y: 300, d: { text: 'bas' } },
        { i: 'c', t: 'add', x: 0, y: 300, d: { text: 'bas-gauche' } },
        { i: 'd', t: 'add', x: 500, y: 0, d: { text: 'haut' } },
      ],
      w: [['m', 'out', 'b', 'when'], ['m', 'out', 'c', 'when'], ['m', 'out', 'd', 'when']],
    });
    assert.deepEqual(G.evaluate(g, { mentioned: true }).active.map((a) => a.text), ['haut', 'bas-gauche', 'bas']);
  });
});
