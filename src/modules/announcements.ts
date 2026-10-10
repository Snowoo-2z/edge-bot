/**
 * Annonces : modale -> apercu -> confirmation -> publication en 📣│・Annonces,
 * avec programmation. Point important de ton serveur : 💼│ Manager Partenariat a le
 * droit de pinguer 🤝│ Notification Partenariat mais PAS d'ecrire dans 📣│・Annonces
 * (salon 🔒). C'est donc Edge qui poste pour lui, sur sa demande : le ping part, la
 * lecture seule du salon reste intacte.
 */
import {
  SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, Events,
  type ButtonInteraction, type GuildMember, type Message,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast } from '../core/perms.js';
import { mustText, logLine } from '../core/send.js';
import { at, truncate } from '../core/ui.js';
import { roleDef, type RoleKey } from '../manifest.js';

interface Pending { title: string; body: string; ping: string | null; at?: number }

export const announcements: EdgeModule = {
  key: 'announcements',
  label: 'Annonces',
  needs: { channels: ['annonces'], perms: ['ManageMessages'] },
  sync: async (c: Ctx) => {
    const rows = await c.db.all('announcements', { where: { published_at: null } as never });
    for (const r of rows) await c.sched.at('announce:publish', String(r.id), new Date(String(r.scheduled_at)), { id: String(r.id) });
    if (rows.length) c.log.info(`${rows.length} annonce(s) programmée(s) remises à l'heure`);
  },
  jobs: () => [
    {
      kind: 'announce:publish',
      run: async (c, payload) => {
        const row = await c.db.one('announcements', { id: String(payload.id) });
        if (!row || row.published_at) return;
        await publish(c, String(payload.id), String(row.author_id), row.embed as Pending);
      },
    },
  ],
  components: () => ({
    confirm: async (c: Ctx, i: ButtonInteraction, args: string[]) => {
      const key = `announce:pending:${i.user.id}`;
      const p = await c.db.kv.get<Pending>(key);
      if (!p || Date.now() - (p.at ?? 0) > 10 * 60_000) return void (await i.reply({ content: '⌛ Aperçu expiré : relance /annonce publier.', flags: 64 as never }));
      await c.db.kv.del(key);
      const row = await c.db.insert('announcements', { channel_id: mustText(c, 'annonces').id, author_id: i.user.id, embed: p, scheduled_at: new Date(), published_at: null });
      await publish(c, String(row.id), i.user.id, p);
      await i.reply({ content: '✅ Publiée.', flags: 64 as never });
      void args;
    },
    cancel: async (c: Ctx, i: ButtonInteraction) => {
      await c.db.kv.del(`announce:pending:${i.user.id}`);
      await i.reply({ content: '🗑️ Annulée, rien n’est paru.', flags: 64 as never });
    },
  }),
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('annonce')
        .setDescription('Annonces du serveur')
        .addSubcommand((s) => s.setName('publier').setDescription('Préparer une annonce (aperçu avant publication)')
          .addStringOption((o) => o.setName('titre').setDescription('Titre court').setRequired(true).setMaxLength(120))
          .addStringOption((o) => o.setName('texte').setDescription('Le corps, markdown OK').setRequired(true).setMaxLength(1800))
          .addStringOption((o) => o.setName('ping').setDescription('Rôle à prévenir (aucun par défaut)').addChoices(
            { name: 'aucun', value: 'none' }, { name: '🎁 Notification Giveaway', value: 'notifGiveaway' }, { name: '🤝 Notification Partenariat', value: 'notifPartenaire' })))
        .addSubcommand((s) => s.setName('programme').setDescription('Publier plus tard')
          .addStringOption((o) => o.setName('titre').setDescription('Titre').setRequired(true).setMaxLength(120))
          .addStringOption((o) => o.setName('texte').setDescription('Corps').setRequired(true).setMaxLength(1800))
          .addStringOption((o) => o.setName('dans').setDescription('Ex : 3h, 1j, 45m').setRequired(true))
          .addStringOption((o) => o.setName('ping').setDescription('Rôle à prévenir').addChoices(
            { name: 'aucun', value: 'none' }, { name: '🎁 Notification Giveaway', value: 'notifGiveaway' }, { name: '🤝 Notification Partenariat', value: 'notifPartenaire' })))
        .addSubcommand((s) => s.setName('lister').setDescription('Annonces publiées et programmées'))
        .addSubcommand((s) => s.setName('annuler').setDescription('Annuler une annonce programmée').addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true))) as never,
      guard: { min: 'mod' },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        const actor = i.member as GuildMember;
        if (sub === 'lister') {
          const rows = await c.db.all('announcements', { where: {}, orderBy: 'id', desc: true, limit: 10 });
          return void (await i.editReply({ content: rows.length ? rows.map((r) => {
            const e = r.embed as Pending;
            return `#${r.id} ${e?.title ?? '(sans titre)'} — ${r.published_at ? `publiée ${at(r.published_at as string)}` : `programmée ${at(r.scheduled_at as string)}`}`;
          }).join('\n') : 'Aucune annonce enregistrée par Edge.' }));
        }
        if (sub === 'annuler') {
          const num = i.options.getInteger('numero', true);
          const row = await c.db.one('announcements', { id: num });
          if (!row) return void (await i.editReply({ content: 'Annonce inconnue.' }));
          if (row.published_at) return void (await i.editReply({ content: 'Elle est déjà publiée : édite-la ou supprime-la à la main.' }));
          await c.sched.cancel('announce:publish', String(num));
          await c.db.delete('announcements', { id: num });
          return void (await i.editReply({ content: `✅ Annonce #${num} retirée du programme.` }));
        }
        const ping = i.options.getString('ping');
        if (ping && ping !== 'none' && !atLeast(actor, 'manager', c.s.idx) && !atLeast(actor, 'mod', c.s.idx)) {
          return void (await i.editReply({ content: `Le ping ${roleDef(ping as RoleKey).name} est réservé à 💼│ Manager Partenariat et au-dessus.` }));
        }
        const body = i.options.getString('texte', true);
        const title = i.options.getString('titre', true);
        if (sub === 'programme') {
          const { parseDuration } = await import('../core/ui.js');
          const dur = parseDuration(i.options.getString('dans', true));
          if (!dur) return void (await i.editReply({ content: 'Durée pas comprise (`45m`, `3h`, `1j`).' }));
          const when = new Date(Date.now() + dur);
          const row = await c.db.insert('announcements', { channel_id: mustText(c, 'annonces').id, author_id: i.user.id, embed: { title, body, ping }, scheduled_at: when, published_at: null });
          await c.sched.at('announce:publish', String(row.id), when, { id: String(row.id) });
          return void (await i.editReply({ content: `🗓️ Annonce #${row.id} programmée pour ${at(when)}. /edge flag announce.dry vrai pour la voir d'abord en aperçu.` }));
        }
        const p: Pending = { title, body, ping: ping && ping !== 'none' ? ping : null, at: Date.now() };
        await c.db.kv.set(`announce:pending:${i.user.id}`, p);
        await i.editReply({
          content: `👁️ **Aperçu** (personne d’autre ne le voit)\n\n**${title}**\n${body}\n${p.ping ? `\n→ partira avec un ping ${roleDef(p.ping as RoleKey).name}.` : '\n→ aucun ping.'}`,
          components: [new ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>().addComponents(
            new ButtonBuilder().setCustomId('edge:announcements:confirm').setLabel('✅ Publier dans 📣│・Annonces').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('edge:announcements:cancel').setLabel('🗑️ Annuler').setStyle(ButtonStyle.Danger),
          )],
        });
      },
    },
  ],
};

async function publish(c: Ctx, id: string, authorId: string, p: Pending): Promise<void> {
  const ch = mustText(c, 'annonces');
  const ping = p.ping ? `<@&${c.s.roleId(p.ping as RoleKey)}>` : '';
  await ch.send({
    content: [`📣 **${p.title}**`, '', p.body, ping, '', `— annoncé par <@${authorId}>`].filter((x) => x !== undefined).join('\n').slice(0, 1990),
    allowedMentions: { parse: p.ping ? ['users', 'roles'] : ['users'] },
  });
  await c.db.update('announcements', { id }, { published_at: new Date() });
  logLine('staff', `📣 annonce #${id} publiée${p.ping ? ` avec ping ${roleDef(p.ping as RoleKey).name}` : ''}`);
}
