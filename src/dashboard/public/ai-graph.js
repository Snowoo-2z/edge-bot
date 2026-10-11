// Graphe de nœuds du module IA (façon Unreal / Blueprints).
// Module partagé : le tableau de bord (navigateur) s'en sert pour éditer, le serveur pour valider
// et évaluer les messages (src/modules/ai.js). Aucune dépendance.
//
// Format stocké (compact) : { n: [{ i, t, x, y, d }], w: [[nodeOut, pinOut, nodeIn, pinIn], ...] }
//   i = identifiant, t = type, x/y = position, d = données (omis si vide).
// Chaque fil relie une SORTIE (valeur vrai/faux) à une ENTRÉE. Une entrée ne reçoit qu'un fil.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EdgeAiGraph = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const LIMITS = { nodes: 60, wires: 150, keywords: 20, keywordLen: 50, channels: 10, text: 500 };
  const NODE_W = 190;
  const HEADER_H = 28;
  const ROW_H = 22;
  const BODY_H = 34;
  const ID_RE = /^[a-z0-9]{1,24}$/;
  const SNOWFLAKE = /^\d{17,20}$/;

  // Catalogue : ins = entrées (à gauche), outs = sorties (à droite), group = couleur et menu.
  const CATALOG = {
    kw: { label: 'Mot-clé', group: 'event', ins: [], outs: ['out'], pinLabels: { out: 'vrai si mot' } },
    channel: { label: 'Salon', group: 'event', ins: [], outs: ['out'], pinLabels: { out: 'vrai si salon' } },
    mention: { label: 'Bot mentionné', group: 'event', ins: [], outs: ['out'], pinLabels: { out: 'vrai si mention' } },
    and: { label: 'ET', group: 'logic', ins: ['a', 'b'], outs: ['out'], pinLabels: { a: 'A', b: 'B', out: 'résultat' } },
    or: { label: 'OU', group: 'logic', ins: ['a', 'b'], outs: ['out'], pinLabels: { a: 'A', b: 'B', out: 'résultat' } },
    not: { label: 'NON', group: 'logic', ins: ['a'], outs: ['out'], pinLabels: { a: 'A', out: 'inverse' } },
    add: { label: 'Ajouter une consigne', group: 'action', ins: ['when'], outs: [], pinLabels: { when: 'si vrai' } },
  };
  const GROUPS = [
    { id: 'event', label: 'Événements' },
    { id: 'logic', label: 'Logique' },
    { id: 'action', label: 'Actions' },
  ];

  const emptyGraph = () => ({ n: [], w: [] });

  // Texte en minuscules sans accents : « Crème » et « creme » se comparent.
  const foldText = (s) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

  // Mot-clé présent comme mot entier (« bug » ne matche pas « bugs »).
  function containsKeyword(foldedText, keyword) {
    const k = foldText(keyword).trim();
    if (!k) return false;
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(foldedText);
  }

  function nodeRows(node) {
    const def = CATALOG[node.t];
    return Math.max(def.ins.length, def.outs.length, 1);
  }

  function nodeHeight(node) {
    return HEADER_H + nodeRows(node) * ROW_H + BODY_H;
  }

  // Centre d'une broche, en coordonnées du canevas (même repère que les nœuds).
  function pinPosition(node, pin, dir) {
    const def = CATALOG[node.t];
    const list = dir === 'out' ? def.outs : def.ins;
    const idx = list.indexOf(pin);
    if (idx < 0) return null;
    return { x: dir === 'out' ? node.x + NODE_W : node.x, y: node.y + HEADER_H + 11 + idx * ROW_H };
  }

  function summaryOf(node) {
    const d = node.d ?? {};
    if (node.t === 'kw') return (d.keywords ?? []).length ? d.keywords.join(', ') : '— aucun mot-clé —';
    if (node.t === 'channel') return (d.channelIds ?? []).length ? `${d.channelIds.length} salon(s)` : '— aucun salon —';
    if (node.t === 'add') return (d.text ?? '').trim() ? truncate(d.text.trim(), 60) : '— consigne vide —';
    return '';
  }

  function truncate(s, max) {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // ---------------------------------------------------------------------------
  // Validation : utilisée par le serveur (données reçues) et par l'éditeur (vérifications de fil).
  // Lève une Error au premier problème, avec un message en français.
  // ---------------------------------------------------------------------------

  function clampCoord(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('Position d’un nœud invalide.');
    return Math.max(-5000, Math.min(5000, Math.round(n)));
  }

  function cleanData(type, raw, opts) {
    const d = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
    if (type === 'kw') {
      // Données absentes (nœud fraîchement ajouté) : liste vide.
      if (d.keywords === undefined) d.keywords = [];
      if (!Array.isArray(d.keywords)) throw new Error('Mot-clé : liste attendue.');
      if (d.keywords.length > LIMITS.keywords) throw new Error(`Mot-clé : ${LIMITS.keywords} maximum par nœud.`);
      const keywords = d.keywords.map((k) => {
        if (typeof k !== 'string') throw new Error('Mot-clé : texte attendu.');
        const t = k.trim();
        if ([...t].length > LIMITS.keywordLen) throw new Error(`Mot-clé : ${LIMITS.keywordLen} caractères maximum.`);
        return t;
      }).filter(Boolean);
      return keywords.length ? { keywords } : {};
    }
    if (type === 'channel') {
      if (d.channelIds === undefined) d.channelIds = [];
      if (!Array.isArray(d.channelIds)) throw new Error('Salon : liste attendue.');
      if (d.channelIds.length > LIMITS.channels) throw new Error(`Salon : ${LIMITS.channels} maximum par nœud.`);
      for (const id of d.channelIds) {
        if (typeof id !== 'string' || !SNOWFLAKE.test(id)) throw new Error('Salon : identifiant invalide.');
        if (opts.channelOk && !opts.channelOk(id)) throw new Error('Salon introuvable ou non textuel sur ce serveur.');
      }
      return d.channelIds.length ? { channelIds: [...d.channelIds] } : {};
    }
    if (type === 'add') {
      if (d.text === undefined) d.text = '';
      if (typeof d.text !== 'string') throw new Error('Consigne : texte attendu.');
      const t = d.text.trim();
      if ([...t].length > LIMITS.text) throw new Error(`Consigne : ${LIMITS.text} caractères maximum.`);
      return t ? { text: t } : {};
    }
    return {};
  }

  function hasCycle(nodes, wires) {
    const deps = new Map(nodes.map((n) => [n.i, []]));
    for (const [a, , b] of wires) deps.get(b).push(a);
    const state = new Map(); // 1 = en cours, 2 = fini
    const visit = (id) => {
      if (state.get(id) === 1) return true;
      if (state.get(id) === 2) return false;
      state.set(id, 1);
      for (const dep of deps.get(id)) if (visit(dep)) return true;
      state.set(id, 2);
      return false;
    };
    return nodes.some((n) => visit(n.i));
  }

  // Normalise et vérifie un graphe. Retourne une copie propre (format compact).
  function parseGraph(input, opts = {}) {
    if (input === null || input === undefined) return emptyGraph();
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Graphe : objet attendu.');
    if (!Array.isArray(input.n) || !Array.isArray(input.w)) throw new Error('Graphe : listes de nœuds et de fils attendues.');
    if (input.n.length > LIMITS.nodes) throw new Error(`Graphe : ${LIMITS.nodes} nœuds maximum.`);
    if (input.w.length > LIMITS.wires) throw new Error(`Graphe : ${LIMITS.wires} fils maximum.`);

    const ids = new Set();
    const nodes = input.n.map((raw) => {
      if (!raw || typeof raw.i !== 'string' || !ID_RE.test(raw.i)) throw new Error('Identifiant de nœud invalide.');
      if (ids.has(raw.i)) throw new Error('Identifiant de nœud en double.');
      ids.add(raw.i);
      if (!Object.prototype.hasOwnProperty.call(CATALOG, raw.t)) throw new Error(`Type de nœud inconnu : ${raw.t}.`);
      const node = { i: raw.i, t: raw.t, x: clampCoord(raw.x), y: clampCoord(raw.y) };
      const d = cleanData(raw.t, raw.d, opts);
      if (Object.keys(d).length) node.d = d;
      return node;
    });
    const byId = new Map(nodes.map((n) => [n.i, n]));

    const used = new Set();
    const wires = input.w.map((w) => {
      if (!Array.isArray(w) || w.length !== 4) throw new Error('Fil invalide.');
      const [a, p, b, q] = w;
      const from = byId.get(a);
      const to = byId.get(b);
      if (!from || !to) throw new Error('Fil relié à un nœud inexistant.');
      if (a === b) throw new Error('Un nœud ne peut pas se relier à lui-même.');
      if (!CATALOG[from.t].outs.includes(p)) throw new Error('Fil : sortie inconnue.');
      if (!CATALOG[to.t].ins.includes(q)) throw new Error('Fil : entrée inconnue.');
      const key = `${b}.${q}`;
      if (used.has(key)) throw new Error('Une entrée ne peut recevoir qu’un seul fil.');
      used.add(key);
      return [a, p, b, q];
    });

    if (hasCycle(nodes, wires)) throw new Error('Boucle détectée : un nœud ne peut pas dépendre de lui-même.');
    return { n: nodes, w: wires };
  }

  // ---------------------------------------------------------------------------
  // Modifications (fonctions pures : elles renvoient un nouveau graphe ou lèvent une erreur)
  // ---------------------------------------------------------------------------

  function newId(graph) {
    let id;
    do {
      id = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    } while (graph.n.some((n) => n.i === id));
    return id;
  }

  function addNode(graph, type, x, y) {
    if (!Object.prototype.hasOwnProperty.call(CATALOG, type)) throw new Error('Type de nœud inconnu.');
    if (graph.n.length >= LIMITS.nodes) throw new Error(`${LIMITS.nodes} nœuds maximum dans le graphe.`);
    const id = newId(graph);
    const next = { n: [...graph.n, { i: id, t: type, x: Math.round(x), y: Math.round(y) }], w: graph.w.map((w) => [...w]) };
    return { graph: parseGraph(next), id };
  }

  function removeNode(graph, id) {
    return {
      n: graph.n.filter((n) => n.i !== id).map((n) => ({ ...n })),
      w: graph.w.filter(([a, , b]) => a !== id && b !== id).map((w) => [...w]),
    };
  }

  function connect(graph, outNode, outPin, inNode, inPin) {
    const candidate = {
      n: graph.n.map((n) => ({ ...n })),
      // Un fil déjà branché sur cette entrée est remplacé.
      w: graph.w.filter(([, , b, q]) => !(b === inNode && q === inPin)).map((w) => [...w]),
    };
    candidate.w.push([outNode, outPin, inNode, inPin]);
    return parseGraph(candidate);
  }

  function disconnect(graph, index) {
    return { n: graph.n.map((n) => ({ ...n })), w: graph.w.filter((_, i) => i !== index).map((w) => [...w]) };
  }

  // ---------------------------------------------------------------------------
  // Évaluation : pour un message, quelles consignes sont actives ?
  // ctx = { text, channelId, mentioned }
  // ---------------------------------------------------------------------------

  function evaluate(graph, ctx = {}) {
    const byId = new Map(graph.n.map((n) => [n.i, n]));
    const sourceOf = new Map(graph.w.map(([a, p, b, q]) => [`${b}.${q}`, [a, p]]));
    const folded = foldText(ctx.text ?? '');
    const memo = new Map();

    const outValue = (id, pin, depth) => {
      const key = `${id}.${pin}`;
      if (memo.has(key)) return memo.get(key);
      if (depth > 200) return false;
      const node = byId.get(id);
      const input = (p) => {
        const src = sourceOf.get(`${id}.${p}`);
        return src ? outValue(src[0], src[1], depth + 1) : false;
      };
      let v = false;
      switch (node?.t) {
        case 'kw':
          v = folded !== '' && (node.d?.keywords ?? []).some((k) => containsKeyword(folded, k));
          break;
        case 'channel':
          v = Boolean(ctx.channelId) && (node.d?.channelIds ?? []).includes(ctx.channelId);
          break;
        case 'mention':
          v = Boolean(ctx.mentioned);
          break;
        case 'and':
          v = input('a') && input('b');
          break;
        case 'or':
          v = input('a') || input('b');
          break;
        case 'not':
          v = !input('a');
          break;
        default:
          v = false;
      }
      memo.set(key, v);
      return v;
    };

    const active = [];
    const ordered = [...graph.n].sort((p, q) => p.y - q.y || p.x - q.x);
    for (const node of ordered) {
      if (node.t !== 'add' || !node.d?.text) continue;
      const src = sourceOf.get(`${node.i}.when`);
      if (src && outValue(src[0], src[1], 0)) active.push({ id: node.i, text: node.d.text });
    }
    return { active };
  }

  // Nœuds « consigne » sans fil branché : jamais appliqués (à signaler dans l'éditeur).
  function unwiredActions(graph) {
    const wired = new Set(graph.w.map(([, , b, q]) => `${b}.${q}`));
    return graph.n.filter((n) => n.t === 'add' && !wired.has(`${n.i}.when`));
  }

  // Total de caractères de texte injecté au prompt par les consignes (pour la limite de taille).
  function instructionChars(graph) {
    return (graph.n ?? []).reduce((sum, n) => sum + (n.d?.text ? n.d.text.length + 2 : 0), 0);
  }

  return {
    CATALOG,
    GROUPS,
    LIMITS,
    NODE_W,
    HEADER_H,
    ROW_H,
    BODY_H,
    emptyGraph,
    foldText,
    containsKeyword,
    nodeHeight,
    nodeRows,
    pinPosition,
    summaryOf,
    parseGraph,
    addNode,
    removeNode,
    connect,
    disconnect,
    evaluate,
    unwiredActions,
    instructionChars,
  };
});
