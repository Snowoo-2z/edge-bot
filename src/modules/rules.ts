/**
 * Reglement : panneau + bouton d'acceptation.
 * Le « gate » est optionnel (flag rules.gate) et est realise en SUPPRIMANT le message
 * avec un rappel, PAS en overwrites par membre : Discord plafonne a 15 overwrites par
 * salon, un gate par membre casserait des le 16e arrivant.
 */
import {
  SlashCommandBuilder, ButtonStyle, ButtonBuilder, ActionRowBuilder, Events, MessageFlags,
  type ButtonInteraction, type GuildMember, type Message, type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { ensurePanel } from '../core/panels.js';
import { mustText } from '../core/send.js';
import { atLeast } from '../core/perms.js';
import { at, truncate } from '../core/ui.js';
import { fr } from '../core/copy.js';

const DEFAULT_RULES = [
  "**1.** Pas d'insulte, de harcèlement, de racisme, de sexisme, de transphobie. Une grotte, pas une arène.",
  "**2.** Pas de NSFW, pas de lien choquant, pas de « c'était pour rire ».",
  "**3.** Pas de pub ni d'invitation hors de 💌│・Invitations.",
  "**4.** On ne doxe pas en public : tu ouvres un ticket et on règle ça.",
  "**5.** Un seul compte. Pas de double-compte pour contourner une sanction.",
  "**6.** Un staff peut te demander de ralentir sans te justifier publiquement.",
].join('\n');

let rulesText = DEFAULT_RULES;

export const rules: EdgeModule = {
  key: 'rules',
  label: 'Règlement & acceptation',
  reglages: [
    {
      cle: 'portail', module: 'rules', type: 'booleen', label: 'Verrouiller tant que le règlement n’est pas accepté',
      aide: 'Le gros bouton sous 📌│・Règlement. Éteint (réglage d’usine) = le panneau reste, l’acceptation donne le rôle, mais personne n’est bloqué à l’entrée.',
      defaut: false, base: 'flags', cleBase: 'rules.gate',
    },
  ],
  needs: { channels: ['reglement'] },
  sync: async (c: Ctx) => { rulesText = truncate((await c.db.kv.get<string>('rules:text')) ?? DEFAULT_RULES, 1800); },
  panels: async (ctx: Ctx) => {
    const r = await ensurePanel(ctx, {
      key: 'rules',
      channel: mustText(ctx, 'reglement'),
      build: () => ({
        content: `📜 **Règlement — à lire avant d'ouvrir la bouche**\n\n${rulesText}\n\nEn cliquant sur « J'accepte », tu dis l'avoir lu. Ça ne change aucun de tes droits : ça nous évite les « j'étais pas au courant » en ticket.`,
        components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new ButtonBuilder().setCustomId('edge:rules:accept').setLabel("✅ J'ai lu et j'accepte").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('edge:tickets:ask:support').setLabel('❔ J’ai une question').setStyle(ButtonStyle.Secondary),
        )],
      }),
    });
    if (r !== 'updated') ctx.log.info(`panneau règlement : ${r}`);
  },
  components: () => ({
    accept: async (c: Ctx, i: ButtonInteraction) => {
      const m = i.member as GuildMember;
      await c.db.upsert('members', ['user_id'], { user_id: m.id, rules_accepted_at: new Date(), joined_at: m.joinedAt ?? new Date() });
      await i.reply({ content: `C'est noté ${at(new Date())}. Merci 👍`, flags: MessageFlags.Ephemeral });
      await c.db.track('rules_accept', { user: m.id });
    },
  }),
  listeners: () => [
    {
      event: Events.MessageCreate,
      run: async (c: Ctx, msg: Message) => {
        if (msg.author.bot || !msg.inGuild()) return;
        if (!(await c.db.flags.isOn('rules.gate', false))) return;
        const parentId = msg.channel.parentId;
        if (parentId !== c.s.category('grotte')?.id && parentId !== c.s.category('activites')?.id) return;
        const m = msg.member ?? (await c.guild.members.fetch(msg.author.id).catch(() => null));
        if (!m || atLeast(m, 'helper', c.s.idx)) return;
        const row = await c.db.one('members', { user_id: m.id });
        if (row?.rules_accepted_at) return;
        await msg.delete().catch(() => void 0);
        const ch = c.s.channel('reglement');
        const notice = await msg.reply({
          content: `📜 Le règlement n’a pas été accepté : clique « J’ai lu et j’accepte » ${ch ? `<#${ch.id}>` : 'dans 📌│・Règlement'}.`,
          allowedMentions: { repliedUser: false },
        }).catch(() => null);
        if (notice) setTimeout(() => void notice.delete().catch(() => void 0), 8_000);
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('reglement')
        .setDescription('Règlement : statut, texte, panneau')
        .addSubcommand((s) => s.setName('statut').setDescription('Un membre a-t-il accepté ?').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('texte').setDescription('Remplacer le règlement affiché').addStringOption((o) => o.setName('contenu').setDescription('Markdown, 1800 car. max').setRequired(true).setMaxLength(1800)))
        .addSubcommand((s) => s.setName('recharger').setDescription('Re-publier le panneau'))
        .addSubcommand((s) => s.setName('aide').setDescription('Expliquer le mode « acceptation obligatoire »')) as never,
      guard: { staff: true },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'statut') {
          const m = i.options.getMember('membre') as GuildMember | null;
          if (!m) return void (await i.editReply({ content: 'Ce membre n’est plus sur le serveur.' }));
          const row = await c.db.one('members', { user_id: m.id });
          return void (await i.editReply({ content: row?.rules_accepted_at ? `✅ ${m.user.username} a accepté le ${at(row.rules_accepted_at as string)}.` : `❌ ${m.user.username} n’a pas encore accepté.` }));
        }
        if (sub === 'texte') {
          if (!atLeast(i.member as GuildMember, 'admin', c.s.idx)) return void (await i.editReply({ content: fr.noPerm('🛡️│ Administrateur') }));
          rulesText = truncate(i.options.getString('contenu', true), 1800);
          await c.db.kv.set('rules:text', rulesText);
          await c.db.kv.del('panel:rules');
          await rules.panels!(c);
          return void (await i.editReply({ content: '✅ Règlement réécrit, panneau re-publié.' }));
        }
        if (sub === 'recharger') {
          await c.db.kv.del('panel:rules');
          await rules.panels!(c);
          return void (await i.editReply({ content: '✅ Panneau re-publié.' }));
        }
        const on = await c.db.flags.isOn('rules.gate', false);
        return void (await i.editReply({ content: [
          '🧱 **Acceptation obligatoire** : tant qu’un membre n’a pas cliqué sur le bouton, son message dans ⛺│↦ LA GROTTE et 🎪│↦ ACTIVITÉS est supprimé avec un rappel vers le règlement.',
          `État actuel : ${on ? '✅ activé' : '❌ désactivé — le bouton ne fait qu’enregistrer la trace.'}`,
          'Activer / couper : `/edge flag rules.gate on` puis `/edge flag rules.gate off`.',
          'Pourquoi ne pas retirer les permissions : Discord limite un salon à 15 overwrites. Un blocage par membre casserait au 16e arrivant.',
        ].join('\n') }));
      },
    },
  ],
};
