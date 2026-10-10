/**
 * Boosts : role ✨│ Booster donne/retire sur le champ, message sobre dans ✨│・Boosts,
 * paliers 7/14/25 qui proposent un event a l'admin. Aucun embed : ca doit ressembler a
 * un serveur ou des gens se parlent, pas a un tableau de bord.
 */
import { SlashCommandBuilder, type GuildMember } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { canManageRole, roleIds } from '../core/perms.js';
import { logLine, say } from '../core/send.js';
import { atLeast } from '../core/perms.js';
import { truncate } from '../core/ui.js';
import { roleDef } from '../manifest.js';

const TIERS = [
  { n: 7, msg: '7 boosts : on peut débloquer un salon event temporaire. /event créer ?' },
  { n: 14, msg: '14 boosts : icône animée + bannière animée possibles. @Admin, ça vous tente ?' },
  { n: 25, msg: '25 boosts : tout est débloqué, y compris la salle d’attente personnalisée.' },
];

export const boosts: EdgeModule = {
  key: 'boosts',
  label: 'Boosts & rôle Booster',
  needs: { roles: ['booster'], channels: ['boosts'] },
  sync: async (c: Ctx) => {
    // rattrape les desynchronisations apres un arret du bot
    const id = roleIds(c.s.idx, 'booster');
    let fixed = 0;
    for (const m of c.guild.members.cache.values()) {
      const should = Boolean(m.premiumSince);
      const has = m.roles.cache.has(id);
      if (should === has) continue;
      if (!canManageRole(c.guild.members.me!, 'booster', c.s.idx)) break;
      await (should ? m.roles.add(id, 'Edge : boost actif') : m.roles.remove(id, 'Edge : boost terminé')).catch(() => void 0);
      fixed++;
    }
    if (fixed) c.log.info(`${fixed} rôle(s) Booster resynchronisé(s)`);
  },
  listeners: () => [
    {
      event: 'guildMemberUpdate',
      run: async (c: Ctx, before: GuildMember, after: GuildMember) => {
        if (after.user.bot) return;
        const was = Boolean(before.premiumSince);
        const now = Boolean(after.premiumSince);
        if (was === now) return;
        const id = roleIds(c.s.idx, 'booster');
        if (canManageRole(c.guild.members.me!, 'booster', c.s.idx)) {
          await (now ? after.roles.add(id, 'Edge : boost') : after.roles.remove(id, 'Edge : boost terminé')).catch(() => void 0);
        } else logLine('staff', `⚠️ Edge ne peut pas donner ${roleDef('booster').name} : rôle trop haut dans la hiérarchie.`);
        const count = c.guild.premiumSubscriptionCount ?? 0;
        if (now) {
          const one = after.user.username;
          await say(c, 'boosts', `✨ ${after} booste le serveur — on est à ${count} boost(s). Merci ${one}${after.premiumSinceTimestamp ? `, depuis <t:${after.premiumSinceTimestamp}:R>` : ''}.`);
          const tier = TIERS.find((t) => t.n === count);
          if (tier) await say(c, 'staffChat', `🎯 Palier atteint : ${tier.msg}`);
          await c.db.upsert('members', ['user_id'], { user_id: after.id, flags: { boosted_at: new Date().toISOString() } });
          await c.db.track('boost', { user: after.id, count });
        } else {
          await say(c, 'boosts', `💤 Le boost de ${after} est arrivé à terme (${count} restants). Aucun reproche : c’est ton serveur, tu fais comme tu veux.`);
          await c.db.track('unboost', { user: after.id, count });
        }
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('boosts')
        .setDescription('État des boosts du serveur')
        .addSubcommand((s) => s.setName('statut').setDescription('Compteur, paliers, boosters actifs')) as never,
      run: async (c: Ctx, i) => {
        const count = c.guild.premiumSubscriptionCount ?? 0;
        const tier = TIERS.filter((t) => count >= t.n).pop();
        const next = TIERS.find((t) => t.n > count);
        const boosters = (await c.guild.members.fetch()).filter((m: GuildMember) => Boolean(m.premiumSince));
        return void (await i.editReply({ content: [
          `✨ **${count} boost(s)** · palier serveur ${c.guild.premiumTier ?? 0}`,
          next ? `Prochain palier : ${next.n} (il manque ${next.n - count})` : 'Paliers max atteints 🎉',
          `Boosters actuels : ${boosters.size ? [...boosters.values()].slice(0, 15).map((m) => `${m.user.username}`).join(', ') + (boosters.size > 15 ? ` +${boosters.size - 15}` : '') : 'personne en ce moment'}`,
          tier ? `Merci à vous 🙏 (${tier.msg})` : '',
        ].filter(Boolean).join('\n').slice(0, 1990) }));
      },
    },
  ],
};
