/**
 * Moderation : dossiers, points de warn, MP a la cible, copie lisible en
 * 🛡️│・Modération-logs.
 *
 * Garde-fous deliberes :
 *  - `/mod` (notes, warns, historique, purge) = Helper et plus ; `/sanction` (timeout,
 *    kick, ban, unban, pardon) = Modérateur et plus ;
 *  - un dossier pardonné reste en base (active=false) : on ne réécrit pas l'histoire ;
 *  - un warn purgé = 0 point, mais le dossier reste consultable par numéro ;
 *  - l'automod ne bannit jamais : il propose (voir modules/automod.ts).
 */
import {
  SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, Events, MessageFlags,
  type ChatInputCommandInteraction, type CommandInteraction, type GuildMember, type TextChannel, type User,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast, canActOn, topKey } from '../core/perms.js';
import { logLine, mustText } from '../core/send.js';
import { at, fmtDur, parseDuration, pad, truncate } from '../core/ui.js';
import { type CaseType, type LadderStep, isActive, pointsAfter, escalate, WARN_TTL_DAYS } from '../logic/ladders.js';
import { fr } from '../core/copy.js';

const POINTS: Record<CaseType, number> = { note: 0, warn: 1, timeout: 1, kick: 2, ban: 4, unban: 0, pardon: 0 };

export const moderation: EdgeModule = {
  key: 'moderation',
  label: 'Modération & dossiers',
  needs: { roles: ['mod', 'helper'], channels: ['modLogs'], perms: ['ModerateMembers', 'ManageMessages'] },
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('mod')
        .setDescription('Surveillance : avertissements, notes, dossiers, purge')
        .addSubcommand((s) => s.setName('avertir').setDescription('Poser un avertissement (1 point)')
          .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
          .addStringOption((o) => o.setName('raison').setDescription('Motif, en une phrase claire').setRequired(true).setMaxLength(400))
          .addStringOption((o) => o.setName('preuve').setDescription('Lien du message ou de la capture')))
        .addSubcommand((s) => s.setName('note').setDescription('Note interne, jamais vue par le membre')
          .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
          .addStringOption((o) => o.setName('note').setDescription('Ce qu’il faut savoir').setRequired(true).setMaxLength(400)))
        .addSubcommand((s) => s.setName('historique').setDescription('Tout ce qui existe sur un membre')
          .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('dossier').setDescription('Ouvrir un numéro de dossier')
          .addIntegerOption((o) => o.setName('numero').setDescription('Le # affiché dans les logs').setRequired(true)))
        .addSubcommand((s) => s.setName('conseil').setDescription('Que dit la barre de points en ce moment ?')
          .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('purge').setDescription('Supprimer les messages récents d’un salon')
          .addIntegerOption((o) => o.setName('nombre').setDescription('Combien (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
          .addUserOption((o) => o.setName('membre').setDescription('Uniquement les siens'))) as never,
      guard: { staff: true },
      run: async (c, i) => run(c, i as ChatInputCommandInteraction, 'mod'),
    },
    {
      data: new SlashCommandBuilder().setName('sanction')
        .setDescription('Actions de modération (⚔️│ Modérateur et plus)')
        .addSubcommand((s) => s.setName('timeout').setDescription('Isoler temporairement')
          .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
          .addStringOption((o) => o.setName('duree').setDescription('Ex : 10m, 1h, 24h, 7d').setRequired(true))
          .addStringOption((o) => o.setName('raison').setDescription('Motif').setRequired(true).setMaxLength(400)))
        .addSubcommand((s) => s.setName('untimeout').setDescription('Lever un timeout')
          .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('kick').setDescription('Expulser (il peut revenir)')
          .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
          .addStringOption((o) => o.setName('raison').setDescription('Motif').setRequired(true).setMaxLength(400)))
        .addSubcommand((s) => s.setName('ban').setDescription('Bannir')
          .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
          .addStringOption((o) => o.setName('raison').setDescription('Motif').setRequired(true).setMaxLength(400))
          .addIntegerOption((o) => o.setName('purge').setDescription('Supprimer ses messages des N dernières heures (0-168)')))
        .addSubcommand((s) => s.setName('unban').setDescription('Lever un ban')
          .addStringOption((o) => o.setName('identifiant').setDescription('ID ou tag exact').setRequired(true))
          .addStringOption((o) => o.setName('raison').setDescription('Motif')))
        .addSubcommand((s) => s.setName('pardon').setDescription('Annuler un dossier actif et recalculer les points')
          .addIntegerOption((o) => o.setName('numero').setDescription('Le numéro du dossier').setRequired(true))
          .addStringOption((o) => o.setName('raison').setDescription('Pourquoi tu annules').setMaxLength(300))) as never,
      guard: { min: 'mod' },
      run: async (c, i) => run(c, i as ChatInputCommandInteraction, 'sanction'),
    },
    {
      // clic droit sur un membre -> historique, sans rien taper
      data: new ContextMenuCommandBuilder().setName('📜 Historique des sanctions').setType(ApplicationCommandType.User) as never,
      guard: { staff: true },
      run: async (c, i) => {
        await history(c, i as never, (i as unknown as { targetId?: string }).targetId ?? '');
      },
    },
  ],
  listeners: () => [
    {
      // trace les sanctions posees sans Edge (API directe, client, autre bot)
      event: Events.GuildMemberUpdate,
      run: async (c: Ctx, before: GuildMember, after: GuildMember) => {
        if (!after || before?.id !== after.id) return;
        const was = Boolean(before.communicationDisabledUntilTimestamp && before.communicationDisabledUntilTimestamp > Date.now());
        const is = Boolean(after.communicationDisabledUntilTimestamp && after.communicationDisabledUntilTimestamp > Date.now());
        if (was === is || after.id === c.client.user.id) return;
        logLine('moderation', is
          ? `⏱️ timeout posé hors Edge sur <@${after.id}> jusqu’au ${at(after.communicationDisabledUntilTimestamp as number)}.`
          : `⏱️ timeout levé hors Edge sur <@${after.id}>.`);
      },
    },
    {
      event: Events.GuildBanAdd,
      run: async (c: Ctx, member: GuildMember) => {
        const row = await c.db.one('members', { user_id: member.id });
        logLine('moderation', `🔨 ban : ${member.user.tag} (${member.id})${row?.warn_points ? ` · ${row.warn_points} point(s) cumulés` : ''}`);
      },
    },
  ],
  jobs: () => [
    {
      kind: 'moderation:purge-warns',
      everyMs: 24 * 3_600_000,
      run: async (c) => {
        const rows = await c.db.all('members', { where: {} });
        let cleared = 0;
        for (const r of rows) {
          if (!Number(r.warn_points ?? 0)) continue;
          await recalc(c, String(r.user_id));
          const after = await c.db.one('members', { user_id: String(r.user_id) });
          if (!Number(after?.warn_points ?? 0)) cleared++;
        }
        if (cleared) c.log.info(`${cleared} membre(s) repassé(s) à 0 point (dossiers plus vieux que ${WARN_TTL_DAYS} j)`);
      },
    },
  ],
};

