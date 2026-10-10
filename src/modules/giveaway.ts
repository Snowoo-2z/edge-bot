/**
 * Giveaway. Un bouton 🎉 pour participer (le salon est en lecture seule : pas de spam
 * de « +1 »), des conditions cumulables, une ponderation par role, un tirage crypto
 * pondere, une fin programmee qui survit a un redemarrage (job en base, pas setTimeout).
 */
import {
  SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, time, TimestampStyles,
  type ButtonInteraction, type GuildMember, type Message,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast } from '../core/perms.js';
import { logLine, mustText } from '../core/send.js';
import { fmtDur, pad, parseDuration, truncate } from '../core/ui.js';
import { weightedDraw, type Weighted } from '../logic/draw.js';
import { DEFAULT_WEIGHTS, weightOf } from '../logic/ladders.js';
import { COLORS, roleDef, type RoleKey } from '../manifest.js';
import { fr } from '../core/copy.js';

interface Gw { id: string; message_id: string | null; channel_id: string; host_id: string; prize: string; ends_at: string; winners_count: number; requires_roles: string[]; min_days: number; weights: Record<string, number>; ping: boolean; status: string }
const map = (r: Record<string, unknown>): Gw => ({
  id: String(r.id), message_id: r.message_id ? String(r.message_id) : null, channel_id: String(r.channel_id), host_id: String(r.host_id),
  prize: String(r.prize), ends_at: String(r.ends_at), winners_count: Number(r.winners_count ?? 1),
  requires_roles: Array.isArray(r.requires_roles) ? (r.requires_roles as string[]) : [], min_days: Number(r.min_days ?? 0),
  weights: (r.weights as Record<string, number>) ?? DEFAULT_WEIGHTS, ping: Boolean(r.ping), status: String(r.status),
});

