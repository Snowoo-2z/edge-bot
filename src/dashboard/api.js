// Routes JSON du tableau de bord. Chaque route agit sur les mêmes données que /config et les commandes :
// les réglages passent par store.js (même cache mémoire), donc le bot applique les changements tout de suite.
const { ChannelType } = require('discord.js');
const store = require('../store');
const welcome = require('../modules/welcome');
const levels = require('../modules/levels');
const suggestions = require('../modules/suggestions');
const giveaways = require('../modules/giveaways');
const links = require('../modules/links');
const logsModule = require('../modules/logs');
const moderation = require('../modules/moderation');
const ticket = require('../modules/ticket');
const security = require('../modules/security');
const reactionRoles = require('../modules/reaction-roles');
const ai = require('../modules/ai');
const aiClient = require('../ai-client');
const backup = require('../backup');
const embedModule = require('../modules/embed');
const leveling = require('../leveling');
const { renderWelcomeCard, THEMES, THEME_LIST, DEFAULT_THEME } = require('../welcome-image');
const { renderLevelCard, LEVEL_DEFAULT_THEME } = require('../level-card');
const { renderLeaderboardCard } = require('../leaderboard-card');
const validate = require('./validate');
const { HttpError, sendJson, sendError, sendBuffer, readJson, readImage } = require('./http');
const auth = require('./auth');

const TEXT_CHANNEL_TYPES = validate.TEXT_KINDS;
const MAX_TEMPLATES = 10;
const EMBED_IMAGE_KINDS = ['image', 'thumbnail'];

// Modules dont les réglages se modifient par PUT /modules/:id.
const MODULES = {
  welcome: { module: welcome, sanitize: validate.sanitizeWelcome },
  levels: { module: levels, sanitize: validate.sanitizeLevels },
  suggestions: { module: suggestions, sanitize: validate.sanitizeSuggestions },
  giveaways: { module: giveaways, sanitize: validate.sanitizeGiveaways },
  links: { module: links, sanitize: validate.sanitizeLinks },
  ticket: { module: ticket, sanitize: validate.sanitizeTicket },
  logs: { module: logsModule, sanitize: validate.sanitizeLogs },
  moderation: { module: moderation, sanitize: validate.sanitizeModeration },
  backups: { module: backup, sanitize: validate.sanitizeBackups },
  security: { module: security, sanitize: validate.sanitizeSecurity },
  ai: { module: ai, sanitize: validate.sanitizeAi },
};

// Modules dont les données passent par des routes dédiées (panneaux, pairs, publication) :
// pas de PUT générique, pour ne pas écraser les panneaux.
const EXTRA_MODULES = { [reactionRoles.ID]: reactionRoles };

const ALL_MODULE_IDS = [...Object.keys(MODULES), embedModule.ID, ...Object.keys(EXTRA_MODULES)];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Erreurs métier des sauvegardes (nom de confirmation, tâche déjà en cours…) : réponse 400 lisible.
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof backup.BackupError || err instanceof reactionRoles.ReactionRoleError) throw new HttpError(400, err.message);
    throw err;
  }
}

const backupRow = (r) => ({ id: r.id, kind: r.kind, guildName: r.guild_name, createdAt: r.created_at, summary: r.summary ?? {} });

// Routeur minimal : motif avec paramètres (:nom) -> gestionnaire.
const routes = [];
function route(method, pattern, handler, options = {}) {
  const names = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:([a-zA-Z]+)/g, (_, name) => {
        names.push(name);
        return '([^/]+)';
      }) +
      '$',
  );
  routes.push({ method, regex, names, handler, auth: options.auth ?? true });
}

// Nom affiché d'un identifiant (membre du serveur, sinon utilisateur connu du bot), ou null.
function nameOf(guild, id) {
  if (!id) return null;
  return guild.members.cache.get(id)?.displayName ?? guild.client?.users?.cache?.get(id)?.username ?? null;
}

