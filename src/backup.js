// Sauvegardes du serveur : rôles, salons (et leurs permissions), configurations des modules
// et messages publiés par le bot (30 au plus par salon).
//
//  - Création et restauration : uniquement depuis le tableau de bord (routes /api/guilds/:id/backups).
//  - Sauvegarde automatique : une fois par jour et par serveur (si le module est activé).
//  - Rétention : les 7 sauvegardes les plus récentes d'un serveur sont conservées.
//  - Restauration NON destructive : rien n'est supprimé. Les rôles et salons absents sont recréés ;
//    ceux qui existent déjà (même identifiant) sont gardés tels quels. Les identifiants des
//    configurations et des messages sont remappés vers les nouveaux identifiants.
//  - Avant chaque restauration, une sauvegarde « pre_restore » est créée. Si elle échoue, la restauration est annulée.
//  - Les données sont stockées dans la table Supabase edge_backups (jsonb), pas dans le bucket public.
const crypto = require('crypto');
const { ChannelType, OverwriteType } = require('discord.js');
const store = require('./store');
const { embed, toggleButton, row, moduleSelectRow } = require('./ui');
const { MODULE_LIST } = require('./modules/registry');
const { log: logEntry } = require('./modules/logs');

const ID = 'backups';
const DEFAULTS = { enabled: true };
const RETENTION = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
const MESSAGES_PER_CHANNEL = 30;
const MESSAGE_SCAN = 100;
const JOB_HISTORY = 50;
const SNOWFLAKE = /\d{17,20}/g;

// Types de salons sauvegardés : texte, annonces, vocal, catégorie.
const SAVED_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildCategory]);
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

class BackupError extends Error {}
const fail = (message) => {
  throw new BackupError(message);
};

const cfgOf = (guildId) => {
  const cfg = store.getModuleConfig(guildId, ID, DEFAULTS);
  cfg.enabled = cfg.enabled !== false;
  return cfg;
};

// ---------------------------------------------------------------------------
// Tâches de fond : une seule à la fois par serveur, historique borné en mémoire.
// ---------------------------------------------------------------------------
const jobs = new Map(); // jobId -> job
const runningByGuild = new Map(); // guildId -> jobId

function startJob(guildId, type, work) {
  if (runningByGuild.has(guildId)) fail('Une sauvegarde ou une restauration est déjà en cours sur ce serveur. Attends la fin.');
  const job = { id: crypto.randomUUID(), guildId, type, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
  jobs.set(job.id, job);
  runningByGuild.set(guildId, job.id);
  work().then(
    (result) => {
      job.status = 'done';
      job.result = result;
    },
    (err) => {
      job.status = 'error';
      job.error = err instanceof BackupError ? err.message : `Erreur inattendue : ${err?.message ?? err}`;
      console.error('[sauvegardes] tâche en échec :', err);
    },
  ).finally(() => {
    job.finishedAt = new Date().toISOString();
    runningByGuild.delete(guildId);
    if (jobs.size > JOB_HISTORY) {
      for (const id of [...jobs.keys()].slice(0, jobs.size - JOB_HISTORY)) jobs.delete(id);
    }
  });
  return publicJob(job);
}

function publicJob(job) {
  return { id: job.id, guildId: job.guildId, type: job.type, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, result: job.result, error: job.error };
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  return job ? publicJob(job) : null;
}

function runningJobFor(guildId) {
  const id = runningByGuild.get(guildId);
  return id ? getJob(id) : null;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------
// Embeds et composants discord.js exposent toJSON() ; un objet brut est accepté tel quel.
const asJson = (x) => (typeof x?.toJSON === 'function' ? x.toJSON() : x);

async function captureMessages(guild, channel, report) {
  const botId = guild.client.user.id;
  try {
    const fetched = await channel.messages.fetch({ limit: MESSAGE_SCAN });
    return [...fetched.values()]
      .filter((m) => m.author?.id === botId)
      .slice(0, MESSAGES_PER_CHANNEL)
      .reverse() // ordre chronologique pour la restauration
      .map((m) => ({
        id: m.id,
        channelId: channel.id,
        content: m.content ?? '',
        embeds: m.embeds.map(asJson),
        components: m.components.map(asJson),
      }));
  } catch (err) {
    report.skipped.push(`messages de #${channel.name} : ${err.message}`);
    return [];
  }
}

async function capture(guild, kind) {
  // @everyone (identifiant = celui du serveur) n'est pas sauvegardé comme rôle : il garde son identifiant.
  const roles = [...guild.roles.cache.values()]
    .filter((r) => !r.managed && r.id !== guild.id)
    .sort((a, b) => a.position - b.position)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.permissions.bitfield.toString(),
      position: r.position,
    }));

  const channels = [...guild.channels.cache.values()]
    .filter((c) => SAVED_TYPES.has(c.type))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      parentId: c.parentId ?? null,
      position: c.rawPosition,
      topic: c.topic ?? null,
      nsfw: Boolean(c.nsfw),
      rateLimitPerUser: c.rateLimitPerUser ?? 0,
      permissionOverwrites: [...c.permissionOverwrites.cache.values()].map((o) => ({
        id: o.id,
        type: o.type,
        allow: o.allow.bitfield.toString(),
        deny: o.deny.bitfield.toString(),
      })),
    }));

  const report = { skipped: [] };
  const messages = [];
  for (const channel of guild.channels.cache.values()) {
    if (!TEXT_TYPES.has(channel.type)) continue;
    messages.push(...(await captureMessages(guild, channel, report)));
  }

  const configs = store.listGuildConfigs(guild.id);
  delete configs[ID]; // la configuration des sauvegardes n'est pas restaurée

  const summary = { roles: roles.length, channels: channels.length, messages: messages.length, modules: Object.keys(configs).length };
  return {
    summary,
    data: { version: 1, kind, guild: { id: guild.id, name: guild.name }, createdAt: new Date().toISOString(), roles, channels, messages, configs },
    skipped: report.skipped,
  };
}