/* ------------------------------------------------------------------ dispatcher */

async function run(c: Ctx, i: ChatInputCommandInteraction, group: 'mod' | 'sanction'): Promise<void> {
  const sub = i.options.getSubcommand();
  if (group === 'mod' && sub === 'purge') return void (await purge(c, i));
  if (group === 'mod' && sub === 'dossier') return void (await dossier(c, i));
  if (group === 'mod' && sub === 'conseil') return void (await advice(c, i));

  const target = i.options.getMember('membre') as GuildMember | null;
  if (group === 'mod' && sub === 'historique') return void (await history(c, i, target?.id ?? ''));
  if (!target) {
    if (sub === 'unban') return void (await unban(c, i));
    return void (await i.editReply({ content: 'Membre introuvable sur ce serveur (il est parti, ou l’ID est faux).' }));
  }
  const actor = i.member as GuildMember;
  const gate = canActOn(actor, target, c.s.idx);
  if (!gate.ok) return void (await i.editReply({ content: `🚫 ${gate.why}` }));

  const reason = i.options.getString('raison') ?? i.options.getString('note') ?? '(motif non précisé)';
  switch (sub) {
    case 'avertir': {
      const id = await addCase(c, { type: 'warn', userId: target.id, moderatorId: actor.id, reason, evidence: i.options.getString('preuve') });
      const points = await recalc(c, target.id);
      await i.editReply({ content: `✅ Avertissement #${pad(String(id))} posé sur ${target.user.username} · points : ${points} → ${escalate(points).label}` });
      break;
    }
    case 'note': {
      const id = await addCase(c, { type: 'note', userId: target.id, moderatorId: actor.id, reason });
      await i.editReply({ content: `🗒️ Note #${pad(String(id))} enregistrée (invisible pour le membre).` });
      break;
    }
    case 'timeout': {
      const dur = parseDuration(i.options.getString('duree', true));
      if (!dur || dur < 1_000) return void (await i.editReply({ content: 'Durée non comprise — formats acceptés : `10m`, `1h`, `24h`, `7d`.' }));
      const capped = Math.min(dur, 28 * 86_400_000);
      if (capped !== dur) await i.followUp({ content: '⚠️ Discord plafonne le timeout à 28 jours : j’ai réduit.', flags: MessageFlags.Ephemeral }).catch(() => void 0);
      await target.timeout(capped, `Edge · ${actor.user.username} : ${reason}`.slice(0, 480));
      const id = await addCase(c, { type: 'timeout', userId: target.id, moderatorId: actor.id, reason, minutes: Math.round(capped / 60_000) });
      await i.editReply({ content: `⏱️ Timeout de ${fmtDur(capped)} posé sur ${target.user.username} (dossier #${pad(String(id))}).` });
      break;
    }
    case 'untimeout': {
      await target.timeout(null, `Edge · levé par ${actor.user.username}`);
      await i.editReply({ content: `⏱️ Timeout levé pour ${target.user.username}.` });
      break;
    }
    case 'kick': {
      await target.kick(`Edge · ${actor.user.username} : ${reason}`.slice(0, 480));
      const id = await addCase(c, { type: 'kick', userId: target.id, moderatorId: actor.id, reason });
      await i.editReply({ content: `👢 ${target.user.username} expulsé (dossier #${pad(String(id))}). Il peut revenir : ça ne remet pas le compteur à zéro.` });
      break;
    }
    case 'ban': {
      const hours = i.options.getInteger('purge') ?? 0;
      if ((topKey(target, c.s.idx) === 'admin') && !atLeast(actor, 'fondateur', c.s.idx)) return void (await i.editReply({ content: fr.noPerm('👑│ Fondateur') }));
      await target.ban({ reason: `Edge · ${actor.user.username} : ${reason}`.slice(0, 480), deleteMessageSeconds: Math.min(604_800, Math.max(0, hours) * 3600) });
      const id = await addCase(c, { type: 'ban', userId: target.id, moderatorId: actor.id, reason });
      await i.editReply({ content: `🔨 ${target.user.username} banni (dossier #${pad(String(id))})${hours ? `, messages des ${hours} dernières heures supprimés` : ''}.` });
      break;
    }
    case 'pardon': {
      const num = i.options.getInteger('numero', true);
      const row = await c.db.one('cases', { id: num });
      if (!row) return void (await i.editReply({ content: `Dossier #${pad(num)} introuvable.` }));
      await c.db.update('cases', { id: String(num) }, { active: false, reason: `${row.reason} → pardonné par ${actor.user.username} : ${reason}` });
      const points = await recalc(c, String(row.user_id));
      logLine('moderation', `🕊️ dossier #${pad(num)} annulé par ${actor.user.username} (${reason}) · points recalculés : ${points}`);
      await i.editReply({ content: `🕊️ Dossier #${pad(num)} annulé. Points actifs : ${points}.` });
      break;
    }
    default:
      await i.editReply({ content: `Subcommande non gérée : ${sub}` });
  }
  void pointsAfter;
}