function truncateText(value, max) {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function createApi({ getClient }) {
  // Serveur Discord demandé. Erreurs lisibles si le bot n'est pas connecté ou n'est pas sur ce serveur.
  function resolveGuild(params) {
    const client = getClient();
    if (!client?.isReady?.()) throw new HttpError(503, 'Le bot n’est pas connecté à Discord pour le moment.');
    const guild = client.guilds.cache.get(params.gid);
    if (!guild) throw new HttpError(404, 'Serveur introuvable : le bot n’y est pas présent.');
    return { client, guild };
  }

  function configOf(guild, moduleId) {
    const def = moduleId === embedModule.ID ? embedModule : (MODULES[moduleId]?.module ?? EXTRA_MODULES[moduleId]);
    return store.getModuleConfig(guild.id, moduleId, def.DEFAULTS);
  }

  function saveConfig(guild, moduleId, cfg) {
    store.updateModuleConfig(guild.id, moduleId, cfg);
    return cfg;
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  route('GET', '/api/session', async ({ req, res }) => {
    sendJson(res, 200, { authenticated: auth.isAuthenticated(req) });
  }, { auth: false });

  route('POST', '/api/login', async ({ req, res }) => {
    const body = await readJson(req);
    const result = auth.login(req, body.password);
    if (!result.ok) {
      if (result.status === 429) {
        return sendError(res, 429, `Trop de tentatives. Réessaie dans ${Math.ceil(result.retryAfter / 60)} min.`, {
          'Retry-After': String(result.retryAfter),
        });
      }
      return sendError(res, 401, 'Mot de passe incorrect.');
    }
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(result.token) });
  }, { auth: false });

  route('POST', '/api/logout', async ({ req, res }) => {
    auth.logout(req);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }, { auth: false });

  // -------------------------------------------------------------------------
  // Bot et serveurs
  // -------------------------------------------------------------------------

  route('GET', '/api/bot', async ({ res }) => {
    const client = getClient();
    const ready = Boolean(client?.isReady?.());
    const guilds = ready
      ? [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) }))
      : [];
    sendJson(res, 200, { ready, tag: ready ? client.user.tag : null, guilds, uptime: Math.round(process.uptime()) });
  });

  route('GET', '/api/guilds/:gid/state', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const channels = [...guild.channels.cache.values()]
      .filter((c) => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory].includes(c.type))
      .map((c) => ({ id: c.id, name: c.name, type: c.type, parent: c.parent?.name ?? null, position: c.rawPosition ?? 0 }))
      .sort((a, b) => a.position - b.position);
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor }));

    const modules = {};
    for (const id of ALL_MODULE_IDS) modules[id] = configOf(guild, id);

    sendJson(res, 200, {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      meta: { channels, roles },
      themes: { cards: THEME_LIST, defaultWelcome: DEFAULT_THEME, defaultLevels: LEVEL_DEFAULT_THEME },
      // Textes du ticket (libellés et limites) : la vue du tableau de bord suit ticket.js.
      ticketTexts: ticket.TEXTS.map(({ key, label, style, max }) => ({ key, label, style, max })),
      logCategories: logsModule.CATEGORIES.map(({ key, label, emoji }) => ({ key, label, emoji })),
      moderationCommands: moderation.COMMAND_KEYS.map((key) => ({ key, label: moderation.COMMANDS[key].label, permission: moderation.COMMANDS[key].perm_label })),
      modules,
    });
  });

  // Contexte d'un message de test : texte, salon (optionnel), mention du bot (simulée), rôles et noms.
  const aiContext = (guild, body) => {
    const channelId = validate.isSnowflake(body?.channelId) ? body.channelId : undefined;
    const roleNames = Object.fromEntries([...guild.roles.cache.values()].map((r) => [r.id, r.name]));
    return {
      text: ai.cleanUserText(body?.message),
      channelId,
      mentioned: body?.mentioned === true,
      serverName: guild.name,
      channelName: channelId ? guild.channels.cache.get(channelId)?.name : undefined,
      authorName: 'Test (tableau de bord)',
      roleNames,
      memberRoleIds: [],
      mentionedRoleIds: [],
      now: new Date(),
    };
  };

  // Aperçu du prompt final pour un message donné : aucun appel à Mistral.
  // Les outils qui seraient proposés au modèle sont listés (noms seulement).
  route('POST', '/api/guilds/:gid/ai/preview', async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    const body = await readJson(req);
    const cfg = configOf(guild, ai.ID);
    const ctx = aiContext(guild, body);
    const canStaySilent = ai.staySilentAllowed(cfg, ctx.mentioned);
    const { system, active, grants } = ai.composeSystemPrompt(cfg, { ...ctx, canStaySilent });
    const tools = ai.toolsFor(cfg, grants, { staySilent: canStaySilent }).map((t) => t.function.name);
    sendJson(res, 200, {
      system,
      active: active.map((a) => ({ id: a.id, text: a.text })),
      tools,
    });
  });

  // Test réel : un appel à Mistral avec le prompt courant (consomme des tokens).
  // Les outils sont simulés : rien n'est enregistré ni attribué ; les actions demandées sont renvoyées.
  route('POST', '/api/guilds/:gid/ai/test', async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    const body = await readJson(req);
    const raw = String(body?.message ?? '');
    if (raw.length > ai.LIMITS.testMessageChars) {
      throw new HttpError(400, `Message de test : ${ai.LIMITS.testMessageChars} caractères maximum.`);
    }
    const ctx = aiContext(guild, body);
    if (!ctx.text) throw new HttpError(400, 'Message de test vide.');
    const cfg = configOf(guild, ai.ID);
    try {
      const { text, actions, silent } = await ai.answerDetailed(cfg, ctx.text, ctx);
      sendJson(res, 200, {
        reply: text.slice(0, ai.LIMITS.reply),
        decision: silent === null ? 'reply' : 'silent',
        reason: silent ?? '',
        actions: actions.map((a) => ({ name: a.name })),
      });
    } catch (err) {
      if (err instanceof aiClient.AiError) throw new HttpError(err.code === 'no_key' ? 503 : 502, err.message);
      throw err;
    }
  });

  // Journal des décisions de l'IA (répondre ou se taire, avec la raison) : 100 dernières.
  route('GET', '/api/guilds/:gid/ai/decisions', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const rows = await store.listAiDecisions(guild.id, 100);
    sendJson(res, 200, {
      rows: rows.map((r) => ({
        at: r.created_at,
        channelName: r.channel_id ? (guild.channels.cache.get(r.channel_id)?.name ?? r.channel_id) : null,
        userName: r.user_id ? nameOf(guild, r.user_id) : null,
        decision: r.decision,
        reason: r.reason,
        excerpt: r.excerpt,
      })),
    });
  });

  // Mémoire des membres (IA) : liste du serveur, modification et effacement par personne.
  // Réservé au tableau de bord (propriétaire) : les membres ne voient pas ces notes.
  route('GET', '/api/guilds/:gid/ai/memories', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const rows = await store.listAiMemories(guild.id);
    sendJson(res, 200, {
      rows: rows.map((r) => ({
        userId: r.user_id,
        userName: nameOf(guild, r.user_id),
        notes: Array.isArray(r.notes) ? r.notes : [],
        updatedAt: r.updated_at,
      })),
      maxNotes: ai.LIMITS.memoryMaxNotes,
    });
  });

  route('PUT', '/api/guilds/:gid/ai/memories/:uid', async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    if (!validate.isSnowflake(params.uid)) throw new HttpError(400, 'Identifiant de membre invalide.');
    const body = await readJson(req);
    const cfg = configOf(guild, ai.ID);
    const notes = validate.aiNotes(body?.notes, Math.min(cfg.memoryMaxNotes, ai.LIMITS.memoryMaxNotes));
    await store.saveAiMemory(guild.id, params.uid, notes);
    sendJson(res, 200, { ok: true, count: notes.length });
  });

  route('DELETE', '/api/guilds/:gid/ai/memories/:uid', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    if (!validate.isSnowflake(params.uid)) throw new HttpError(400, 'Identifiant de membre invalide.');
    await store.deleteAiMemory(guild.id, params.uid);
    sendJson(res, 200, { ok: true });
  });

  route('PUT', '/api/guilds/:gid/modules/:module', async ({ req, res, params }) => {
    const def = MODULES[params.module];
    if (!def) throw new HttpError(404, 'Module inconnu.');
    const { guild } = resolveGuild(params);
    const body = await readJson(req);
    const current = configOf(guild, params.module);
    const patch = def.sanitize(guild, body, current);
    const next = { ...current, ...patch };
    // Objets imbriqués : fusion, pour qu'une mise à jour partielle ne supprime pas les autres clés.
    for (const key of ['texts', 'roles', 'categories', 'channels']) {
      if (patch[key]) next[key] = { ...(current[key] ?? {}), ...patch[key] };
    }
    saveConfig(guild, params.module, next);
    console.log(`[dashboard] module ${params.module} modifié (serveur ${guild.name}).`);
    sendJson(res, 200, { config: next });
  });

  // -------------------------------------------------------------------------
  // Niveaux, suggestions, giveaways (lectures et actions)
  // -------------------------------------------------------------------------

  route('GET', '/api/guilds/:gid/levels', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const top = leveling.guildRanking(guild.id).slice(0, 50);
    const missing = top.map((r) => r.userId).filter((id) => !guild.members.cache.has(id));
    if (missing.length) {
      await guild.members.fetch({ user: missing }).catch(() => null);
    }
    const rows = top.map((rec, i) => ({
      rank: i + 1,
      userId: rec.userId,
      name: guild.members.cache.get(rec.userId)?.displayName ?? `Membre ${rec.userId.slice(-4)}`,
      level: leveling.levelFromXp(rec.xp),
      xp: rec.xp,
      voiceSeconds: rec.voiceSeconds,
    }));
    sendJson(res, 200, { rows, total: leveling.guildRanking(guild.id).length });
  });

  // Journal (module Logs) : pages de 50 lignes, la plus récente d'abord.
  route('GET', '/api/guilds/:gid/logs', async ({ res, params, query }) => {
    const { guild } = resolveGuild(params);
    const category = query.get('category') || null;
    if (category && !logsModule.CATEGORY_KEYS.includes(category)) throw new HttpError(400, 'Catégorie inconnue.');
    const before = query.get('before') || null;
    if (before && Number.isNaN(Date.parse(before))) throw new HttpError(400, 'Curseur invalide.');
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.get('limit') ?? '50', 10) || 50));
    const data = await store.loadLogs({ guildId: guild.id, category, before, limit });
    const rows = data.map((r) => ({
      id: String(r.id),
      category: r.category,
      event: r.event,
      title: r.title,
      description: r.description,
      actorId: r.actor_id,
      actorName: nameOf(guild, r.actor_id),
      targetId: r.target_id,
      targetName: nameOf(guild, r.target_id),
      channelId: r.channel_id,
      createdAt: r.created_at,
    }));
    sendJson(res, 200, { rows, nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt : null });
  });

  // Avertissements du serveur (ou d'un membre : ?user=ID).
  route('GET', '/api/guilds/:gid/warnings', async ({ res, params, query }) => {
    const { guild } = resolveGuild(params);
    const user = query.get('user') || null;
    if (user && !validate.isSnowflake(user)) throw new HttpError(400, 'Identifiant de membre invalide.');
    const data = await store.loadWarnings(guild.id, user);
    const rows = data.map((w) => ({
      id: w.id,
      userId: w.user_id,
      userName: nameOf(guild, w.user_id),
      moderatorId: w.moderator_id,
      moderatorName: nameOf(guild, w.moderator_id),
      reason: w.reason,
      createdAt: w.created_at,
    }));
    sendJson(res, 200, { rows });
  });

  // Retrait d'un avertissement depuis le tableau de bord (journalisé comme une action de modération).
  route('DELETE', '/api/guilds/:gid/warnings/:id', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const id = Number.parseInt(params.id, 10);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Numéro d’avertissement invalide.');
    const removed = await store.deleteWarning(guild.id, id);
    if (!removed) throw new HttpError(404, 'Avertissement introuvable.');
    logsModule.log(guild, {
      category: 'moderation',
      event: 'unwarn',
      title: 'Avertissement retiré (tableau de bord)',
      targetId: removed.user_id,
      fields: [
        { name: 'Membre', value: `<@${removed.user_id}>`, inline: true },
        { name: 'Numéro', value: `#${id}`, inline: true },
        { name: 'Raison d’origine', value: truncateText(removed.reason, 300) },
      ],
    });
    console.log(`[dashboard] avertissement ${id} retiré (serveur ${guild.name}).`);
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/guilds/:gid/suggestions', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const rows = [...suggestions.suggestions.values()]
      .filter((s) => s.guild_id === guild.id)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, 100)
      .map((s) => ({
        id: s.id,
        content: s.content,
        closed: Boolean(s.closed),
        up: s.up_ids.length,
        down: s.down_ids.length,
        endsAt: s.ends_at,
        createdAt: s.created_at,
        authorId: s.author_id,
      }));
    sendJson(res, 200, { rows });
  });

  route('GET', '/api/guilds/:gid/giveaways', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const rows = [...giveaways.giveaways.values()]
      .filter((g) => g.guild_id === guild.id)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, 100)
      .map((g) => ({
        id: g.id,
        prize: g.prize,
        winners: g.winners_count,
        participants: g.participant_ids.length,
        winnerIds: g.winner_ids,
        channelId: g.channel_id,
        endsAt: g.ends_at,
        ended: Boolean(g.ended),
      }));
    sendJson(res, 200, { rows });
  });

  route('POST', '/api/guilds/:gid/giveaways/:id/end', async ({ res, params }) => {
    resolveGuild(params);
    const g = giveaways.giveaways.get(params.id);
    if (!g || g.guild_id !== params.gid) throw new HttpError(404, 'Giveaway introuvable.');
    if (g.ended) throw new HttpError(409, 'Ce giveaway est déjà terminé.');
    await giveaways.endGiveaway(g);
    console.log(`[dashboard] giveaway ${g.id} terminé à la main.`);
    sendJson(res, 200, { ok: true, winnerIds: g.winner_ids });
  });

  // -------------------------------------------------------------------------
  // Tickets : publication du panneau et images / GIF
  // -------------------------------------------------------------------------

  route('POST', '/api/guilds/:gid/ticket/publish', async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    const body = await readJson(req);
    const channel = guild.channels.cache.get(body.channelId);
    if (!channel || !TEXT_CHANNEL_TYPES.includes(channel.type)) {
      throw new HttpError(400, 'Choisis un salon texte pour publier le panneau.');
    }
    await ticket.publishPanel(guild, configOf(guild, ticket.ID), channel);
    console.log(`[dashboard] panneau de tickets publié dans #${channel.name} (serveur ${guild.name}).`);
    sendJson(res, 200, { ok: true });
  });

  route('POST', '/api/guilds/:gid/ticket/assets/:kind', async ({ req, res, params }) => {
    if (!['image', 'gif'].includes(params.kind)) throw new HttpError(404, 'Type de fichier inconnu.');
    const { guild } = resolveGuild(params);
    const file = await readImage(req);
    if (params.kind === 'gif' && file.ext !== '.gif') throw new HttpError(415, 'Pour le GIF du ticket, envoie un fichier .gif.');
    const cfg = configOf(guild, ticket.ID);
    const filePath = `${guild.id}/${params.kind}${file.ext}`;
    const url = await store.uploadAsset(filePath, file.buffer, file.mime);
    const previous = cfg.assets?.[params.kind];
    if (previous?.path && previous.path !== filePath) await store.deleteAsset(previous.path);
    cfg.assets = { ...(cfg.assets ?? {}), [params.kind]: { path: filePath, url } };
    saveConfig(guild, ticket.ID, cfg);
    sendJson(res, 200, { config: cfg });
  });

  route('DELETE', '/api/guilds/:gid/ticket/assets/:kind', async ({ res, params }) => {
    if (!['image', 'gif'].includes(params.kind)) throw new HttpError(404, 'Type de fichier inconnu.');
    const { guild } = resolveGuild(params);
    const cfg = configOf(guild, ticket.ID);
    const asset = cfg.assets?.[params.kind];
    if (asset?.path) await store.deleteAsset(asset.path);
    cfg.assets = { ...(cfg.assets ?? {}), [params.kind]: null };
    saveConfig(guild, ticket.ID, cfg);
    sendJson(res, 200, { config: cfg });
  });

  // -------------------------------------------------------------------------
  // Créateur d'embed
  // -------------------------------------------------------------------------

  route('PUT', '/api/guilds/:gid/embed/draft', async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    const body = await readJson(req);
    const cfg = configOf(guild, embedModule.ID);
    cfg.draft = validate.sanitizeDraft(body);
    saveConfig(guild, embedModule.ID, cfg);
    sendJson(res, 200, { config: cfg });
  });

  route('POST', '/api/guilds/:gid/embed/templates', async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    const body = await readJson(req);
    const name = validate.text(body.name ?? '', 'Nom du modèle', 60, { required: true });
    const cfg = configOf(guild, embedModule.ID);
    if (Object.keys(cfg.templates ?? {}).length >= MAX_TEMPLATES) {
      throw new HttpError(400, `Maximum ${MAX_TEMPLATES} modèles. Supprime-en un avant.`);
    }
    const draft = validate.sanitizeDraft(body.draft ?? cfg.draft ?? {});
    cfg.templates = { ...(cfg.templates ?? {}), [`tpl${Date.now().toString(36)}`]: { name, data: draft } };
    saveConfig(guild, embedModule.ID, cfg);
    sendJson(res, 200, { config: cfg });
  });

  route('DELETE', '/api/guilds/:gid/embed/templates/:tid', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const cfg = configOf(guild, embedModule.ID);
    if (!cfg.templates?.[params.tid]) throw new HttpError(404, 'Modèle introuvable.');
    delete cfg.templates[params.tid];
    saveConfig(guild, embedModule.ID, cfg);
    sendJson(res, 200, { config: cfg });
  });

  route('POST', '/api/guilds/:gid/embed/image/:kind', async ({ req, res, params }) => {
    if (!EMBED_IMAGE_KINDS.includes(params.kind)) throw new HttpError(404, 'Type d’image inconnu.');
    const { guild } = resolveGuild(params);
    const file = await readImage(req);
    const url = await store.uploadAsset(`${guild.id}/embed/${params.kind}-${Date.now()}${file.ext}`, file.buffer, file.mime);
    const cfg = configOf(guild, embedModule.ID);
    cfg.draft = { ...(cfg.draft ?? {}), [params.kind]: url };
    saveConfig(guild, embedModule.ID, cfg);
    sendJson(res, 200, { config: cfg });
  });

  route('DELETE', '/api/guilds/:gid/embed/image/:kind', async ({ res, params }) => {
    if (!EMBED_IMAGE_KINDS.includes(params.kind)) throw new HttpError(404, 'Type d’image inconnu.');
    const { guild } = resolveGuild(params);
    const cfg = configOf(guild, embedModule.ID);
    cfg.draft = { ...(cfg.draft ?? {}), [params.kind]: '' };
    saveConfig(guild, embedModule.ID, cfg);
    sendJson(res, 200, { config: cfg });
  });

  route('POST', '/api/guilds/:gid/embed/send', async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    const body = await readJson(req);
    const channel = guild.channels.cache.get(body.channelId);
    if (!channel || !TEXT_CHANNEL_TYPES.includes(channel.type)) {
      throw new HttpError(400, 'Choisis un salon texte.');
    }
    const cfg = configOf(guild, embedModule.ID);
    const draft = validate.sanitizeDraft(cfg.draft ?? {});
    const isEmpty = !(draft.title || draft.description || draft.authorName || draft.footerText || draft.image || draft.thumbnail || draft.fields.length);
    if (isEmpty) throw new HttpError(400, 'L’embed est vide : ajoute au moins un titre ou une description.');
    await channel.send({ embeds: [embedModule.buildEmbed(draft)], allowedMentions: { parse: [] } });
    console.log(`[dashboard] embed envoyé dans #${channel.name} (serveur ${guild.name}).`);
    sendJson(res, 200, { ok: true });
  });

  // -------------------------------------------------------------------------
  // Aperçus PNG (données d'exemple, aucune donnée de membre réelle)
  // -------------------------------------------------------------------------

  route('GET', '/api/guilds/:gid/preview/:name', async ({ res, params, query }) => {
    const { guild } = resolveGuild(params);
    const theme = Object.hasOwn(THEMES, query.get('theme')) ? query.get('theme') : null;
    let png;
    if (params.name === 'welcome') {
      const fill = (s) =>
        String(s ?? '')
          .slice(0, 200)
          .replace(/\{user\}/g, 'Alice')
          .replace(/\{server\}/g, guild.name)
          .replace(/\{count\}/g, '42');
      png = await renderWelcomeCard({
        title: fill(query.get('title') ?? 'Bienvenue {user} !'),
        subtitle: fill(query.get('subtitle') ?? 'Membre n°{count} · {server}'),
        initial: 'A',
        showAvatar: query.get('avatar') !== '0',
        theme: theme ?? DEFAULT_THEME,
      });
    } else if (params.name === 'level') {
      png = await renderLevelCard({
        name: 'Alice',
        level: 7,
        xp: 5600,
        levelStartXp: 4900,
        nextLevelXp: 6400,
        rank: 3,
        voiceSeconds: 93_600,
        theme: theme ?? LEVEL_DEFAULT_THEME,
      });
    } else if (params.name === 'leaderboard') {
      const sample = ['Alice', 'Bob', 'Chloé', 'David', 'Emma', 'Fares', 'Gabin', 'Hana'];
      png = await renderLeaderboardCard({
        rows: sample.map((name, i) => ({ rank: i + 1, name, level: 12 - i, voiceSeconds: (8 - i) * 3600 * 4 })),
        theme: theme ?? LEVEL_DEFAULT_THEME,
        subtitle: 'Top 10 du serveur',
      });
    } else {
      throw new HttpError(404, 'Aperçu inconnu.');
    }
    sendBuffer(res, 200, png, 'image/png');
  });

  // -------------------------------------------------------------------------
  // Sécurité : verrouillage et levée manuels (les réglages passent par PUT /modules/security).
  // -------------------------------------------------------------------------

  route('POST', '/api/guilds/:gid/security/lock', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const cfg = security.cfgOf(guild.id);
    if (cfg.lockdown.active) throw new HttpError(400, 'Le serveur est déjà verrouillé.');
    await security.lockdown(guild, cfg, 'Verrouillage manuel (tableau de bord).');
    console.log(`[dashboard] serveur verrouillé (serveur ${guild.name}).`);
    sendJson(res, 200, { config: security.cfgOf(guild.id) });
  });

  route('POST', '/api/guilds/:gid/security/unlock', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const cfg = security.cfgOf(guild.id);
    if (!cfg.lockdown.active) throw new HttpError(400, 'Le serveur n’est pas verrouillé.');
    const error = await security.unlock(guild, cfg, 'tableau de bord');
    if (error) throw new HttpError(400, error);
    console.log(`[dashboard] verrouillage levé (serveur ${guild.name}).`);
    sendJson(res, 200, { config: security.cfgOf(guild.id) });
  });

  // -------------------------------------------------------------------------
  // Rôles par réaction : panneaux, rôles (emoji → rôle) et publication du message Discord.
  // -------------------------------------------------------------------------

  const rrPanel = '/api/guilds/:gid/reaction-roles/panels/:pid';

  route('POST', '/api/guilds/:gid/reaction-roles/panels', async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    const body = await readJson(req);
    sendJson(res, 200, await guarded(() => reactionRoles.createPanel(guild, body)));
  });

  route('PUT', rrPanel, async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    const body = await readJson(req);
    sendJson(res, 200, await guarded(() => reactionRoles.updatePanel(guild, params.pid, body)));
  });

  route('DELETE', rrPanel, async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    sendJson(res, 200, await guarded(() => reactionRoles.deletePanel(guild, params.pid)));
  });

  route('POST', `${rrPanel}/pairs`, async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    const body = await readJson(req);
    sendJson(res, 200, await guarded(() => reactionRoles.addPair(guild, params.pid, body?.emoji, body?.roleId)));
  });

  route('DELETE', `${rrPanel}/pairs/:key`, async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    sendJson(res, 200, await guarded(() => reactionRoles.removePair(guild, params.pid, params.key)));
  });

  route('POST', `${rrPanel}/publish`, async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    sendJson(res, 200, await guarded(() => reactionRoles.publishPanel(guild, params.pid)));
  });

  // -------------------------------------------------------------------------
  // Sauvegardes : création et restauration uniquement depuis ce tableau de bord.
  // La restauration exige le nom exact du serveur ; une sauvegarde de sécurité est faite avant.
  // -------------------------------------------------------------------------

  route('GET', '/api/guilds/:gid/backups', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const rows = await store.loadBackups(guild.id);
    sendJson(res, 200, { rows: rows.map(backupRow), running: backup.runningJobFor(guild.id), retention: backup.RETENTION });
  });

  route('POST', '/api/guilds/:gid/backups', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const job = await guarded(async () => backup.startBackup(guild));
    console.log(`[dashboard] sauvegarde lancée (serveur ${guild.name}).`);
    sendJson(res, 202, { job });
  });

  route('POST', '/api/guilds/:gid/backups/:id/restore', async ({ req, res, params }) => {
    const { guild } = resolveGuild(params);
    if (!UUID.test(params.id)) throw new HttpError(400, 'Identifiant de sauvegarde invalide.');
    const body = await readJson(req);
    const job = await guarded(() => backup.startRestore(guild, params.id, body?.confirmName));
    console.log(`[dashboard] restauration lancée (serveur ${guild.name}, sauvegarde ${params.id}).`);
    sendJson(res, 202, { job });
  });

  route('GET', '/api/guilds/:gid/jobs/:jobId', async ({ res, params }) => {
    const { guild } = resolveGuild(params);
    const job = backup.getJob(params.jobId);
    if (!job || job.guildId !== guild.id) throw new HttpError(404, 'Tâche introuvable.');
    sendJson(res, 200, { job });
  });

  return {
    // Retourne true si la requête a été traitée (réponse envoyée), false si la route n'existe pas.
    async dispatch(req, res, url) {
      const method = req.method;
      let matched = null;
      let params = {};
      let pathMatched = false;
      for (const r of routes) {
        const m = r.regex.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        matched = r;
        params = Object.fromEntries(r.names.map((name, i) => [name, decodeURIComponent(m[i + 1])]));
        break;
      }
      if (!matched) {
        if (!pathMatched) return false;
        sendError(res, 405, 'Méthode non autorisée.');
        return true;
      }

      // Protection CSRF : les requêtes qui modifient des données doivent porter un en-tête personnalisé
      // (impossible à envoyer depuis un autre site sans CORS) et venir de la même origine.
      if (method !== 'GET' && method !== 'HEAD') {
        if (req.headers['x-edge-dashboard'] !== '1') {
          sendError(res, 403, 'Requête refusée.');
          return true;
        }
        const origin = req.headers.origin;
        let sameOrigin = true;
        if (origin) {
          try {
            sameOrigin = new URL(origin).host === req.headers.host;
          } catch {
            sameOrigin = false;
          }
        }
        if (!sameOrigin) {
          sendError(res, 403, 'Origine refusée.');
          return true;
        }
      }

      if (matched.auth && !auth.isAuthenticated(req)) {
        sendError(res, 401, 'Connexion requise.');
        return true;
      }

      try {
        await matched.handler({ req, res, params, query: url.searchParams });
      } catch (err) {
        if (err instanceof HttpError || err instanceof validate.ValidationError) {
          sendError(res, err.status, err.message);
        } else {
          console.error('[dashboard] erreur :', err);
          sendError(res, 500, err.message?.slice(0, 200) || 'Erreur interne.');
        }
      }
      return true;
    },
  };
}

module.exports = { createApi, MAX_TEMPLATES };
