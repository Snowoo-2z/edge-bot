/**
 * Anti-raid : fenetre glissante sur les arrivees, et soft-lock par OVERWRITE DE CATEGORIE
 * (@everyone + Membre perdent SendMessages sur la Grotte et les Activites).
 * On ne touche jamais aux permissions globales du serveur, on ne retire aucun role :
 * un deblocage raté est pire qu'un raid. Le lock auto est derriere un flag (off par defaut,
 * a regler sur du reel apres quelques semaines de trafic).
 */
import { ChannelType, OverwriteType, SlashCommandBuilder, type GuildMember, type TextChannel } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast, overwrite } from '../core/perms.js';
import { logLine, mustText } from '../core/send.js';
import { fmtDur } from '../core/ui.js';
import type { CategoryKey, PermName } from '../manifest.js';

const WINDOW = 60_000;
const LOCKED_CATS: CategoryKey[] = ['grotte', 'activites'];
const LOCK_PERMS: PermName[] = ['SendMessages', 'SendMessagesInThreads', 'AddReactions'];

export const antiraid: EdgeModule = {
  key: 'antiraid',
  label: 'Anti-raid',
  needs: { categories: ['grotte', 'activites'], roles: ['membre'], perms: ['ManageChannels'] },
  listeners: () => [
    {
      event: 'guildMemberAdd',
      run: async (c: Ctx, m: GuildMember) => {
        const now = Date.now();
        joins.push(now);
        while (joins.length && now - joins[0]! > WINDOW) joins.shift();
        const threshold = Number((await c.db.kv.get<{ n: number }>('antiraid.threshold'))?.n ?? 12);
        await c.db.upsert('members', ['user_id'], { user_id: m.id, joined_at: m.joinedAt ?? new Date() });
        if (joins.length < threshold) return;
        const lock = await c.db.kv.get<{ at: number; by: string }>('antiraid.lock');
        if (lock) return;
        if (!(await c.db.flags.isOn('antiraid.auto', false))) {
          logLine('moderation', `🚨 ${joins.length} arrivées en ${fmtDur(WINDOW)} (seuil ${threshold}). Lock automatique désarmé : tranche avec /raid lock.`);
          return;
        }
        await lockNow(c, `auto (${joins.length} joins/min)`, 'edge');
      },
    },
  ],
  jobs: () => [
    {
      kind: 'antiraid:watch',
      everyMs: 120_000,
      run: async (c) => {
        const lock = await c.db.kv.get<{ at: number; by: string }>('antiraid.lock');
        if (!lock) return;
        const ttl = Number((await c.db.kv.get<{ n: number }>('antiraid.ttl'))?.n ?? 45) * 60_000;
        if (Date.now() - lock.at < ttl) return;
        await unlock(c, 'délai dépassé');
        logLine('moderation', `🟢 lock de raid levé automatiquement après ${fmtDur(ttl)} (posés par ${lock.by}).`);
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('raid')
        .setDescription('Verrou d’urgence du serveur')
        .addSubcommand((s) => s.setName('statut').setDescription('Fenêtre de joins, lock en cours, réglages'))
        .addSubcommand((s) => s.setName('lock').setDescription('Couper l’écriture des salons publics maintenant'))
        .addSubcommand((s) => s.setName('unlock').setDescription('Rendre l’accès normal'))
        .addSubcommand((s) => s.setName('seuil').setDescription('Régler le déclencheur automatique')
          .addIntegerOption((o) => o.setName('joins_par_minute').setDescription('Ex : 12 (0 = détection seule, sans lock)').setRequired(true).setMinValue(0).setMaxValue(200))) as never,
      guard: { staff: true },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        const actor = i.member as GuildMember;
        const lock = await c.db.kv.get<{ at: number; by: string }>('antiraid.lock');
        if (sub === 'statut') {
          const now = Date.now();
          const rate = joins.filter((t) => now - t <= WINDOW).length;
          const th = Number((await c.db.kv.get<{ n: number }>('antiraid.threshold'))?.n ?? 12);
          return void (await i.editReply({ content: [
            `🚨 **Anti-raid**`,
            `· ${rate} arrivée(s) sur la dernière minute (seuil auto : ${th || 'off'})`,
            `· lock automatique : ${await c.db.flags.isOn('antiraid.auto', false) ? '✅ armé' : '❌ pas armé (`/edge flag antiraid.auto vrai`)'}`,
            lock ? `· ⏛ SERVEUR VERROUILLÉ depuis ${fmtDur(now - lock.at)} par ${lock.by}` : '· aucun verrouillage en cours',
            `· ce que fait un lock : retire SendMessages dans ⛺│↦ LA GROTTE et 🎪│↦ ACTIVITÉS pour @everyone et 👤│ Membre. Rien d’autre. Aucun rôle retiré.`,
          ].join('\n') }));
        }
        if (sub === 'lock') {
          if (!atLeast(actor, 'mod', c.s.idx)) return void (await i.editReply({ content: '⚔️│ Modérateur minimum pour verrouiller.' }));
          await lockNow(c, actor.user.username, 'manuel');
          return void (await i.editReply({ content: '🔒 Salons publics verrouillés. Le staff peut continuer à parler dans 🔐│↦ STAFF.' }));
        }
        if (sub === 'unlock') {
          if (!atLeast(actor, 'mod', c.s.idx)) return void (await i.editReply({ content: '⚔️│ Modérateur minimum.' }));
          if (!lock) return void (await i.editReply({ content: 'Rien à déverrouiller.' }));
          await unlock(c, actor.user.username);
          return void (await i.editReply({ content: '✅ Écriture rendue aux salons publics.' }));
        }
        const n = i.options.getInteger('joins_par_minute', true);
        await c.db.kv.set('antiraid.threshold', { n });
        return void (await i.editReply({ content: n ? `🎯 Seuil : ${n} arrivées/minute avant lock auto (si le flag antiraid.auto est armé).` : '🎯 Seuil sur 0 : Edge détecte et alerte, mais ne verrouille jamais seul.' }));
      },
    },
  ],
};