/* -------------------------------------------------------------------- dossiers */

async function addCase(c: Ctx, o: { type: CaseType; userId: string; moderatorId: string; reason: string; minutes?: number; evidence?: string | null }): Promise<string | number> {
  const expires = o.type === 'timeout' && o.minutes
    ? new Date(Date.now() + o.minutes * 60_000)
    : o.type === 'note' ? null : new Date(Date.now() + WARN_TTL_DAYS * 86_400_000);
  const row = await c.db.insert('cases', {
    user_id: o.userId, moderator_id: o.moderatorId, type: o.type, reason: truncate(o.reason, 380),
    duration_minutes: o.minutes ?? null, evidence_url: o.evidence ?? null,
    active: true, expires_at: expires, dm_sent: false, created_at: new Date(),
  });
  const points = await recalc(c, o.userId);
  const step: LadderStep = escalate(points);
  const target = await c.guild.members.fetch(o.userId).catch(() => null);
  const dm = target ? await notify(c, target, o, row.id as string | number) : false;
  if (dm) await c.db.update('cases', { id: String(row.id) }, { dm_sent: true });
  logLine('moderation', [
    `⚔️ #${pad(String(row.id))} · ${o.type} · <@${o.userId}> par ${o.moderatorId}`,
    `   motif : ${truncate(o.reason, 160)}`,
    o.minutes ? `   durée : ${fmtDur(o.minutes * 60_000)}` : null,
    o.evidence ? `   preuve : ${o.evidence}` : null,
    `   points : ${points} · prochaine étape conseillée : ${step.label}`,
    dm ? '   MP : envoyé' : `   MP : ${target ? 'impossible (MP fermés)' : 'membre parti'}`,
  ].filter((x) => x !== null).join('\n'));
  await c.db.track('case', { type: o.type, user: o.userId, mod: o.moderatorId });
  return row.id as string | number;
}