export const giveaway: EdgeModule = {
  key: 'giveaway',
  label: 'Giveaways',
  needs: { roles: ['animateur', 'notifGiveaway'], channels: ['giveaway'], perms: ['ManageMessages'] },
  sync: async (c: Ctx) => {
    const rows = (await c.db.all('giveaways', { where: { status: 'running' } })).map(map);
    let repaired = 0;
    for (const g of rows) {
      if (new Date(g.ends_at).getTime() <= Date.now()) { await finish(c, g, 'fin rattrapée au redémarrage'); repaired++; continue; }
      await c.sched.at('giveaway:end', g.id, new Date(g.ends_at), { id: g.id });
    }
    if (rows.length) c.log.info(`${rows.length - repaired}/${rows.length} giveaway(s) remis sous surveillance`);
  },
  jobs: () => [
    {
      kind: 'giveaway:end',
      run: async (c, payload) => {
        const row = await c.db.one('giveaways', { id: String(payload.id) });
        if (!row) return;
        const g = map(row);
        if (g.status !== 'running') return;
        await finish(c, g);
      },
    },
  ],
  components: () => ({
    join: async (c: Ctx, i: ButtonInteraction, args: string[]) => {
      const row = await c.db.one('giveaways', { id: args[0]!, status: 'running' });
      if (!row) return void (await i.reply({ content: 'Ce concours est fini.', flags: 64 as never }));
      const g = map(row);
      if (Date.now() > new Date(g.ends_at).getTime()) return void (await i.reply({ content: 'Le tirage est passé.', flags: 64 as never }));
      const m = i.member as GuildMember;
      const missing = g.requires_roles.filter((rk) => !c.s.roleId(rk as RoleKey) || !m.roles.cache.has(c.s.roleId(rk as RoleKey)!));
      if (missing.length) return void (await i.reply({ content: `Il te manque : ${missing.map((x) => roleDef(x as RoleKey).name).join(', ')}.`, flags: 64 as never }));
      if (g.min_days > 0 && m.joinedAt && (Date.now() - m.joinedAt.getTime()) / 86_400_000 < g.min_days) {
        return void (await i.reply({ content: `Il faut être arrivé depuis ${g.min_days} jour(s) minimum.`, flags: 64 as never }));
      }
      const weight = weightOf(Object.keys(g.weights).filter((k) => m.roles.cache.has(c.s.roleId(k as RoleKey)!)), g.weights);
      const already = await c.db.one('giveaway_entries', { giveaway_id: g.id, user_id: m.id });
      if (already) {
        await c.db.delete('giveaway_entries', { giveaway_id: g.id, user_id: m.id });
        return void (await i.reply({ content: '❌ Retiré du tirage.', flags: 64 as never }));
      }
      await c.db.insert('giveaway_entries', { giveaway_id: g.id, user_id: m.id, weight, created_at: new Date() });
      const bonus = weight > 1 ? ` ×${weight} (${roleKeysLabel(c, m)})` : '';
      await i.reply({ content: `🎉 Inscrit${bonus}. Tu peux retirer ton inscription en retapant sur le bouton.`, flags: 64 as never });
      await editCounter(c, g);
    },
  }),
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('giveaway')
        .setDescription('Concours du serveur')
        .addSubcommand((s) => s.setName('demarrer').setDescription('Lancer un concours')
          .addStringOption((o) => o.setName('lot').setDescription('Ce qui est gagné').setRequired(true).setMaxLength(300))
          .addStringOption((o) => o.setName('duree').setDescription('Ex : 2h, 24h, 3j').setRequired(true))
          .addIntegerOption((o) => o.setName('gagnants').setDescription('Combien de gagnants (défaut 1)'))
          .addRoleOption((o) => o.setName('role_requis').setDescription('Il faut ce rôle pour participer'))
          .addIntegerOption((o) => o.setName('anciennete').setDescription('Jours minimum sur le serveur'))
          .addBooleanOption((o) => o.setName('ping').setDescription('Prévenir 🎁│ Notification Giveaway (défaut : oui)'))
          .addChannelOption((o) => o.setName('salon').setDescription('Où (défaut : 🎁│・Giveaway)')))
        .addSubcommand((s) => s.setName('list').setDescription('Les concours en cours'))
        .addSubcommand((s) => s.setName('finir').setDescription('Tirer maintenant').addIntegerOption((o) => o.setName('numero').setDescription('Le # du giveaway').setRequired(true)))
        .addSubcommand((s) => s.setName('annuler').setDescription('Annuler sans tirer').addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true)).addStringOption((o) => o.setName('raison').setDescription('Pourquoi').setMaxLength(200)))
        .addSubcommand((s) => s.setName('reroll').setDescription('Tirer un gagnant de plus').addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true)).addIntegerOption((o) => o.setName('nombre').setDescription('Combien (défaut 1)')))
        .addSubcommand((s) => s.setName('gagnants').setDescription('Qui a gagné tel concours').addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true))) as never,
      guard: { min: 'animateur' },
      cooldownMs: 5_000,
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const rows = (await c.db.all('giveaways', { where: { status: 'running' }, orderBy: 'ends_at' })).map(map);
          return void (await i.editReply({ content: rows.length ? rows.map((g) => `#${pad(g.id)} ${truncate(g.prize, 60)} · fin ${time(new Date(g.ends_at), TimestampStyles.RelativeTime)} · <#${g.channel_id}>`).join('\n') : '🎁 Aucun concours en cours.' }));
        }
        const num = i.options.getInteger('numero');
        if (num === null) {
          const dur = parseDuration(i.options.getString('duree', true));
          if (!dur || dur < 60_000) return void (await i.editReply({ content: 'Durée pas comprise — `30m`, `2h`, `3j`. Minimum 1 minute.' }));
          if (dur > 60 * 86_400_000) return void (await i.editReply({ content: 'Au-delà de 60 jours, un concours dort. Raccourcis ou relance-le.' }));
          const ch = (i.options.getChannel('salon') as import('discord.js').TextChannel | null) ?? mustText(c, 'giveaway');
          const roleReq = i.options.getRole('role_requis');
          const row = await c.db.insert('giveaways', {
            channel_id: ch.id, host_id: i.user.id, prize: i.options.getString('lot', true),
            ends_at: new Date(Date.now() + dur), winners_count: i.options.getInteger('gagnants') ?? 1,
            requires_roles: roleReq ? [roleKeyOf(c, roleReq.id)] : [], min_days: i.options.getInteger('anciennete') ?? 0,
            weights: DEFAULT_WEIGHTS, ping: i.options.getBoolean('ping') ?? true, status: 'running',
          });
          const g = map(row);
          const msg = await ch.send({
            embeds: [gwEmbed(c, g, i.user.username)],
            components: controls(g),
            allowedMentions: { parse: g.ping ? ['users', 'roles'] : ['users'] },
            content: g.ping ? pingLine(c) : undefined,
          });
          await c.db.update('giveaways', { id: g.id }, { message_id: msg.id });
          await c.sched.at('giveaway:end', g.id, new Date(g.ends_at), { id: g.id });
          logLine('staff', `🎁 giveaway #${pad(g.id)} lancé par ${i.user.username} : ${truncate(g.prize, 90)} (fin dans ${fmtDur(dur)})`);
          return void (await i.editReply({ content: `✅ Concours #${pad(g.id)} lancé dans <#${ch.id}>, tirage ${time(new Date(g.ends_at), TimestampStyles.RelativeTime)}.` }));
        }
        const raw = await c.db.one('giveaways', { id: num });
        if (!raw) return void (await i.editReply({ content: `Concours #${pad(num)} inconnu.` }));
        const g = map(raw);
        if (sub === 'finir') { await c.db.delete('scheduler_jobs', { kind: 'giveaway:end', ref_key: g.id }); await finish(c, g, 'fin anticipée'); return void (await i.editReply({ content: '🎉 Tirage fait.' })); }
        if (sub === 'annuler') {
          await c.db.update('giveaways', { id: g.id }, { status: 'cancelled', ended_at: new Date() });
          await c.sched.cancel('giveaway:end', g.id);
          const ch = c.guild.channels.cache.get(g.channel_id) as import('discord.js').TextChannel | undefined;
          if (g.message_id && ch) await ch.messages.fetch(g.message_id).then((m) => m.edit({ embeds: [gwEmbed(c, g, undefined, `🚫 Annulé par ${i.user.username} — ${i.options.getString('raison') ?? 'sans motif'}`)], components: [] })).catch(() => void 0);
          return void (await i.editReply({ content: `🚫 #${pad(g.id)} annulé, aucun tirage.` }));
        }
        if (sub === 'gagnants') {
          const ids = (raw.winner_ids as string[] | null) ?? [];
          return void (await i.editReply({ content: ids.length ? `Gagnant(s) de #${pad(g.id)} : ${ids.map((x) => `<@${x}>`).join(' ')}` : `Aucun gagnant enregistré pour #${pad(g.id)}.` }));
        }
        if (sub === 'reroll') {
          const entries = (await c.db.all('giveaway_entries', { where: { giveaway_id: g.id } })).map(entry);
          const k = i.options.getInteger('nombre') ?? 1;
          const picks = weightedDraw(entries, k);
          if (!picks.length) return void (await i.editReply({ content: 'Personne à tirer : aucune participation valide.' }));
          const prev = ((raw.winner_ids as string[] | null) ?? []);
          await c.db.update('giveaways', { id: g.id }, { winner_ids: [...prev, ...picks.map((p) => p.userId)] });
          const ch = c.guild.channels.cache.get(g.channel_id) as import('discord.js').TextChannel | undefined;
          await ch?.send({ content: `🔁 Reroll #${pad(g.id)} : ${picks.map((p) => `<@${p.userId}>`).join(' ')} — félicitations (le lot est le même, on repart pas de zéro).` });
          return void (await i.editReply({ content: `🔁 ${picks.length} nouveau(x) gagnant(s) tiré(s).` }));
        }
      },
    },
  ],
};

