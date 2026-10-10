/** Bienvenue : message texte simple (pas d'embed), ping du nouvel arrivant, role Membre. */
import { Events, type GuildMember } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { canalSelon, mustText } from '../core/send.js';
import { atLeast, canManageRole, roleIds } from '../core/perms.js';
import { fmtDur, at } from '../core/ui.js';
import { fr } from '../core/copy.js';
import { logLine } from '../core/send.js';
import { SlashCommandBuilder } from 'discord.js';

const DEFAULT_TEXT = 'Salut {membre} 👋 bienvenue sur {serveur}. Le règlement est dans {reglement}, va dire bonjour en {discussion}.';
const SUSPECT_DAYS = 7;

export const welcome: EdgeModule = {
  key: 'welcome',
  label: 'Bienvenue & départs',
  reglages: [
    {
      cle: 'message', module: 'welcome', type: 'texte', label: 'Message de bienvenue',
      aide: 'Placeholders : {membre} {serveur} {reglement} {discussion}. C’est le même texte que /bienvenue texte.',
      defaut: DEFAULT_TEXT, maxLen: 1800, base: 'kv', cleBase: 'welcome:text',
    },
    {
      cle: 'salon', module: 'welcome', type: 'salon', label: 'Salon de bienvenue',
      aide: 'Par défaut 🎉│・Bienvenue. Tu peux le pointer n’importe où sans toucher à la structure.',
      defaut: 'bienvenue',
    },
    {
      cle: 'delai', module: 'welcome', type: 'nombre', label: 'Délai avant le message (s)',
      aide: 'Attendre quelques secondes laisse l’arrivant lire le règlement avant d’être salué. 0 = immédiat.',
      defaut: 0, min: 0, max: 120,
    },
    {
      cle: 'mp_texte', module: 'welcome', type: 'texte', label: 'Message privé d’accueil',
      aide: 'Vide = pas de MP. Mêmes placeholders que le message public.',
      defaut: '', maxLen: 1500,
    },
  ],
  needs: { roles: ['membre'], channels: ['bienvenue', 'signalements', 'reglement', 'discussion'] },
  commands: (ctx: Ctx) => [
    {
      data: new SlashCommandBuilder().setName('bienvenue')
        .setDescription('Gérer l’accueil du serveur')
        .addSubcommand((s) => s.setName('texte').setDescription('Changer le message d’accueil (meme ton, plus long, pas d’embed)')
          .addStringOption((o) => o.setName('contenu').setDescription('Placeholders : {membre} {serveur} {reglement} {discussion}').setRequired(true).setMaxLength(600)))
        .addSubcommand((s) => s.setName('test').setDescription('Renvoyer un message d’accueil de test')
          .addUserOption((o) => o.setName('membre').setDescription('Qui on salue (défaut : toi)')))
        .addSubcommand((s) => s.setName('stats').setDescription('Arrivées / départs de la semaine')) as never,
      guard: { staff: true },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'texte') {
          if (!atLeast(i.member as GuildMember, 'admin', c.s.idx)) return void (await i.editReply({ content: fr.noPerm('🛡️│ Administrateur') }));
          await c.db.kv.set('welcome:text', i.options.getString('contenu', true));
          c.cfg.invalider('welcome'); // le reglage lit la meme cle : le cache de 20 s ne doit pas mentir
          return void (await i.editReply({ content: '✅ Message d’accueil mis à jour.' }));
        }
        if (sub === 'test') {
          const target = (i.options.getMember('membre') as GuildMember | null) ?? (i.member as GuildMember);
          await greet(c, target, true);
          return void (await i.editReply({ content: `Envoyé dans ${mustText(c, 'bienvenue')}.` }));
        }
        const w = week();
        const j = (await c.db.kv.get<{ n: number }>(`welcome:in:${w}`))?.n ?? 0;
        const l = (await c.db.kv.get<{ n: number }>(`welcome:out:${w}`))?.n ?? 0;
        const sus = (await c.db.kv.get<{ n: number }>(`welcome:suspect:${w}`))?.n ?? 0;
        return void (await i.editReply({ content: `📈 Semaine ${w} : ${j} arrivée(s), ${l} départ(s), ${sus} compte(s) suspect(s).\nTotal serveur : ${c.guild.memberCount} membres.` }));
      },
    },
  ],
  listeners: () => [
    {
      event: Events.GuildMemberAdd,
      run: async (c: Ctx, m: GuildMember) => {
        if (m.user.bot) return;
        await c.db.upsert('members', ['user_id'], { user_id: m.id, joined_at: m.joinedAt ?? new Date(), flags: { joined: true } });
        const ageDays = (Date.now() - m.user.createdTimestamp) / 86_400_000;
        const suspect = ageDays < SUSPECT_DAYS;
        if (suspect) await bump(c, `welcome:suspect:${week()}`);
        await giveMembre(c, m);
        await greet(c, m, suspect);
        if (suspect) logLine('moderation', `🕵️ compte jeune : ${m.user.tag} (${m.id}) — créé il y a ${fmtDur(Date.now() - m.user.createdTimestamp)}. Surveille-le.`);
        await bump(c, `welcome:in:${week()}`);
        await c.db.track('join', { user: m.id, suspect });
      },
    },
    {
      event: Events.GuildMemberRemove,
      run: async (c: Ctx, m: GuildMember) => {
        if (m.user.bot) return;
        const row = await c.db.one('members', { user_id: m.id });
        const stay = m.joinedAt ? fmtDur(Date.now() - m.joinedAt.getTime()) : '?';
        logLine('moderation', `👋 départ : ${m.user.tag} (${m.id}) — resté ${stay}, ${Number(row?.messages ?? 0)} messages, niveau ${row?.level ?? 0}.`);
        await bump(c, `welcome:out:${week()}`);
        await c.db.track('leave', { user: m.id });
      },
    },
  ],
};