// Garde les RETENTION sauvegardes les plus récentes du serveur.
async function enforceRetention(guildId) {
  const rows = await store.loadBackups(guildId);
  const extra = rows.slice(RETENTION).map((r) => r.id);
  if (extra.length) await store.deleteBackups(guildId, extra);
}

async function createBackup(guild, kind = 'manual') {
  const { summary, data, skipped } = await capture(guild, kind);
  const row = await store.insertBackup({ guild_id: guild.id, kind, guild_name: guild.name, summary, data });
  await enforceRetention(guild.id);
  return { id: row.id, kind: row.kind, createdAt: row.created_at, summary: row.summary, skipped };
}

// ---------------------------------------------------------------------------
// Restauration
// ---------------------------------------------------------------------------
// Remplace chaque identifiant connu (rôle, salon, message) par son nouvel identifiant, dans toute la valeur.
function remap(value, map) {
  if (typeof value === 'string') {
    if (map.has(value)) return map.get(value);
    return value.replace(SNOWFLAKE, (m) => map.get(m) ?? m);
  }
  if (Array.isArray(value)) return value.map((v) => remap(v, map));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = remap(v, map);
    return out;
  }
  return value;
}

// Empreintes des messages du bot déjà présents dans un salon (100 derniers messages).
async function fingerprintsOf(channel, botId) {
  const out = new Map();
  try {
    const fetched = await channel.messages.fetch({ limit: MESSAGE_SCAN });
    for (const m of fetched.values()) {
      if (m.author?.id !== botId) continue;
      const fp = JSON.stringify([m.content ?? '', m.embeds.map(asJson), m.components.map(asJson)]);
      out.set(fp, m);
    }
  } catch {
    // Pas de lecture possible : on republiera.
  }
  return out;
}

