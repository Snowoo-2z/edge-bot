/**
 * Tickets. Un panneau, UN SEUL menu deroulant, le role qui bien est pingue selon l'option.
 *
 * Points non negogiables :
 *  - overwrites calcules a la main : @everyone refuse ViewChannel, ouvreur + helper/manager/
 *    mod/admin/fondateur autorites (+ role eventuel lie a l'option) ;
 *  - numero de ticket = id de ligne => jamais de trou ni de collision apres un crash ;
 *  - transcript HTML pousse dans 🎫│・Tickets-logs AVANT suppression du salon ;
 *  - sync() au boot : un salon supprime a la main ne laisse pas un ticket ouvert pour toujours.
 */
import {
  SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, Events, MessageFlags, AttachmentBuilder,
  type ButtonInteraction, type GuildChannel, type GuildMember, type Message, type StringSelectMenuInteraction,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { ensurePanel } from '../core/panels.js';
import { jump, logLine, mustText } from '../core/send.js';
import { atLeast, overwrite, roleIds } from '../core/perms.js';
import { TICKET_ACCESS, TICKET_OPTIONS, channelDef, roleDef, ticketOption, type RoleKey } from '../manifest.js';
import { at, pad, slug, truncate } from '../core/ui.js';

export interface Ticket { id: string; channel_id: string; opener_id: string; type: string; status: string; claimed_by: string | null; pinged_after: boolean; created_at: string | null; last_message_at: string | null }
const tk = (r: Record<string, unknown>): Ticket => ({
  id: String(r.id), channel_id: String(r.channel_id ?? ''), opener_id: String(r.opener_id), type: String(r.type),
  status: String(r.status ?? 'open'), claimed_by: r.claimed_by ? String(r.claimed_by) : null,
  pinged_after: Boolean(r.pinged_after), created_at: (r.created_at as string | undefined) ?? null,
  last_message_at: (r.last_message_at as string | undefined) ?? null,
});

const OPEN_PERMS = ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'AddReactions', 'UseExternalEmojis'] as const;
const MAX_OPEN_PER_MEMBER = 1;

