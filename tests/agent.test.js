// Tests de l'agent IA de serveur : outils, moteur (plan, validation, trace), module.
// Discord et Mistral sont remplacés : aucun appel réseau.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const store = require('../src/store');
const tools = require('../src/agent/tools');
const { runAgent, PLAN_TIMEOUT_MS, DELETE_TIMEOUT_MS } = require('../src/agent/engine');
const agent = require('../src/modules/agent');

const G = '830000000000000001';
const TRACE = '830000000000000050';

// ---- Faux serveur ---------------------------------------------------------
function makeGuild() {
  let seq = 100;
  const nextId = () => String(830000000000000000n + BigInt(++seq));
  const channels = new Map();
  const roles = new Map();
  const log = { sent: [], overwrites: [], deleted: [] };
  roles.set(G, { id: G, name: '@everyone', position: 0, managed: false, hexColor: '#000000' });

  const makeChannel = (id, name, type, parentId = null, topic = null) => {
    const ch = {
      id,
      name,
      type,
      parentId,
      topic,
      rawPosition: 0,
      send: async (o) => {
        const msg = { id: nextId(), content: typeof o === 'string' ? o : o.content };
        log.sent.push({ channel: id, options: o, msg });
        return msg;
      },
      messages: { fetch: async () => new Map() },
      edit: async (o) => {
        if (o.name !== undefined) ch.name = o.name;
        if (o.topic !== undefined) ch.topic = o.topic;
        if (o.parent !== undefined) ch.parentId = o.parent;
      },
      delete: async () => {
        log.deleted.push(id);
        channels.delete(id);
      },
      permissionOverwrites: {
        edit: async (roleId, overwrite) => log.overwrites.push({ channel: id, roleId, overwrite }),
      },
    };
    channels.set(id, ch);
    return ch;
  };

  const guild = {
    id: G,
    name: 'Edge Test',
    channels: {
      cache: channels,
      create: async (o) => makeChannel(nextId(), o.name, o.type, o.parent ?? null, o.topic ?? null),
    },
    roles: {
      cache: roles,
      create: async (o) => {
        const role = { id: nextId(), name: o.name, position: 1, managed: false, hexColor: '#000000', color: o.color };
        roles.set(role.id, role);
        return role;
      },
    },
  };
  // Salon de suivi (protégé contre la suppression).
  makeChannel(TRACE, 'agent-suivi', ChannelType.GuildText);
  return { guild, log, makeChannel, nextId };
}

// Modèle scripté : chaque appel renvoie la prochaine réponse ; on garde les outils proposés.
function scriptedChat(responses) {
  const calls = [];
  const queue = [...responses];
  const chat = async (opts) => {
    calls.push({ tools: (opts.tools ?? []).map((t) => t.function.name), messages: opts.messages.length });
    if (!queue.length) throw new Error('script épuisé');
    const next = queue.shift();
    return { text: next.text ?? '', toolCalls: next.toolCalls ?? [] };
  };
  return { chat, calls };
}
const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
const reply = (text, ...toolCalls) => ({ text, toolCalls });

function harness(opts = {}) {
  const { guild, log, makeChannel, nextId } = makeGuild();
  const said = [];
  const confirms = [];
  const say = async (content) => said.push(content);
  const confirm = async (o) => {
    confirms.push(o);
    return opts.confirmAnswer ?? true;
  };
  return { guild, log, makeChannel, nextId, said, confirms, say, confirm };
}

const CFG = {
  approval: false,
  maxSteps: 6,
  model: 'ministral-14b-2512',
  categories: { read: true, create: true, edit: true, send: true, delete: false },
};

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

test('planification : lecture seule + submit_plan ; exécution : catégories activées seulement', () => {
  const planning = tools.specsFor({ read: true, create: true, delete: true }, { planning: true }).map((s) => s.function.name);
  assert.deepEqual(planning.sort(), ['list_channels', 'list_roles', 'read_channel_messages', 'submit_plan']);

  const exec = tools.specsFor(CFG.categories).map((s) => s.function.name);
  assert.ok(exec.includes('create_text_channel'));
  assert.ok(exec.includes('set_channel_access'));
  assert.ok(!exec.includes('delete_channel'), 'suppression désactivée par défaut');
  assert.ok(!exec.includes('submit_plan'));
});

