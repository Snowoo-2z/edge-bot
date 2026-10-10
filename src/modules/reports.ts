/**
 * Signalements : clic droit sur un message ou un membre -> ticket prive, jamais un
 * fil public. Le rapport est aussi resume dans 🚨│・Signalements pour que le staff
 * le voie meme si le ticket est revendique ailleurs.
 * Anti-abus : 3 rapports classe sans fondement par un meme membre = avertissement.
 */
import {
  SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, Events,
  type GuildMember, type Message,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast } from '../core/perms.js';
import { jump, logLine } from '../core/send.js';
import { truncate } from '../core/ui.js';
import { createTicket } from './tickets.js';
import { autoCase } from './moderation.js';

export const reports: EdgeModule = {
  key: 'reports',
  label: 'Signalements',
  needs: { channels: ['signalements', 'ticketOpen'], categories: ['tickets'] },
  commands: () => [
    {
      // la voie rapide, sans menu contextuel (mobile)
      data: new SlashCommandBuilder().setName('signaler')
        .setDescription('Signaler un comportement, en privé')
        .addUserOption((o) => o.setName('membre').setDescription('Qui tu signales').setRequired(true))
        .addStringOption((o) => o.setName('motif').setDescription('Ce qui s’est passé, factuellement').setRequired(true).setMaxLength(900))
        .addStringOption((o) => o.setName('lien').setDescription('Lien du message concerné (clic droit → Copier le lien)')) as never,
      run: async (c, i) => {
        const target = i.options.getMember('membre') as GuildMember | null;
        if (!target) return void (await i.editReply({ content: 'Ce membre n’est plus là — signale-le en ticket avec son ID, on regardera les logs.' }));
        const res = await file(c, i.user.id, target.id, null, i.options.getString('motif', true), i.options.getString('lien'));
        await i.editReply({ content: res });
      },
    },
    {
      data: new ContextMenuCommandBuilder().setName('🚨 Signaler ce membre').setType(ApplicationCommandType.User) as never,
      run: async (c, i) => {
        const t = i as unknown as { targetId: string };
        await i.editReply({ content: `⏳ Ouvre \`/signaler\` et cible <@${t.targetId}> pour décrire les faits — un signalement sans motif n’est pas exploitable.` });
      },
    },
    {
      data: new ContextMenuCommandBuilder().setName('🚨 Signaler ce message').setType(ApplicationCommandType.Message) as never,
      run: async (c, i) => {
        const mi = i as unknown as { targetMessage: Message };
        const msg = mi.targetMessage;
        if (msg.author.id === i.user.id) return void (await i.editReply({ content: 'Signaler son propre message n’aide personne — supprime-le, ou édite-le.' }));
        const res = await file(c, i.user.id, msg.author.id, msg.id, `Signalement depuis le menu contextuel (message de ${msg.author.username} : « ${truncate(msg.content, 200) || 'sans texte'} »)`, jump(c, msg.channelId, msg.id));
        await i.editReply({ content: res });
      },
    },
  ],
  listeners: () => [
    {
      // le staff peut classer sans sortir du ticket
      event: 'messageCreate',
      run: async (c: Ctx, msg: Message) => {
        if (msg.author.bot || !msg.content.startsWith('#')) return;
        if (!atLeast(msg.member as GuildMember, 'helper', c.s.idx)) return;
        const m = msg.content.match(/^#(\d{1,6})\s+(sans fondement|fonde)\b/i);
        if (!m) return;
        const id = m[1];
        const row = await c.db.one('reports', { id });
        if (!row) return;
        const founded = /fonde/i.test(m[2]!) && !/sans/i.test(m[2]!);
        await c.db.update('reports', { id: String(id) }, { status: founded ? 'fonde' : 'sans_fondement', reviewed_by: msg.author.id });
        logLine('staff', `🚩 rapport #${id} classé « ${founded ? 'fondé' : 'sans fondement'} » par ${msg.author.username}`);
        if (!founded) {
          const rows = await c.db.all('reports', { where: { reporter_id: String(row.reporter_id), status: 'sans_fondement' } });
          if (rows.length >= 3) {
            await autoCase(c, { type: 'warn', userId: String(row.reporter_id), reason: `${rows.length} signalements sans fondement consécutifs` });
            logLine('moderation', `⚠️ <@${row.reporter_id}> a posé ${rows.length} signalements sans fondement → avertissement automatique posé.`);
          }
        }
      },
    },
  ],
};

async function file(c: Ctx, reporterId: string, targetId: string, messageId: string | null, reason: string, link: string | null): Promise<string> {
  const reporter = await c.guild.members.fetch(reporterId).catch(() => null);
  if (!reporter) return 'Impossible de te retrouver sur le serveur.';
  if (atLeast(reporter, 'helper', c.s.idx)) {
    const id = await c.db.insert('reports', { reporter_id: reporterId, target_user_id: targetId, target_message_id: messageId, link, reason: truncate(reason, 880), status: 'open', created_at: new Date() });
    logLine('moderation', `🚩 signalement interne #${id} par ${reporter.user.username} sur <@${targetId}> : ${truncate(reason, 160)}`);
    return `🗂️ Noté (rapport interne #${id}). Tu es staff : pas besoin de ticket, le log suffit.`;
  }
  const res = await createTicket(c, reporter, 'signalement', `${reason}\n\nMembre visé : <@${targetId}>${link ? `\nPreuve : ${link}` : ''}`);
  if (!res.ok) return `⚠️ ${res.error}`;
  const row = await c.db.insert('reports', { reporter_id: reporterId, target_user_id: targetId, target_message_id: messageId, link, reason: truncate(reason, 880), status: 'open', ticket_id: res.num, created_at: new Date() });
  const ch = c.s.channel('signalements') as import('discord.js').TextChannel | null;
  await ch?.send({
    content: `🚩 Rapport #${row.id} · cible <@${targetId}>\n${truncate(reason, 400)}${link ? `\n${link}` : ''}\n→ échangé dans <#${res.channelId}>`,
    allowedMentions: { parse: [] },
  }).catch(() => void 0);
  logLine('staff', `🚩 signalement #${row.id} ouvert par ${reporter.user.username} contre <@${targetId}> → ticket #${res.num}`);
  return `✅ C’est parti en ticket privé : <#${res.channelId}>. Le staff concerné est prévenu. Ajoute-y d'autres preuves si tu en as (captures, autres liens).`;
}