async function applySnapshot(guild, data) {
  const report = { rolesCreated: 0, channelsCreated: 0, messagesRestored: 0, messagesAlreadyPresent: 0, configsRestored: 0, errors: [] };
  const map = new Map([[data.guild.id, guild.id]]); // @everyone : même identifiant que le serveur
  const reused = new Set(); // identifiants existants déjà associés (pas deux éléments sur un même existant)

  // 1. Rôles (du plus bas au plus haut : Discord les place au-dessus à la création).
  //    Un rôle existant est reconnu par son identifiant, sinon par son nom : il n'est pas recréé.
  for (const r of data.roles.filter((x) => x.id !== data.guild.id)) {
    const existing =
      guild.roles.cache.get(r.id) ??
      [...guild.roles.cache.values()].find((x) => x.name === r.name && x.id !== guild.id && !x.managed && !reused.has(x.id));
    if (existing) {
      map.set(r.id, existing.id);
      reused.add(existing.id);
      continue;
    }
    try {
      const created = await guild.roles.create({
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: BigInt(r.permissions),
        reason: 'Restauration de sauvegarde',
      });
      map.set(r.id, created.id);
      report.rolesCreated++;
    } catch (err) {
      report.errors.push(`rôle « ${r.name} » : ${err.message}`);
    }
  }

  // 2. Salons : catégories d'abord, puis le reste
  const ordered = [...data.channels].sort((a, b) => (a.type === ChannelType.GuildCategory ? 0 : 1) - (b.type === ChannelType.GuildCategory ? 0 : 1) || a.position - b.position);
  for (const c of ordered) {
    // Un salon existant est reconnu par son identifiant, sinon par son nom, son type et son parent.
    const wantedParent = c.parentId && map.has(c.parentId) ? map.get(c.parentId) : null;
    const existing =
      guild.channels.cache.get(c.id) ??
      [...guild.channels.cache.values()].find(
        (x) =>
          x.name === c.name &&
          x.type === c.type &&
          !reused.has(x.id) &&
          (c.type === ChannelType.GuildCategory || (x.parentId ?? null) === wantedParent),
      );
    if (existing) {
      map.set(c.id, existing.id);
      reused.add(existing.id);
      continue;
    }
    const overwrites = c.permissionOverwrites
      .filter((o) => o.type === OverwriteType.Role && map.has(o.id))
      .map((o) => ({ id: map.get(o.id), type: OverwriteType.Role, allow: BigInt(o.allow), deny: BigInt(o.deny) }));
    const options = {
      name: c.name,
      type: c.type,
      parent: c.parentId && map.has(c.parentId) && c.type !== ChannelType.GuildCategory ? map.get(c.parentId) : undefined,
      position: c.position,
      permissionOverwrites: overwrites,
      reason: 'Restauration de sauvegarde',
    };
    if (TEXT_TYPES.has(c.type)) {
      options.topic = c.topic ?? undefined;
      options.nsfw = c.nsfw;
      options.rateLimitPerUser = c.rateLimitPerUser ?? 0;
    }
    try {
      const created = await guild.channels.create(options);
      map.set(c.id, created.id);
      report.channelsCreated++;
    } catch (err) {
      report.errors.push(`salon « ${c.name} » : ${err.message}`);
    }
  }

  // 3. Messages du bot : republiés dans le salon (recréé ou existant), dans l'ordre d'origine.
  //    Un message identique déjà présent dans le salon n'est pas republié (pas de doublon).
  const presentByChannel = new Map(); // salon -> Map(empreinte -> message)
  for (const m of data.messages) {
    const channelId = map.get(m.channelId);
    const channel = channelId ? guild.channels.cache.get(channelId) : null;
    if (!channel?.isTextBased()) continue;
    const payload = {
      content: remap(m.content, map) || undefined,
      embeds: remap(m.embeds, map),
      components: remap(m.components, map),
    };
    const fingerprint = JSON.stringify([payload.content ?? '', payload.embeds ?? [], payload.components ?? []]);
    if (!presentByChannel.has(channel.id)) {
      presentByChannel.set(channel.id, await fingerprintsOf(channel, guild.client.user.id));
    }
    const present = presentByChannel.get(channel.id);
    if (present.has(fingerprint)) {
      map.set(m.id, present.get(fingerprint).id);
      report.messagesAlreadyPresent++;
      continue;
    }
    try {
      const sent = await channel.send({ ...payload, allowedMentions: { parse: [] } });
      map.set(m.id, sent.id);
      present.set(fingerprint, sent);
      report.messagesRestored++;
    } catch (err) {
      report.errors.push(`message dans #${channel.name} : ${err.message}`);
    }
  }

  // 4. Configurations des modules, avec identifiants remappés
  for (const [moduleId, cfg] of Object.entries(data.configs)) {
    if (moduleId === ID) continue;
    const next = remap(cfg, map);
    if (moduleId === 'security') {
      // Jamais de verrouillage restauré : il s'applique à l'instant présent.
      next.lockdown = { active: false, previousLevel: null, since: null, reason: null };
    }
    if (moduleId === 'reaction_roles') {
      for (const panel of next.panels ?? []) {
        const old = data.configs.reaction_roles.panels.find((p) => p.id === panel.id);
        panel.messageId = old?.messageId && map.has(old.messageId) ? map.get(old.messageId) : null;
      }
    }
    store.updateModuleConfig(guild.id, moduleId, next);
    report.configsRestored++;
  }

  // 5. Panneaux de rôles : réactions à reposer sur les messages republiés
  const reactionRoles = require('./modules/reaction-roles');
  const panelsCfg = store.getModuleConfig(guild.id, reactionRoles.ID, reactionRoles.DEFAULTS);
  for (const panel of panelsCfg.panels ?? []) {
    if (!panel.channelId || !panel.pairs?.length) continue;
    try {
      await reactionRoles.publish(guild, panel);
    } catch (err) {
      report.errors.push(`panneau « ${panel.title} » : ${err.message}`);
    }
  }
  if (panelsCfg.panels?.length) store.updateModuleConfig(guild.id, reactionRoles.ID, panelsCfg);

  return report;
}