/** Le texte est un reglage : /bienvenue texte et /edge config ecrivent exactement au meme endroit. */
function deplier(c: Ctx, m: GuildMember, tpl: string): string {
  return tpl
    .replaceAll('{membre}', `<@${m.id}>`)
    .replaceAll('{serveur}', c.guild.name)
    .replaceAll('{reglement}', `<#${mustText(c, 'reglement').id}>`)
    .replaceAll('{discussion}', `<#${mustText(c, 'discussion').id}>`);
}

async function greet(c: Ctx, m: GuildMember, quiet = false): Promise<void> {
  const r = c.reglages('welcome');
  const tpl = (await r.str('message')) || DEFAULT_TEXT;
  const delai = await r.num('delai');
  if (!quiet && delai > 0) await new Promise((ok) => setTimeout(ok, Math.min(delai, 120) * 1000));
  const content = deplier(c, m, tpl);
  try {
    const cible = await canalSelon(c, await r.salon('salon'), 'bienvenue');
    await cible.send({ content: content.slice(0, 2000), allowedMentions: { parse: ['users'], repliedUser: false } }).catch(() => void 0);
  } catch (e) {
    c.log.debug(`bienvenue publique impossible : ${(e as Error).message}`);
  }
  const mp = (await r.str('mp_texte')) || '';
  if (mp && !quiet) {
    await m.send({ content: deplier(c, m, mp).slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => void 0);
    await bump(c, 'welcome:mp');
  }
}

/** Role Membre auto, seulement si Edge peut le poser (hierarchie). */
async function giveMembre(c: Ctx, m: GuildMember): Promise<void> {
  const id = roleIds(c.s.idx, 'membre');
  if (m.roles.cache.has(id)) return;
  if (!canManageRole(c.guild.members.me!, 'membre', c.s.idx)) { c.log.warn('rôle 👤│ Membre hors de portée d’Edge : position à corriger'); return; }
  await m.roles.add(id, 'Edge : attribution automatique à l’arrivée').catch(() => void 0);
}

async function bump(c: Ctx, key: string): Promise<void> {
  const cur = (await c.db.kv.get<{ n: number }>(key))?.n ?? 0;
  await c.db.kv.set(key, { n: cur + 1 });
}

const week = (d = new Date()): string => {
  const day = (d.getDay() + 6) % 7;
  const mon = new Date(d);
  mon.setDate(d.getDate() - day);
  const onejan = new Date(mon.getFullYear(), 0, 1);
  const w = Math.ceil(((mon.getTime() - onejan.getTime()) / 86_400_000 + onejan.getDay() + 1) / 7);
  return `${mon.getFullYear()}-W${String(w).padStart(2, '0')}`;
};
