/**
 * Recrutement staff. Edge prepare, un humain decide et agit : le bot NE DONNE JAMAIS
 * un role de staff (whitelist volontaire, see manifest.ASSIGNABLE_ROLES). II poste la
 * fiche de poste, collecte les candidatures en modale, les pose dans 💬│・Staff-chat
 * avec les boutons de decision, et a la retenue il ecrit la ligne de rappel pour
 * l'Admin qui a les mains sur les roles. Periode d'essai de 30 j avec relance.
 */
import {
  SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, type ButtonInteraction, type GuildMember, type ModalSubmitInteraction,
  type MessageActionRowComponentBuilder, type ModalActionRowComponentBuilder,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast } from '../core/perms.js';
import { logLine, mustText } from '../core/send.js';
import { at, fmtDur, pad, truncate } from '../core/ui.js';
import { ROLE_DEFS, roleDef, type RoleKey } from '../manifest.js';

const POSTES: RoleKey[] = ['helper', 'manager', 'animateur', 'mod'];
const QUESTIONS = [
  { id: 'dispo', label: 'Tes disponibilités réelles par semaine', style: TextInputStyle.Short, max: 200 },
  { id: 'expo', label: 'Ce que tu as déjà fait (staff, projet, asso…)', style: TextInputStyle.Paragraph, max: 600 },
  { id: 'pourquoi', label: 'Pourquoi Edge et pas un autre serveur', style: TextInputStyle.Paragraph, max: 600 },
  { id: 'situ', label: 'Un membre te signale un copain qui break 2 règles. Tu fais quoi ?', style: TextInputStyle.Paragraph, max: 600 },
];