// Démarre une restauration (tâche de fond). La confirmation par nom de serveur est vérifiée ici.
async function startRestore(guild, backupId, confirmName) {
  if (String(confirmName ?? '').trim() !== guild.name) fail('Le nom saisi ne correspond pas au nom du serveur. Restauration annulée.');
  const row = await store.loadBackup(guild.id, backupId);
  if (!row) fail('Sauvegarde introuvable pour ce serveur.');
  return startJob(guild.id, 'restore', async () => {
    const safety = await createBackup(guild, 'pre_restore');
    const report = await applySnapshot(guild, row.data);
    logEntry(guild, {
      category: 'moderation',
      event: 'backupRestore',
      title: 'Sauvegarde restaurée (tableau de bord)',
      description: `Rôles créés : ${report.rolesCreated} · salons créés : ${report.channelsCreated} · messages : ${report.messagesRestored} · erreurs : ${report.errors.length}`,
    });
    return { safetyBackupId: safety.id, ...report };
  });
}

function startBackup(guild) {
  return startJob(guild.id, 'backup', async () => {
    const created = await createBackup(guild, 'manual');
    return { id: created.id, summary: created.summary, skipped: created.skipped };
  });
}

// ---------------------------------------------------------------------------
// Sauvegarde quotidienne
// ---------------------------------------------------------------------------
async function runDailyTick(client) {
  if (!client?.isReady()) return;
  for (const guild of client.guilds.cache.values()) {
    if (!cfgOf(guild.id).enabled || runningByGuild.has(guild.id)) continue;
    try {
      const [last] = await store.loadBackups(guild.id);
      if (last && Date.now() - new Date(last.created_at).getTime() < DAY_MS) continue;
      const created = await createBackup(guild, 'daily');
      console.log(`[sauvegardes] quotidienne créée pour ${guild.name} (${JSON.stringify(created.summary)}).`);
    } catch (err) {
      console.error(`[sauvegardes] quotidienne impossible pour ${guild.name} :`, err.message);
    }
  }
}

function start(getClient) {
  setTimeout(() => runDailyTick(getClient()), 60_000);
  setInterval(() => runDailyTick(getClient()), TICK_MS);
}

// ---------------------------------------------------------------------------
// /config : seulement l'activation de la sauvegarde quotidienne.
// La création et la restauration se font depuis le tableau de bord.
// ---------------------------------------------------------------------------
function render() {
  return {
    content: '💾 **Sauvegardes** · création et restauration depuis le tableau de bord uniquement.',
    embeds: [embed('Une sauvegarde automatique est faite chaque jour. Les 7 plus récentes sont conservées.\nSauvegardes : rôles, salons et permissions, configurations des modules, messages du bot (30 au plus par salon).')],
    components: [moduleSelectRow(MODULE_LIST, ID)],
  };
}

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , action] = interaction.customId.split(':');
  if (action !== 'toggle') return;
  const cfg = cfgOf(guild.id);
  cfg.enabled = !cfg.enabled;
  store.updateModuleConfig(guild.id, ID, cfg);
  const view = render();
  return interaction.update({
    ...view,
    components: [...view.components, row(toggleButton('cfg:backups:toggle', 'Sauvegarde quotidienne', cfg.enabled))],
  });
}

module.exports = {
  ID,
  DEFAULTS,
  BackupError,
  RETENTION,
  cfgOf,
  render,
  handleComponent,
  start,
  startBackup,
  startRestore,
  getJob,
  runningJobFor,
  createBackup,
  listBackups: (guildId) => store.loadBackups(guildId),
  // Exposés pour les tests.
  _remap: remap,
  _applySnapshot: applySnapshot,
  _capture: capture,
  _runDailyTick: runDailyTick,
};
