// Module « Modération » : commandes /ban, /unban, /kick, /timeout, /untimeout, /warn, /warnings,
// /unwarn, /purge, /slowmode.
//  - Chaque commande a sa liste de rôles autorisés (réglée dans /config). Sans rôle choisi, la commande
//    utilise la permission Discord correspondante (ex. « Bannir des membres »).
//  - Les administrateurs et le propriétaire peuvent toujours utiliser les commandes.
//  - Contrôles : pas de sanction sur soi-même, le propriétaire, le bot, ni un membre de rang supérieur
//    ou égal (rôle le plus haut). Le bot doit lui aussi être au-dessus de la cible.
//  - Un MP optionnel prévient le membre (texte modifiable) ; les actions sont écrites dans le module Logs.
//  - Les avertissements sont enregistrés dans Supabase (table edge_warnings).
const { ButtonStyle, MessageFlags, PermissionFlagsBits, RoleSelectMenuBuilder } = require('discord.js');
const store = require('../store');
const { embed, button, row, selectMenu, toggleButton, textModal, moduleSelectRow, ephemeralPayload, truncate } = require('../ui');
const { MODULE_LIST } = require('./registry');
const { parseDuration, formatDuration } = require('../duration');
const logs = require('./logs');

const ID = 'moderation';
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MIN_MS = 60 * 1000;
const TIMEOUT_MAX_MS = 28 * DAY_MS; // limite Discord
const PURGE_MAX_AGE_MS = 14 * DAY_MS; // Discord ignore les messages plus anciens lors d'une suppression groupée
const WARNINGS_SHOWN = 20;
const DM_MAX = 500;
const DEFAULT_DM = 'Tu as reçu une sanction sur **{server}** : {action}.\nRaison : {reason}\nDurée : {duration}';

// Nom de commande -> libellé et permission Discord native (utilisée si aucun rôle n'est choisi).
const COMMANDS = {
  ban: { label: 'Bannir', perm: PermissionFlagsBits.BanMembers, perm_label: 'Bannir des membres' },
  unban: { label: 'Débannir', perm: PermissionFlagsBits.BanMembers, perm_label: 'Bannir des membres' },
  kick: { label: 'Expulser', perm: PermissionFlagsBits.KickMembers, perm_label: 'Expulser des membres' },
  timeout: { label: 'Timeout', perm: PermissionFlagsBits.ModerateMembers, perm_label: 'Exclure temporairement des membres' },
  untimeout: { label: 'Retirer le timeout', perm: PermissionFlagsBits.ModerateMembers, perm_label: 'Exclure temporairement des membres' },
  warn: { label: 'Avertir', perm: PermissionFlagsBits.ModerateMembers, perm_label: 'Exclure temporairement des membres' },
  warnings: { label: 'Voir les avertissements', perm: PermissionFlagsBits.ModerateMembers, perm_label: 'Exclure temporairement des membres' },
  unwarn: { label: 'Retirer un avertissement', perm: PermissionFlagsBits.ModerateMembers, perm_label: 'Exclure temporairement des membres' },
  purge: { label: 'Supprimer des messages', perm: PermissionFlagsBits.ManageMessages, perm_label: 'Gérer les messages' },
  slowmode: { label: 'Mode lent', perm: PermissionFlagsBits.ManageChannels, perm_label: 'Gérer les salons' },
};
const COMMAND_KEYS = Object.keys(COMMANDS);
// Actions qui déclenchent un MP au membre.
const DM_ACTIONS = { ban: 'banni', kick: 'expulsé', timeout: 'mis en timeout', warn: 'averti' };

const DEFAULTS = {
  enabled: false,
  notifyTarget: true,
  texts: { dm: DEFAULT_DM },
  roles: Object.fromEntries(COMMAND_KEYS.map((k) => [k, []])),
};

const cfgOf = (guildId) => {
  const cfg = store.getModuleConfig(guildId, ID, DEFAULTS);
  cfg.roles = { ...DEFAULTS.roles, ...cfg.roles };
  return cfg;
};
const rolesOf = (cfg, name) => (Array.isArray(cfg.roles?.[name]) ? cfg.roles[name] : []);

