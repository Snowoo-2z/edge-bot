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

  const LIMITS = { nodes: 60, wires: 150, keywords: 20, keywordLen: 50, channels: 10, roles: 25, grantRoles: 10, inputs: 6, text: 500 };
  const NODE_W = 210;
  const HEADER_H = 32;
  const ROW_H = 26;
  const BODY_H = 34;
  const ID_RE = /^[a-z0-9]{1,24}$/;
  const SNOWFLAKE = /^\d{17,20}$/;
  const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

  // Catalogue : ins = entrées (à gauche), outs = sorties (à droite), group = couleur et menu.
  // variadic : nombre d'entrées réglable (d.n, de 2 à 6), noms de broches a, b, c…
  // aliases : mots utilisés par la recherche du menu d'ajout.
  const CATALOG = {
    kw: { label: 'Mot-clé', group: 'event', ins: [], outs: ['out'], pinLabels: { out: 'vrai si mot' }, aliases: 'mot clé mots clés texte contient' },
    channel: { label: 'Salon', group: 'event', ins: [], outs: ['out'], pinLabels: { out: 'vrai si salon' }, aliases: 'canal channel' },
    mention: { label: 'Bot mentionné', group: 'event', ins: [], outs: ['out'], pinLabels: { out: 'vrai si mention' }, aliases: 'ping tag arobase' },
    role: { label: 'Le membre a un rôle', group: 'event', ins: [], outs: ['out'], pinLabels: { out: 'vrai si rôle' }, aliases: 'rôle role grade' },
    mentionRole: { label: 'Le message mentionne un rôle', group: 'event', ins: [], outs: ['out'], pinLabels: { out: 'vrai si ping' }, aliases: 'ping rôle role mention' },
    and: { label: 'ET', group: 'logic', variadic: true, ins: ['a', 'b'], outs: ['out'], pinLabels: { out: 'résultat' }, aliases: 'et and tous' },
    or: { label: 'OU', group: 'logic', variadic: true, ins: ['a', 'b'], outs: ['out'], pinLabels: { out: 'résultat' }, aliases: 'ou or au moins un' },
    not: { label: 'NON', group: 'logic', ins: ['a'], outs: ['out'], pinLabels: { a: 'A', out: 'inverse' }, aliases: 'non not inverse' },
    add: { label: 'Ajouter une consigne', group: 'action', ins: ['when'], outs: [], pinLabels: { when: 'si vrai' }, aliases: 'consigne prompt instruction' },
    grant: { label: 'L’IA peut donner un rôle', group: 'action', ins: ['when'], outs: [], pinLabels: { when: 'si vrai' }, aliases: 'rôle role attribuer donner ajouter' },
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

  // ---------------------------------------------------------------------------
  // Géométrie
  // ---------------------------------------------------------------------------

  function inputCount(node) {
    const n = Number(node.d?.n);
    return Number.isInteger(n) && n >= 2 && n <= LIMITS.inputs ? n : 2;
  }

  // Entrées réelles d'un nœud (ET / OU : nombre réglable).
  function insOf(node) {
    const def = CATALOG[node.t];
    return def.variadic ? LETTERS.slice(0, inputCount(node)) : def.ins;
  }

  function outsOf(node) {
    return CATALOG[node.t].outs;
  }

  function pinLabel(node, pin) {
    const def = CATALOG[node.t];
    if (def.pinLabels[pin]) return def.pinLabels[pin];
    return def.variadic ? pin.toUpperCase() : pin;
  }

  function nodeRows(node) {
    return Math.max(insOf(node).length, outsOf(node).length, 1);
  }

  function nodeHeight(node) {
    return HEADER_H + nodeRows(node) * ROW_H + BODY_H;
  }

  // Décalage vertical du centre d'une broche (i = rang de la broche), depuis le haut du nœud.
  function pinOffset(i) {
    return HEADER_H + ROW_H / 2 + i * ROW_H;
  }

  // Centre d'une broche, en coordonnées du canevas (même repère que les nœuds).
  function pinPosition(node, pin, dir) {
    const list = dir === 'out' ? outsOf(node) : insOf(node);
    const idx = list.indexOf(pin);
    if (idx < 0) return null;
    return { x: dir === 'out' ? node.x + NODE_W : node.x, y: node.y + pinOffset(idx) };
  }

  function truncate(s, max) {
    const chars = [...String(s)];
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : String(s);
  }

  // Résumé affiché sur le nœud. roleName(id) donne le nom d'un rôle (sinon l'identifiant).
  function summaryOf(node, roleName = (id) => id) {
    const d = node.d ?? {};
    if (node.t === 'kw') return (d.keywords ?? []).length ? d.keywords.join(', ') : '— aucun mot-clé —';
    if (node.t === 'channel') return (d.channelIds ?? []).length ? `${d.channelIds.length} salon(s)` : '— aucun salon —';
    if (node.t === 'role' || node.t === 'mentionRole' || node.t === 'grant') {
      const ids = d.roleIds ?? [];
      if (!ids.length) return '— aucun rôle —';
      return ids.map((id) => roleName(id)).join(', ');
    }
    if (node.t === 'and' || node.t === 'or') return `${insOf(node).length} entrées`;
    if (node.t === 'add') return (d.text ?? '').trim() ? truncate(d.text.trim(), 60) : '— consigne vide —';
    return '';
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

  function roleIdsOf(d, type, opts) {
    // Données absentes (nœud fraîchement ajouté) : liste vide.
    const list = d.roleIds === undefined ? [] : d.roleIds;
    const max = type === 'grant' ? LIMITS.grantRoles : LIMITS.roles;
    if (!Array.isArray(list)) throw new Error('Rôle : liste attendue.');
    if (list.length > max) throw new Error(`Rôle : ${max} maximum par nœud.`);
    const seen = new Set();
    for (const id of list) {
      if (typeof id !== 'string' || !SNOWFLAKE.test(id)) throw new Error('Rôle : identifiant invalide.');
      if (seen.has(id)) throw new Error('Rôle en double dans le nœud.');
      seen.add(id);
      if (opts.roleOk && !opts.roleOk(id, type)) {
        throw new Error(type === 'grant' ? 'Rôle non attribuable par l’IA (introuvable, géré par une intégration ou administrateur).' : 'Rôle introuvable sur ce serveur.');
      }
    }
    return list.length ? [...list] : [];
  }

  function cleanData(type, raw, opts) {
    const d = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
    if (type === 'kw') {
      // Données absentes (nœud fraîchement ajouté) : liste vide.
      if (d.keywords === undefined) d.keywords = [];
      if (!Array.isArray(d.keywords)) throw new Error('Mot-clé : liste attendue.');
      if (d.keywords.length > LIMITS.keywords) throw new Error(`Mot-clé : ${LIMITS.keywords} maximum par nœud.`);
      const keywords = d.keywords
        .map((k) => {
          if (typeof k !== 'string') throw new Error('Mot-clé : texte attendu.');
          const t = k.trim();
          if ([...t].length > LIMITS.keywordLen) throw new Error(`Mot-clé : ${LIMITS.keywordLen} caractères maximum.`);
          return t;
        })
        .filter(Boolean);
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
    if (type === 'role' || type === 'mentionRole' || type === 'grant') {
      const roleIds = roleIdsOf(d, type, opts);
      return roleIds.length ? { roleIds } : {};
    }
    if (type === 'and' || type === 'or') {
      if (d.n === undefined) return {};
      const n = Number(d.n);
      if (!Number.isInteger(n) || n < 2 || n > LIMITS.inputs) throw new Error(`Entrées : entre 2 et ${LIMITS.inputs}.`);
      return n === 2 ? {} : { n };
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
  // opts.channelOk(id) et opts.roleOk(id, type) : contrôles faits par le serveur.
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
      if (!outsOf(from).includes(p)) throw new Error('Fil : sortie inconnue.');
      if (!insOf(to).includes(q)) throw new Error('Fil : entrée inconnue.');
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

  // Identifiant libre pour le graphe (et pour les nœuds ajoutés dans le même lot).
  function freshId(graph, taken = new Set()) {
    let id;
    do {
      id = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    } while (graph.n.some((n) => n.i === id) || taken.has(id));
    return id;
  }

  function addNode(graph, type, x, y) {
    if (!Object.prototype.hasOwnProperty.call(CATALOG, type)) throw new Error('Type de nœud inconnu.');
    if (graph.n.length >= LIMITS.nodes) throw new Error(`${LIMITS.nodes} nœuds maximum dans le graphe.`);
    const id = freshId(graph);
    const next = { n: [...graph.n, { i: id, t: type, x: Math.round(x), y: Math.round(y) }], w: graph.w.map((w) => [...w]) };
    return { graph: parseGraph(next), id };
  }

  // Supprime plusieurs nœuds (ids : tableau ou Set) et les fils qui s'y rattachent.
  function removeNodes(graph, ids) {
    const drop = new Set(ids);
    return {
      n: graph.n.filter((n) => !drop.has(n.i)).map((n) => ({ ...n, ...(n.d ? { d: { ...n.d } } : {}) })),
      w: graph.w.filter(([a, , b]) => !drop.has(a) && !drop.has(b)).map((w) => [...w]),
    };
  }

  function removeNode(graph, id) {
    return removeNodes(graph, [id]);
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

  // Nombre d'entrées d'un ET / OU. Les fils branchés sur les entrées supprimées sont retirés.
  function setInputCount(graph, id, count) {
    const n = Math.max(2, Math.min(LIMITS.inputs, Math.round(count)));
    const node = graph.n.find((x) => x.i === id);
    if (!node || !CATALOG[node.t].variadic) throw new Error('Ce nœud n’a pas d’entrées réglables.');
    const nodes = graph.n.map((x) => (x.i === id ? { ...x, d: { ...(x.d ?? {}), n } } : { ...x, ...(x.d ? { d: { ...x.d } } : {}) }));
    const wires = graph.w.filter(([, , b, q]) => !(b === id && LETTERS.indexOf(q) >= n)).map((w) => [...w]);
    return parseGraph({ n: nodes, w: wires });
  }

  // Colle un fragment copié ({ n, w } avec les anciens identifiants) avec un décalage.
  // Les fils ne sont recréés que s'ils relient deux nœuds du fragment.
  function pasteFragment(graph, fragment, offset = { x: 40, y: 40 }) {
    const taken = new Set();
    const map = new Map();
    for (const old of fragment.n) {
      const id = freshId(graph, taken);
      taken.add(id);
      map.set(old.i, id);
    }
    const added = fragment.n.map((old) => ({
      i: map.get(old.i),
      t: old.t,
      x: old.x + offset.x,
      y: old.y + offset.y,
      ...(old.d ? { d: { ...old.d } } : {}),
    }));
    const wires = fragment.w.filter(([a, , b]) => map.has(a) && map.has(b)).map(([a, p, b, q]) => [map.get(a), p, map.get(b), q]);
    const next = {
      n: [...graph.n.map((n) => ({ ...n, ...(n.d ? { d: { ...n.d } } : {}) })), ...added],
      w: [...graph.w.map((w) => [...w]), ...wires],
    };
    return { graph: parseGraph(next), ids: added.map((n) => n.i) };
  }

  // ---------------------------------------------------------------------------
  // Évaluation : pour un message, quelles consignes sont actives, et quels rôles l'IA peut donner ?
  // ctx = { text, channelId, mentioned, memberRoleIds, mentionedRoleIds }
  // Retourne { active: [{id, text}], grants: [{id, roleIds}] } (ordre : haut vers bas, gauche vers droite).
  // ---------------------------------------------------------------------------

  function containsAny(list, ids) {
    const set = new Set(ids ?? []);
    return (list ?? []).some((id) => set.has(id));
  }

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
        case 'role':
          v = containsAny(node.d?.roleIds, ctx.memberRoleIds);
          break;
        case 'mentionRole':
          v = containsAny(node.d?.roleIds, ctx.mentionedRoleIds);
          break;
        case 'and':
          v = insOf(node).every((p) => input(p));
          break;
        case 'or':
          v = insOf(node).some((p) => input(p));
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
    const grants = [];
    const ordered = [...graph.n].sort((p, q) => p.y - q.y || p.x - q.x);
    for (const node of ordered) {
      if (node.t !== 'add' && node.t !== 'grant') continue;
      const src = sourceOf.get(`${node.i}.when`);
      if (!src || !outValue(src[0], src[1], 0)) continue;
      if (node.t === 'add' && node.d?.text) active.push({ id: node.i, text: node.d.text });
      if (node.t === 'grant' && node.d?.roleIds?.length) grants.push({ id: node.i, roleIds: [...node.d.roleIds] });
    }
    return { active, grants };
  }

  // Nœuds « consigne » ou « rôle » sans fil branché : jamais appliqués (à signaler dans l'éditeur).
  function unwiredActions(graph) {
    const wired = new Set(graph.w.map(([, , b, q]) => `${b}.${q}`));
    return graph.n.filter((n) => (n.t === 'add' || n.t === 'grant') && !wired.has(`${n.i}.when`));
  }

  // Total de caractères injecté au prompt par les consignes (pour la limite de taille).
  function instructionChars(graph) {
    return (graph.n ?? []).reduce((sum, n) => {
      if (n.t === 'add') return sum + (n.d?.text ? n.d.text.length + 2 : 0);
      if (n.t === 'grant') return sum + 160;
      return sum;
    }, 0);
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
    insOf,
    outsOf,
    pinLabel,
    pinOffset,
    nodeHeight,
    nodeRows,
    pinPosition,
    summaryOf,
    parseGraph,
    freshId,
    addNode,
    removeNode,
    removeNodes,
    connect,
    disconnect,
    setInputCount,
    pasteFragment,
    evaluate,
    unwiredActions,
    instructionChars,
  };
});
