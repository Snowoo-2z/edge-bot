/**
 * Audit : la lecture seule qui rend le reste fiable.
 *  - /audit structure : manifeste vs serveur reel (drift complet)
 *  - /audit ping      : verifie les PROMESSES de ping du serveur, reelles et pas declaratives
 *  - /audit perms     : pourquoi untel ne peut pas (ou peut) dans tel salon
 *  - /audit recent    : digest de l'audit log Discord (ce que les autres bots/humains font)
 */
import { SlashCommandBuilder, AuditLogEvent, type GuildMember, type TextChannel } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { driftReport, resolveStructure } from '../core/structure.js';
import { canPingEveryone, canPingRole, canSpeakIn, INVARIANTS } from '../core/permmodel.js';
import { canPingReal } from '../core/send.js';
import { CHANNEL_DEFS, ROLE_DEFS, channelDef, roleDef, type ChannelKey, type RoleKey } from '../manifest.js';
import { at, truncate } from '../core/ui.js';

const EVENTS: [string, AuditLogEvent][] = [
  ['suppression de message', AuditLogEvent.MessageDelete], ['bulk delete', AuditLogEvent.MessageBulkDelete],
  ['kick', AuditLogEvent.MemberKick], ['ban', AuditLogEvent.MemberBanAdd], ['unban', AuditLogEvent.MemberBanRemove],
  ['deplacement vocal', AuditLogEvent.MemberMove], ['membre deconnecte', AuditLogEvent.MemberDisconnect],
  ['role retire/ajoute', AuditLogEvent.MemberRoleUpdate], ['epingle/depingle', AuditLogEvent.MessagePin],
  ['salon modifié', AuditLogEvent.ChannelUpdate], ['salon créé', AuditLogEvent.ChannelCreate], ['salon supprimé', AuditLogEvent.ChannelDelete],
  ['rôle modifié', AuditLogEvent.RoleUpdate], ['rôle supprimé', AuditLogEvent.RoleDelete], ['webhook créé', AuditLogEvent.WebhookCreate],
  ['intégration', AuditLogEvent.IntegrationCreate], ['émoji/gribouille', AuditLogEvent.EmojiUpdate],
];