/* ------------------------------------------------------------------ interieur */

interface Entry extends Weighted { userId: string }
const entry = (r: Record<string, unknown>): Entry => ({ userId: String(r.user_id), weight: Number(r.weight ?? 1) });

function gwEmbed(c: Ctx, g: Gw, host?: string, note?: string): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(`🎁 ${truncate(g.prize, 240)}`)
    .setColor(COLORS.giveaway)
    .setTimestamp(new Date(g.ends_at))
    .setDescription([
      `Clique sur **🎉 Participer** pour entrer. Une personne = une entrée, retirable jusqu'au tirage.`,
      g.winners_count > 1 ? `**${g.winners_count} gagnants.**` : '**1 gagnant.**',
      g.requires_roles.length ? `Il faut le rôle ${g.requires_roles.map((r) => `**${roleDef(r as RoleKey).name}**`).join(' ou ')}.` : '',
      g.min_days ? `Être arrivé depuis au moins ${g.min_days} jour(s).` : '',
      Object.keys(g.weights).length ? `Bonus de tirage : ${Object.entries(g.weights).map(([k, v]) => `${roleDef(k as RoleKey).name} ×${v}`).join(', ')}.` : '',
      note ? `\n${note}` : '',
    ].filter(Boolean).join('\n'))
    .setFooter({ text: note ? 'Concours terminé' : `Terminé ${new Date(g.ends_at).toLocaleString('fr-FR')}${host ? ` · lancé par ${host}` : ''}` });
  return e;
}

