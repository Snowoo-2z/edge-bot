/**
 * XP / niveaux. Choix assumé du proprio : AUCUN cooldown entre deux messages.
 * Le seul garde-fou est le contenu : message trop court, doublon immediat, bot,
 * ou message de commande => 0 xp. C'est plus juste qu'un minuteur qui punit les
 * gens qui parlent beaucoup legitimement, et ca ne casse pas le rythme du salon.
 * Pas de fichier image pour la carte de rang : un bloc texte rend mieux et ne
 * demande ni canvas ni fonts installees.
 */
import { SlashCommandBuilder, type Message } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { bar, levelFromXp, truncate } from '../core/ui.js';
import { norm } from '../core/structure.js';

const XP_MIN = 3;
const XP_PER_MESSAGE = 5;
const XP_BONUS_FIRST_OF_DAY = 10;
const DAY = 86_400_000;

export const levels: EdgeModule = {
  key: 'levels',
  label: 'XP & niveaux',
  reglages: [
    {
      cle: 'annonces', module: 'levels', type: 'booleen', label: 'Annoncer les passages de palier',
      aide: 'Un ricochet dans 📈│・Niveau à chaque palier. Éteint par défaut : les niveaux montent en silence, le classement et les rôles restent à jour.',
      defaut: false, base: 'flags', cleBase: 'levels.announce',
    },
  ],
  needs: { content: true },
  listeners: () => [
    {
      event: 'messageCreate',
      run: async (c: Ctx, msg: Message) => {
        if (msg.author.bot || !msg.inGuild() || msg.webhookId) return;
        if (msg.content.startsWith('/')) return;
        if (msg.content.trim().length < XP_MIN) return;
        if (!(await c.on('levels'))) return;
        const ch = msg.channel as import('discord.js').TextChannel;
        if (ch.parentId === c.s.category('staff')?.id || ch.parentId === c.s.category('tickets')?.id) return;

        const row = await c.db.one('members', { user_id: msg.author.id }) ?? await c.db.insert('members', { user_id: msg.author.id, joined_at: msg.member?.joinedAt ?? new Date(), xp: 0, messages: 0, flags: {} });
        const lastHash = String(row.last_hash ?? '');
        const hash = hashOf(msg.content);
        if (hash === lastHash) return; // doublon immediat = 0 xp, pas de malus

        const xp = Number(row.xp ?? 0) + XP_PER_MESSAGE;
        const before = levelFromXp(xp).level;
        const after = levelFromXp(xp).level;
        await c.db.update('members', { user_id: msg.author.id }, { xp, messages: Number(row.messages ?? 0) + 1, last_hash: hash });
        await dailyStreak(c, msg.author.id, row);

        if (after > before && (await c.db.flags.isOn('levels.announce', false))) {
          await msg.reply({ content: `🎉 niveau ${after} pour ${msg.author} (${xp} xp).`, allowedMentions: { repliedUser: false } }).catch(() => void 0);
          await applyRewards(c, msg);
        }
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('rang')
        .setDescription('Ton niveau et celui des autres')
        .addSubcommand((s) => s.setName('voir').setDescription('Ta carte de rang').addUserOption((o) => o.setName('membre').setDescription('Un autre membre')))
        .addSubcommand((s) => s.setName('top').setDescription('Le classement du serveur'))
        .addSubcommand((s) => s.setName('reglages').setDescription('Annoncer ou non les passages de niveau').addBooleanOption((o) => o.setName('annonce').setDescription('On/off').setRequired(true))) as never,
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'reglages') {
          const on = i.options.getBoolean('annonce', true);
          await c.db.flags.set('levels.announce', on);
          return void (await i.editReply({ content: on ? '📣 Les passages de niveau seront annoncés dans le salon où ils arrivent.' : '🔕 Plus d’annonce de niveau. Les XP continuent de compter, et sans cooldown comme demandé.' }));
        }
        if (sub === 'top') {
          const rows = (await c.db.all('members', { where: {}, orderBy: 'xp', desc: true, limit: 10 })).filter((r) => Number(r.xp ?? 0) > 0);
          if (!rows.length) return void (await i.editReply({ content: 'Personne n’a encore d’XP. Dites-vous bonjour, ça compte.' }));
          const lines: string[] = [];
          for (const [idx, r] of rows.entries()) {
            const lvl = levelFromXp(Number(r.xp ?? 0));
            const tag = r.tags ? ` · ${truncate(String(r.tags), 22)}` : '';
            lines.push(`**${idx + 1}.** <@${r.user_id}> — niv. ${lvl.level}${tag}`);
          }
          return void (await i.editReply({ content: `🏆 **Top 10 XP**\n${lines.join('\n')}\n\nXP par message : ${XP_PER_MESSAGE} (sans cooldown). Passer un jour = +${XP_BONUS_FIRST_OF_DAY}.` }));
        }
        const target = i.options.getUser('membre') ?? i.user;
        const row = await c.db.one('members', { user_id: target.id });
        const xp = Number(row?.xp ?? 0);
        const l = levelFromXp(xp);
        const rank = (await c.db.all('members', { where: {}, orderBy: 'xp', desc: true })).findIndex((r) => String(r.user_id) === target.id);
        const m = await c.guild.members.fetch(target.id).catch(() => null);
        return void (await i.editReply({ content: [
          `▬▬▬▬▬ **${m?.displayName ?? target.username}** ▬▬▬▬▬`,
          `Niveau **${l.level}** · ${xp} xp · #${rank < 0 ? '—' : rank + 1} du serveur`,
          `${bar(l.pct, 14)} ${l.into}/${l.need} pour le niveau ${l.level + 1}`,
          `${Number(row?.messages ?? 0)} messages${Number(row?.voice_minutes ?? 0) ? ` · ${Math.round(Number(row?.voice_minutes ?? 0) / 60)} h en vocal` : ''}`,
          (await c.db.flags.isOn('levels.announce', false)) ? '' : '_Annonces de niveau coupées (flag levels.announce)._ ',
        ].filter(Boolean).join('\n') }));
      },
    },
  ],
};

function hashOf(s: string): string {
  const n = norm(s);
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) | 0;
  return String(h);
}

async function dailyStreak(c: Ctx, userId: string, row: Record<string, unknown>): Promise<void> {
  const flags = (row.flags as Record<string, string> | null) ?? {};
  const today = new Date().toISOString().slice(0, 10);
  if (flags.lastDay === today) return;
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  const streak = flags.lastDay === yesterday ? Number(flags.streak ?? 0) + 1 : 1;
  const xp = Number(row.xp ?? 0) + XP_BONUS_FIRST_OF_DAY;
  await c.db.update('members', { user_id: userId }, { xp, flags: { ...flags, lastDay: today, streak } });
}

async function applyRewards(c: Ctx, msg: Message): Promise<void> {
  const rows = await c.db.all('level_rewards', { where: {} });
  if (!rows.length) return;
  const lvl = levelFromXp(Number((await c.db.one('members', { user_id: msg.author.id }))?.xp ?? 0)).level;
  for (const r of rows) {
    if (Number(r.level) <= lvl) await msg.member?.roles.add(String(r.role_id), 'Edge : récompense de niveau').catch(() => void 0);
  }
}

/** /rang reglages est garde pour un staff qui veut couper les annonces ; la voie royale reste /edge flag levels.announce. */
