// Module « Sécurité » : anti-raid et anti-nuke.
//  - Anti-raid : si trop de comptes arrivent en peu de temps, le serveur est verrouillé
//    (niveau de vérification relevé). Le déverrouillage est manuel (/config ou tableau de bord).
//  - Anti-nuke : si un membre non autorisé supprime trop de salons ou de rôles, crée trop de salons,
//    ou bannit / expulse trop de monde dans la fenêtre de temps, il perd ses rôles à risque puis il est banni.
//  - Liste blanche : propriétaire, bot, membres et rôles choisis. Les administrateurs ne sont PAS exemptés.
//  - Chaque réaction est signalée dans le salon d'alerte (ou en MP au propriétaire) et dans les logs.
const {
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Events,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  GuildVerificationLevel,
  AuditLogEvent,
} = require('discord.js');
const store = require('../store');
const { embed, button, row, toggleButton, moduleSelectRow, textModal, ephemeralPayload, truncate } = require('../ui');
const { MODULE_LIST } = require('./registry');
const { auditFor } = require('../audit');
const { log: logEntry, markBotAction } = require('./logs');

const ID = 'security';
const DEFAULTS = {
  raid: { enabled: false, joinThreshold: 10, windowSeconds: 10 },
  nuke: {
    enabled: false,
    windowSeconds: 10,
    limits: { channelDelete: 3, roleDelete: 3, channelCreate: 5, ban: 3, kick: 5 },
  },
  alertChannelId: null,
  whitelistUserIds: [],
  whitelistRoleIds: [],
  lockdown: { active: false, previousLevel: null, since: null, reason: null },
};
const KIND_LABEL = {
  channelDelete: 'suppressions de salons',
  roleDelete: 'suppressions de rôles',
  channelCreate: 'créations de salons',
  ban: 'bannissements',
  kick: 'expulsions',
};
const TEXT_KINDS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const JOIN_TRACK_MAX = 500;

const cfgOf = (guildId) => {
  const cfg = store.getModuleConfig(guildId, ID, DEFAULTS);
  cfg.raid = { ...DEFAULTS.raid, ...cfg.raid };
  cfg.nuke = { ...DEFAULTS.nuke, ...cfg.nuke, limits: { ...DEFAULTS.nuke.limits, ...(cfg.nuke?.limits ?? {}) } };
  cfg.lockdown = { ...DEFAULTS.lockdown, ...cfg.lockdown };
  cfg.whitelistUserIds = Array.isArray(cfg.whitelistUserIds) ? cfg.whitelistUserIds : [];
  cfg.whitelistRoleIds = Array.isArray(cfg.whitelistRoleIds) ? cfg.whitelistRoleIds : [];
  return cfg;
};
const save = (guildId, cfg) => store.updateModuleConfig(guildId, ID, cfg);