const controls = (g: Gw): ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>[] => [
  new ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`edge:giveaway:join:${g.id}`).setLabel('🎉 Participer').setStyle(ButtonStyle.Primary),
  ),
];

const pingLine = (c: Ctx): string => {
  const id = c.s.roleId('notifGiveaway');
  return id ? `<@&${id}> un concours vient de s'ouvrir 🎁` : 'Un concours vient de s’ouvrir 🎁';
};

const roleKeysLabel = (c: Ctx, m: GuildMember): string =>
  [...c.s.idx.byId.entries()].filter(([id]) => m.roles.cache.has(id)).map(([, k]) => k).join('+');
const roleKeyOf = (c: Ctx, roleId: string): string => c.s.idx.byId.get(roleId) ?? roleId;

async function editCounter(c: Ctx, g: Gw): Promise<void> {
  if (!g.message_id) return;
  const ch = c.guild.channels.cache.get(g.channel_id) as import('discord.js').TextChannel | undefined;
  const msg = await ch?.messages.fetch(g.message_id).catch(() => null);
  if (!msg) return;
  const n = await c.db.count('giveaway_entries', { giveaway_id: g.id });
  await msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0] as object ?? {}).setFooter({ text: `${n} participation(s) · terminé ${new Date(g.ends_at).toLocaleString('fr-FR')}` })] }).catch(() => void 0);
}

async function finish(c: Ctx, g: Gw, why?: string): Promise<void> {
  const entries = (await c.db.all('giveaway_entries', { where: { giveaway_id: g.id } })).map(entry);
  const picks = weightedDraw(entries, g.winners_count);
  await c.db.update('giveaways', { id: g.id }, { status: 'ended', ended_at: new Date(), winner_ids: picks.map((p) => p.userId) });
  await c.sched.cancel('giveaway:end', g.id);
  const ch = c.guild.channels.cache.get(g.channel_id) as import('discord.js').TextChannel | undefined;
  if (g.message_id && ch) {
    await ch.messages.fetch(g.message_id).then((m: Message) => m.edit({
      embeds: [gwEmbed(c, { ...g, status: 'ended' }, undefined, `🏁 Terminé${why ? ` — ${why}` : ''} · ${entries.length} participation(s) · ${picks.length ? `gagnant(s) : ${picks.map((p) => `<@${p.userId}>`).join(' ')}` : 'aucun gagnant (personne n’a participé)'} · contacte ${c.s.roleId('animateur') ? `<@&${c.s.roleId('animateur')}>` : 'un animateur'} pour récupérer le lot.`)],
      components: [],
    })).catch(() => void 0);
  }
  if (picks.length) {
    await ch?.send({
      content: `🏆 **${truncate(g.prize, 120)}** — ${picks.map((p) => `<@${p.userId}>`).join(' ')}${g.ping ? ` ${pingLine(c)}` : ''}`,
      allowedMentions: { parse: ['users', 'roles'] },
    }).catch(() => void 0);
    for (const p of picks) {
      const m = await c.guild.members.fetch(p.userId).catch(() => null);
      await m?.send({ content: `🎉 Tu as gagné « ${g.prize} » sur ${c.guild.name} ! Un animateur passe te voir. Si on ne te contacte pas sous 7 jours, le lot est retiré.` }).catch(() => void 0);
    }
  }
  logLine('staff', `🏁 giveaway #${pad(g.id)} terminé — ${entries.length} entrée(s), ${picks.length} gagnant(s)${picks.length ? ` : ${picks.map((p) => p.userId).join(',')}` : ''}`);
  await c.db.track('giveaway_end', { id: g.id, entries: entries.length, winners: picks.length });
}