class ModerationError extends Error {}
const fail = (message) => {
  throw new ModerationError(message);
};

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
// Vrai si le membre peut utiliser la commande selon la configuration du serveur.
function canUse(member, name, cfg) {
  if (!member || !COMMANDS[name]) return false;
  if (member.id === member.guild?.ownerId) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  const roles = rolesOf(cfg, name);
  if (roles.length) return roles.some((id) => member.roles.cache.has(id));
  return Boolean(member.permissions?.has(COMMANDS[name].perm));
}

function denialMessage(name, cfg) {
  const roles = rolesOf(cfg, name);
  if (roles.length) return `Tu n’as pas la permission d’utiliser \`/${name}\`. Rôles autorisés : ${roles.map((id) => `<@&${id}>`).join(' ')}.`;
  return `Tu n’as pas la permission d’utiliser \`/${name}\`. Il faut la permission Discord « ${COMMANDS[name].perm_label} ».`;
}

// Contrôles de hiérarchie avant une sanction sur un membre du serveur.
function ensureCanModerate(guild, actor, member) {
  if (member.id === guild.client.user.id) fail('Je ne peux pas me sanctionner moi-même.');
  if (member.id === actor.id) fail('Tu ne peux pas te sanctionner toi-même.');
  if (member.id === guild.ownerId) fail('Impossible de sanctionner le propriétaire du serveur.');
  if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    fail('Ce membre a un rôle égal ou supérieur au tien.');
  }
  const me = guild.members.me;
  if (me && me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    fail('Mon rôle est trop bas pour sanctionner ce membre. Place le rôle du bot au-dessus.');
  }
}

