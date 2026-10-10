/**
 * Suggestions : formulaire -> post dans 🗳️│・Suggestions avec votes 👍/👎, thread de
 * discussion, statut pose par le staff et notification de l'auteur a chaque changement.
 * Le statut est la seule chose qui compte pour celui qui propose : "valide" ou
 * "refuse, parce que" evite 80 % des relances en ticket.
 */
import {
  SlashCommandBuilder, ChannelType, Events, type GuildMember, type Message, type TextChannel,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast } from '../core/perms.js';
import { jump, logLine, mustText } from '../core/send.js';
import { pad, truncate } from '../core/ui.js';

const STATUSES: Record<string, { emoji: string; note: string }> = {
  recu: { emoji: '📥', note: 'lue, pas encore discutée' },
  a_etudier: { emoji: '🔎', note: 'on en parle en staff' },
  valide: { emoji: '✅', note: 'c’est parti comme ça' },
  en_cours: { emoji: '🔨', note: 'quelqu’un est dessus' },
  refuse: { emoji: '🚫', note: 'non, et voici pourquoi' },
};

export const suggestions: EdgeModule = {
  key: 'suggestions',
  label: 'Suggestions',
  needs: { channels: ['suggestions'] },
  listeners: () => [
    {
      event: Events.MessageReactionAdd,
      run: async (c: Ctx, reaction: { message: Message; emoji: { name?: string } }) => {
        const row = await c.db.one('suggestions', { message_id: reaction.message.id });
        if (!row) return;
        const field = reaction.emoji.name === '👍' ? 'votes_up' : reaction.emoji.name === '👎' ? 'votes_down' : null;
        if (!field) return;
        await c.db.update('suggestions', { id: String(row.id) }, { [field]: Number(row[field] ?? 0) + 1 });
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('suggestion')
        .setDescription('Boîte à idées du serveur')
        .addSubcommand((s) => s.setName('nouvelle').setDescription('Proposer une idée')
          .addStringOption((o) => o.setName('titre').setDescription('Une ligne, concrète').setRequired(true).setMaxLength(90))
          .addStringOption((o) => o.setName('detail').setDescription('Pourquoi, et comment en pratique').setMaxLength(900)))
        .addSubcommand((s) => s.setName('statut').setDescription('Poser un statut (staff)')
          .addIntegerOption((o) => o.setName('numero').setDescription('Le # de la suggestion').setRequired(true))
          .addStringOption((o) => o.setName('etat').setDescription('Lequel').setRequired(true).addChoices(...Object.entries(STATUSES).map(([k, v]) => ({ name: `${v.emoji} ${k}`, value: k }))))
          .addStringOption((o) => o.setName('note').setDescription('Un mot pour l’auteur (obligatoire pour « refuse »)').setMaxLength(400)))
        .addSubcommand((s) => s.setName('top').setDescription('Les plus votées')
          .addIntegerOption((o) => o.setName('nombre').setDescription('Combien (défaut 10)'))) as never,
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'nouvelle') {
          const title = i.options.getString('titre', true);
          const body = i.options.getString('detail') ?? '';
          const ch = mustText(c, 'suggestions');
          const row = await c.db.insert('suggestions', { message_id: '0', author_id: i.user.id, title, body, status: 'recu', votes_up: 0, votes_down: 0, created_at: new Date() });
          const msg = await ch.send({
            content: [
              `🗳️ **${title}** · suggestion #${pad(String(row.id))}`,
              body ? truncate(body, 900) : '_aucun détail donné_',
              `proposée par <@${i.user.id}> · vote 👍 / 👎 en bas`,
            ].join('\n'),
          });
          await c.db.update('suggestions', { id: String(row.id) }, { message_id: msg.id });
          await msg.react('👍').catch(() => void 0);
          await msg.react('👎').catch(() => void 0);
          const thread = await msg.startThread({ name: `discussion — ${title}`.slice(0, 90), autoArchiveDuration: ChannelType.GuildText ? 1440 : 1440 }).catch(() => null);
          if (thread) await c.db.update('suggestions', { id: String(row.id) }, { thread_id: thread.id });
          await i.editReply({ content: `✅ Idée postée : ${jump(c, ch.id, msg.id)} — merci. Un staff passe mettre un statut, même si c’est « non ».` });
          await c.db.track('suggestion', { user: i.user.id });
          return;
        }
        if (sub === 'top') {
          const rows = (await c.db.all('suggestions', { where: {}, limit: 200 }))
            .map((r) => ({ id: String(r.id), title: String(r.title), status: String(r.status ?? 'recu'), net: Number(r.votes_up ?? 0) - Number(r.votes_down ?? 0) }))
            .sort((a, b) => b.net - a.net)
            .slice(0, i.options.getInteger('nombre') ?? 10);
          if (!rows.length) return void (await i.editReply({ content: 'Aucune suggestion pour l’instant.' }));
          return void (await i.editReply({ content: `🗳️ **Les plus votées**\n${rows.map((r) => `${(STATUSES[r.status] ?? STATUSES.recu!).emoji} #${pad(r.id)} ${truncate(r.title, 52)} — ${r.net} vote(s) net(s) · ${r.status}`).join('\n')}` }));
        }
        const actor = i.member as GuildMember;
        if (!atLeast(actor, 'helper', c.s.idx)) return void (await i.editReply({ content: 'Réservé au staff (Helper et plus).' }));
        const num = i.options.getInteger('numero', true);
        const status = i.options.getString('etat', true);
        const note = i.options.getString('note');
        if (status === 'refuse' && !note) return void (await i.editReply({ content: '« refusé » sans raison, c’est ce qui fâche. Ajoute l’option `note`.' }));
        const row = await c.db.one('suggestions', { id: num });
        if (!row) return void (await i.editReply({ content: `Suggestion #${pad(num)} introuvable.` }));
        await c.db.update('suggestions', { id: String(num) }, { status, staff_note: note, reviewed_by: actor.id });
        const ch = c.guild.channels.cache.get(String(row.channel_id ?? '')) as TextChannel | undefined;
        const msg = (await ch?.messages.fetch(String(row.message_id)).catch(() => null)) ?? null;
        const tag = `> ${(STATUSES[status] ?? STATUSES.recu)!.emoji} **Statut : ${status}** — ${(STATUSES[status] ?? STATUSES.recu)!.note}${note ? `\n> ${truncate(note, 300)}` : ''}\n> — ${actor.displayName}`;
        if (msg) await msg.reply({ content: `<@${row.author_id}>\n${tag}` }).catch(() => void 0);
        logLine('staff', `🗳️ suggestion #${pad(num)} → ${status} par ${actor.user.username}${note ? ` (${truncate(note, 90)})` : ''}`);
        await i.editReply({ content: `✅ Statut #${pad(num)} = ${status}${note ? ' · note transmise à l’auteur' : ''}.` });
      },
    },
  ],
};
