/**
 * Evenements : s'appuie sur l'evenement Discord natif (l'Animateur a ManageEvents),
 * avec un RSVP par bouton dans 🎮│・Gaming et un rappel 15 min avant.
 * Edge ne duplique pas le calendrier Discord : il le rend visible.
 */
import {
  SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, Events, GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel, GuildScheduledEventStatus, time, TimestampStyles,
  type ButtonInteraction, type GuildScheduledEvent, type GuildScheduledEventCreateOptions,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast } from '../core/perms.js';
import { mustText, say } from '../core/send.js';
import { at, truncate } from '../core/ui.js';
import { parseDuration } from '../core/ui.js';

interface Ev { id: string; guild_event_id: string | null; channel_id: string; creator_id: string; title: string; starts_at: string; status: string; reminded: boolean }
const map = (r: Record<string, unknown>): Ev => ({
  id: String(r.id), guild_event_id: r.guild_event_id ? String(r.guild_event_id) : null, channel_id: String(r.channel_id),
  creator_id: String(r.creator_id), title: String(r.title), starts_at: String(r.starts_at), status: String(r.status), reminded: Boolean(r.reminded),
});

export const events: EdgeModule = {
  key: 'events',
  label: 'Événements & RSVP',
  needs: { roles: ['animateur'], channels: ['gaming', 'vGaming'], perms: ['ManageEvents'] },
  sync: async (c: Ctx) => {
    const rows = (await c.db.all('scheduled_events', { where: { status: 'scheduled' } })).map(map);
    for (const e of rows) {
      const remind = new Date(new Date(e.starts_at).getTime() - 15 * 60_000);
      if (remind.getTime() > Date.now()) await c.sched.at('events:remind', e.id, remind, { id: e.id });
      else if (new Date(e.starts_at).getTime() > Date.now()) await c.sched.at('events:remind', e.id, new Date(), { id: e.id });
    }
    if (rows.length) c.log.info(`${rows.length} événement(s) suivis après redémarrage`);
  },
  jobs: () => [
    {
      kind: 'events:remind',
      run: async (c, payload) => {
        const row = await c.db.one('scheduled_events', { id: String(payload.id) });
        if (!row) return;
        const e = map(row);
        if (e.status !== 'scheduled') return;
        const yes = (await c.db.all('events_rsvp', { where: { event_row: e.id, state: 'yes' } })).length;
        await say(c, 'gaming', `⏰ **${e.title}** démarre ${time(new Date(e.starts_at), TimestampStyles.RelativeTime)} — ${yes} confirmé(s). Le salon vocal est prêt.`);
        await c.db.update('scheduled_events', { id: e.id }, { reminded: true });
        if (e.guild_event_id) {
          const ge = await c.guild.scheduledEvents.fetch(e.guild_event_id).catch(() => null);
          await ge?.edit({ status: GuildScheduledEventStatus.Active }).catch(() => void 0);
        }
      },
    },
    {
      kind: 'events:cleanup',
      everyMs: 6 * 3_600_000,
      run: async (c) => {
        for (const r of (await c.db.all('scheduled_events', { where: { status: 'scheduled' } })).map(map)) {
          if (new Date(r.starts_at).getTime() > Date.now()) continue;
          await c.db.update('scheduled_events', { id: r.id }, { status: 'done' });
          await c.sched.cancel('events:remind', r.id);
          if (r.guild_event_id) {
            const ge = await c.guild.scheduledEvents.fetch(r.guild_event_id).catch(() => null);
            await ge?.edit({ status: GuildScheduledEventStatus.Completed }).catch(() => void 0);
          }
        }
      },
    },
  ],
  components: () => ({
    rsvp: async (c: Ctx, i: ButtonInteraction, args: string[]) => {
      const [eventId, state] = args;
      const row = await c.db.one('scheduled_events', { id: eventId! });
      if (!row) return void (await i.reply({ content: 'Cet événement n’est plus suivi.', flags: 64 as never }));
      await c.db.upsert('events_rsvp', ['event_row', 'user_id'], { event_row: eventId, user_id: i.user.id, state });
      await i.reply({ content: `Noté : ${state === 'yes' ? '🙌 tu viens' : state === 'maybe' ? '🤔 peut-être' : '❌ pas cette fois'}.`, flags: 64 as never });
      await refresh(c, map(row), i.message.id);
    },
  }),
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('event')
        .setDescription('Soirées et rendez-vous du serveur')
        .addSubcommand((s) => s.setName('creer').setDescription('Programmer un événement (salon vocal + RSVP)')
          .addStringOption((o) => o.setName('titre').setDescription('Titre').setRequired(true).setMaxLength(100))
          .addStringOption((o) => o.setName('dans').setDescription('Ex : 2h, demain à 21:00 → utilise plutôt un délai (`30m`, `2h`, `1j`)').setRequired(true))
          .addStringOption((o) => o.setName('description').setDescription('Au programme').setMaxLength(600))
          .addChannelOption((o) => o.setName('salon').setDescription('Salon vocal (défaut 🎮│ Gaming)')))
        .addSubcommand((s) => s.setName('liste').setDescription('Les événements suivis par Edge'))
        .addSubcommand((s) => s.setName('annuler').setDescription('Annuler un événement').addIntegerOption((o) => o.setName('numero').setDescription('Le # interne').setRequired(true)))
        .addSubcommand((s) => s.setName('inscrits').setDescription('Qui vient').addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true))) as never,
      guard: { min: 'animateur' },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'liste') {
          const rows = (await c.db.all('scheduled_events', { where: { status: 'scheduled' }, orderBy: 'starts_at' })).map(map);
          if (!rows.length) return void (await i.editReply({ content: 'Aucun événement programmé. `/event creer`.' }));
          return void (await i.editReply({ content: `📅 ${rows.length} événement(s)\n${rows.map((e) => `#${e.id} ${truncate(e.title, 50)} · ${at(e.starts_at)}`).join('\n')}` }));
        }
        if (sub === 'inscrits') {
          const num = i.options.getInteger('numero', true);
          const rows = await c.db.all('events_rsvp', { where: { event_row: num } });
          const by = { yes: [] as string[], maybe: [] as string[], no: [] as string[] };
          for (const r of rows) by[(r.state as keyof typeof by) ?? 'maybe']!.push(`<@${r.user_id}>`);
          return void (await i.editReply({ content: [`🙋 #${num} — ${by.yes.length} oui · ${by.maybe.length} peut-être · ${by.no.length} non`, by.yes.length ? `\nOui : ${by.yes.slice(0, 30).join(' ')}` : ''].join('\n').slice(0, 1990) }));
        }
        if (sub === 'annuler') {
          const num = i.options.getInteger('numero', true);
          const raw = await c.db.one('scheduled_events', { id: num });
          if (!raw) return void (await i.editReply({ content: 'Événement inconnu.' }));
          const e = map(raw);
          if (!atLeast(i.member as never, 'animateur', c.s.idx) && e.creator_id !== i.user.id) return void (await i.editReply({ content: 'Seul l’auteur ou un animateur+ peut l’annuler.' }));
          await c.db.update('scheduled_events', { id: e.id }, { status: 'cancelled' });
          await c.sched.cancel('events:remind', e.id);
          if (e.guild_event_id) await c.guild.scheduledEvents.fetch(e.guild_event_id).then((ge: GuildScheduledEvent) => ge.edit({ status: GuildScheduledEventStatus.Canceled })).catch(() => void 0);
          await say(c, 'gaming', `🚫 Événement « ${e.title} » annulé. ${e.creator_id ? `<@${e.creator_id}>` : ''}`);
          return void (await i.editReply({ content: '✅ Annulé, RSVP nettoyés en douceur (personne n’est puni de s’être inscrit).' }));
        }
        const dur = parseDuration(i.options.getString('dans', true));
        if (!dur) return void (await i.editReply({ content: 'Créneau pas compris — utilise un délai : `30m`, `2h`, `1j`.' }));
        if (dur < 5 * 60_000) return void (await i.editReply({ content: 'C’est dans moins de 5 minutes : le rappel n’aurait aucun sens.' }));
        const starts = new Date(Date.now() + dur);
        const voiceCh = (i.options.getChannel('salon') as VoiceChannelLike | null) ?? c.s.channel('vGaming');
        let ge: GuildScheduledEvent | null = null;
        if (voiceCh) {
          ge = await c.guild.scheduledEvents.create({
            name: i.options.getString('titre', true).slice(0, 100),
            description: i.options.getString('description') ?? undefined,
            scheduledStartTime: starts,
            entityType: GuildScheduledEventEntityType.Voice,
            channelId: voiceCh.id,
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
          } as GuildScheduledEventCreateOptions).catch((e: Error) => { c.log.warn(`événement Discord natif refusé : ${e.message}`); return null; });
        }
        const row = await c.db.insert('scheduled_events', {
          guild_event_id: ge?.id ?? null, channel_id: mustText(c, 'gaming').id, creator_id: i.user.id,
          title: i.options.getString('titre', true), starts_at: starts, status: 'scheduled', reminded: false,
        });
        const e = map(row);
        await c.sched.at('events:remind', e.id, new Date(starts.getTime() - 15 * 60_000), { id: e.id });
        await say(c, 'gaming', [
          `📅 **${e.title}**`,
          `c'est ${time(starts, TimestampStyles.RelativeTime)} (${at(starts)})${ge ? ' · événement Discord natif créé' : ''}`,
          i.options.getString('description') ? `\n${i.options.getString('description')}` : '',
          `\nDis si tu viens :`,
        ].filter(Boolean).join('\n'), { components: await controlsFor(c, e) });
        return void (await i.editReply({ content: `📅 Événement #${e.id} créé, rappel à J-15 min.` }));
      },
    },
  ],
  listeners: () => [
    {
      event: Events.GuildScheduledEventDelete,
      run: async (c: Ctx, ge: GuildScheduledEvent) => {
        const row = await c.db.one('scheduled_events', { guild_event_id: ge.id });
        if (!row) return;
        await c.db.update('scheduled_events', { id: String(row.id) }, { status: 'deleted' });
        await c.sched.cancel('events:remind', String(row.id));
        c.log.info(`événement #${row.id} supprimé côté Discord : RSVP gelés`);
      },
    },
  ],
};

type VoiceChannelLike = { id: string };

async function controlsFor(_c: Ctx, e: Ev): Promise<ActionRowBuilder<MessageActionRowComponentBuilder>[]> {
  return [new ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`edge:events:rsvp:${e.id}:yes`).setLabel('🙌 Je viens').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`edge:events:rsvp:${e.id}:maybe`).setLabel('🤔 Peut-être').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`edge:events:rsvp:${e.id}:no`).setLabel('❌ Non').setStyle(ButtonStyle.Danger),
  )];
}

async function refresh(c: Ctx, e: Ev, messageId: string): Promise<void> {
  const ch = c.guild.channels.cache.get(e.channel_id) as import('discord.js').TextChannel | undefined;
  const msg = await ch?.messages.fetch(messageId).catch(() => null);
  const counts = { yes: 0, maybe: 0, no: 0 };
  for (const r of await c.db.all('events_rsvp', { where: { event_row: e.id } })) counts[(r.state as keyof typeof counts) ?? 'maybe']++;
  await msg?.edit({ components: await controlsFor(c, e) }).catch(() => void 0);
  void counts;
}