test('création de salon : nom normalisé, catégorie vérifiée dans le cache', async () => {
  const { guild, makeChannel, nextId } = makeGuild();
  const cat = makeChannel(nextId(), 'Infos', ChannelType.GuildCategory);
  const ctx = { guild, traceChannelId: TRACE, budget: { actions: 0 }, confirm: async () => true };
  const allowed = tools.allowedNames(CFG.categories);

  const ok = await tools.execute('create_text_channel', { name: 'Mes Annonces', category_id: cat.id, topic: 'Infos' }, ctx, allowed);
  assert.equal(ok.ok, true);
  const created = [...guild.channels.cache.values()].find((c) => c.name === 'mes-annonces');
  assert.ok(created, 'nom avec tirets et minuscules');
  assert.equal(created.parentId, cat.id);

  const bad = await tools.execute('create_text_channel', { name: 'x', category_id: '123' }, ctx, allowed);
  assert.equal(bad.ok, false, 'catégorie inconnue refusée');
  assert.match(bad.text, /catégorie introuvable/);
});

test('identifiants inventés et outils non autorisés sont refusés sans rien faire', async () => {
  const { guild, makeChannel } = makeGuild();
  makeChannel('830000000000000999', 'general', ChannelType.GuildText);
  const ctx = { guild, traceChannelId: TRACE, budget: { actions: 0 }, confirm: async () => true };

  const unknown = await tools.execute('send_message', { channel_id: '830000000000000998', content: 'bonjour' }, ctx, tools.allowedNames(CFG.categories));
  assert.equal(unknown.ok, false);

  const denied = await tools.execute('delete_channel', { channel_id: '830000000000000999' }, ctx, tools.allowedNames(CFG.categories));
  assert.equal(denied.ok, false);
  assert.match(denied.text, /non autorisé/);
  assert.equal(guild.channels.cache.has('830000000000000999'), true);
});

test('accès d’un rôle : allow / deny / default, et @everyone via l’id du serveur', async () => {
  const { guild, log, makeChannel, nextId } = makeGuild();
  const ch = makeChannel(nextId(), 'staff', ChannelType.GuildText);
  const role = await guild.roles.create({ name: 'Modo' });
  const ctx = { guild, traceChannelId: TRACE, budget: { actions: 0 }, confirm: async () => true };
  const allowed = tools.allowedNames(CFG.categories);

  await tools.execute('set_channel_access', { channel_id: ch.id, role_id: role.id, view: 'allow', send: 'deny' }, ctx, allowed);
  await tools.execute('set_channel_access', { channel_id: ch.id, role_id: G, view: 'deny' }, ctx, allowed);
  const [first, second] = log.overwrites;
  assert.deepEqual(first.overwrite, { ViewChannel: true, SendMessages: false });
  assert.equal(first.roleId, role.id);
  assert.deepEqual(second.overwrite, { ViewChannel: false });
  assert.equal(second.roleId, G);

  const none = await tools.execute('set_channel_access', { channel_id: ch.id, role_id: role.id }, ctx, allowed);
  assert.equal(none.ok, false);
});

test('édition : sujet refusé sur un salon vocal, rien à modifier refusé', async () => {
  const { guild, makeChannel, nextId } = makeGuild();
  const voice = makeChannel(nextId(), 'Salon vocal', ChannelType.GuildVoice);
  const ctx = { guild, traceChannelId: TRACE, budget: { actions: 0 }, confirm: async () => true };
  const allowed = tools.allowedNames(CFG.categories);

  const topic = await tools.execute('edit_channel', { channel_id: voice.id, topic: 'nope' }, ctx, allowed);
  assert.equal(topic.ok, false);
  const empty = await tools.execute('edit_channel', { channel_id: voice.id }, ctx, allowed);
  assert.equal(empty.ok, false);
  const renamed = await tools.execute('edit_channel', { channel_id: voice.id, name: 'Lounge' }, ctx, allowed);
  assert.equal(renamed.ok, true);
  assert.equal(voice.name, 'lounge');
});

