// Écouteurs Discord du module Logs. Chaque écouteur est isolé : une erreur ne doit jamais
// bloquer le bot ni les autres modules.
const { AuditLogEvent, Events } = require('discord.js');
const logs = require('./modules/logs');

const RECENT_BAN_MS = 15_000;
const AUDIT_WINDOW_MS = 20_000;
const recentBans = new Map(); // "guildId:userId" -> timestamp

const mention = (id) => (id ? `<@${id}>` : 'inconnu');
const channelRef = (id) => (id ? `<#${id}>` : 'inconnu');
const shortText = (text, fallback = '*contenu indisponible*') => (text && text.trim() ? text : fallback);

// Cherche dans le journal d'audit l'auteur d'une action récente sur une cible.
// Retourne null si la permission manque ou si rien ne correspond.
async function auditFor(guild, type, targetId) {
  try {
    const audit = await guild.fetchAuditLogs({ type, limit: 6 });
    return (
      audit.entries.find(
        (e) => (e.targetId ?? e.target?.id) === targetId && Date.now() - e.createdTimestamp < AUDIT_WINDOW_MS,
      ) ?? null
    );
  } catch {
    return null;
  }
}

function userOf(user) {
  if (!user) return undefined;
  return { name: user.tag ?? user.username, iconURL: user.displayAvatarURL?.() };
}