async function notify(c: Ctx, target: GuildMember, o: { type: CaseType; reason: string; minutes?: number }, caseId: string | number): Promise<boolean> {
  if (o.type === 'note' || o.type === 'unban') return false;
  let panel = '';
  try { panel = `<#${mustText(c, 'ticketOpen').id}>`; } catch { panel = 'le salon 🎫│・Ouvrir-un-ticket'; }
  const body = [
    `Salut ${target.user.username},`,
    '',
    `Une mesure a été prise sur **${c.guild.name}** (dossier #${pad(String(caseId))}).`,
    `Type : ${labelOf(o.type)}${o.minutes ? ` · durée : ${fmtDur(o.minutes * 60_000)}` : ''}`,
    `Motif retenu : ${o.reason}`,
    '',
    `Tu peux contester calmement : motif « ⚖️ Contester une sanction » dans ${panel}.`,
    `Reste factuel — ce qui s'est passé, pas ce que tu penses du staff.`,
    `Un avertissement se purgent tout seul après ${WARN_TTL_DAYS} jours sans récidive.`,
  ].join('\n');
  return target.send({ content: body.slice(0, 1990) }).then(() => true).catch(() => false);
}

const labelOf = (t: CaseType): string => ({ note: 'note interne', warn: 'avertissement', timeout: 'silence forcé', kick: 'expulsion', ban: 'bannissement', unban: 'levée de ban', pardon: 'annulation' }[t] ?? t);

/** Recalcule les points actifs d'un membre depuis ses dossiers (source de verite = cases). */
export async function recalc(c: Ctx, userId: string): Promise<number> {
  const rows = await c.db.all('cases', { where: { user_id: userId } });
  let points = 0;
  for (const r of rows) {
    if (r.type === 'note' || r.active === false) continue;
    if (!isActive({ type: String(r.type), active: r.active as boolean, created_at: r.created_at as string, expires_at: r.expires_at as string })) continue;
    points += POINTS[r.type as CaseType] ?? 0;
  }
  await c.db.upsert('members', ['user_id'], { user_id: userId, warn_points: points }, { warn_points: points });
  return points;
}

async function history(c: Ctx, i: ChatInputCommandInteraction, userId: string): Promise<void> {
  if (!userId) return void (await i.editReply({ content: 'Aucun membre ciblé.' }));
  const rows = await c.db.all('cases', { where: { user_id: userId }, orderBy: 'id', desc: true });
  const target = await c.guild.members.fetch(userId).catch(() => null);
  const mem = await c.db.one('members', { user_id: userId });
  const points = Number(mem?.warn_points ?? 0);
  const head = [
    `📂 ${target ? `**${target.user.username}**` : `\`${userId}\``} — ${rows.length} dossier(s) · ${points} point(s) actif(s)`,
    `Prochaine étape conseillée : ${escalate(points).label}`,
    target ? `Membre depuis ${at(target.joinedAt as unknown as string)}${topKey(target, c.s.idx) ? ` · rôle ${topKey(target, c.s.idx)}` : ''}` : 'Hors serveur',
  ];
  const lines = rows.slice(0, 10).map((r) => {
    const live = isActive({ type: String(r.type), active: r.active as boolean, created_at: r.created_at as string, expires_at: r.expires_at as string });
    return `${live ? '🟢' : '⚪'} #${pad(String(r.id))} ${String(r.type).padEnd(7)} ${truncate(String(r.reason ?? ''), 70)} — par \`${String(r.moderator_id)}\``;
  });
  await i.editReply({ content: [...head, '', ...(lines.length ? lines : ['(aucun dossier)']), rows.length > 10 ? `… ${rows.length - 10} plus ancien(s)` : ''].join('\n').slice(0, 1990) });
}