test('message : pas de mention de masse, texte vide refusé', async () => {
  const { guild, log, makeChannel, nextId } = makeGuild();
  const ch = makeChannel(nextId(), 'annonces', ChannelType.GuildText);
  const ctx = { guild, traceChannelId: TRACE, budget: { actions: 0 }, confirm: async () => true };
  const allowed = tools.allowedNames(CFG.categories);

  const sent = await tools.execute('send_message', { channel_id: ch.id, content: ' Bienvenue @everyone ' }, ctx, allowed);
  assert.equal(sent.ok, true);
  const last = log.sent.at(-1);
  assert.deepEqual(last.options.allowedMentions, { parse: [] });
  assert.equal(last.options.content, 'Bienvenue @everyone');

  const empty = await tools.execute('send_message', { channel_id: ch.id, content: '   ' }, ctx, allowed);
  assert.equal(empty.ok, false);
});

test('suppression : confirmation obligatoire, salon de suivi protégé, @everyone protégé', async () => {
  const { guild, log, makeChannel, nextId } = makeGuild();
  const ch = makeChannel(nextId(), 'vieux', ChannelType.GuildText);
  const asks = [];
  const ctx = {
    guild,
    traceChannelId: TRACE,
    budget: { actions: 0 },
    confirm: async (o) => {
      asks.push(o);
      return false;
    },
  };
  const allowed = new Set(['delete_channel', 'delete_role']);

  const refused = await tools.execute('delete_channel', { channel_id: ch.id }, ctx, allowed);
  assert.equal(refused.ok, false);
  assert.equal(guild.channels.cache.has(ch.id), true, 'refus : rien supprimé');
  assert.equal(asks.length, 1);
  assert.match(asks[0].text, /supprimer/);

  const trace = await tools.execute('delete_channel', { channel_id: TRACE }, { ...ctx, confirm: async () => true }, allowed);
  assert.equal(trace.ok, false, 'le salon de suivi ne se supprime jamais');
  assert.equal(log.deleted.length, 0);

  const everyone = await tools.execute('delete_role', { role_id: G }, { ...ctx, confirm: async () => true }, allowed);
  assert.equal(everyone.ok, false);

  const yes = await tools.execute('delete_channel', { channel_id: ch.id }, { ...ctx, confirm: async () => true }, allowed);
  assert.equal(yes.ok, true);
  assert.deepEqual(log.deleted, [ch.id]);
});

test('budget : au plus MAX_ACTIONS actions modifiantes par exécution', async () => {
  const { guild } = makeGuild();
  const ctx = { guild, traceChannelId: TRACE, budget: { actions: 0 }, confirm: async () => true };
  const allowed = tools.allowedNames(CFG.categories);
  let refused = 0;
  for (let i = 0; i < tools.MAX_ACTIONS + 2; i++) {
    const r = await tools.execute('create_category', { name: `cat ${i}` }, ctx, allowed);
    if (!r.ok) refused++;
  }
  assert.equal(ctx.budget.actions, tools.MAX_ACTIONS);
  assert.equal(refused, 2);
});

test('erreur Discord : renvoyée au modèle sous forme de texte, sans lever d’exception', async () => {
  const { guild } = makeGuild();
  guild.channels.create = async () => {
    throw new Error('Missing Permissions');
  };
  const ctx = { guild, traceChannelId: TRACE, budget: { actions: 0 }, confirm: async () => true };
  const r = await tools.execute('create_category', { name: 'x' }, ctx, tools.allowedNames(CFG.categories));
  assert.equal(r.ok, false);
  assert.match(r.text, /Missing Permissions/);
});

// ---------------------------------------------------------------------------
// Moteur
// ---------------------------------------------------------------------------