// ---------------------------------------------------------------------------
// Alertes
// ---------------------------------------------------------------------------
async function alert(guild, cfg, title, description, fields = []) {
  const e = embed(description).setTitle(truncate(title, 250)).setTimestamp(new Date());
  if (fields.length) e.addFields(fields.slice(0, 20).map((f) => ({ name: truncate(f.name, 250), value: truncate(f.value, 1000), inline: Boolean(f.inline) })));
  const payload = { embeds: [e], allowedMentions: { parse: [] } };
  try {
    const channel = cfg.alertChannelId
      ? guild.channels.cache.get(cfg.alertChannelId) ?? (await guild.channels.fetch(cfg.alertChannelId).catch(() => null))
      : null;
    if (channel?.isTextBased()) return await channel.send(payload);
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) await owner.send(payload).catch(() => {});
  } catch (err) {
    console.error('[sécurité] alerte impossible :', err.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Anti-raid
// ---------------------------------------------------------------------------
const joins = new Map(); // guildId -> timestamps des arrivées récentes

async function lockdown(guild, cfg, reason) {
  if (cfg.lockdown.active) return;
  const previous = guild.verificationLevel;
  cfg.lockdown = { active: true, previousLevel: previous, since: new Date().toISOString(), reason };
  save(guild.id, cfg);
  let result = 'niveau de vérification relevé';
  try {
    await guild.setVerificationLevel(GuildVerificationLevel.High, 'Anti-raid : verrouillage automatique');
  } catch (err) {
    console.error('[sécurité] verrouillage impossible :', err.message);
    result = `⚠️ verrouillage impossible (${err.message}) : vérifie la permission « Gérer le serveur »`;
  }
  await alert(guild, cfg, '🚨 Anti-raid : serveur verrouillé', `${reason}\n\nPour lever le verrouillage : \`/config\` → Sécurité → « Lever le verrouillage ».`, [
    { name: 'Action', value: result, inline: false },
  ]);
  logEntry(guild, { category: 'moderation', event: 'antiraidLock', title: 'Anti-raid : serveur verrouillé', description: reason });
}

async function unlock(guild, cfg, by) {
  const level = cfg.lockdown.previousLevel ?? GuildVerificationLevel.Medium;
  try {
    await guild.setVerificationLevel(level, 'Anti-raid : fin du verrouillage');
  } catch (err) {
    return `❌ Impossible de rétablir le niveau de vérification : ${err.message}`;
  }
  cfg.lockdown = { active: false, previousLevel: null, since: null, reason: null };
  save(guild.id, cfg);
  logEntry(guild, { category: 'moderation', event: 'antiraidUnlock', title: 'Anti-raid : verrouillage levé', actorId: by ?? null });
  return null;
}

async function onMemberJoin(member) {
  const guild = member.guild;
  const cfg = cfgOf(guild.id);
  if (!cfg.raid.enabled || cfg.lockdown.active) return;
  const now = Date.now();
  const windowMs = cfg.raid.windowSeconds * 1000;
  const list = (joins.get(guild.id) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  joins.set(guild.id, list.slice(-JOIN_TRACK_MAX));
  if (list.length >= cfg.raid.joinThreshold) {
    joins.delete(guild.id);
    await lockdown(guild, cfg, `${list.length} arrivées en ${cfg.raid.windowSeconds} s (seuil : ${cfg.raid.joinThreshold}).`);
  }
}

// ---------------------------------------------------------------------------
// Anti-nuke
// ---------------------------------------------------------------------------
const counters = new Map(); // "guild:executor:kind" -> timestamps
const responding = new Set(); // "guild:executor" en cours de traitement

function isWhitelisted(guild, cfg, member) {
  if (member.id === guild.ownerId || member.id === guild.client.user.id) return true;
  if (cfg.whitelistUserIds.includes(member.id)) return true;
  return cfg.whitelistRoleIds.some((id) => member.roles.cache.has(id));
}

// Retire les rôles à risque puis bannit. Chaque étape est tolérante aux échecs (hiérarchie, permissions).
async function neutralize(guild, cfg, executorId, kind, count) {
  const key = `${guild.id}:${executorId}`;
  if (responding.has(key)) return;
  responding.add(key);
  try {
    const member = await guild.members.fetch(executorId).catch(() => null);
    const steps = [];
    if (member) {
      const removable = member.roles.cache.filter((r) => r.id !== guild.id && r.editable);
      if (removable.size) {
        const ok = await member.roles.set(member.roles.cache.filter((r) => r.id === guild.id || !r.editable).map((r) => r.id), 'Anti-nuke : retrait des rôles').then(() => true, () => false);
        steps.push(ok ? `rôles retirés (${removable.size})` : 'retrait des rôles impossible');
      }
    }
    markBotAction('ban', guild.id, executorId);
    const banned = await guild.bans
      .create(executorId, { reason: `Anti-nuke : ${count} ${KIND_LABEL[kind]} en peu de temps`, deleteMessageSeconds: 0 })
      .then(() => true, () => false);
    steps.push(banned ? 'banni' : 'bannissement impossible (rôle trop haut ou membre introuvable)');

    const label = member ? `<@${executorId}>` : executorId;
    await alert(guild, cfg, '🚨 Anti-nuke : action déclenchée', `${label} a fait ${count} ${KIND_LABEL[kind]} en ${cfg.nuke.windowSeconds} s.`, [
      { name: 'Réponse', value: steps.join('\n') || '—', inline: false },
      { name: 'Si c’est une erreur', value: 'Débannis le membre (`/unban`) et redonne-lui ses rôles.', inline: false },
    ]);
    logEntry(guild, {
      category: 'moderation',
      event: 'antinuke',
      title: 'Anti-nuke déclenché',
      description: steps.join(' · '),
      actorId: executorId,
      targetId: executorId,
      fields: [{ name: 'Action', value: `${count} ${KIND_LABEL[kind]}`, inline: true }],
    });
  } finally {
    responding.delete(key);
  }
}

async function recordAction(guild, kind, executorId) {
  if (!executorId) return;
  const cfg = cfgOf(guild.id);
  if (!cfg.nuke.enabled) return;
  if (executorId === guild.client.user.id) return;
  const member = guild.members.cache.get(executorId) ?? (await guild.members.fetch(executorId).catch(() => null));
  if (member && isWhitelisted(guild, cfg, member)) return;
  if (!member && executorId === guild.ownerId) return;

  const now = Date.now();
  const windowMs = cfg.nuke.windowSeconds * 1000;
  const key = `${guild.id}:${executorId}:${kind}`;
  const list = (counters.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  counters.set(key, list);
  const limit = cfg.nuke.limits[kind];
  if (limit && list.length >= limit) {
    counters.delete(key);
    await neutralize(guild, cfg, executorId, kind, list.length);
  }
}

// ---------------------------------------------------------------------------
// Événements Discord
// ---------------------------------------------------------------------------
function registerEvents(client) {
  const safe = (fn) => (...args) => fn(...args).catch((err) => console.error('[sécurité]', err));

  client.on(Events.GuildMemberAdd, safe(async (member) => {
    if (member.user.bot) return;
    await onMemberJoin(member);
  }));

  client.on(Events.ChannelDelete, safe(async (channel) => {
    if (!channel.guild) return;
    const entry = await auditFor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    await recordAction(channel.guild, 'channelDelete', entry?.executorId);
  }));

  client.on(Events.ChannelCreate, safe(async (channel) => {
    if (!channel.guild) return;
    const entry = await auditFor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    await recordAction(channel.guild, 'channelCreate', entry?.executorId);
  }));

  client.on(Events.GuildRoleDelete, safe(async (role) => {
    const entry = await auditFor(role.guild, AuditLogEvent.RoleDelete, role.id);
    await recordAction(role.guild, 'roleDelete', entry?.executorId);
  }));

  client.on(Events.GuildBanAdd, safe(async (ban) => {
    const entry = await auditFor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    await recordAction(ban.guild, 'ban', entry?.executorId);
  }));

  client.on(Events.GuildMemberRemove, safe(async (member) => {
    // Seule une expulsion a une entrée « MemberKick » ; un départ volontaire n'en a pas.
    const entry = await auditFor(member.guild, AuditLogEvent.MemberKick, member.id);
    if (entry) await recordAction(member.guild, 'kick', entry.executorId);
  }));
}

// ---------------------------------------------------------------------------
// Interface /config
// ---------------------------------------------------------------------------
const yn = (v) => (v ? '🟢 Activé' : '⚪ Désactivé');

function renderMain(guild, cfg) {
  const lock = cfg.lockdown.active
    ? `🔒 **Verrouillé** depuis <t:${Math.floor(new Date(cfg.lockdown.since).getTime() / 1000)}:R>`
    : '🔓 Serveur ouvert';
  const wl = `${cfg.whitelistUserIds.length} membre(s), ${cfg.whitelistRoleIds.length} rôle(s)`;
  const limits = Object.entries(cfg.nuke.limits)
    .map(([k, v]) => `${KIND_LABEL[k]} : ${v}`)
    .join('\n');
  return {
    content:
      '🛡️ **Sécurité** · anti-raid (afflux de comptes) et anti-nuke (suppressions et bans en masse). Les seuils sont des modales.',
    embeds: [
      embed()
        .addFields(
          { name: 'Anti-raid', value: `${yn(cfg.raid.enabled)}\n${cfg.raid.joinThreshold} arrivées / ${cfg.raid.windowSeconds} s`, inline: true },
          { name: 'Anti-nuke', value: `${yn(cfg.nuke.enabled)}\nfenêtre ${cfg.nuke.windowSeconds} s`, inline: true },
          { name: 'Verrouillage', value: lock, inline: true },
          { name: 'Seuils anti-nuke', value: limits, inline: false },
          { name: 'Salon d’alerte', value: cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'aucun (alertes en MP au propriétaire)', inline: true },
          { name: 'Liste blanche', value: wl, inline: true },
        ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        toggleButton('cfg:security:toggle:raid', 'Anti-raid', cfg.raid.enabled),
        toggleButton('cfg:security:toggle:nuke', 'Anti-nuke', cfg.nuke.enabled),
        cfg.lockdown.active
          ? button('cfg:security:unlock', 'Lever le verrouillage', ButtonStyle.Success, '🔓')
          : button('cfg:security:lock', 'Verrouiller maintenant', ButtonStyle.Danger, '🔒'),
        button('cfg:security:view:alert', 'Salon d’alerte', ButtonStyle.Primary, '📣'),
        button('cfg:security:view:whitelist', 'Liste blanche', ButtonStyle.Primary, '✅'),
      ),
      row(
        button('cfg:security:open:raid', 'Seuils anti-raid', ButtonStyle.Secondary, '⚙️'),
        button('cfg:security:open:nukeA', 'Seuils anti-nuke (salons)', ButtonStyle.Secondary, '⚙️'),
        button('cfg:security:open:nukeB', 'Seuils anti-nuke (membres)', ButtonStyle.Secondary, '⚙️'),
      ),
    ],
  };
}

function renderAlert(cfg) {
  return {
    content: '📣 **Salon d’alerte** · reçoit les alertes anti-raid et anti-nuke.',
    embeds: [embed(cfg.alertChannelId ? `Salon actuel : <#${cfg.alertChannelId}>` : 'Aucun salon. Les alertes sont envoyées en MP au propriétaire.')],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:security:pick:alert')
          .setPlaceholder('Choisir le salon d’alerte')
          .setChannelTypes(...TEXT_KINDS)
          .setMinValues(1)
          .setMaxValues(1),
      ),
      row(button('cfg:security:view:main', 'Retour', ButtonStyle.Secondary, '⬅️')),
    ],
  };
}

function renderWhitelist(guild, cfg) {
  const users = new UserSelectMenuBuilder()
    .setCustomId('cfg:security:pick:users')
    .setPlaceholder('Membres de confiance (ignorés par l’anti-nuke)')
    .setMinValues(0)
    .setMaxValues(25);
  if (cfg.whitelistUserIds.length) users.setDefaultUsers(...cfg.whitelistUserIds);
  const roles = new RoleSelectMenuBuilder()
    .setCustomId('cfg:security:pick:roles')
    .setPlaceholder('Rôles de confiance (ignorés par l’anti-nuke)')
    .setMinValues(0)
    .setMaxValues(25);
  if (cfg.whitelistRoleIds.length) roles.setDefaultRoles(...cfg.whitelistRoleIds);
  return {
    content:
      '✅ **Liste blanche** · le propriétaire et le bot sont toujours exemptés. Les administrateurs ne le sont pas : ajoute-les ici s’ils doivent pouvoir tout faire.',
    embeds: [embed()],
    components: [moduleSelectRow(MODULE_LIST, ID), row(users), row(roles), row(button('cfg:security:view:main', 'Retour', ButtonStyle.Secondary, '⬅️'))],
  };
}

function render(view, guild) {
  const cfg = cfgOf(guild.id);
  if (view === 'alert') return renderAlert(cfg);
  if (view === 'whitelist') return renderWhitelist(guild, cfg);
  return renderMain(guild, cfg);
}

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , action, ...rest] = interaction.customId.split(':');
  const arg = rest.join(':');
  const cfg = cfgOf(guild.id);

  switch (action) {
    case 'view':
      return interaction.update(render(arg, guild));

    case 'toggle': {
      if (arg !== 'raid' && arg !== 'nuke') return;
      cfg[arg].enabled = !cfg[arg].enabled;
      save(guild.id, cfg);
      return interaction.update(renderMain(guild, cfg));
    }

    case 'lock': {
      await interaction.deferUpdate();
      await lockdown(guild, cfg, 'Verrouillage manuel depuis /config.');
      return interaction.editReply(renderMain(guild, cfgOf(guild.id)));
    }

    case 'unlock': {
      await interaction.deferUpdate();
      const error = await unlock(guild, cfg, interaction.user.id);
      if (error) return interaction.followUp(ephemeralPayload(error));
      return interaction.editReply(renderMain(guild, cfgOf(guild.id)));
    }

    case 'pick': {
      if (arg === 'alert') {
        cfg.alertChannelId = interaction.values[0] ?? null;
        save(guild.id, cfg);
        return interaction.update(renderAlert(cfg));
      }
      if (arg === 'users') {
        cfg.whitelistUserIds = [...interaction.values].slice(0, 25);
        save(guild.id, cfg);
        return interaction.update(renderWhitelist(guild, cfg));
      }
      if (arg === 'roles') {
        cfg.whitelistRoleIds = [...interaction.values].slice(0, 25);
        save(guild.id, cfg);
        return interaction.update(renderWhitelist(guild, cfg));
      }
      return;
    }

    case 'open': {
      if (arg === 'raid') {
        return interaction.showModal(
          textModal('cfg:security:modal:raid', 'Seuils anti-raid', [
            { key: 'joins', label: 'Arrivées déclenchant l’alerte (2 à 100)', max: 3, required: true, value: String(cfg.raid.joinThreshold) },
            { key: 'window', label: 'Durée de la fenêtre en secondes (5 à 120)', max: 3, required: true, value: String(cfg.raid.windowSeconds) },
          ]),
        );
      }
      if (arg === 'nukeA') {
        return interaction.showModal(
          textModal('cfg:security:modal:nukeA', 'Anti-nuke : salons et rôles', [
            { key: 'channelDelete', label: 'Salons supprimés (1 à 50)', max: 3, required: true, value: String(cfg.nuke.limits.channelDelete) },
            { key: 'roleDelete', label: 'Rôles supprimés (1 à 50)', max: 3, required: true, value: String(cfg.nuke.limits.roleDelete) },
            { key: 'channelCreate', label: 'Salons créés (1 à 50)', max: 3, required: true, value: String(cfg.nuke.limits.channelCreate) },
          ]),
        );
      }
      if (arg === 'nukeB') {
        return interaction.showModal(
          textModal('cfg:security:modal:nukeB', 'Anti-nuke : membres et fenêtre', [
            { key: 'ban', label: 'Bannissements (1 à 50)', max: 3, required: true, value: String(cfg.nuke.limits.ban) },
            { key: 'kick', label: 'Expulsions (1 à 50)', max: 3, required: true, value: String(cfg.nuke.limits.kick) },
            { key: 'window', label: 'Fenêtre en secondes (5 à 120)', max: 3, required: true, value: String(cfg.nuke.windowSeconds) },
          ]),
        );
      }
      return;
    }

    default:
      return;
  }
}