export const audit: EdgeModule = {
  key: 'audit',
  label: 'Audit de structure & de ping',
  needs: { roles: ['mod'], channels: ['auditStaff'], perms: ['ViewAuditLog'] },
  jobs: () => [
    {
      kind: 'audit:drift',
      everyMs: 12 * 3_600_000,
      run: async (c) => {
        const s = resolveStructure(c.guild);
        const bad = driftReport(s).filter((d) => d.level === 'error');
        if (!bad.length) return;
        const ch = c.s.channel('auditStaff') as TextChannel | null;
        await ch?.send({ content: `🧾 Dérive de structure détectée (${bad.length} point(s) bloquant(s)) :\n${bad.slice(0, 10).map((d) => `• ${d.what}`).join('\n')}` }).catch(() => void 0);
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('audit')
        .setDescription('Vérifier la structure, les pings, les droits, les traces')
        .addSubcommand((s) => s.setName('structure').setDescription('Comparer le serveur au manifeste d’Edge').addBooleanOption((o) => o.setName('tout').setDescription('Inclure les infos non bloquantes')))
        .addSubcommand((s) => s.setName('ping').setDescription('Tester qui peut pinguer qui, réellement'))
        .addSubcommand((s) => s.setName('perms').setDescription('Droits effectifs d’un membre dans un salon')
          .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
          .addChannelOption((o) => o.setName('salon').setDescription('Où').setRequired(true)))
        .addSubcommand((s) => s.setName('recent').setDescription('Dernières traces de l’audit log Discord')
          .addStringOption((o) => o.setName('type').setDescription('Filtrer').addChoices(...EVENTS.map(([label, v]) => ({ name: label, value: String(v) }))))
          .addIntegerOption((o) => o.setName('nombre').setDescription('Combien (défaut 10, max 30)')))
        .addSubcommand((s) => s.setName('promesses').setDescription('Les invariants de ta config, évalués un à un')) as never,
      guard: { min: 'mod' },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'structure') {
          const s = resolveStructure(c.guild);
          const report = driftReport(s);
          const showAll = i.options.getBoolean('tout') ?? false;
          const rows = report.filter((d) => showAll || d.level !== 'info');
          const head = rows.length
            ? `🧾 ${rows.length} écart(s) avec le manifeste` + (showAll ? '' : ' · ℹ️ masqués, vois tout avec l’option « tout »')
            : '✅ Structure conforme au manifeste : 30 salons, 11 rôles, overwrites OK.';
          const body = rows.slice(0, 22).map((d) => {
            const icon = d.level === 'error' ? '❌' : d.level === 'warn' ? '⚠️' : 'ℹ️';
            const detail = d.expected ? `\\n     attendu : ${d.expected} · réel : ${d.got}` : '';
            return `${icon} [${d.area}] ${d.what}${detail}`;
          });
          return void (await i.editReply({ content: [head, ...body].join('\\n').slice(0, 1990) }));
        }
        if (sub === 'ping') {
          const out: string[] = ['📡 **Qui peut pinguer quoi** — testé sur le réel, pas sur le papier'];
          const testers: RoleKey[] = ['membre', 'booster', 'animateur', 'helper', 'manager', 'mod', 'admin'];
          const ch = c.s.channel('discussion') as TextChannel;
          const g = c.s.channel('giveaway') as TextChannel;
          for (const who of testers) {
            const role = c.s.role(who);
            const sample = role?.members.first();
            if (!sample || !ch || !g) { out.push(`· ${roleDef(who).name} : impossible à tester (aucun membre ou salon manquant)`); continue; }
            const m = await c.guild.members.fetch(sample.id).catch(() => null) as GuildMember | null;
            const yes = (v: boolean): string => (v ? '🔊 oui' : '🔇 non');
            out.push(`· ${roleDef(who).name} : @everyone ${yes(canPingEveryone([who], 'discussion'))} · 🎁 Notif Giveaway ${yes(canPingReal(c, m, 'notifGiveaway', g))} · 🤝 Notif Partenariat ${yes(canPingReal(c, m, 'notifPartenaire', ch))}`);
          }
          out.push('', 'Edge a MentionEveryone : c’est lui qui porte les pings pour les rôles qui n’y ont pas droit. C’est ce qui rend `mentionable:false` utile au lieu de juste silencieux.');
          const lines = out;
          return void (await i.editReply({ content: lines.join('\n').slice(0, 1990) }));
        }
        if (sub === 'perms') {
          const m = i.options.getMember('membre') as GuildMember | null;
          const ch = i.options.getChannel('salon') as TextChannel | null;
          if (!m || !ch) return void (await i.editReply({ content: 'Membre ou salon introuvable.' }));
          const p = ch.permissionsFor(m);
          const key = ['ViewChannel', 'SendMessages', 'ManageMessages', 'MentionEveryone', 'EmbedLinks', 'ReadMessageHistory', 'AddReactions'] as const;
          const keys = [...m.roles.cache.keys()];
          const roles = [...c.s.idx.byId.entries()].filter(([id]) => keys.includes(id)).map(([, k]) => k);
          return void (await i.editReply({ content: [
            `🔐 ${m.user.username} dans #${ch.name}`,
            ...key.map((perm) => `${p?.has(perm as never) ? '✅' : '❌'} ${perm}`),
            `rôles Edge reconnus : ${roles.map((r) => roleDef(r).name).join(', ') || 'aucun'}`,
          ].join('\n') }));
        }
        if (sub === 'recent') {
          const type = i.options.getString('type');
          const limit = i.options.getInteger('nombre') ?? 10;
          const logs = await c.guild.fetchAuditLogs({ type: (type ? Number(type) : undefined) as AuditLogEvent | undefined, limit: Math.min(30, limit) }).catch(() => null);
          if (!logs) return void (await i.editReply({ content: 'Edge n’a pas ViewAuditLog, ou le serveur refuse.' }));
          const lines = [...logs.entries.values()].map((e) => {
            const t = EVENTS.find(([, v]) => v === e.action)?.[0] ?? String(e.action);
            return `· ${at(e.createdTimestamp)} ${t} par ${e.executor?.username ?? '?'}${e.targetId ? ` → \`${e.targetId}\`` : ''}${(e.extra as { count?: number } | undefined)?.count ? ` (x${(e.extra as { count?: number }).count})` : ''} ${e.reason ? truncate(`— ${e.reason}`, 90) : ''}`;
          });
          if (await c.db.flags.isOn('audit.post', true)) {
            const ch = c.s.channel('auditStaff') as TextChannel | null;
            await ch?.send({ content: `📋 Audit log, ${lines.length} entrée(s)\n${lines.join('\n')}`.slice(0, 1990), allowedMentions: { parse: [] } }).catch(() => void 0);
          }
          return void (await i.editReply({ content: lines.length ? lines.join('\n').slice(0, 1990) : 'Aucune trace.' }));
        }
        const lines = INVARIANTS.map((v) => `${v.check() === v.attendu ? '✅' : '💥'} ${v.id} — ${v.description}`);
        const ok = INVARIANTS.every((v) => v.check() === v.attendu);
        return void (await i.editReply({ content: `${ok ? '🟢' : '🔴'} **Invariants du manifeste** (${INVARIANTS.filter((v) => v.check() === v.attendu).length}/${INVARIANTS.length} conformes)\n${lines.join('\n')}`.slice(0, 1990) }));
      },
    },
  ],
};

/** Utile aux autres modules : le modele pur, applique au manifeste. */
export function modelCheck(actor: RoleKey[], chKey: ChannelKey, target: RoleKey): { speak: boolean; ping: boolean } {
  return { speak: canSpeakIn(actor, chKey), ping: canPingRole(actor, target, chKey) && canPingEveryone(actor, chKey) };
}
