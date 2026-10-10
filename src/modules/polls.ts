/**
 * Sondages : on utilise le VRAI sondage Discord (UI native, resultats comptes par
 * Discord, pas de spam de reactions). Duree en heures, multi-choix optionnel.
 * Le bot peut cloturer un sondage qu'il a lui-meme cree : c'est la seule limite.
 */
import { SlashCommandBuilder, type Poll, type Message } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { mustText } from '../core/send.js';
import { at, truncate } from '../core/ui.js';

export const polls: EdgeModule = {
  key: 'polls',
  label: 'Sondages',
  needs: { channels: ['sondages'] },
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('sondage')
        .setDescription('Sondage natif Discord dans 📊│・Sondages')
        .addSubcommand((s) => s.setName('nouveau').setDescription('Créer un sondage')
          .addStringOption((o) => o.setName('question').setDescription('La question').setRequired(true).setMaxLength(280))
          .addStringOption((o) => o.setName('choix').setDescription('Les options séparées par des points-virgules (2 à 10)').setRequired(true).setMaxLength(900))
          .addIntegerOption((o) => o.setName('duree').setDescription('Durée en heures (1-168, défaut 24)'))
          .addBooleanOption((o) => o.setName('multi').setDescription('Plusieurs réponses autorisées ?'))
          .addChannelOption((o) => o.setName('salon').setDescription('Où (défaut 📊│・Sondages)')))
        .addSubcommand((s) => s.setName('list').setDescription('Sondages récents postés par Edge'))
        .addSubcommand((s) => s.setName('finir').setDescription('Clôturer un sondage avant l’heure').addStringOption((o) => o.setName('lien_du_message').setDescription('Clic droit sur le sondage → Copier le lien').setRequired(true))) as never,
      guard: { staff: true },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const rows = await c.db.all('polls', { where: {}, orderBy: 'id', desc: true, limit: 10 });
          return void (await i.editReply({ content: rows.length ? rows.map((r) => `· ${truncate(String(r.question), 70)} — ${r.closed ? 'clos' : 'en cours'} ${at(r.created_at as string)} (<#${r.channel_id}>/${r.message_id})`).join('\n') : 'Aucun sondage enregistré.' }));
        }
        if (sub === 'finir') {
          const link = i.options.getString('lien_du_message', true);
          const m = link.match(/\/(?:(?<c>\d+)\/)?(?<id>\d{15,25})$/);
          if (!m?.groups?.id) return void (await i.editReply({ content: 'Lien illisible — colle le lien complet du message.' }));
          const ch = c.guild.channels.cache.get(m.groups.c ?? '') as import('discord.js').TextChannel | undefined;
          const msg = await ch?.messages.fetch(m.groups.id).catch(() => null) as Message | undefined;
          const poll = msg?.poll as Poll | null | undefined;
          if (!msg || !poll) return void (await i.editReply({ content: 'Sondage introuvable. (Edge ne peut clôturer que ceux qu’il a créés.)' }));
          if (poll.resultsFinalized) return void (await i.editReply({ content: 'Il est déjà terminé (les résultats sont figés).' }));
          await poll.end().catch(() => void 0);
          await c.db.update('polls', { message_id: msg.id }, { closed: true });
          return void (await i.editReply({ content: `✅ Sondage clôturé. Résultats visibles dans <#${msg.channel.id}>.` }));
        }
        const question = i.options.getString('question', true);
        const raw = i.options.getString('choix', true);
        const answers = raw.split(/[;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 10);
        if (answers.length < 2) return void (await i.editReply({ content: 'Il faut au moins 2 options, séparées par des `;`.' }));
        if (answers.some((a) => a.length > 55)) return void (await i.editReply({ content: 'Une option dépasse 55 caractères — Discord refuse.' }));
        const hours = Math.min(168, Math.max(1, i.options.getInteger('duree') ?? 24));
        const ch = (i.options.getChannel('salon') as import('discord.js').TextChannel | null) ?? mustText(c, 'sondages');
        try {
          const msg = await ch.send({ poll: { question: { text: question }, answers: answers.map((text) => ({ text })), duration: hours, allowMultiselect: i.options.getBoolean('multi') ?? false, layoutType: 1 } });
          await c.db.insert('polls', { message_id: msg.id, channel_id: ch.id, author_id: i.user.id, question, ends_at: new Date(Date.now() + hours * 3_600_000), closed: false });
          return void (await i.editReply({ content: `📊 Sondage posté dans <#${ch.id}>, ${hours} h de vote.` }));
        } catch (e) {
          return void (await i.editReply({ content: `❌ Le sondage natif n'est pas accepté ici : ${(e as Error).message.slice(0, 160)}\n(Vérifie que Edge a « Créer des sondages » sur ce salon.)` }));
        }
      },
    },
  ],
};
