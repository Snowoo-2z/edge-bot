/**
 * Invitations. Methode honnete et sans permission exotique : on snapshotte les
 * compteurs d'invitations du serveur, et a chaque arrivee on cherche quell'invitation
 * a vu son compteur bouger. C'est la seule voie fiable sans bot dans tous les serveurs.
 * Limites assumees : une invitation creee entre deux ticks n'est pas attribuable, et
 * les liens expirés ne laissent aucune trace.
 */
import { SlashCommandBuilder, type Invite, type GuildMember } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast } from '../core/perms.js';
import { logLine } from '../core/send.js';
import { fmtDur } from '../core/ui.js';

interface Snap { code: string; uses: number; inviter: string | null; channel: string | null }
let snapshot = new Map<string, Snap>();

export const invites: EdgeModule = {
  key: 'invites',
  label: 'Invitations & parrainage',
  reglages: [
    {
      cle: 'role_auto', module: 'invites', type: 'booleen', label: 'Rôle Partenaire automatique',
      aide: 'Allumé, Edge donne 💼│・Partenaire tout seul aux 50 invites nettes. Éteint (réglage d’usine) = le classement tourne, c’est le staff qui décide.',
      defaut: false, base: 'flags', cleBase: 'invites.allowSelf',
    },
    {
      cle: 'annonces', module: 'invites', type: 'booleen', label: 'Annoncer les records',
      aide: 'Un message dans 💬│・Notification Partenariat à chaque nouveau leader.',
      defaut: false, base: 'flags', cleBase: 'invites.announce',
    },
  ],
  needs: { channels: ['invitations'], perms: ['ManageGuild'] },
  sync: async (c: Ctx) => { await resync(c); c.log.info(`suivi d'invitations : ${snapshot.size} lien(s) sous surveillance`); },
  listeners: () => [
    { event: 'inviteCreate', run: async (c: Ctx, inv: Invite) => { snapshot.set(inv.code, { code: inv.code, uses: inv.uses ?? 0, inviter: inv.inviter?.id ?? null, channel: inv.channelId }); void c; } },
    { event: 'inviteDelete', run: async (c: Ctx, inv: Invite) => { snapshot.delete(inv.code); void c; } },
    {
      event: 'guildMemberAdd',
      run: async (c: Ctx, m: GuildMember) => {
        if (m.user.bot) return;
        const before = snapshot;
        await resync(c);
        const movers: Snap[] = [];
        for (const [code, now] of snapshot) {
          const was = before.get(code);
          if (was && now.uses > was.uses) movers.push(now);
          if (!was) movers.push(now);
        }
        if (!movers.length) return;
        const credited = movers.find((x) => x.inviter && x.inviter !== m.id) ?? movers[0]!;
        if (!credited.inviter) return;
        const self = credited.inviter === m.id;
        if (self && !(await c.db.flags.isOn('invites.allowSelf', false))) {
          logLine('moderation', `🔁 auto-invite ignorée : <@${m.id}> arrive par son propre lien (${credited.code}).`);
          return;
        }
        const month = new Date().toISOString().slice(0, 7);
        await c.db.bump('invite_stats', { user_id: credited.inviter, code: credited.code, month }, 'used', 1, { user_id: credited.inviter, code: credited.code, month, used: 0 });
        await c.db.track('invite_use', { by: credited.inviter, code: credited.code, joined: m.id });
        logLine('ticket', `💌 ${m.user.username} arrive via <@${credited.inviter}> (\`${credited.code}\`).`);
        if (await c.db.flags.isOn('invites.announce', false)) {
          const total = await totalFor(c, credited.inviter);
          await sayInvite(c, `🎉 <@${credited.inviter}> a fait entrer ${m.user.username} — ${total} invitation(s) au total.`);
        }
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('invites')
        .setDescription('Qui a ramené qui')
        .addSubcommand((s) => s.setName('top').setDescription('Classement du mois').addStringOption((o) => o.setName('mois').setDescription('AAAA-MM (défaut : mois courant)')))
        .addSubcommand((s) => s.setName('voir').setDescription('Le détail pour un membre').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('resync').setDescription('Recharger les compteurs (staff)')) as never,
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'resync') {
          if (!atLeast(i.member as GuildMember, 'helper', c.s.idx)) return void (await i.editReply({ content: 'Staff seulement.' }));
          const n = await resync(c);
          return void (await i.editReply({ content: `🔄 ${n} invitation(s) rechargées depuis Discord.` }));
        }
        if (sub === 'voir') {
          const target = i.options.getMember('membre') as GuildMember | null;
          if (!target) return void (await i.editReply({ content: 'Membre introuvable.' }));
          const rows = await c.db.all('invite_stats', { where: { user_id: target.id }, orderBy: 'used', desc: true });
          const total = rows.reduce((n, r) => n + Number(r.used ?? 0), 0);
          return void (await i.editReply({ content: rows.length ? `💌 ${target.user.username} : ${total} arrivée(s) amenée(s)\n${rows.slice(0, 8).map((r) => `· \`${r.code}\` (${r.month}) → ${r.used}`).join('\n')}` : `💌 ${target.user.username} n'a encore fait entrer personne. Le compteur démarre quand Edge voit le lien.` }));
        }
        const month = i.options.getString('mois') ?? new Date().toISOString().slice(0, 7);
        const rows = await c.db.all('invite_stats', { where: { month } });
        const agg = new Map<string, number>();
        for (const r of rows) agg.set(String(r.user_id), (agg.get(String(r.user_id)) ?? 0) + Number(r.used ?? 0));
        const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (!top.length) return void (await i.editReply({ content: `📭 Aucune invitation attribuée sur ${month}. (Le suivi ne compte que ce qu'Edge voit depuis son ajout.)` }));
        return void (await i.editReply({ content: `🏅 **Invitations · ${month}**\n${top.map(([u, n], idx) => `**${idx + 1}.** <@${u}> — ${n}`).join('\n')}` }));
      },
    },
  ],
  jobs: () => [
    { kind: 'invites:resync', everyMs: 10 * 60_000, run: async (c) => { await resync(c); } },
  ],
};

async function resync(c: Ctx): Promise<number> {
  try {
    const list = await c.guild.invites.fetch();
    snapshot = new Map(list.map((inv) => [inv.code, { code: inv.code, uses: inv.uses ?? 0, inviter: inv.inviter?.id ?? null, channel: inv.channelId }]));
    return snapshot.size;
  } catch (e) {
    c.log.warn(`suivi d'invitations coupé : ${(e as Error).message}`);
    return snapshot.size;
  }
}

async function totalFor(c: Ctx, userId: string): Promise<number> {
  const rows = await c.db.all('invite_stats', { where: { user_id: userId } });
  return rows.reduce((n, r) => n + Number(r.used ?? 0), 0);
}

async function sayInvite(c: Ctx, text: string): Promise<void> {
  const ch = c.s.channel('invitations') as import('discord.js').TextChannel | null;
  await ch?.send({ content: text, allowedMentions: { parse: ['users'] } }).catch(() => void 0);
}
void fmtDur;
