/**
 * Choisir-ses-roles : un Select Menu, des actions explicites (ajouter / tout couper).
 * Seuls les roles de NOTIFICATION sont auto-attrapables : c'est exactement le role du
 * salon « 🎭│・Choisir-ses-rôles », parce que 🎁/🤝 Notification sont mentionable:false
 * => seuls les roles avec MentionEveryone peuvent les pinguer (cf. audit).
 */
import {
  SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, MessageFlags,
  type GuildMember, type StringSelectMenuInteraction, type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { ensurePanel } from '../core/panels.js';
import { mustText, logLine } from '../core/send.js';
import { atLeast, canManageRole, roleIds } from '../core/perms.js';
import { SELF_ASSIGNABLE_ROLES, roleDef } from '../manifest.js';
import { at } from '../core/ui.js';

const OPTIONS: { key: string; label: string; desc: string; roles: string[] }[] = [
  { key: 'on-giveaway', label: '🔔 Être pingué pour les giveaways', desc: 'Rien d’autre que les concours.', roles: ['notifGiveaway'] },
  { key: 'on-partenaire', label: '🤝 Être pingué pour les partenariats', desc: '1 à 2 posts par mois max.', roles: ['notifPartenaire'] },
  { key: 'on-both', label: '📣 Les deux', desc: 'Giveaways + partenariats.', roles: ['notifGiveaway', 'notifPartenaire'] },
  { key: 'off-all', label: '🔕 Ne plus être pingué', desc: 'Je retire les deux rôles.', roles: [] },
];

export const selfroles: EdgeModule = {
  key: 'selfroles',
  label: 'Rôles à choisir soi-même',
  needs: { roles: [...SELF_ASSIGNABLE_ROLES], channels: ['selfroles'] },
  panels: async (ctx: Ctx) => {
    await ensurePanel(ctx, {
      key: 'selfroles',
      channel: mustText(ctx, 'selfroles'),
      build: () => ({
        content: [
          '🎭 **Tes notifications**',
          'Sur ce serveur, personne ne peut pinguer @everyone. Les rôles ci-dessous sont les seuls que tu ajoutes toi-même pour recevoir une notif.',
          'Un menu, un choix, c’est réversible à tout moment. Et non, ça ne donne aucun droit sur le serveur.',
        ].join('\n'),
        components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new StringSelectMenuBuilder().setCustomId('edge:selfroles:pick').setPlaceholder('Choisir ce que je veux recevoir…').addOptions(
            OPTIONS.map((o) => ({ label: o.label, value: o.key, description: o.desc })),
          ),
        )],
      }),
    });
  },
  components: () => ({
    pick: async (c: Ctx, i: StringSelectMenuInteraction) => {
      const m = i.member as GuildMember;
      const opt = OPTIONS.find((o) => o.key === i.values[0]);
      if (!opt) return void (await i.reply({ content: 'Option inconnue.', flags: MessageFlags.Ephemeral }));
      const wanted = new Set(opt.roles);
      const changes: string[] = [];
      const errs: string[] = [];
      for (const key of SELF_ASSIGNABLE_ROLES) {
        const id = c.s.roleId(key)!;
        const has = m.roles.cache.has(id);
        if (wanted.has(key) && !has) {
          if (!canManageRole(c.guild.members.me!, key, c.s.idx)) { errs.push(roleDef(key).name); continue; }
          await m.roles.add(id, 'Edge : choix personnel dans 🎭│・Choisir-ses-rôles').catch(() => errs.push(roleDef(key).name));
          changes.push(`+ ${roleDef(key).name}`);
        } else if (!wanted.has(key) && has) {
          await m.roles.remove(id, 'Edge : choix personnel dans 🎭│・Choisir-ses-rôles').catch(() => errs.push(roleDef(key).name));
          changes.push(`- ${roleDef(key).name}`);
        }
        await c.db.upsert('selfroles_state', ['user_id', 'role_key'], { user_id: m.id, role_key: key, enabled: wanted.has(key), updated_at: new Date() });
      }
      const txt = opt.roles.length === 0
        ? '🔕 Coupé. Tu ne seras plus pingué par Edge.'
        : `🔔 OK : ${[...wanted].map((k) => roleDef(k as never as import('../manifest.js').RoleKey).name).join(' + ')} ajouté${wanted.size > 1 ? 's' : ''}.`;
      await i.reply({ content: `${txt}${errs.length ? `\n⚠️ Impossible pour : ${errs.join(', ')} (hierarchie du rôle Edge).` : ''}\nTu peux changer d’avis quand tu veux, ici même. ${at(new Date())}`, flags: MessageFlags.Ephemeral });
      await c.db.track('selfroles', { user: m.id, opt: opt.key });
      if (errs.length) logLine('staff', `⚠️ selfroles bloqué pour ${m.user.username} : ${errs.join(', ')} — le rôle Edge est mal placé.`);
    },
  }),
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('selfroles')
        .setDescription('Qui a pris quoi (staff)')
        .addSubcommand((s) => s.setName('etat').setDescription('Répartition des rôles de notification'))
        .addSubcommand((s) => s.setName('voir').setDescription('Le choix d’un membre').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))) as never,
      guard: { staff: true },
      run: async (c, i) => {
        if (i.options.getSubcommand() === 'voir') {
          const m = i.options.getMember('membre') as GuildMember | null;
          if (!m) return void (await i.editReply({ content: 'Membre hors serveur.' }));
          const owned = SELF_ASSIGNABLE_ROLES.filter((k) => m.roles.cache.has(roleIds(c.s.idx, k)));
          return void (await i.editReply({ content: owned.length ? `${m.user.username} reçoit : ${owned.map((k) => roleDef(k).name).join(', ')}` : `${m.user.username} n’a aucun rôle de notification.` }));
        }
        const lines: string[] = [];
        for (const k of SELF_ASSIGNABLE_ROLES) {
          const role = c.s.role(k);
          lines.push(`${role?.name ?? k} : ${role?.members.size ?? 0} membre(s)`);
        }
        return void (await i.editReply({ content: `📊 Rôles auto-attribués\n${lines.join('\n')}` }));
      },
    },
  ],
};