export const recruitment: EdgeModule = {
  key: 'recruitment',
  label: 'Recrutement staff',
  needs: { channels: ['recrutement', 'staffChat'] },
  components: () => ({
    ask: async (c: Ctx, i: ButtonInteraction, args: string[]) => {
      const poste = args[0] ?? 'helper';
      const modal = new ModalBuilder().setCustomId(`edge:recruitment:submit:${poste}`).setTitle(`Candidature · ${roleDef(poste as RoleKey).name}`);
      for (const q of QUESTIONS) {
        const row = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
          new TextInputBuilder().setCustomId(`r:${q.id}`).setLabel(truncate(q.label, 45)).setStyle(q.style).setMaxLength(q.max).setRequired(true),
        );
        modal.addComponents(row as never);
      }
      await i.showModal(modal);
    },
    submit: async (c: Ctx, i: ModalSubmitInteraction, args: string[]) => {
      const m = i.member as GuildMember;
      const poste = args[0] ?? 'helper';
      const dup = await c.db.one('applications', { applicant_id: m.id, status: ['received', 'interview'] });
      if (dup) return void (await i.reply({ content: `Tu as déjà une candidature ouverte (#${pad(String(dup.id))}). Attends la réponse, ou écris dans le ticket si tu veux la retirer.`, flags: 64 as never }));
      const answers: Record<string, string> = {};
      for (const q of QUESTIONS) answers[q.id] = truncate((i.fields.getTextInputValue(`r:${q.id}`) ?? '').trim(), q.max);
      const row = await c.db.insert('applications', { role_requested: poste, applicant_id: m.id, answers, status: 'received', created_at: new Date() });
      await i.reply({ content: `✅ Candidature #${pad(String(row.id))} envoyée au staff. Réponse sous quelques jours, même si c'est non.`, flags: 64 as never });
      await mustText(c, 'staffChat').send({
        content: [
          `📋 **Candidature #${pad(String(row.id))} · ${roleDef(poste as RoleKey).name}**`,
          `<@${m.id}> · ${m.user.tag} · ${m.joinedAt ? `ici depuis ${fmtDur(Date.now() - m.joinedAt.getTime())}` : 'arrivant'} · ${Number((await c.db.one('members', { user_id: m.id }))?.messages ?? 0)} messages suivis`,
          ...QUESTIONS.map((q) => `**${q.label}**\n${answers[q.id] ?? '—'}`),
        ].join('\n').slice(0, 1990),
        components: decision(row),
      });
      await c.db.track('application', { user: m.id, poste });
    },
    decide: async (c: Ctx, i: ButtonInteraction, args: string[]) => {
      const [id, verdict] = args;
      if (!atLeast(i.member as GuildMember, 'admin', c.s.idx)) return void (await i.reply({ content: 'Décision réservée à 🛡️│ Administrateur et plus.', flags: 64 as never }));
      const row = await c.db.one('applications', { id: id! });
      if (!row) return void (await i.reply({ content: 'Candidature introuvable.', flags: MessageFlagsLike }));
      const status = verdict === 'accept' ? 'accepted' : verdict === 'reject' ? 'rejected' : 'interview';
      await c.db.update('applications', { id: id! }, { status, reviewed_by: i.user.id, decided_at: new Date(), ...(status === 'accepted' ? { trial_ends_at: new Date(Date.now() + 30 * 86_400_000) } : {}) });
      if (status === 'accepted') await c.sched.at('recruitment:trial', id!, new Date(Date.now() + 30 * 86_400_000), { id: id!, user: String(row.applicant_id), role: String(row.role_requested) });
      await i.reply({ content: status === 'accepted'
        ? '✅ Retenu. J’ai prévenu le candidat et écrit la ligne de rôle pour un Admin (Edge ne donne pas les rôles de staff lui-même).'
        : status === 'interview' ? '🗓️ Marké « entretien ».' : '🚫 Refusé, proprement.', flags: 64 as never });
      const target = await c.guild.members.fetch(String(row.applicant_id)).catch(() => null);
      const msg = status === 'accepted'
        ? `🎉 Bonne nouvelle : ta candidature pour ${roleDef(row.role_requested as RoleKey).name} est retenue. Un Admin te donne le rôle et on te briefe en salon staff. Période d'essai de 30 jours, sans surprise.`
        : status === 'interview'
          ? `🗓️ Ta candidature intéresse le staff : on te propose d'en parler de vive voix. Réponds ici ou en ticket quand tu es dispo.`
          : `Merci pour ta candidature à ${roleDef(row.role_requested as RoleKey).name}. Ce n'est pas pour cette fois — si tu veux savoir pourquoi, ouvre un ticket, on te répond franchement.`;
      await target?.send({ content: msg }).catch(() => void 0);
      logLine('staff', `📋 candidature #${pad(id!)} → ${status} par ${i.user.username}${status === 'accepted' ? ` · À FAIRE (Admin) : donner ${roleDef(row.role_requested as RoleKey).name} à ${row.applicant_id}` : ''}`);
      if (status === 'accepted') {
        await mustText(c, 'staffChat').send({ content: `🔑 **Action manuelle requise** — Edge ne touche pas les rôles de staff.\nDonne \`${roleDef(row.role_requested as RoleKey).name}\` à <@${row.applicant_id}>, puis réagis ici pour que je le note.` });
      }
      if (i.message.components?.length) await i.message.edit({ components: [] }).catch(() => void 0);
    },
  }),
  jobs: () => [
    {
      kind: 'recruitment:trial',
      run: async (c, payload) => {
        const userId = String(payload.user ?? '');
        const days = 30;
        await mustText(c, 'staffChat').send({ content: `⏳ Fin de période d'essai pour <@${userId}> (${roleDef(String(payload.role) as RoleKey).name}, ${days} j). Bilan en staff-chat, puis soit tu confirmes, soit tu retires le rôle.` }).catch(() => void 0);
        logLine('staff', `⏳ bilan de période d'essai à faire pour ${userId}`);
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('recrutement')
        .setDescription('Recrutement du staff')
        .addSubcommand((s) => s.setName('poste').setDescription('Publier une offre dans 📖│・Recrutement Staff')
          .addStringOption((o) => o.setName('role').setDescription('Quel poste').setRequired(true).addChoices(...POSTES.map((p) => ({ name: roleDef(p).name, value: p }))))
          .addStringOption((o) => o.setName('description').setDescription('Ce qu’on attend, ce qu’on offre').setMaxLength(900)))
        .addSubcommand((s) => s.setName('lister').setDescription('Les candidatures en cours'))
        .addSubcommand((s) => s.setName('candidater').setDescription('Postuler maintenant (le candidat peut aussi cliquer le bouton du poste)')
          .addStringOption((o) => o.setName('role').setDescription('Pour quel poste').setRequired(true).addChoices(...POSTES.map((p) => ({ name: roleDef(p).name, value: p })))))
        .addSubcommand((s) => s.setName('retirer').setDescription('Retirer ma candidature (staff ou candidat)').addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true))) as never,
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'poste') {
          if (!atLeast(i.member as GuildMember, 'admin', c.s.idx)) return void (await i.editReply({ content: 'Publier une offre = Administrateur.' }));
          const poste = i.options.getString('role', true) as RoleKey;
          const desc = i.options.getString('description') ?? 'Ce qu’on cherche : quelqu’un de régulier, calme, qui lit avant de parler. Ce qu’on donne : un vrai rôle, un salon de consignes, et le droit de dire non.';
          const ch = mustText(c, 'recrutement');
          await ch.send({
            content: `📢 **Recrutement ouvert · ${roleDef(poste).name}**\n${desc}\n\nClique sur le bouton pour candidater (4 champs, 3 minutes). Les candidatures partent en interne, personne ne les lit en public.`,
            components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
              new ButtonBuilder().setCustomId(`edge:recruitment:ask:${poste}`).setLabel('📮 Candidater').setStyle(ButtonStyle.Primary),
            )],
          });
          return void (await i.editReply({ content: `✅ Offre publiée dans <#${ch.id}>, avec le bouton de candidature.` }));
        }
        if (sub === 'candidater') {
          const poste = i.options.getString('role', true) as RoleKey;
          const modal = new ModalBuilder().setCustomId(`edge:recruitment:submit:${poste}`).setTitle(`Candidature · ${roleDef(poste).name}`);
          for (const q of QUESTIONS) modal.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId(`r:${q.id}`).setLabel(truncate(q.label, 45)).setStyle(q.style).setMaxLength(q.max).setRequired(true)) as never);
          return void (await i.showModal(modal));
        }
        if (sub === 'retirer') {
          const num = i.options.getInteger('numero', true);
          const row = await c.db.one('applications', { id: num });
          if (!row) return void (await i.editReply({ content: 'Candidature introuvable.' }));
          if (String(row.applicant_id) !== i.user.id && !atLeast(i.member as GuildMember, 'admin', c.s.idx)) return void (await i.editReply({ content: 'Tu ne peux retirer que les tiennes.' }));
          await c.db.update('applications', { id: num }, { status: 'withdrawn', reviewed_by: i.user.id });
          await c.sched.cancel('recruitment:trial', String(num));
          return void (await i.editReply({ content: '🗑️ Retirée. Merci de l’avoir dit plutôt que de disparaître.' }));
        }
        if (!atLeast(i.member as GuildMember, 'mod', c.s.idx)) return void (await i.editReply({ content: 'Staff (Mod+) seulement.' }));
        const rows = (await c.db.all('applications', { where: {}, orderBy: 'id', desc: true, limit: 15 }));
        if (!rows.length) return void (await i.editReply({ content: 'Aucune candidature.' }));
        return void (await i.editReply({ content: `📋 ${rows.length} dossier(s)\n${rows.map((r) => {
          const role = ROLE_DEFS.find((x) => x.key === r.role_requested)?.name ?? String(r.role_requested);
          return `#${pad(String(r.id))} <@${r.applicant_id}> · ${role} · ${r.status}${r.created_at ? ` · ${at(r.created_at as string)}` : ''}`;
        }).join('\n')}` }));
      },
    },
  ],
};

const MessageFlagsLike = 64 as never;

function decision(row: { id?: string | number }): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const id = String(row.id);
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`edge:recruitment:decide:${id}:accept`).setLabel('✅ Retenu').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`edge:recruitment:decide:${id}:interview`).setLabel('🗓️ Entretien').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`edge:recruitment:decide:${id}:reject`).setLabel('🚫 Refusé').setStyle(ButtonStyle.Danger),
  )];
}