export const tickets: EdgeModule = {
  key: 'tickets',
  label: 'Tickets',
  needs: {
    categories: ['tickets'], channels: ['ticketOpen', 'ticketLogs'],
    roles: [...TICKET_ACCESS], perms: ['ManageChannels', 'ViewChannel', 'SendMessages', 'ManageRoles'],
  },
  reglages: [
    {
      cle: 'message_panneau', module: 'tickets', type: 'texte', label: 'Texte du panneau d’ouverture',
      aide: 'Le paragraphe explicatif au-dessus du menu des motifs. Le menu et les motifs viennent du manifeste.',
      defaut: 'Choisis le motif dans le menu : Edge crée un salon privé pour toi et va chercher la bonne personne. Personne d’autre ne le voit.',
      maxLen: 900,
    },
  ],

  panels: async (ctx: Ctx) => {
    const intro = (await ctx.reglages('tickets').str('message_panneau')) || '';
    await ensurePanel(ctx, {
      key: 'tickets',
      channel: mustText(ctx, 'ticketOpen'),
      build: () => ({
        content: [
          '🎫 **Ouvrir un ticket**',
          intro,
          TICKET_OPTIONS.map((o) => `• ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n'),
          'Un seul ticket ouvert à la fois. Pour préciser un truc sensible, écris-le directement dedans.',
        ].join('\n'),
        components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new StringSelectMenuBuilder().setCustomId('edge:tickets:open').setPlaceholder('Sélectionne le motif de ta demande…').addOptions(
            TICKET_OPTIONS.map((o) => ({ label: o.label.slice(0, 90), value: o.key, description: (o.description ?? '—').slice(0, 95) })),
          ),
        )],
      }),
    });
  },
  components: () => ({
    open: async (c: Ctx, i: StringSelectMenuInteraction) => { await openTicket(c, i, String(i.values[0])); },
    ask: async (c: Ctx, i: ButtonInteraction, args: string[]) => {
      const r = await createTicket(c, i.member as GuildMember, args[0] ?? 'support');
      await i.reply({ content: r.ok ? r.note : r.error, flags: MessageFlags.Ephemeral });
    },
    claim: async (c: Ctx, i: ButtonInteraction) => {
      const t = await byChannel(c, i.channelId);
      if (!t) return void (await i.reply({ content: 'Ce salon n’est pas un ticket connu.', flags: MessageFlags.Ephemeral }));
      if (!atLeast(i.member as GuildMember, 'helper', c.s.idx)) return void (await i.reply({ content: 'Staff seulement.', flags: MessageFlags.Ephemeral }));
      await c.db.update('tickets', { id: String(t.id) }, { status: 'claimed', claimed_by: i.user.id, updated_at: new Date() });
      await i.message.edit({ components: controls(c, i.message) as never }).catch(() => void 0);
      await i.reply({ content: `🙋 Ticket pris en charge par ${i.user.username}.`, flags: MessageFlags.Ephemeral });
      logLine('ticket', `🙋 #${pad(t.id as string)} revendiqué par ${i.user.username}`);
    },
    close: async (c: Ctx, i: ButtonInteraction) => {
      const t = await byChannel(c, i.channelId);
      if (!t) return void (await i.reply({ content: 'Ticket inconnu (peut-être déjà fermé).', flags: MessageFlags.Ephemeral }));
      const m = i.member as GuildMember;
      const allowed = String(t.opener_id) === m.id || atLeast(m, 'helper', c.s.idx);
      if (!allowed) return void (await i.reply({ content: 'Seul l’ouvreur ou le staff peut fermer ce ticket.', flags: MessageFlags.Ephemeral }));
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await close(c, t, i.user.id, m.id === t.opener_id ? 'fermé par le membre' : `fermé par ${m.user.username}`);
    },
  }),
  listeners: () => [
    {
      event: Events.MessageCreate,
      run: async (c: Ctx, msg: Message) => {
        if (msg.author.bot || !msg.inGuild()) return;
        const t = await byChannel(c, msg.channel.id);
        if (!t) return;
        await c.db.insert('ticket_messages', {
          ticket_id: t.id, author_id: msg.author.id, author_name: msg.author.username,
          content: truncate(msg.content, 1800) || '(sans texte)',
          attachments: msg.attachments.map((a) => ({ name: a.name, url: a.proxyURL ?? a.url })),
        });
        await c.db.update('tickets', { id: t.id }, { last_message_at: new Date(), updated_at: new Date() });
      },
    },
    {
      event: Events.ChannelDelete,
      run: async (c: Ctx, ch: GuildChannel) => {
        const t = await byChannel(c, ch.id);
        if (!t) return;
        await c.db.update('tickets', { id: String(t.id) }, { status: 'closed', closed_at: new Date(), close_reason: 'salon supprimé à la main' });
        logLine('ticket', `⚠️ #${pad(t.id as string)} : le salon a été supprimé hors Edge, ticket marqué fermé.`);
      },
    },
  ],
  sync: async (c: Ctx) => {
    const open = await c.db.all('tickets', { where: { status: ['open', 'claimed', 'pending_staff'] } });
    let orphans = 0;
    for (const t of open) {
      const ch = c.guild.channels.cache.get(String(t.channel_id));
      if (!ch) { await c.db.update('tickets', { id: String(t.id) }, { status: 'closed', closed_at: new Date(), close_reason: 'salon introuvable au redémarrage' }); orphans++; }
    }
    if (orphans) c.log.warn(`${orphans} ticket(s) orphelin(s) refermé(s) au boot`);
    const cat = c.s.category('tickets');
    if (cat) {
      for (const ch of cat.children.cache.values()) {
        if (!await byChannel(c, ch.id)) c.log.warn(`salon « ${ch.name} » dans 📁│↦ TICKETS sans ticket en base`);
      }
    }
  },
  jobs: (c) => [
    {
      kind: 'tickets:stale',
      everyMs: 6 * 3_600_000,
      run: async (ctx) => {
        const open = (await ctx.db.all('tickets', { where: { status: ['open', 'claimed'] } })).map(tk);
        const now = Date.now();
        for (const t of open) {
          const last = new Date((t.last_message_at ?? t.created_at ?? now) as string).getTime();
          const ch = ctx.guild.channels.cache.get(String(t.channel_id));
          if (!ch || !('send' in ch)) continue;
          if (now - last > 7 * 86_400_000) { await close(ctx, t, ctx.client.user.id, 'fermé automatiquement après 7 jours sans nouvelle'); continue; }
          if (now - last > 2 * 86_400_000 && !t.pinged_after) {
            await (ch as unknown as import('discord.js').TextChannel).send({ content: `⌛ Ce ticket attend depuis plus de 48 h. ${t.claimed_by ? `<@${t.claimed_by}> ?` : roleMentionsFor(ctx, t.type)}`, allowedMentions: { parse: ['users', 'roles'] } }).catch(() => void 0);
            await ctx.db.update('tickets', { id: String(t.id) }, { pinged_after: true });
          }
        }
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('ticket')
        .setDescription('Gérer les tickets')
        .addSubcommand((s) => s.setName('voir').setDescription('Résumé d’un ticket').addIntegerOption((o) => o.setName('numero').setDescription('Le numéro (0042)').setRequired(true)))
        .addSubcommand((s) => s.setName('fermer').setDescription('Fermer un ticket avec une raison').addIntegerOption((o) => o.setName('numero').setDescription('Le numéro').setRequired(true)).addStringOption((o) => o.setName('raison').setDescription('Pourquoi tu fermes').setMaxLength(300)))
        .addSubcommand((s) => s.setName('ajouter').setDescription('Donner accès à un membre').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('enlever').setDescription('Retirer l’accès').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('liste').setDescription('Tickets ouverts en ce moment')) as never,
      guard: { staff: true },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'liste') {
          const open = await c.db.all('tickets', { where: { status: ['open', 'claimed', 'pending_staff'] }, orderBy: 'id', desc: true });
          if (!open.length) return void (await i.editReply({ content: '✅ Aucun ticket ouvert.' }));
          return void (await i.editReply({ content: `🎫 ${open.length} ouvert(s)\n${open.slice(0, 20).map((t) => `#${pad(t.id as string)} ${t.type} · <@${t.opener_id}> · ${at(t.created_at as string)}`).join('\n')}` }));
        }
        const num = i.options.getInteger('numero');
        const raw = num ? await c.db.one('tickets', { id: num }) : null;
        const t = raw ? tk(raw) : await byChannel(c, i.channelId);
        if (!t) return void (await i.editReply({ content: num ? `Aucun ticket #${pad(num)}.` : 'Utilise cette commande depuis un salon de ticket, ou donne un numéro.' }));
        if (sub === 'voir') {
          const msgs = await c.db.all('ticket_messages', { where: { ticket_id: String(t.id) }, limit: 8 });
          return void (await i.editReply({ content: [
            `🎫 #${pad(t.id as string)} · ${t.type} · ${t.status}`,
            `ouvert par ${t.opener_id} le ${at(t.created_at as string)}${t.claimed_by ? ` · pris en charge par ${t.claimed_by}` : ''}`,
            t.channel_id ? `salon : <#${t.channel_id}>` : 'salon supprimé',
            msgs.length ? `\n${msgs.map((m) => `${m.author_name} : ${String(m.content).slice(0, 120)}`).join('\n')}` : '',
          ].join('\n') }));
        }
        if (sub === 'fermer') { await close(c, t, i.user.id, i.options.getString('raison') ?? `fermé par ${i.user.username}`); return void (await i.editReply({ content: `✅ #${pad(t.id as string)} fermé, transcript archivé.` })); }
        const who = i.options.getMember('membre') as GuildMember | null;
        const ch = c.guild.channels.cache.get(String(t.channel_id));
        if (!who || !('permissionsOverwrites' in (ch as object))) return void (await i.editReply({ content: 'Membre ou salon indisponible.' }));
        const gc = ch as unknown as { permissionOverwrites: { add: (o: never, r: string) => Promise<unknown>; remove: (id: string, r: string) => Promise<unknown> } };
        if (sub === 'ajouter') await gc.permissionOverwrites.add({ id: who.id, type: 1, allow: [...OPEN_PERMS].map((p) => p) as never, deny: [] } as never, `Edge : ticket #${pad(t.id as string)}`);
        else await gc.permissionOverwrites.remove(who.id, `Edge : ticket #${pad(t.id as string)}`);
        return void (await i.editReply({ content: sub === 'ajouter' ? `✅ ${who.user.username} a maintenant accès au ticket.` : `✅ ${who.user.username} n’a plus accès au ticket.` }));
      },
    },
  ],
};

/* -------------------------------------------------------------------- creation */

async function openTicket(c: Ctx, i: StringSelectMenuInteraction | ButtonInteraction, typeKey: string): Promise<void> {
  const opt = ticketOption(typeKey);
  if (!opt) return void (await i.reply({ content: 'Motif inconnu — demande à un staff de re-publier le panneau (`/edge panneaux`).', flags: MessageFlags.Ephemeral }));
  const m = i.member as GuildMember;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const res = await createTicket(c, m, opt.key);
  if (!res.ok) return void (await i.editReply({ content: res.error }));
  await i.editReply({ content: res.note });
}

/**
 * Creation reelle d'un ticket. Exportee pour que d'autres modules (reports,
 * partnership, recruitment) ouvrent un canal prives plutot que de bricoler un log.
 */
export type TicketResult = { ok: true; channelId: string; num: string; note: string } | { ok: false; error: string };

export async function createTicket(c: Ctx, m: GuildMember, typeKey: string, note?: string): Promise<TicketResult> {
  const opt = ticketOption(typeKey);
  if (!opt) return { ok: false, error: 'Motif de ticket inconnu.' };
  const cat = c.s.category('tickets');
  if (!cat) return { ok: false, error: '📁│↦ TICKETS introuvable sur ce serveur : Edge ne créera rien dans la nature.' };

  const existingRaw = await c.db.one('tickets', { opener_id: m.id, status: ['open', 'claimed', 'pending_staff'] });
  const existing = existingRaw ? tk(existingRaw) : null;
  if (existing && (await countOpen(c, m.id)) >= MAX_OPEN_PER_MEMBER && c.guild.channels.cache.get(existing.channel_id)) {
    return { ok: false, error: `⏳ Tu as déjà un ticket ouvert : <#${existing.channel_id}> (#${pad(existing.id)}). Écris dedans plutôt que d'en rouvrir un.` };
  }

  const row = await c.db.insert('tickets', {
    channel_id: 'pending', opener_id: m.id, type: opt.key, status: 'open', pinged_role: opt.ping,
    intro: note ?? opt.modalIntro, created_at: new Date(), last_message_at: new Date(),
  });
  const num = String(row.id);
  const name = `t-${pad(num)}-${slug(m.user.username, 24)}`;

  const overwrites = [
    overwrite(c.guild.id, [], ['ViewChannel']),
    overwrite(c.guild.members.me!.id, [...OPEN_PERMS, 'ManageMessages', 'ManageThreads', 'MentionEveryone', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory'] as never, []),
    overwrite(m.id, [...OPEN_PERMS] as never, []),
    ...[...new Set<RoleKey>([...TICKET_ACCESS, ...(opt.extraAccess ?? [])])].map((rk) => overwrite(roleIds(c.s.idx, rk), [...OPEN_PERMS] as never, [])),
  ];

  let ch;
  try {
    ch = await c.guild.channels.create({ name, type: ChannelType.GuildText, parent: cat.id, topic: `#${pad(num)} · ${opt.label} · ouvert par ${m.user.tag} (${m.id})`, permissionOverwrites: overwrites as never });
  } catch (e) {
    await c.db.delete('tickets', { id: num });
    c.log.error(`création de ticket refusée : ${(e as Error).message}`);
    return { ok: false, error: "❌ Impossible de créer le salon — vérifie les permissions d'Edge sur la catégorie 📁│↦ TICKETS (`/audit structure` te dira quoi)." };
  }
  await c.db.update('tickets', { id: num }, { channel_id: ch.id });

  const opener = await c.db.one('members', { user_id: m.id });
  await ch.send({
    content: [
      `🎫 **Ticket #${pad(num)} — ${opt.label.replace(/^\S+\s/, '')}**`,
      `<@${m.id}> : ${note ?? opt.modalIntro}`,
      '',
      `${roleMention(c, opt.ping)} — on a besoin de vous ici.${opt.key === 'signalement' ? ' Restez factuel : dates, captures, liens de messages.' : ''}`,
      "Quand c'est réglé, le bouton 🔒 en bas ferme le ticket (un transcript est gardé, personne ne perd le fil).",
      opener?.warn_points ? `\nℹ️ Ce membre a ${opener.warn_points} point(s) de warn actif(s).` : '',
    ].join('\n'),
    components: controls(c, null, opt.key),
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
  });
  logLine('ticket', `🎫 #${pad(num)} ouvert par ${m.user.tag} — motif ${opt.key}, ping ${roleDef(opt.ping).name}`);
  await c.db.track('ticket_open', { user: m.id, type: opt.key });
  return { ok: true, channelId: ch.id, num, note: `✅ Ticket créé : <#${ch.id}>. Le rôle ${roleDef(opt.ping).name} a été prévenu.` };
}

const roleMention = (c: Ctx, k: RoleKey): string => `<@&${roleIds(c.s.idx, k)}>`;
const roleMentionsFor = (c: Ctx, type: string): string => {
  const o = ticketOption(type);
  return o ? `<@&${roleIds(c.s.idx, o.ping)}>` : '';
};

function controls(_c: Ctx, _msg: Message | null, type = 'support'): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    type === 'support' || type === 'tech' || type === 'autre'
      ? new ButtonBuilder().setCustomId('edge:tickets:claim').setLabel('🙋 Prendre en charge').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId('edge:tickets:claim').setLabel('🙋 Je m’en occupe').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('edge:tickets:close').setLabel('🔒 Clôturer').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setLabel(`${type}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
  )];
}

/* ---------------------------------------------------------------------- fermet */

async function close(c: Ctx, t: Ticket, by: string, reason: string): Promise<void> {
  const ch = c.guild.channels.cache.get(String(t.channel_id));
  const msgs = await c.db.all('ticket_messages', { where: { ticket_id: String(t.id) }, orderBy: 'id' });
  const html = transcript(t, msgs, reason, by);
  const num = pad(String(t.id));
  try {
    await mustText(c, 'ticketLogs').send({
      content: `📁 Transcript #${num} · ${t.type} · <@${t.opener_id}> · clôturé par <@${by}> — ${truncate(reason, 140)}`,
      files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `ticket-${num}.html`, description: 'Transcript du ticket' })],
      allowedMentions: { parse: [] },
    });
  } catch (e) { c.log.error('archive de transcript impossible', (e as Error).message); }
  await c.db.update('tickets', { id: t.id }, { status: 'closed', closed_at: new Date(), close_reason: truncate(reason, 280), closed_by: by });
  logLine('ticket', `🔒 #${num} fermé par ${by} — ${reason}`);
  if (ch && 'delete' in ch) await (ch as unknown as { delete: (r: string) => Promise<unknown> }).delete(`Edge : ticket #${num} fermé`).catch(() => void 0);
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[x]!);
function transcript(t: Ticket, msgs: Record<string, unknown>[], reason: string, by: string): string {
  const rows = msgs.map((m) => `<div class="m"><b>${esc(String(m.author_name ?? m.author_id))}</b><span>${esc(String(m.created_at ?? '')).slice(0, 16)}</span><p>${esc(String(m.content ?? ''))}</p>${Array.isArray(m.attachments) ? (m.attachments as { name: string; url: string }[]).map((a) => `<a href="${esc(a.url)}">${esc(a.name)}</a>`).join(' · ') : ''}</div>`).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>ticket</title>
<style>body{font:14px/1.5 system-ui;background:#0f1115;color:#dfe3ea;padding:24px;max-width:760px}
.m{border-left:2px solid #5865f2;padding:8px 12px;margin:10px 0;background:#161922;border-radius:0 8px 8px 0}
.m b{color:#fff}.m span{float:right;color:#7b8494;font-size:12px}.m p{margin:6px 0 0;white-space:pre-wrap}a{color:#8ab4ff}
h1{font-size:16px}small{color:#7b8494}</style>
<h1>Ticket · ${esc(String(t.type))}</h1><small>ouvert par ${esc(String(t.opener_id))} · clôturé par ${esc(by)} · ${esc(reason)}</small>
${rows || '<small>aucun message enregistré</small>'}`;
}

async function byChannel(c: Ctx, channelId: string): Promise<Ticket | null> {
  const r = await c.db.one('tickets', { channel_id: channelId, status: ['open', 'claimed', 'pending_staff'] });
  return r ? tk(r) : null;
}
async function countOpen(c: Ctx, userId: string): Promise<number> {
  return c.db.count('tickets', { opener_id: userId, status: ['open', 'claimed', 'pending_staff'] });
}