async function fetchMember(guild, userId) {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

// ---------------------------------------------------------------------------
// Helpers d'actions
// ---------------------------------------------------------------------------
const reasonOf = (interaction) => interaction.options.getString('raison')?.trim() || 'Aucune raison précisée';

// Raison inscrite dans le journal d'audit Discord (512 caractères maximum).
const auditReason = (actor, command, reason) => truncate(`${actor.user.username} via /${command} : ${reason}`, 512);

// Remplit le texte du MP ; la ligne « Durée » disparaît si la sanction n'a pas de durée.
function fillDm(template, { action, server, reason, duration }) {
  return String(template)
    .split('\n')
    .filter((line) => !(line.includes('{duration}') && !duration))
    .join('\n')
    .replaceAll('{action}', action)
    .replaceAll('{server}', server)
    .replaceAll('{reason}', reason)
    .replaceAll('{duration}', duration ?? '')
    .trim();
}

// MP au membre avant la sanction (après un ban, le bot ne peut plus lui écrire).
async function notify(cfg, guild, user, action, reason, duration) {
  const template = cfg.texts?.dm ?? DEFAULT_DM;
  if (!cfg.notifyTarget || !template.trim() || !user || user.bot) return;
  const text = fillDm(template, { action, server: guild.name, reason, duration });
  try {
    await user.send({ content: truncate(text, 2000), allowedMentions: { parse: [] } });
  } catch {
    // MP refusé (DMs fermés) : la sanction reste appliquée.
  }
}

// Nom et avatar d'une cible (User ou GuildMember).
function userInfo(target) {
  const u = target.user ?? target;
  return { name: u.username ?? String(target.id), iconURL: u.displayAvatarURL?.() };
}

function journal(guild, event, title, { actor, target, channelId, description, fields = [] }) {
  logs.log(guild, {
    category: 'moderation',
    event,
    title,
    description,
    actorId: actor?.id ?? null,
    targetId: target?.id ?? null,
    channelId: channelId ?? null,
    user: target ? userInfo(target) : undefined,
    fields: [
      { name: 'Membre', value: target ? `<@${target.id}>` : null, inline: true },
      { name: 'Par', value: actor ? `<@${actor.id}>` : null, inline: true },
      ...fields,
    ],
  });
}

// Secondes lisibles pour le mode lent : « 30 s », « 5 min », « 2 h ».
function formatSeconds(seconds) {
  if (seconds === 0) return 'désactivé';
  return seconds < 60 ? `${seconds} s` : formatDuration(seconds * 1000);
}

// ---------------------------------------------------------------------------
// Actions (une par commande). Chacune renvoie le texte de confirmation.
// ---------------------------------------------------------------------------
const ACTIONS = {
  async ban({ interaction, guild, cfg, actor }) {
    const user = interaction.options.getUser('membre', true);
    const reason = reasonOf(interaction);
    const days = interaction.options.getInteger('supprimer') ?? 0;
    const member = await fetchMember(guild, user.id);
    if (member) {
      ensureCanModerate(guild, actor, member);
      if (!member.bannable) fail('Je ne peux pas bannir ce membre (permissions ou rôle trop haut).');
    } else if (user.id === actor.id) {
      fail('Tu ne peux pas te bannir toi-même.');
    }
    await notify(cfg, guild, user, DM_ACTIONS.ban, reason);
    logs.markBotAction('ban', guild.id, user.id);
    await guild.bans.create(user.id, { reason: auditReason(actor, 'ban', reason), deleteMessageSeconds: days * 86400 });
    journal(guild, 'ban', 'Membre banni', {
      actor,
      target: user,
      channelId: interaction.channelId,
      description: `Raison : ${reason}`,
      fields: days ? [{ name: 'Messages supprimés', value: `${days} j`, inline: true }] : [],
    });
    return `🔨 ${user} a été **banni**.\nRaison : ${reason}`;
  },

  async unban({ interaction, guild, cfg, actor }) {
    const raw = interaction.options.getString('utilisateur', true);
    const id = raw.match(/\d{17,20}/)?.[0];
    if (!id) fail('Identifiant invalide. Donne l’identifiant (ID) du membre : clic droit sur son profil, puis « Copier l’identifiant ».');
    const reason = reasonOf(interaction);
    const ban = await guild.bans.fetch(id).catch(() => null);
    if (!ban) fail('Ce membre n’est pas banni.');
    logs.markBotAction('unban', guild.id, id);
    await guild.bans.remove(id, auditReason(actor, 'unban', reason));
    journal(guild, 'unban', 'Ban levé', { actor, target: ban.user, channelId: interaction.channelId, description: `Raison : ${reason}` });
    return `✅ Le bannissement de <@${id}> a été retiré.\nRaison : ${reason}`;
  },

  async kick({ interaction, guild, cfg, actor }) {
    const user = interaction.options.getUser('membre', true);
    const reason = reasonOf(interaction);
    const member = await fetchMember(guild, user.id);
    if (!member) fail('Ce membre n’est pas sur le serveur.');
    ensureCanModerate(guild, actor, member);
    if (!member.kickable) fail('Je ne peux pas expulser ce membre (permissions ou rôle trop haut).');
    await notify(cfg, guild, user, DM_ACTIONS.kick, reason);
    logs.markBotAction('kick', guild.id, user.id);
    await member.kick(auditReason(actor, 'kick', reason));
    journal(guild, 'kick', 'Membre expulsé', { actor, target: user, channelId: interaction.channelId, description: `Raison : ${reason}` });
    return `👢 ${user} a été **expulsé**.\nRaison : ${reason}`;
  },

  async timeout({ interaction, guild, cfg, actor }) {
    const user = interaction.options.getUser('membre', true);
    const reason = reasonOf(interaction);
    const ms = parseDuration(interaction.options.getString('duree', true));
    if (!ms) fail('Durée invalide. Exemples : `10m`, `2h`, `1j`, `1j 12h`.');
    if (ms < TIMEOUT_MIN_MS || ms > TIMEOUT_MAX_MS) fail('La durée doit être comprise entre 1 minute et 28 jours.');
    const member = await fetchMember(guild, user.id);
    if (!member) fail('Ce membre n’est pas sur le serveur.');
    ensureCanModerate(guild, actor, member);
    if (!member.moderatable) fail('Je ne peux pas mettre ce membre en timeout (permissions ou rôle trop haut).');
    const duration = formatDuration(ms);
    await notify(cfg, guild, user, DM_ACTIONS.timeout, reason, duration);
    logs.markBotAction('timeout', guild.id, user.id);
    await member.timeout(ms, auditReason(actor, 'timeout', reason));
    journal(guild, 'timeout', 'Timeout appliqué', {
      actor,
      target: user,
      channelId: interaction.channelId,
      description: `Raison : ${reason}`,
      fields: [
        { name: 'Durée', value: duration, inline: true },
        { name: 'Fin', value: `<t:${Math.floor((Date.now() + ms) / 1000)}:F>`, inline: true },
      ],
    });
    return `🔇 ${user} est en timeout pendant **${duration}**.\nRaison : ${reason}`;
  },

  async untimeout({ interaction, guild, cfg, actor }) {
    const user = interaction.options.getUser('membre', true);
    const reason = reasonOf(interaction);
    const member = await fetchMember(guild, user.id);
    if (!member) fail('Ce membre n’est pas sur le serveur.');
    ensureCanModerate(guild, actor, member);
    if (!member.isCommunicationDisabled()) fail('Ce membre n’est pas en timeout.');
    if (!member.moderatable) fail('Je ne peux pas retirer le timeout de ce membre.');
    logs.markBotAction('timeout', guild.id, user.id);
    await member.timeout(null, auditReason(actor, 'untimeout', reason));
    journal(guild, 'untimeout', 'Timeout retiré', { actor, target: user, channelId: interaction.channelId, description: `Raison : ${reason}` });
    return `🔊 Le timeout de ${user} a été retiré.`;
  },

  async warn({ interaction, guild, cfg, actor }) {
    const user = interaction.options.getUser('membre', true);
    const reason = interaction.options.getString('raison', true).trim();
    const member = await fetchMember(guild, user.id);
    if (!member) fail('Ce membre n’est pas sur le serveur.');
    ensureCanModerate(guild, actor, member);
    const row = await store.addWarning({ guild_id: guild.id, user_id: user.id, moderator_id: actor.id, reason });
    await notify(cfg, guild, user, DM_ACTIONS.warn, reason);
    const total = (await store.loadWarnings(guild.id, user.id)).length;
    journal(guild, 'warn', 'Avertissement donné', {
      actor,
      target: user,
      channelId: interaction.channelId,
      description: `Raison : ${reason}`,
      fields: [
        { name: 'Numéro', value: `#${row.id}`, inline: true },
        { name: 'Total', value: String(total), inline: true },
      ],
    });
    return `⚠️ Avertissement **#${row.id}** donné à ${user}. Il a maintenant **${total}** avertissement(s).\nRaison : ${reason}`;
  },

  async warnings({ interaction, guild }) {
    const user = interaction.options.getUser('membre', true);
    const list = await store.loadWarnings(guild.id, user.id);
    if (!list.length) return `${user} n’a aucun avertissement.`;
    const lines = list.slice(0, WARNINGS_SHOWN).map((w) => {
      const date = `<t:${Math.floor(new Date(w.created_at).getTime() / 1000)}:d>`;
      return `**#${w.id}** · ${date} · par <@${w.moderator_id}>\n${truncate(w.reason, 200)}`;
    });
    const more = list.length > WARNINGS_SHOWN ? `\n… et ${list.length - WARNINGS_SHOWN} autre(s).` : '';
    return `**${list.length}** avertissement(s) pour ${user} :\n\n${lines.join('\n\n')}${more}`;
  },

  async unwarn({ interaction, guild, actor }) {
    const id = interaction.options.getInteger('id', true);
    const removed = await store.deleteWarning(guild.id, id);
    if (!removed) fail(`Avertissement #${id} introuvable sur ce serveur.`);
    journal(guild, 'unwarn', 'Avertissement retiré', {
      actor,
      target: { id: removed.user_id, username: removed.user_id },
      channelId: interaction.channelId,
      fields: [
        { name: 'Numéro', value: `#${id}`, inline: true },
        { name: 'Raison d’origine', value: truncate(removed.reason, 300) },
      ],
    });
    return `✅ Avertissement **#${id}** retiré (membre : <@${removed.user_id}>).`;
  },

  async purge({ interaction, guild, actor }) {
    const channel = interaction.channel;
    if (!channel || typeof channel.bulkDelete !== 'function') fail('Ce salon ne permet pas de supprimer des messages en masse.');
    const amount = interaction.options.getInteger('nombre', true);
    const user = interaction.options.getUser('membre');
    const fetched = await channel.messages.fetch({ limit: 100 });
    let targets = [...fetched.values()].filter((m) => Date.now() - m.createdTimestamp < PURGE_MAX_AGE_MS);
    if (user) targets = targets.filter((m) => m.author.id === user.id);
    targets = targets.slice(0, amount);
    if (!targets.length) return 'Aucun message récent à supprimer.';
    logs.markBotAction('bulk', guild.id, channel.id);
    const deleted = await channel.bulkDelete(targets, true);
    const count = deleted.size;
    journal(guild, 'purge', 'Messages supprimés (/purge)', {
      actor,
      target: user,
      channelId: channel.id,
      fields: [
        { name: 'Salon', value: `<#${channel.id}>`, inline: true },
        { name: 'Nombre', value: String(count), inline: true },
      ],
    });
    const scope = user ? ` de ${user}` : '';
    const skipped = count < targets.length ? '\nLes messages de plus de 14 jours ne peuvent pas être supprimés en masse.' : '';
    return `🧹 **${count}** message(s)${scope} supprimé(s) dans <#${channel.id}>.${skipped}`;
  },

  async slowmode({ interaction, guild, actor }) {
    const seconds = interaction.options.getInteger('secondes', true);
    const channel = interaction.options.getChannel('salon') ?? interaction.channel;
    if (!channel || typeof channel.setRateLimitPerUser !== 'function') fail('Ce salon ne permet pas le mode lent.');
    await channel.setRateLimitPerUser(seconds, auditReason(actor, 'slowmode', `${seconds} s`));
    journal(guild, 'slowmode', 'Mode lent modifié', {
      actor,
      channelId: channel.id,
      fields: [
        { name: 'Salon', value: `<#${channel.id}>`, inline: true },
        { name: 'Délai', value: formatSeconds(seconds), inline: true },
      ],
    });
    return seconds === 0
      ? `🐢 Mode lent désactivé dans <#${channel.id}>.`
      : `🐢 Mode lent réglé à **${formatSeconds(seconds)}** dans <#${channel.id}>.`;
  },
};

// Point d'entrée des commandes de modération.
async function handleCommand(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply(ephemeralPayload('Cette commande ne fonctionne que sur un serveur.'));
  // Accusé de réception immédiat (Discord attend une réponse dans les 3 s).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const say = (text) => interaction.editReply({ embeds: [embed(truncate(text, 4000))] });

  const name = interaction.commandName;
  const cfg = cfgOf(guild.id);
  if (!cfg.enabled) return say('Le module Modération est désactivé. Active-le dans `/config`.');
  if (!canUse(interaction.member, name, cfg)) return say(denialMessage(name, cfg));

  try {
    const text = await ACTIONS[name]({ interaction, guild, cfg, actor: interaction.member });
    return say(text);
  } catch (err) {
    if (err instanceof ModerationError) return say(`❌ ${err.message}`);
    console.error(`[moderation] /${name} :`, err);
    return say(`❌ Action impossible : ${truncate(err.message, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Interface /config
// ---------------------------------------------------------------------------
function rolesSummary(cfg, name) {
  const roles = rolesOf(cfg, name);
  return roles.length ? roles.map((id) => `<@&${id}>`).join(' ') : `Permission Discord : ${COMMANDS[name].perm_label}`;
}

function render(view, guild, arg) {
  const cfg = cfgOf(guild.id);
  if (view === 'roles') return arg && COMMANDS[arg] ? renderCommand(cfg, arg) : renderRoles(cfg);
  return renderMain(cfg);
}

function renderMain(cfg) {
  return {
    content:
      '🛡️ **Module Modération** · commandes de sanction, avec des rôles autorisés par commande.',
    embeds: [
      embed()
        .addFields(
          { name: 'Module', value: cfg.enabled ? '🟢 Activé' : '⚪ Désactivé', inline: true },
          { name: 'MP au membre', value: cfg.notifyTarget && cfg.texts.dm.trim() ? '🟢 Envoyé' : '⚪ Désactivé (ou texte vide)', inline: true },
          { name: 'Commandes', value: COMMAND_KEYS.map((k) => `\`/${k}\` → ${truncate(rolesSummary(cfg, k), 120)}`).join('\n').slice(0, 1024), inline: false },
        ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        toggleButton('cfg:moderation:toggle:enabled', 'Module', cfg.enabled),
        toggleButton('cfg:moderation:toggle:notifyTarget', 'MP', cfg.notifyTarget),
        button('cfg:moderation:view:roles', 'Rôles par commande', ButtonStyle.Primary, '🔑'),
        button('cfg:moderation:open:dm', 'Texte du MP', ButtonStyle.Primary, '✏️'),
      ),
    ],
  };
}

