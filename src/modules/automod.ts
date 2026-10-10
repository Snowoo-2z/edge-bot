/**
 * Automod. Les detecteurs sont purs (src/logic/matchers.ts) -> testables sans Discord.
 * Principes :
 *  - on commence doux (suppression + explication), on monte seulement en cas de recidive ;
 *  - jamais de ban automatique : au-dela du 7e hit, Edge PROPOSE et ping le staff ;
 *  - les roles >= Administrateur sont exempts (ils peuvent deja tout faire, le bloquer
 *    serait une guerre de permissions) ; Animateur ne l'est PAS pour @everyone : c'est
 *    precisement la fuite de sa permission MentionEveryone que cette regle surveille.
 */
import { SlashCommandBuilder, type GuildMember, type Message } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast } from '../core/perms.js';
import { logLine } from '../core/send.js';
import { fmtDur, truncate } from '../core/ui.js';
import { automodStep } from '../logic/ladders.js';
import { duplicateScore, floodBurst, scan, type Hit, type RuleKind } from '../logic/matchers.js';
import { autoCase } from './moderation.js';

interface RuleRow { id: string; kind: string; enabled: unknown; params: Record<string, unknown>; action: string; strikes: unknown }

const DEFAULTS: { kind: RuleKind; params: Record<string, unknown>; strikes: number }[] = [
  { kind: 'invite', params: { exceptChannels: ['invitations'] }, strikes: 1 },
  { kind: 'webhook', params: {}, strikes: 1 },
  { kind: 'token', params: {}, strikes: 1 },
  { kind: 'everyone_ping', params: { exempt: ['admin', 'fondateur'] }, strikes: 1 },
  { kind: 'mass_mention', params: { max: 5 }, strikes: 1 },
  { kind: 'caps', params: { min: 18 }, strikes: 2 },
  { kind: 'flood', params: { window: 8000, count: 4 }, strikes: 2 },
  { kind: 'duplicate', params: { similarity: 0.85 }, strikes: 1 },
  { kind: 'zalgo', params: {}, strikes: 1 },
  { kind: 'unicode_spam', params: {}, strikes: 2 },
];

const LABELS: Record<string, string> = {
  invite: 'Invitation vers un autre serveur (hors 💌│・Invitations)',
  webhook: 'URL de webhook collée',
  token: 'Segment de jeton / clé',
  everyone_ping: '@everyone ou @here par quelqu’un qui ne devrait pas',
  mass_mention: 'Rafale de mentions',
  caps: 'CRIS EN MAJUSCULES',
  flood: 'Meme message recollé x4 en 8 s',
  duplicate: 'Copier-coller repeté',
  zalgo: 'Texte zalgo / diacritiques empilés',
  unicode_spam: 'Caractère répété',
  link: 'Lien externe non whitelisté',
};