const joins: number[] = [];

type LockState = 'deny' | 'allow' | 'inherit';
interface LockEntry { ch: string; who: string; had: boolean; prev: Partial<Record<PermName, LockState>> }

/**
 * Le lock ne fait QUE toucher SendMessages / SendMessagesInThreads / AddReactions pour
 * @everyone et 👤│ Membre, sur les deux categories publiques. Un etat deja present (par
 * exemple un salon temporairement calme a la main) est snapshotte puis restaure a l'identique :
 * `unlock` n'ecrase jamais une decision plus ancienne que la sienne.
 */
async function lockNow(c: Ctx, by: string, kind: string): Promise<void> {
  const targets = [c.guild.id, c.s.roleId('membre')].filter(Boolean) as string[];
  const snapshot: LockEntry[] = [];
  for (const key of LOCKED_CATS) {
    const cat = c.s.category(key);
    if (!cat) continue;
    for (const ch of cat.children.cache.values()) {
      if (!('permissionOverwrites' in ch) || ch.type !== ChannelType.GuildText) continue;
      const tc = ch as TextChannel;
      for (const id of targets) {
        const ov = tc.permissionOverwrites.cache.get(id);
        const prev: Partial<Record<PermName, LockState>> = {};
        for (const p of LOCK_PERMS) prev[p] = ov ? (ov.deny.has(p as never) ? 'deny' : ov.allow.has(p as never) ? 'allow' : 'inherit') : 'inherit';
        snapshot.push({ ch: tc.id, who: id, had: Boolean(ov), prev });
        await tc.permissionOverwrites.edit(id as never, Object.fromEntries(LOCK_PERMS.map((p) => [p, false])) as never, { reason: `Edge : verrouillage anti-raid (${kind})` }).catch(() => void 0);
      }
    }
  }
  await c.db.kv.set('antiraid.lock', { at: Date.now(), by });
  await c.db.kv.set('antiraid.snapshot', snapshot);
  await c.db.track('raid_lock', { by, kind, channels: snapshot.length });
  logLine('moderation', `🔒 SERVEUR VERROUILLÉ (${kind}) par ${by} — ${snapshot.length} overwrite(s) posés sur ⛺│↦ LA GROTTE et 🎪│↦ ACTIVITÉS. Aucun rôle retiré.`);
  const staff = mustText(c, 'signalements');
  await staff.send({ content: `🔒 Edge a coupé l’écriture dans les salons publics (${kind}). Le staff garde la parole. Déverrouille avec \`/raid unlock\`.` }).catch(() => void 0);
  void overwrite;
}

async function unlock(c: Ctx, by: string): Promise<void> {
  const snapshot = (await c.db.kv.get<LockEntry[]>('antiraid.snapshot')) ?? [];
  for (const s of snapshot) {
    const ch = c.guild.channels.cache.get(s.ch);
    if (!ch || !('permissionOverwrites' in ch)) continue;
    const tc = ch as TextChannel;
    if (!s.had) { await tc.permissionOverwrites.delete(s.who as never, 'Edge : fin de verrouillage anti-raid').catch(() => void 0); continue; }
    const restore = Object.fromEntries(LOCK_PERMS.map((p) => [p, s.prev[p] === 'deny' ? false : s.prev[p] === 'allow' ? true : null]));
    await tc.permissionOverwrites.edit(s.who as never, restore as never, { reason: 'Edge : restauration de l’état antérieur' }).catch(() => void 0);
  }
  await c.db.kv.del('antiraid.snapshot');
  await c.db.kv.del('antiraid.lock');
  logLine('moderation', `🟢 verrouillage anti-raid levé par ${by} (${snapshot.length} overwrite(s) restaurés à l’identique).`);
}
