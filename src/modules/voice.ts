/**
 * Vocal : minutes comptees, top, eviction des inactifs (on ne touche JAMAIS a
 * 🎵│・Musique ni 🌙│・Chill : on y écoute sans parler), salon temporaire pour une
 * soirée, supprimé quand il se vide.
 * Comptage : une minute n'est validée que si la personne est présente ET non muette
 * au tick de 60 s. Pas de presence intent, donc pas de détection de voix active.
 */
import { SlashCommandBuilder, ChannelType, Events, type GuildMember, type VoiceChannel, type VoiceState } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast } from '../core/perms.js';
import { logLine } from '../core/send.js';
import { fmtDur } from '../core/ui.js';
import type { ChannelKey } from '../manifest.js';

const IDLE_MS_DEFAULT = 20 * 60_000;
const EXEMPT: ChannelKey[] = ['vMusique', 'vChill'];
const WATCHED: ChannelKey[] = ['vGeneral', 'vGaming'];
const active = new Map<string, number>();

export const voice: EdgeModule = {
  key: 'voice',
  label: 'Vocal',
  needs: { channels: [...WATCHED, ...EXEMPT], categories: ['vocal'], perms: ['MoveMembers'] },
  listeners: () => [
    {
      event: Events.VoiceStateUpdate,
      run: async (c: Ctx, _before: VoiceState | null, after: VoiceState | null) => {
        const id = after?.id ?? _before?.id;
        if (!id || after?.member?.user.bot) return;
        const exempt = after?.channelId && EXEMPT.some((k) => c.s.channelId(k) === after.channelId);
        if (after?.channel && !exempt && talks(after)) active.set(id, Date.now());
        else active.delete(id);
      },
    },
    {
      event: Events.ChannelDelete,
      run: async (c: Ctx, ch: { id: string }) => { temp.delete(ch.id); void c; },
    },
  ],
  jobs: () => [
    {
      kind: 'voice:flush',
      everyMs: 60_000,
      run: async (c) => {
        const now = Date.now();
        const byUser = new Map<string, number>();
        for (const [id, since] of active) {
          if (now - since < 60_000) continue;
          byUser.set(id, (byUser.get(id) ?? 0) + 1);
          active.set(id, since + 60_000);
        }
        for (const [id, mins] of byUser) {
          await c.db.bump('members', { user_id: id }, 'voice_minutes', mins, { user_id: id, joined_at: new Date(), xp: 0, messages: 0 });
        }
      },
    },
    {
      kind: 'voice:idle',
      everyMs: 5 * 60_000,
      run: async (c) => {
        if (!(await c.db.flags.isOn('voice.kickIdle', true))) return;
        const limit = Number((await c.db.kv.get<{ n: number }>('voice.idleMs'))?.n ?? IDLE_MS_DEFAULT);
        const now = Date.now();
        for (const key of WATCHED) {
          const ch = c.s.channel(key) as VoiceChannel | null;
          if (!ch || ch.type !== ChannelType.GuildVoice) continue;
          for (const vs of ch.members.values()) {
            if (vs.user.bot || atLeast(vs, 'helper', c.s.idx)) continue;
            const since = active.get(vs.id);
            if (!since || now - since < limit) continue;
            await vs.voice.setMute(true, 'Edge : inactivité').catch(() => void 0);
            await vs.send({ content: '🔇 Micro coupé pour inactivité. Reprends la parole, le son te rend le micro au prochain tick.' }).catch(() => void 0);
            active.set(vs.id, now);
            logLine('ops', `🔇 ${vs.user.username} muet d'office dans ${ch.name} après ${fmtDur(now - since)} sans voix.`);
          }
        }
      },
    },
    {
      kind: 'voice:temp',
      everyMs: 5 * 60_000,
      run: async (c) => {
        for (const id of [...temp]) {
          const ch = c.guild.channels.cache.get(id);
          if (!ch) { temp.delete(id); continue; }
          const vc = ch as VoiceChannel;
          if (vc.members.size > 0) { await c.db.kv.del(`voice:temp:${id}`); continue; }
          const emptySince = await c.db.kv.get<number>(`voice:temp:${id}`);
          if (!emptySince) { await c.db.kv.set(`voice:temp:${id}`, Date.now()); continue; }
          if (Date.now() - emptySince < 10 * 60_000) continue;
          await vc.delete('Edge : salon temporaire vide depuis 10 minutes').catch(() => void 0);
          temp.delete(id);
          await c.db.kv.del(`voice:temp:${id}`);
          logLine('ops', `🧹 salon temporaire ${vc.name} supprimé (vide).`);
        }
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('vocal')
        .setDescription('Vocal : classement, salon temporaire, réglages')
        .addSubcommand((s) => s.setName('top').setDescription('Heures en vocal, cumulées'))
        .addSubcommand((s) => s.setName('temp').setDescription('Salon vocal temporaire (auto-supprimé vide)')
          .addStringOption((o) => o.setName('nom').setDescription('Nom (optionnel)').setMaxLength(40)))
        .addSubcommand((s) => s.setName('inactivite').setDescription('Régler la coupure de micro').addIntegerOption((o) => o.setName('minutes').setDescription('5 à 120').setRequired(true)))
        .addSubcommand((s) => s.setName('couper').setDescription('Désactiver la surveillance des inactifs')) as never,
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'temp') {
          const cat = c.s.category('vocal');
          if (!cat) return void (await i.editReply({ content: 'Catégorie 🔊│↦ VOCAUX introuvable.' }));
          const name = `⌛ ${i.options.getString('nom') ?? `soirée de ${i.user.username}`}`.slice(0, 40);
          const ch = await c.guild.channels.create({ name, type: ChannelType.GuildVoice, parent: cat.id, bitrate: 64_000 });
          temp.add(ch.id);
          const m = i.member as GuildMember | null;
          await m?.voice.setChannel(ch).catch(() => void 0);
          return void (await i.editReply({ content: `🔊 ${ch} créé — il disparaît 10 minutes après le départ du dernier. Si tu le supprimes à la main, c'est bon aussi.` }));
        }
        if (sub === 'inactivite') {
          if (!atLeast(i.member as GuildMember, 'helper', c.s.idx)) return void (await i.editReply({ content: 'Staff seulement.' }));
          const n = Math.min(120, Math.max(5, i.options.getInteger('minutes', true)));
          await c.db.kv.set('voice.idleMs', { n: n * 60_000 });
          await c.db.flags.set('voice.kickIdle', true);
          return void (await i.editReply({ content: `⏱️ Micro coupé après ${n} min de silence dans 🔊│ Général et 🎮│ Gaming. 🎵│ Musique et 🌙│ Chill ne sont jamais touchés.` }));
        }
        if (sub === 'couper') {
          if (!atLeast(i.member as GuildMember, 'helper', c.s.idx)) return void (await i.editReply({ content: 'Staff seulement.' }));
          await c.db.flags.set('voice.kickIdle', false);
          return void (await i.editReply({ content: '🔕 Surveillance des inactifs coupée. Le comptage des minutes continue.' }));
        }
        const rows = (await c.db.all('members', { where: {}, orderBy: 'voice_minutes', desc: true, limit: 10 })).filter((r) => Number(r.voice_minutes ?? 0) > 0);
        if (!rows.length) return void (await i.editReply({ content: 'Aucune minute de vocal enregistrée pour l’instant.' }));
        const lines = rows.map((r, idx) => `**${idx + 1}.** <@${r.user_id}> — ${Math.round(Number(r.voice_minutes) / 60)} h`);
        return void (await i.editReply({ content: `🎙️ **Heures en vocal cumulées**\n${lines.join('\n')}\n\n_Une minute compte si tu es là et que ton micro n'est pas coupé._` }));
      },
    },
  ],
};

const talks = (vs: VoiceState): boolean => !vs.selfMute && !vs.selfDeaf && !vs.deaf;
const temp = new Set<string>();