test('exécution directe : chaque action est une ligne de trace, puis un résumé', async () => {
  const h = harness();
  const script = scriptedChat([
    reply('', call('a', 'list_channels', {})),
    reply('', call('b', 'create_category', { name: 'Communauté' })),
    reply('', call('c', 'create_text_channel', { name: 'discussion' })),
    reply('Serveur prêt.'),
  ]);
  const res = await runAgent({ guild: h.guild, goal: 'Créer une section Communauté', cfg: CFG, traceChannelId: TRACE, say: h.say, confirm: h.confirm, chat: script.chat });
  assert.equal(res.status, 'done');
  assert.equal(res.actions, 2);
  assert.ok(h.said.some((s) => s.includes('Créer la catégorie')), 'trace de la création');
  assert.ok(h.said.some((s) => s.includes('Lecture des salons')), 'trace de la lecture');
  assert.ok(h.said.at(-1).includes('Terminé'));
  assert.ok(h.said.at(-1).includes('Serveur prêt.'));
  assert.ok([...h.guild.channels.cache.values()].some((c) => c.name === 'Communauté'), 'catégorie créée');
  assert.ok([...h.guild.channels.cache.values()].some((c) => c.name === 'discussion'), 'salon créé');
});

test('avec validation : phase de plan en lecture seule, plan affiché, validé, puis exécuté', async () => {
  const h = harness();
  const script = scriptedChat([
    reply('', call('p1', 'list_channels', {})),
    reply('', call('p2', 'create_category', { name: 'interdit en préparation' })), // refusé : outil absent
    reply('', call('p3', 'submit_plan', { plan: '1. Créer la catégorie Annonces\n2. Créer #news' })),
    reply('Fait.', call('e1', 'create_category', { name: 'Annonces' })),
    reply('Fini.'),
  ]);
  const res = await runAgent({
    guild: h.guild,
    goal: 'Section annonces',
    cfg: { ...CFG, approval: true },
    traceChannelId: TRACE,
    say: h.say,
    confirm: h.confirm,
    chat: script.chat,
  });
  assert.equal(res.status, 'done');
  assert.deepEqual(script.calls[0].tools.sort(), ['list_channels', 'list_roles', 'read_channel_messages', 'submit_plan']);
  assert.ok(!script.calls[3].tools.includes('submit_plan'), 'exécution : plus de submit_plan');
  assert.ok(h.said.some((s) => s.includes('Plan proposé') && s.includes('Créer la catégorie Annonces')));
  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].yes, 'Lancer');
  assert.equal(h.confirms[0].timeoutMs, PLAN_TIMEOUT_MS);
  assert.ok(h.said.some((s) => s.includes('non autorisé ici')), 'la création en préparation est refusée');
  assert.ok([...h.guild.channels.cache.values()].some((c) => c.name === 'Annonces'));
  assert.ok(![...h.guild.channels.cache.values()].some((c) => c.name.includes('interdit')));
});

test('plan refusé : aucune modification, statut cancelled', async () => {
  const h = harness({ confirmAnswer: false });
  const script = scriptedChat([reply('', call('p', 'submit_plan', { plan: '1. Tout supprimer' }))]);
  const before = h.guild.channels.cache.size;
  const res = await runAgent({ guild: h.guild, goal: 'x', cfg: { ...CFG, approval: true }, traceChannelId: TRACE, say: h.say, confirm: h.confirm, chat: script.chat });
  assert.equal(res.status, 'cancelled');
  assert.equal(res.actions, 0);
  assert.equal(h.guild.channels.cache.size, before);
  assert.ok(h.said.some((s) => s.includes('Plan annulé')));
});

test('étapes épuisées : statut limit et message explicite', async () => {
  const h = harness();
  const forever = {
    chat: async () => ({ text: '', toolCalls: [call(`x${Math.random()}`, 'list_channels', {})] }),
  };
  const res = await runAgent({ guild: h.guild, goal: 'boucle', cfg: { ...CFG, maxSteps: 3 }, traceChannelId: TRACE, say: h.say, confirm: h.confirm, chat: forever.chat });
  assert.equal(res.status, 'limit');
  assert.ok(h.said.some((s) => s.includes('Étapes épuisées (3)')));
});