// Lit un entier saisi dans une modale, borné. Lève une erreur lisible sinon.
function intField(interaction, key, min, max, label) {
  const raw = interaction.fields.getTextInputValue(key).trim();
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new Error(`${label} : nombre entre ${min} et ${max} attendu.`);
  return n;
}

async function handleModal(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , , kind] = interaction.customId.split(':');
  const cfg = cfgOf(guild.id);
  try {
    if (kind === 'raid') {
      cfg.raid.joinThreshold = intField(interaction, 'joins', 2, 100, 'Arrivées');
      cfg.raid.windowSeconds = intField(interaction, 'window', 5, 120, 'Fenêtre');
    } else if (kind === 'nukeA') {
      cfg.nuke.limits.channelDelete = intField(interaction, 'channelDelete', 1, 50, 'Salons supprimés');
      cfg.nuke.limits.roleDelete = intField(interaction, 'roleDelete', 1, 50, 'Rôles supprimés');
      cfg.nuke.limits.channelCreate = intField(interaction, 'channelCreate', 1, 50, 'Salons créés');
    } else if (kind === 'nukeB') {
      cfg.nuke.limits.ban = intField(interaction, 'ban', 1, 50, 'Bannissements');
      cfg.nuke.limits.kick = intField(interaction, 'kick', 1, 50, 'Expulsions');
      cfg.nuke.windowSeconds = intField(interaction, 'window', 5, 120, 'Fenêtre');
    } else {
      return interaction.reply(ephemeralPayload('Formulaire inconnu.'));
    }
  } catch (err) {
    return interaction.reply(ephemeralPayload(`❌ ${err.message}`));
  }
  save(guild.id, cfg);
  await interaction.deferUpdate();
  return interaction.editReply(renderMain(guild, cfgOf(guild.id)));
}

module.exports = {
  ID,
  DEFAULTS,
  cfgOf,
  render,
  handleComponent,
  handleModal,
  registerEvents,
  // Exposés pour les tests.
  _recordAction: recordAction,
  _onMemberJoin: onMemberJoin,
  _isWhitelisted: isWhitelisted,
  _unlock: unlock,
};