export const automod: EdgeModule = {
  key: 'automod',
  label: 'Automatisation de la modération',
  needs: { channels: ['modLogs'], perms: ['ManageMessages'], content: true },
  sync: async (c: Ctx) => {
    if ((await c.db.count('automod_rules')) === 0) {
      for (const r of DEFAULTS) await c.db.insert('automod_rules', { kind: r.kind, enabled: true, params: r.params, action: 'escalade', strikes: r.strikes });
      c.log.info(`${DEFAULTS.length} règles d’automod initialisées`);
    }
  },
  listeners: () => [
    {
      event: 'messageCreate',
      run: async (c: Ctx, msg: Message) => {
        if (msg.author.bot || !msg.inGuild() || !msg.content) return;
        const rules = (await c.db.all('automod_rules', { where: { enabled: true } })).map((r) => r as unknown as RuleRow);
        if (!rules.length) return;
        const m = msg.member ?? await c.guild.members.fetch(msg.author.id).catch(() => null);
        if (!m) return;
        if (atLeast(m, 'admin', c.s.idx)) return;

        const enabled = new Set(rules.map((r) => r.kind));
        const own = [...c.guild.invites.cache.values()].map((i) => i.code);
        const hits = scan(msg.content, {
          inviteAllowed: !enabled.has('invite') || msg.channel.id === c.s.channel('invitations')?.id,
          guildId: c.guild.id,
          vanityCode: c.guild.vanityURLCode,
          ownCodes: own,
          maxMentions: num(rules.find((r) => r.kind === 'mass_mention')?.params, 'max', 5),
          allowLinks: !enabled.has('link'),
          capsMinLength: num(rules.find((r) => r.kind === 'caps')?.params, 'min', 18),
        }).filter((h) => enabled.has(h.kind));

        if (enabled.has('flood') || enabled.has('duplicate')) {
          const hist = recent(c, m.id);
          if (enabled.has('duplicate') && duplicateScore(hist.map((h) => h.text), msg.content) >= 1) hits.push({ kind: 'duplicate', detail: 'même contenu déjà posté à l’instant', delete: true, score: 1 });
          if (enabled.has('flood') && floodBurst(hist)) hits.push({ kind: 'flood', detail: `${hist.length} messages en moins de 8 s`, delete: true, score: 2 });
          hist.push({ text: msg.content, at: Date.now() });
        }

        if (!hits.length) return;
        const worst = hits.reduce((a, b) => (b.score > a.score ? b : a));
        const count = await hitCount(c, m.id);
        const step = automodStep(count + 1);
        const explain = hits.map((h) => `${LABELS[h.kind] ?? h.kind} — ${h.detail}`).join(' · ');

        if (hits.some((h) => h.delete) && step.action !== 'ignore') {
          await msg.delete().catch(() => void 0);
          const note = await msg.reply({ content: `${i18n(step.action)} ${explain}\nSi tu trouves ça idiot, dis-le en ticket (🎫│・Ouvrir-un-ticket) — pas en recollant le même message.`, allowedMentions: { repliedUser: false } }).catch(() => null);
          if (note) setTimeout(() => void note.delete().catch(() => void 0), 12_000);
        }

        await c.db.insert('automod_hits', { rule_kind: worst.kind, user_id: m.id, message_id: msg.id, channel_id: msg.channel.id, detail: truncate(explain, 400), action_taken: step.action, created_at: new Date() });
        logLine('moderation', `🤖 automod · <@${m.id}> · ${explain}\n   ${step.label}${step.minutes ? ` (${fmtDur(step.minutes * 60_000)})` : ''} · hit #${count + 1} dans ${msg.channel}`);

        if (step.action === 'timeout' && step.minutes) {
          if (c.guild.members.me?.permissions.has('ModerateMembers')) await m.timeout(step.minutes * 60_000, `Edge · automod : ${worst.kind}`).catch(() => void 0);
          await autoCase(c, { type: 'timeout', userId: m.id, reason: `automod (${worst.kind})`, minutes: step.minutes });
        } else if (step.action === 'ban_suggest') {
          await logLine('moderation', `🆘 Récidive lourde de <@${m.id}> (${count + 1} hits en 7 j) → la décision appartient à un humain : /mod historique pour lire le dossier, /sanction ban pour conclure.`);
          await sayStaff(c, `🆘 ${m.user.username} cumule ${count + 1} déclenchements d'automod. Edge s'arrête là : la décision t'appartient.`);
        }
        void worst;
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('automod')
        .setDescription('Règles automatiques : liste, test, stats')
        .addSubcommand((s) => s.setName('regles').setDescription('Lister les règles et les couper/activer')
          .addStringOption((o) => o.setName('couper').setDescription('Couper une règle par son nom').addChoices(...DEFAULTS.map((d) => ({ name: (LABELS[d.kind] ?? d.kind).slice(0, 100), value: d.kind }))))
          .addStringOption((o) => o.setName('reactiver').setDescription('Réactiver une règle').addChoices(...DEFAULTS.map((d) => ({ name: (LABELS[d.kind] ?? d.kind).slice(0, 100), value: d.kind })))))
        .addSubcommand((s) => s.setName('test').setDescription('Faire tourner les détecteurs sur un texte, sans rien supprimer')
          .addStringOption((o) => o.setName('texte').setDescription('Le message à tester').setRequired(true).setMaxLength(1500)))
        .addSubcommand((s) => s.setName('stats').setDescription('Ce que l’automod a mangé ces 7 derniers jours')
          .addUserOption((o) => o.setName('membre').setDescription('Optionnel : un seul membre'))) as never,
      guard: { min: 'mod' },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'regles') {
          const cut = i.options.getString('couper'), back = i.options.getString('reactiver');
          if (cut) await c.db.update('automod_rules', { kind: cut }, { enabled: false });
          if (back) await c.db.update('automod_rules', { kind: back }, { enabled: true });
          const rows = await c.db.all('automod_rules', { where: {} });
          return void (await i.editReply({ content: `⚙️ **Règles d’automod**\n${rows.map((r) => `${r.enabled === false ? '🔕' : '🔔'} \`${r.kind}\` → ${automodStep(Number(r.strikes ?? 1)).label}`).join('\n')}\n\nLes seuils d'escalade sont fixes : 1 hit = suppression, 3 = 10 min, 4 = 1 h, 5 = 24 h, 7 = proposition de ban.` }));
        }
        if (sub === 'test') {
          const text = i.options.getString('texte', true);
          const hits: Hit[] = scan(text, { inviteAllowed: false, guildId: c.guild.id, ownCodes: [], allowLinks: true });
          return void (await i.editReply({ content: hits.length ? `🧪 ${hits.length} détection(s) sur ce texte :\n${hits.map((h) => `• ${LABELS[h.kind] ?? h.kind} — ${h.detail}`).join('\n')}` : '🧪 Rien. Ce texte passerait sans être supprimé.' }));
        }
        const who = i.options.getMember('membre') as GuildMember | null;
        const since = Date.now() - 7 * 86_400_000;
        const rows = (await c.db.all('automod_hits', { where: who ? { user_id: who.id } : {}, orderBy: 'id', desc: true, limit: 500 })).filter((r) => new Date(r.created_at as string).getTime() > since);
        const by = new Map<string, number>();
        for (const r of rows) by.set(String(r.rule_kind), (by.get(String(r.rule_kind)) ?? 0) + 1);
        const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
        return void (await i.editReply({ content: rows.length ? `📊 7 jours${who ? ` · ${who.user.username}` : ''} : ${rows.length} déclenchement(s)\n${top.map(([k, n]) => `· ${LABELS[k] ?? k} : ${n}`).join('\n')}` : '📊 Aucun déclenchement sur 7 jours. L’automod est propre, ou mal réglé.' }));
      },
    },
  ],
};

