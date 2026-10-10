/**
 * Presentations : bouton + modale uniquement (aucune commande a taper pour un membre).
 * Le message poste est du texte brut, pas un embed. Validation staff par bouton.
 */
import {
  SlashCommandBuilder, ButtonStyle, ButtonBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, Events, MessageFlags,
  type ButtonInteraction, type GuildMember, type Message, type ModalSubmitInteraction,
  type ActionRowBuilder as AR, type MessageActionRowComponentBuilder, type ModalActionRowComponentBuilder,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { ensurePanel } from '../core/panels.js';
import { mustText, logLine } from '../core/send.js';
import { atLeast } from '../core/perms.js';
import { at, truncate } from '../core/ui.js';

interface Answers { pseudo: string; odù: string; passions: string; cherche: string }
const FIELDS: { id: keyof Answers; label: string; style: TextInputStyle; max: number; ph: string }[] = [
  { id: 'pseudo', label: 'Pseudo (ou prénom) et âge', style: TextInputStyle.Short, max: 80, ph: 'Ex. Loo, 21 ans' },
  { id: 'odù', label: 'D’où tu viens', style: TextInputStyle.Short, max: 80, ph: 'Ville / région / pays' },
  { id: 'passions', label: 'Ce que tu fais dans la vie', style: TextInputStyle.Paragraph, max: 300, ph: 'Études, boulot, jeux, graphisme, musique…' },
  { id: 'cherche', label: 'Ce que tu cherches ici', style: TextInputStyle.Paragraph, max: 300, ph: 'Un crew, de l’aide sur un projet, juste discuter…' },
];

export const presentation: EdgeModule = {
  key: 'presentation',
  label: 'Présentations',
  needs: { channels: ['presentations', 'staffChat'] },
  panels: async (ctx: Ctx) => {
    await ensurePanel(ctx, {
      key: 'presentation',
      channel: mustText(ctx, 'presentations'),
      build: () => ({
        content: [
          '👋 **Présentations**',
          'Clique sur le bouton ci-dessous, remplis les 4 champs, et c’est posté proprement.',
          'Pas de commande à taper, pas de format à retenir. Un staff passe derrière pour valider.',
          'Un conseil : dis ce que tu cherches ici, c’est ce qui déclenche les vraies conversations.',
        ].join('\n'),
        components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new ButtonBuilder().setCustomId('edge:presentation:ask').setLabel('📝 Se présenter').setStyle(ButtonStyle.Primary),
        )],
      }),
    });
  },
  components: () => ({
    ask: async (c: Ctx, i: ButtonInteraction) => {
      const modal = new ModalBuilder().setCustomId('edge:presentation:submit').setTitle('Se présenter en 4 champs');
      for (const f of FIELDS) {
        modal.addComponents(new (ActionRowBuilder as unknown as new () => AR<ModalActionRowComponentBuilder>)().addComponents(
          new TextInputBuilder().setCustomId(`p:${f.id}`).setLabel(truncate(f.label, 45)).setStyle(f.style).setMaxLength(f.max).setRequired(true).setPlaceholder(f.ph),
        ) as never);
      }
      await i.showModal(modal);
    },
    submit: async (c: Ctx, i: ModalSubmitInteraction) => {
      const m = i.member as GuildMember;
      const a: Answers = { pseudo: '', odù: '', passions: '', cherche: '' };
      for (const f of FIELDS) a[f.id] = (i.fields.getTextInputValue(`p:${f.id}`) ?? '').trim().slice(0, f.max);
      if (!a.pseudo) return void (await i.reply({ content: 'Faut au moins un pseudo.', flags: MessageFlags.Ephemeral }));
      const already = await c.db.one('presentations', { user_id: m.id });
      const body = [
        `**${m.user.username}** vient de se présenter 👋`,
        `• ${a.pseudo}`,
        `• D'où : ${a.odù}`,
        `• Vie : ${a.passions}`,
        `• Cherche : ${a.cherche}`,
      ].join('\n');
      const sent = await mustText(c, 'presentations').send({
        content: body,
        components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`edge:presentation:validate:${m.id}`).setLabel('✅ Valider la présentation').setStyle(ButtonStyle.Success),
        )],
      });
      await c.db.upsert('presentations', ['user_id'], { user_id: m.id, message_id: sent.id, answers: a, verified: false, created_at: new Date() }, { message_id: sent.id, answers: a, verified: false, created_at: new Date() });
      await c.db.upsert('members', ['user_id'], { user_id: m.id, presented_at: new Date() }, { presented_at: new Date() });
      await i.reply({ content: already ? '✅ Renvoyé — ta présentation précédente est écrasée.' : '✅ Postée. Merci !', flags: MessageFlags.Ephemeral });
      await c.db.track('presentation', { user: m.id, again: Boolean(already) });
    },
    validate: async (c: Ctx, i: ButtonInteraction, args: string[]) => {
      const target = args[0]!;
      if (!atLeast(i.member as GuildMember, 'helper', c.s.idx)) return void (await i.reply({ content: 'Réservé au staff.', flags: MessageFlags.Ephemeral }));
      const row = await c.db.one('presentations', { user_id: target });
      if (!row) return void (await i.reply({ content: 'Aucune présentation enregistrée pour ce membre.', flags: MessageFlags.Ephemeral }));
      await c.db.update('presentations', { user_id: target }, { verified: true, verified_by: i.user.id, verified_at: new Date() });
      await c.db.update('members', { user_id: target }, { verified: true });
      if (i.message.components?.length) await i.message.edit({ components: [] }).catch(() => void 0);
      await i.reply({ content: `✅ Présentation de <@${target}> validée.`, flags: MessageFlags.Ephemeral });
      logLine('staff', `📝 présentation validée : <@${target}> par ${i.user.username}`);
    },
  }),
  listeners: () => [
    {
      // un membre qui se presente a la main (sans bouton) compte quand meme
      event: Events.MessageCreate,
      run: async (c: Ctx, msg: Message) => {
        if (msg.author.bot) return;
        const ch = c.s.channel('presentations');
        if (!ch || msg.channel.id !== ch.id || msg.author.id === c.client.user.id) return;
        if (msg.reference?.messageId) return;
        await c.db.upsert('presentations', ['user_id'], { user_id: msg.author.id, message_id: msg.id, answers: { libre: truncate(msg.content, 700) }, verified: false });
        await c.db.upsert('members', ['user_id'], { user_id: msg.author.id, presented_at: new Date() }, { presented_at: new Date() });
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('presentation')
        .setDescription('Suivi des présentations (staff)')
        .addSubcommand((s) => s.setName('statut').setDescription('Présentation validée ou non ?').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('valider').setDescription('Valider à la main').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('relancer').setDescription('Envoyer un rappel poli en MP').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('manquantes').setDescription('Les arrivants de la semaine sans présentation')) as never,
      guard: { staff: true },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        const target = i.options.getMember('membre') as GuildMember | null;
        if (sub === 'statut' || sub === 'valider') {
          if (!target) return void (await i.editReply({ content: 'Membre hors serveur.' }));
          const row = await c.db.one('presentations', { user_id: target.id });
          if (!row) return void (await i.editReply({ content: `❌ ${target.user.username} n’a pas de présentation.` }));
          if (sub === 'valider') {
            await c.db.update('presentations', { user_id: target.id }, { verified: true, verified_by: i.user.id, verified_at: new Date() });
            await c.db.update('members', { user_id: target.id }, { verified: true });
            return void (await i.editReply({ content: `✅ Validé pour ${target.user.username}.` }));
          }
          return void (await i.editReply({ content: `Présentation du ${at(row.created_at as string)} — ${row.verified ? '✅ validée' : '⏳ en attente'}.\n${JSON.stringify(row.answers, null, 0).slice(0, 600)}` }));
        }
        if (sub === 'relancer') {
          if (!target || target.user.bot) return void (await i.editReply({ content: 'Impossible de le/la joindre.' }));
          await target.send({ content: `Coucou ${target.user.username} 👋 Tu n’as pas fini ta présentation dans ${mustText(c, 'presentations')}. Deux lignes suffisent, ça aide les gens à venir te parler.` }).catch(() => null);
          return void (await i.editReply({ content: `Rappel envoyé (si ses MP sont ouverts).` }));
        }
        const rows = await c.db.all('members', { where: {}, limit: 500 });
        const since = Date.now() - 7 * 86_400_000;
        const missing: string[] = [];
        for (const r of rows) {
          if (!r.presented_at && new Date(r.joined_at as string).getTime() > since) missing.push(`<@${r.user_id}>`);
        }
        return void (await i.editReply({ content: missing.length ? `⏳ ${missing.length} arrivant(s) de la semaine sans présentation :\n${missing.slice(0, 40).join(' ')}` : '✅ Tout le monde du moins de 7 jours s’est présenté.' }));
      },
    },
  ],
};