function renderRoles(cfg) {
  return {
    content: '🔑 **Rôles par commande** · choisis une commande pour régler qui peut l’utiliser.',
    embeds: [
      embed(
        'Sans rôle choisi, la commande suit la permission Discord native. Les administrateurs et le propriétaire peuvent toujours utiliser toutes les commandes.',
      ).addFields({ name: 'État', value: COMMAND_KEYS.map((k) => `\`/${k}\` → ${truncate(rolesSummary(cfg, k), 120)}`).join('\n').slice(0, 1024) }),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      selectMenu(
        'cfg:moderation:pick:cmd',
        'Choisir une commande',
        COMMAND_KEYS.map((k) => ({
          label: `/${k} · ${COMMANDS[k].label}`,
          value: k,
          description: truncate(`Permission native : ${COMMANDS[k].perm_label}`, 100),
        })),
      ),
      row(button('cfg:moderation:view:main', 'Retour', ButtonStyle.Secondary, '⬅️')),
    ],
  };
}

function renderCommand(cfg, name) {
  const selected = rolesOf(cfg, name);
  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`cfg:moderation:pick:roles:${name}`)
    .setPlaceholder('Choisir les rôles autorisés')
    .setMinValues(0)
    .setMaxValues(25);
  if (selected.length) roleSelect.setDefaultRoles(...selected);
  return {
    content: `🔑 **/${name}** · ${COMMANDS[name].label}`,
    embeds: [
      embed().addFields(
        { name: 'Rôles autorisés', value: truncate(rolesSummary(cfg, name), 1000), inline: false },
        { name: 'Repli', value: `Sans rôle : permission Discord « ${COMMANDS[name].perm_label} ».`, inline: false },
      ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(roleSelect),
      row(
        button(`cfg:moderation:clear:${name}`, 'Tout effacer', ButtonStyle.Danger, '🗑️'),
        button('cfg:moderation:view:roles', 'Retour', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , action, ...rest] = interaction.customId.split(':');
  const arg = rest.join(':');
  const cfg = cfgOf(guild.id);
  const save = () => store.updateModuleConfig(guild.id, ID, cfg);

  switch (action) {
    case 'view':
      if (arg === 'roles') return interaction.update(renderRoles(cfg));
      return interaction.update(renderMain(cfg));

    case 'toggle':
      if (!['enabled', 'notifyTarget'].includes(arg)) return;
      cfg[arg] = !cfg[arg];
      save();
      return interaction.update(renderMain(cfg));

    case 'pick': {
      if (arg === 'cmd') {
        const name = interaction.values[0];
        if (!COMMANDS[name]) return;
        return interaction.update(renderCommand(cfg, name));
      }
      if (arg.startsWith('roles:')) {
        const name = arg.slice('roles:'.length);
        if (!COMMANDS[name]) return;
        cfg.roles[name] = [...interaction.values].slice(0, 25);
        save();
        return interaction.update(renderCommand(cfg, name));
      }
      return;
    }

    case 'clear': {
      if (!COMMANDS[arg]) return;
      cfg.roles[arg] = [];
      save();
      return interaction.update(renderCommand(cfg, arg));
    }

    case 'open': {
      if (arg !== 'dm') return;
      return interaction.showModal(
        textModal('cfg:moderation:modal:dm', 'Message envoyé au membre', [
          {
            key: 'dm',
            label: 'Texte du MP (vide = désactivé)',
            max: DM_MAX,
            paragraph: true,
            required: false,
            value: cfg.texts.dm,
            placeholder: 'Variables : {action}, {server}, {reason}, {duration}',
          },
        ]),
      );
    }

    default:
      return;
  }
}

async function handleModal(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const cfg = cfgOf(guild.id);
  const value = interaction.fields.getTextInputValue('dm').trim();
  cfg.texts.dm = value; // vide = aucun MP envoyé
  store.updateModuleConfig(guild.id, ID, cfg);
  await interaction.deferUpdate();
  return interaction.editReply(renderMain(cfg));
}

module.exports = {
  ID,
  DEFAULTS,
  COMMANDS,
  COMMAND_KEYS,
  DEFAULT_DM,
  canUse,
  denialMessage,
  fillDm,
  formatSeconds,
  ensureCanModerate,
  handleCommand,
  handleComponent,
  handleModal,
  render,
  // Exposé pour les tests.
  _renderers: { renderMain, renderRoles, renderCommand },
};