const num = (params: Record<string, unknown> | undefined, key: string, def: number): number => Number(params?.[key] ?? def);
const i18n = (a: string): string => ({ ignore: '⚠️', delete: '🗑️ Message retiré :', delete_warn: '🗑️ Retiré + warn :', timeout: '⏱️ Retiré + silence posé :', kick_suggest: '👢 À expulser :', ban_suggest: '🔨 À trancher par un humain :' }[a] ?? '🗑️');

const recentMap = new Map<string, { text: string; at: number }[]>();
function recent(c: Ctx, userId: string): { text: string; at: number }[] {
  const now = Date.now();
  const arr = (recentMap.get(userId) ?? []).filter((h) => now - h.at <= 8_000);
  recentMap.set(userId, arr);
  return arr;
}
async function hitCount(c: Ctx, userId: string): Promise<number> {
  const since = Date.now() - 7 * 86_400_000;
  const rows = await c.db.all('automod_hits', { where: { user_id: userId } });
  return rows.filter((r) => new Date(r.created_at as string).getTime() > since).length;
}
async function sayStaff(c: Ctx, text: string): Promise<void> {
  const ch = c.s.channel('signalements') as import('discord.js').TextChannel | null;
  await ch?.send({ content: `⚔️ ${text}` }).catch(() => void 0);
}