test('erreur du modèle : statut error, message dans le salon, rien ne plante', async () => {
  const h = harness();
  const res = await runAgent({
    guild: h.guild,
    goal: 'x',
    cfg: CFG,
    traceChannelId: TRACE,
    say: h.say,
    confirm: h.confirm,
    chat: async () => {
      throw new Error('Mistral ne répond pas (délai dépassé).');
    },
  });
  assert.equal(res.status, 'error');
  assert.ok(h.said.some((s) => s.includes('Mistral ne répond pas')));
});

test('suppression demandée par le modèle : confirmation avec délai dédié', async () => {
  const h = harness({ confirmAnswer: false });
  const { guild } = h;
  const target = h.makeChannel(h.nextId(), 'a-supprimer', ChannelType.GuildText);
  const script = scriptedChat([
    reply('', call('d', 'delete_channel', { channel_id: target.id })),
    reply('Refus respecté.'),
  ]);
  const res = await runAgent({
    guild,
    goal: 'nettoyer',
    cfg: { ...CFG, categories: { ...CFG.categories, delete: true } },
    traceChannelId: TRACE,
    say: h.say,
    confirm: h.confirm,
    chat: script.chat,
  });
  assert.equal(res.status, 'done');
  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].timeoutMs, DELETE_TIMEOUT_MS);
  assert.equal(guild.channels.cache.has(target.id), true, 'refusé : le salon reste');
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

let stored = new Map();
beforeEach(() => {
  stored = new Map();
  store.getModuleConfig = (g, m, defaults) => ({ ...structuredClone(defaults), ...(stored.get(`${g}:${m}`) ?? {}) });
  store.updateModuleConfig = (g, m, cfg) => stored.set(`${g}:${m}`, structuredClone(cfg));
});

test('configuration : valeurs par défaut sûres (suppression désactivée, validation activée)', () => {
  const cfg = agent.cfgOf(G);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.approval, true);
  assert.equal(cfg.categories.delete, false);
  assert.equal(cfg.categories.create, true);
});

test('panneau /config : rendu principal et outils sans erreur', () => {
  const { guild } = makeGuild();
  const main = agent.render('main', guild);
  assert.ok(main.embeds.length === 1);
  const tools = agent.render('tools', guild);
  assert.ok(tools.components.length >= 2);
});

test('validation par bouton : seul un administrateur peut valider, et le clic débloque l’action', async () => {
  const { makeChannel, nextId } = makeGuild();
  const channel = makeChannel(nextId(), 'suivi', ChannelType.GuildText);
  const pending = agent.askConfirm(channel, { text: 'Lancer ?', yes: 'Lancer', no: 'Annuler', timeoutMs: 1000 });
  const token = [...agent.decisions.keys()][0];
  assert.ok(token, 'une demande est en attente');

  const member = { memberPermissions: { has: () => false }, user: { username: 'lea' }, reply: async (p) => p, update: async (p) => p };
  const refused = await agent.handleInteraction({ ...member, customId: `agent:ok:${token}` });
  assert.match(refused.embeds[0].data.description, /administrateurs/);
  assert.equal(agent.decisions.has(token), true, 'refus d’un non-admin : toujours en attente');

  const admin = { memberPermissions: { has: (f) => f === PermissionFlagsBits.Administrator }, user: { username: 'admin' }, reply: async (p) => p, update: async (p) => p };
  await agent.handleInteraction({ ...admin, customId: `agent:ok:${token}` });
  assert.equal(await pending, true);
  assert.equal(agent.decisions.has(token), false);
});

test('demande expirée : les boutons ne font plus rien', async () => {
  const reply = async (p) => p;
  const res = await agent.handleInteraction({ customId: 'agent:ok:inconnu', reply, memberPermissions: { has: () => true } });
  assert.match(res.embeds[0].data.description, /plus active/);
});