function registerLogEvents(client) {
  const on = (event, handler) =>
    client.on(event, async (...args) => {
      try {
        await handler(...args);
      } catch (err) {
        console.error(`[logs] ${event} :`, err);
      }
    });

  // ----- Messages ------------------------------------------------------------
  on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (!newMessage.guild || newMessage.partial || newMessage.author?.bot) return;
    if (logs.isLogChannel(newMessage.guild.id, newMessage.channelId)) return;
    if (!oldMessage.partial && oldMessage.content === newMessage.content) return;
    logs.log(newMessage.guild, {
      category: 'messages',
      event: 'messageUpdate',
      title: 'Message modifié',
      description: `[Aller au message](${newMessage.url})`,
      actorId: newMessage.author.id,
      targetId: newMessage.author.id,
      channelId: newMessage.channelId,
      user: userOf(newMessage.author),
      fields: [
        { name: 'Auteur', value: mention(newMessage.author.id), inline: true },
        { name: 'Salon', value: channelRef(newMessage.channelId), inline: true },
        { name: 'Avant', value: shortText(oldMessage.partial ? null : oldMessage.content, '*ancien contenu inconnu (message antérieur au démarrage du bot)*') },
        { name: 'Après', value: shortText(newMessage.content, '*vide*') },
      ],
    });
  });

  on(Events.MessageDelete, async (message) => {
    if (!message.guild) return;
    if (message.author?.bot) return;
    if (logs.isLogChannel(message.guild.id, message.channelId)) return;
    const author = message.author;
    // Suppression par quelqu'un d'autre que l'auteur : on tente de retrouver l'auteur de la suppression.
    let executorId = null;
    if (author) {
      const entry = await auditFor(message.guild, AuditLogEvent.MessageDelete, author.id);
      if (entry && entry.executorId !== author.id) executorId = entry.executorId;
    }
    const attachments = message.attachments?.size ?? 0;
    logs.log(message.guild, {
      category: 'messages',
      event: 'messageDelete',
      title: 'Message supprimé',
      actorId: executorId ?? author?.id ?? null,
      targetId: author?.id ?? null,
      channelId: message.channelId,
      user: userOf(author),
      fields: [
        { name: 'Auteur', value: mention(author?.id), inline: true },
        { name: 'Salon', value: channelRef(message.channelId), inline: true },
        { name: 'Supprimé par', value: executorId ? mention(executorId) : 'l’auteur ou inconnu', inline: true },
        { name: 'Contenu', value: shortText(message.partial ? null : message.content) },
        ...(attachments ? [{ name: 'Pièces jointes', value: String(attachments), inline: true }] : []),
      ],
    });
  });

  on(Events.MessageBulkDelete, async (messages, channel) => {
    const guild = channel?.guild;
    if (!guild) return;
    if (logs.consumeBotAction('bulk', guild.id, channel.id)) return; // déjà journalisé par /purge
    logs.log(guild, {
      category: 'messages',
      event: 'messageDeleteBulk',
      title: 'Suppression de messages en masse',
      channelId: channel.id,
      fields: [
        { name: 'Salon', value: channelRef(channel.id), inline: true },
        { name: 'Nombre', value: String(messages.size), inline: true },
      ],
    });
  });

  // ----- Membres -------------------------------------------------------------
  on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return;
    logs.log(member.guild, {
      category: 'members',
      event: 'guildMemberAdd',
      title: 'Membre arrivé',
      targetId: member.id,
      user: userOf(member.user),
      fields: [
        { name: 'Membre', value: mention(member.id), inline: true },
        { name: 'Compte créé le', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:D>`, inline: true },
        { name: 'Membres', value: String(member.guild.memberCount), inline: true },
      ],
    });
  });

  on(Events.GuildMemberRemove, async (member) => {
    const guild = member.guild;
    if (member.user?.bot) return;
    if (logs.consumeBotAction('kick', guild.id, member.id)) return;
    if (recentBans.has(`${guild.id}:${member.id}`)) return; // bannissement : journalisé par guildBanAdd
    const kick = await auditFor(guild, AuditLogEvent.MemberKick, member.id);
    if (kick) {
      logs.log(guild, {
        category: 'moderation',
        event: 'memberKick',
        title: 'Membre expulsé',
        description: kick.reason ? `Raison : ${kick.reason}` : null,
        actorId: kick.executorId,
        targetId: member.id,
        user: userOf(member.user),
        fields: [
          { name: 'Membre', value: mention(member.id), inline: true },
          { name: 'Par', value: mention(kick.executorId), inline: true },
        ],
      });
      return;
    }
    const roles = member.roles?.cache?.filter((r) => r.id !== guild.id).map((r) => `<@&${r.id}>`) ?? [];
    logs.log(guild, {
      category: 'members',
      event: 'guildMemberRemove',
      title: 'Membre parti',
      targetId: member.id,
      user: userOf(member.user),
      fields: [
        { name: 'Membre', value: mention(member.id), inline: true },
        { name: 'Rôles', value: roles.length ? roles.join(' ') : 'aucun' },
        { name: 'Membres', value: String(guild.memberCount), inline: true },
      ],
    });
  });

  on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (newMember.user.bot) return;
    const guild = newMember.guild;
    const who = { name: newMember.displayName, iconURL: newMember.displayAvatarURL?.() };

    // Timeout (appliqué ou retiré)
    const oldUntil = oldMember.communicationDisabledUntilTimestamp ?? null;
    const newUntil = newMember.communicationDisabledUntilTimestamp ?? null;
    if (oldUntil !== newUntil) {
      if (!logs.consumeBotAction('timeout', guild.id, newMember.id)) {
        const entry = await auditFor(guild, AuditLogEvent.MemberUpdate, newMember.id);
        const applied = Boolean(newUntil && newUntil > Date.now());
        logs.log(guild, {
          category: 'moderation',
          event: applied ? 'timeoutAdded' : 'timeoutRemoved',
          title: applied ? 'Timeout appliqué' : 'Timeout retiré',
          description: entry?.reason ? `Raison : ${entry.reason}` : null,
          actorId: entry?.executorId ?? null,
          targetId: newMember.id,
          user: who,
          fields: [
            { name: 'Membre', value: mention(newMember.id), inline: true },
            { name: 'Par', value: mention(entry?.executorId), inline: true },
            ...(applied ? [{ name: 'Fin', value: `<t:${Math.floor(newUntil / 1000)}:F>`, inline: false }] : []),
          ],
        });
      }
    }

    if (oldMember.nickname !== newMember.nickname) {
      logs.log(guild, {
        category: 'members',
        event: 'nicknameUpdate',
        title: 'Pseudo modifié',
        targetId: newMember.id,
        user: who,
        fields: [
          { name: 'Membre', value: mention(newMember.id), inline: true },
          { name: 'Avant', value: oldMember.nickname ?? oldMember.user.username, inline: true },
          { name: 'Après', value: newMember.nickname ?? newMember.user.username, inline: true },
        ],
      });
    }

    if (oldMember.roles?.cache && newMember.roles?.cache) {
      const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id) && r.id !== guild.id);
      const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id) && r.id !== guild.id);
      if (added.size || removed.size) {
        const entry = await auditFor(guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
        logs.log(guild, {
          category: 'members',
          event: 'memberRoleUpdate',
          title: 'Rôles du membre modifiés',
          targetId: newMember.id,
          actorId: entry?.executorId ?? null,
          user: who,
          fields: [
            { name: 'Membre', value: mention(newMember.id), inline: true },
            { name: 'Par', value: mention(entry?.executorId), inline: true },
            ...(added.size ? [{ name: 'Ajoutés', value: [...added.values()].map((r) => `<@&${r.id}>`).join(' ') }] : []),
            ...(removed.size ? [{ name: 'Retirés', value: [...removed.values()].map((r) => `<@&${r.id}>`).join(' ') }] : []),
          ],
        });
      }
    }
  });

  // ----- Bans ----------------------------------------------------------------
  on(Events.GuildBanAdd, async (ban) => {
    const guild = ban.guild;
    recentBans.set(`${guild.id}:${ban.user.id}`, Date.now() + RECENT_BAN_MS);
    if (logs.consumeBotAction('ban', guild.id, ban.user.id)) return;
    const entry = await auditFor(guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    logs.log(guild, {
      category: 'moderation',
      event: 'guildBanAdd',
      title: 'Membre banni',
      description: ban.reason ? `Raison : ${ban.reason}` : entry?.reason ? `Raison : ${entry.reason}` : null,
      actorId: entry?.executorId ?? null,
      targetId: ban.user.id,
      user: userOf(ban.user),
      fields: [
        { name: 'Membre', value: mention(ban.user.id), inline: true },
        { name: 'Par', value: mention(entry?.executorId), inline: true },
      ],
    });
  });

  on(Events.GuildBanRemove, async (ban) => {
    const guild = ban.guild;
    if (logs.consumeBotAction('unban', guild.id, ban.user.id)) return;
    const entry = await auditFor(guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    logs.log(guild, {
      category: 'moderation',
      event: 'guildBanRemove',
      title: 'Ban levé',
      targetId: ban.user.id,
      actorId: entry?.executorId ?? null,
      user: userOf(ban.user),
      fields: [
        { name: 'Membre', value: mention(ban.user.id), inline: true },
        { name: 'Par', value: mention(entry?.executorId), inline: true },
      ],
    });
  });

  // ----- Vocal ---------------------------------------------------------------
  on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const guild = newState.guild ?? oldState.guild;
    const member = newState.member ?? oldState.member;
    if (!guild || !member || member.user.bot) return;
    if (oldState.channelId === newState.channelId) return;
    const from = oldState.channelId;
    const to = newState.channelId;
    const base = { category: 'voice', targetId: member.id, user: userOf(member.user) };
    if (!from && to) {
      logs.log(guild, { ...base, event: 'voiceJoin', title: 'Connexion vocale', channelId: to, fields: [
        { name: 'Membre', value: mention(member.id), inline: true },
        { name: 'Salon', value: channelRef(to), inline: true },
      ] });
    } else if (from && !to) {
      logs.log(guild, { ...base, event: 'voiceLeave', title: 'Déconnexion vocale', channelId: from, fields: [
        { name: 'Membre', value: mention(member.id), inline: true },
        { name: 'Salon', value: channelRef(from), inline: true },
      ] });
    } else if (from && to) {
      logs.log(guild, { ...base, event: 'voiceMove', title: 'Déplacement vocal', channelId: to, fields: [
        { name: 'Membre', value: mention(member.id), inline: true },
        { name: 'De', value: channelRef(from), inline: true },
        { name: 'Vers', value: channelRef(to), inline: true },
      ] });
    }
  });

  // ----- Salons --------------------------------------------------------------
  on(Events.ChannelCreate, async (channel) => {
    const guild = channel.guild;
    if (!guild) return;
    const entry = await auditFor(guild, AuditLogEvent.ChannelCreate, channel.id);
    logs.log(guild, {
      category: 'channels',
      event: 'channelCreate',
      title: 'Salon créé',
      actorId: entry?.executorId ?? null,
      targetId: channel.id,
      fields: [
        { name: 'Salon', value: channelRef(channel.id), inline: true },
        { name: 'Par', value: mention(entry?.executorId), inline: true },
      ],
    });
  });

  on(Events.ChannelDelete, async (channel) => {
    const guild = channel.guild;
    if (!guild) return;
    const entry = await auditFor(guild, AuditLogEvent.ChannelDelete, channel.id);
    logs.log(guild, {
      category: 'channels',
      event: 'channelDelete',
      title: 'Salon supprimé',
      actorId: entry?.executorId ?? null,
      targetId: channel.id,
      fields: [
        { name: 'Nom', value: channel.name ?? 'inconnu', inline: true },
        { name: 'Par', value: mention(entry?.executorId), inline: true },
      ],
    });
  });

  on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
    const guild = newChannel.guild;
    if (!guild || oldChannel.name === newChannel.name) return;
    const entry = await auditFor(guild, AuditLogEvent.ChannelUpdate, newChannel.id);
    logs.log(guild, {
      category: 'channels',
      event: 'channelUpdate',
      title: 'Salon renommé',
      actorId: entry?.executorId ?? null,
      targetId: newChannel.id,
      fields: [
        { name: 'Salon', value: channelRef(newChannel.id), inline: true },
        { name: 'Avant', value: oldChannel.name, inline: true },
        { name: 'Après', value: newChannel.name, inline: true },
        { name: 'Par', value: mention(entry?.executorId), inline: true },
      ],
    });
  });

  // ----- Rôles ---------------------------------------------------------------
  on(Events.GuildRoleCreate, async (role) => {
    const entry = await auditFor(role.guild, AuditLogEvent.RoleCreate, role.id);
    logs.log(role.guild, {
      category: 'roles',
      event: 'roleCreate',
      title: 'Rôle créé',
      actorId: entry?.executorId ?? null,
      targetId: role.id,
      fields: [
        { name: 'Rôle', value: `<@&${role.id}>`, inline: true },
        { name: 'Par', value: mention(entry?.executorId), inline: true },
      ],
    });
  });

  on(Events.GuildRoleDelete, async (role) => {
    const entry = await auditFor(role.guild, AuditLogEvent.RoleDelete, role.id);
    logs.log(role.guild, {
      category: 'roles',
      event: 'roleDelete',
      title: 'Rôle supprimé',
      actorId: entry?.executorId ?? null,
      targetId: role.id,
      fields: [
        { name: 'Nom', value: role.name, inline: true },
        { name: 'Par', value: mention(entry?.executorId), inline: true },
      ],
    });
  });

  on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
    const changedName = oldRole.name !== newRole.name;
    const changedColor = oldRole.color !== newRole.color;
    const changedPerms = oldRole.permissions.bitfield !== newRole.permissions.bitfield;
    if (!changedName && !changedColor && !changedPerms) return;
    const entry = await auditFor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    const fields = [{ name: 'Rôle', value: `<@&${newRole.id}>`, inline: true }];
    if (changedName) fields.push({ name: 'Nom', value: `${oldRole.name} → ${newRole.name}`, inline: true });
    if (changedColor) fields.push({ name: 'Couleur', value: `#${oldRole.color.toString(16).padStart(6, '0')} → #${newRole.color.toString(16).padStart(6, '0')}`, inline: true });
    if (changedPerms) fields.push({ name: 'Permissions', value: 'modifiées (détail dans le journal d’audit Discord)' });
    fields.push({ name: 'Par', value: mention(entry?.executorId), inline: true });
    logs.log(newRole.guild, {
      category: 'roles',
      event: 'roleUpdate',
      title: 'Rôle modifié',
      actorId: entry?.executorId ?? null,
      targetId: newRole.id,
      fields,
    });
  });
}

module.exports = { registerLogEvents };