async function advice(c: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const target = i.options.getMember('membre') as GuildMember;
  const points = await recalc(c, target.id);
  const step = escalate(points);
  await i.editReply({ content: [
    `Barre de ${target.user.username} : **${points} point(s)**`,
    `Étape conseillée maintenant : ${step.label}`,
    `Si tu montes : ${escalate(points + 1).label}`,
    `Un warn vaut 1 pt, un timeout 1 pt, un kick 2 pts. Purge automatique après ${WARN_TTL_DAYS} jours.`,
  ].join('\n') });
}

async function dossier(c: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const num = i.options.getInteger('numero', true);
  const row = await c.db.one('cases', { id: num });
  if (!row) return void (await i.editReply({ content: `Dossier #${pad(num)} introuvable.` }));
  const mod = await c.guild.members.fetch(String(row.moderator_id)).catch(() => null);
  await i.editReply({ content: [
    `📁 Dossier #${pad(num)} · ${labelOf(row.type as CaseType)}${row.active === false ? ' · annulé' : ''}`,
    `cible : <@${row.user_id}> · posé par ${mod ? mod.user.username : `\`${row.moderator_id}\``}`,
    `motif : ${row.reason}`,
    row.duration_minutes ? `durée : ${fmtDur(Number(row.duration_minutes) * 60_000)}` : null,
    `créé le ${at(row.created_at as string)}${row.expires_at ? ` · expire le ${at(row.expires_at as string)}` : ''}`,
    row.evidence_url ? `preuve : ${row.evidence_url}` : null,
    row.dm_sent ? 'MP : envoyé' : 'MP : pas envoyé',
  ].filter(Boolean).join('\n') });
}

async function unban(c: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const q = i.options.getString('identifiant', true);
  const bans = await c.guild.bans.fetch().catch(() => null);
  const hit = bans?.find((b) => b.user.id === q || b.user.tag === q || b.user.username === q);
  if (!hit) return void (await i.editReply({ content: `Aucun ban ne correspond à « ${q} ».` }));
  const actor = i.member as GuildMember;
  await c.guild.bans.remove(hit.user.id, `Edge · ${actor.user.username} : levé`);
  await addCase(c, { type: 'unban', userId: hit.user.id, moderatorId: actor.id, reason: `ban levé (${hit.reason ?? 'sans motif'})` });
  await i.editReply({ content: `✅ Ban levé pour ${hit.user.tag}.` });
}

async function purge(c: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const n = i.options.getInteger('nombre', true);
  const who = i.options.getMember('membre') as GuildMember | null;
  const ch = i.channel as TextChannel | null;
  if (!ch || typeof ch.bulkDelete !== 'function') return void (await i.editReply({ content: 'Pas dans un salon texte.' }));
  const msgs = await ch.messages.fetch({ limit: Math.min(100, Math.max(n, 20)) });
  const doomed = [...msgs.values()].filter((m) => !m.pinned && (!who || m.author.id === who.id) && Date.now() - m.createdTimestamp < 13 * 86_400_000).slice(0, n);
  if (!doomed.length) return void (await i.editReply({ content: 'Rien à supprimer : messages trop vieux, épinglés, ou filtre qui ne correspond à personne.' }));
  const fresh = doomed.filter((m) => Date.now() - m.createdTimestamp < 14 * 86_400_000);
  const del = fresh.length >= 2 ? await ch.bulkDelete(fresh, true).catch(() => null) : null;
  let solo = 0;
  for (const m of doomed) if (!del?.has(m.id)) await m.delete().then(() => { solo++; }).catch(() => void 0);
  const total = (del?.size ?? 0) + solo;
  logLine('moderation', `🧹 ${total}/${n} message(s) retirés dans <#${ch.id}> par ${i.user.username}${who ? ` (filtré sur ${who.user.username})` : ''}`);
  await i.editReply({ content: `🧹 ${total} message(s) supprimé(s) sur ${n} demandés.` });
}

/** Utilitaire expose aux autres modules (automod, antiraid) pour creer un dossier proprement. */
export async function autoCase(c: Ctx, o: { type: CaseType; userId: string; reason: string; minutes?: number }): Promise<string | number> {
  return addCase(c, { ...o, moderatorId: c.client.user.id });
}
export const typeOf = (s: string): CaseType => (['note', 'warn', 'timeout', 'kick', 'ban', 'unban', 'pardon'].includes(s) ? s as CaseType : 'note');
export const userTag = (u: User | null | undefined, id: string): string => (u ? `${u.username} (\`${id}\`)` : `\`${id}\``);
