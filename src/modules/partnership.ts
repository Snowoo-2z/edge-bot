/**
 * Partenariats. Ce qui est verifiable sans etre dans le serveur d'en face :
 * un lien d'invite public resout le nom, le nombre de membres et l'etat du lien
 * (client.fetchInvite). Ce qui ne l'est PAS : la reciprocite (leur salon d'invitations
 * / liste de partenaires) — illisible sans etre membre. Donc :
 *   - si Edge est deja dans ce serveur => controle automatique complet ;
 *   - sinon => Edge prepare la checklist et un 💼│ Manager valide a la main.
 * Le ping 🤝│ Notification Partenariat part par Edge (le Manager n'a pas le droit
 * d'ecrire dans 📣│・Annonces, lui).
 */
import { SlashCommandBuilder, type GuildMember } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { atLeast, canManageRole, roleIds } from '../core/perms.js';
import { jump, logLine, mustText } from '../core/send.js';
import { at, pad, truncate } from '../core/ui.js';
import { afterCheck, type PartnershipState } from '../logic/ladders.js';
import { roleDef } from '../manifest.js';

interface P { id: string; partner_name: string; partner_guild_id: string | null; contact_id: string; status: PartnershipState; reciprocal: boolean; member_count: number | null; invite_code: string | null; fails: number; checks: number; last_checked_at: string | null; note: string | null }
const map = (r: Record<string, unknown>): P => ({
  id: String(r.id), partner_name: String(r.partner_name), partner_guild_id: r.partner_guild_id ? String(r.partner_guild_id) : null,
  contact_id: String(r.contact_id), status: (r.status as PartnershipState) ?? 'pending', reciprocal: Boolean(r.reciprocal),
  member_count: r.member_count === null || r.member_count === undefined ? null : Number(r.member_count),
  invite_code: r.invite_code ? String(r.invite_code) : null, fails: Number(r.fails ?? 0), checks: Number(r.checks ?? 0),
  last_checked_at: r.last_checked_at ? String(r.last_checked_at) : null, note: r.note ? String(r.note) : null,
});

const MIN_MEMBERS = 20;
const MIN_AGE_DAYS = 14;

export const partnership: EdgeModule = {
  key: 'partnership',
  label: 'Partenariats',
  needs: { roles: ['manager', 'partenaire', 'notifPartenaire'], channels: ['annonces', 'ticketLogs'] },
  jobs: () => [
    {
      kind: 'partnership:check',
      everyMs: 7 * 24 * 3_600_000,
      run: async (c) => {
        const rows = (await c.db.all('partnerships', { where: { status: ['active', 'paused'] } })).map(map);
        if (!rows.length) return;
        let bad = 0;
        for (const p of rows) {
          const ok = await check(c, p);
          const next = afterCheck(p.status, ok, p.fails);
          await c.db.update('partnerships', { id: p.id }, { status: next.state, fails: next.fails, checks: Number(p.checks) + 1, last_checked_at: new Date(), reciprocal: ok });
          if (!ok) {
            bad++;
            await say2(c, `⚠️ Partenariat **${p.partner_name}** : ${next.state === 'expired' ? 'rupture après 3 contrôles ratés' : `contrôle raté (${next.fails}/3)`}. Rôle 🤝│ Partenaire ${next.state === 'expired' ? 'retiré' : 'conservé, on revérifiera lundi'}.`);
            if (next.state === 'expired' && p.contact_id) await unbind(c, p.contact_id);
          }
        }
        logLine('staff', `🤝 contrôle hebdo : ${rows.length} partenariat(s), ${bad} souci(s).`);
      },
    },
  ],
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('partenariat')
        .setDescription('Gestion des partenaires (💼│ Manager et plus)')
        .addSubcommand((s) => s.setName('candidature').setDescription('Enregistrer une demande')
          .addStringOption((o) => o.setName('serveur').setDescription('Nom du serveur partenaire').setRequired(true).setMaxLength(80))
          .addStringOption((o) => o.setName('lien').setDescription('Lien ou code d’invitation chez eux').setRequired(true).setMaxLength(120))
          .addUserOption((o) => o.setName('contact').setDescription('Leur représentant ici').setRequired(true))
          .addStringOption((o) => o.setName('offre').setDescription('Ce qu’ils proposent').setMaxLength(400)))
        .addSubcommand((s) => s.setName('auditer').setDescription('Vérifier le serveur partenaire (membres, âge, lien vivant)')
          .addIntegerOption((o) => o.setName('numero').setDescription('Le # de la candidature').setRequired(true)))
        .addSubcommand((s) => s.setName('accepter').setDescription('Accepter, annoncer et pinger les abonnés')
          .addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true))
          .addStringOption((o) => o.setName('texte').setDescription('Phrase d’annonce (défaut : générée)').setMaxLength(600)))
        .addSubcommand((s) => s.setName('refuser').setDescription('Refuser proprement').addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true)).addStringOption((o) => o.setName('raison').setDescription('Pourquoi').setRequired(true).setMaxLength(300)))
        .addSubcommand((s) => s.setName('reciprocite').setDescription('Confirmer le lien chez eux (si Edge n’y est pas)')
          .addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true))
          .addStringOption((o) => o.setName('etat').setDescription('Trouvé ou pas ?').setRequired(true).addChoices({ name: '✅ lien présent', value: 'oui' }, { name: '❌ absent', value: 'non' })))
        .addSubcommand((s) => s.setName('lier').setDescription('Donner 🤝│ Partenaire au représentant')
          .addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true))
          .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
        .addSubcommand((s) => s.setName('rompre').setDescription('Couper le partenariat et retirer le rôle')
          .addIntegerOption((o) => o.setName('numero').setDescription('Le #').setRequired(true))
          .addStringOption((o) => o.setName('raison').setDescription('Motif').setMaxLength(300)))
        .addSubcommand((s) => s.setName('lister').setDescription('Le tableau des partenaires')) as never,
      guard: { min: 'manager' },
      run: async (c, i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'lister') {
          const rows = (await c.db.all('partnerships', { where: {}, orderBy: 'id', desc: true, limit: 20 })).map(map);
          if (!rows.length) return void (await i.editReply({ content: 'Aucun partenariat enregistré. `/partenariat candidature`.' }));
          return void (await i.editReply({ content: `🤝 **${rows.length} dossier(s)**\n${rows.map((p) => `${icon(p.status)} #${pad(p.id)} ${truncate(p.partner_name, 26)} · ${p.status}${p.reciprocal ? '' : ' · reciprocite ❌'}${p.member_count ? ` · ${p.member_count} membres` : ''}${p.last_checked_at ? ` · vu ${at(p.last_checked_at)}` : ''}`).join('\n')}` }));
        }
        if (sub === 'candidature') {
          const name = i.options.getString('serveur', true);
          const code = clean(i.options.getString('lien', true));
          const contact = i.options.getMember('contact') as GuildMember | null;
          const row = await c.db.insert('partnerships', {
            partner_name: name, partner_guild_id: null, contact_id: contact?.id ?? i.user.id, status: 'pending',
            invite_code: code, reciprocal: false, note: i.options.getString('offre'), checks: 0, fails: 0, created_at: new Date(),
          });
          const me = c.guild.invites.cache.find((x) => x.code === code) ?? null;
          const own = me?.guild?.id;
          if (own) await c.db.update('partnerships', { id: String(row.id) }, { partner_guild_id: own });
          await say2(c, `🤝 Nouvelle candidature #${pad(String(row.id))} : **${name}** ** (contact <@${contact?.id ?? i.user.id}>) — à auditer : \`/partenariat auditer ${row.id}\`.`);
          return void (await i.editReply({ content: `📥 Candidature #${pad(String(row.id))} enregistrée.` }));
        }
        const num = i.options.getInteger('numero', true);
        const raw = await c.db.one('partnerships', { id: num });
        if (!raw) return void (await i.editReply({ content: `Dossier #${pad(num)} introuvable.` }));
        const p = map(raw);

        if (sub === 'auditer') {
          const r = await audit(c, p);
          return void (await i.editReply({ content: r.join('\n').slice(0, 1900) }));
        }
        if (sub === 'reciprocite') {
          const ok = i.options.getString('etat', true) === 'oui';
          await c.db.update('partnerships', { id: p.id }, { reciprocal: ok, last_checked_at: new Date(), fails: ok ? 0 : p.fails + 1 });
          return void (await i.editReply({ content: ok ? '✅ Réciprocité notée. Le contrôle hebdo part de là.' : `⚠️ Enregistré comme absent (${p.fails + 1}/3). Au 3e échec, rupture automatique.` }));
        }
        if (sub === 'accepter') {
          if (!p.reciprocal) {
            const inGuild = p.partner_guild_id ? c.client.guilds.cache.has(p.partner_guild_id) : false;
            if (!inGuild) return void (await i.editReply({ content: '🚫 Impossible d’accepter sans contrôle de réciprocité : valide-le avec `/partenariat reciprocite` (ou invite Edge chez eux pour que ce soit automatique).' }));
          }
          if (p.status === 'active') return void (await i.editReply({ content: 'Il est déjà actif.' }));
          await c.db.update('partnerships', { id: p.id }, { status: 'active', reciprocal: true, fails: 0, last_checked_at: new Date() });
          const ch = mustText(c, 'annonces');
          const text = i.options.getString('texte') ?? `🤝 **Nouveau partenaire : ${p.partner_name}**\nOn ouvre un échange avec eux — salons d'entraide, events croisés, et un lien d'invite dans ${c.s.channelId('invitations') ? `<#${c.s.channelId('invitations')}>` : '💌│・Invitations'}.\nMerci de les accueillir correctement.`;
          await ch.send({ content: `${text}\n\n<@&${roleIds(c.s.idx, 'notifPartenaire')}>`, allowedMentions: { parse: ['users', 'roles'] } });
          await c.db.update('partnerships', { id: p.id }, { note: `${p.note ?? ''}\nannonce: ${jump(c, ch.id, 'annonce')}`.trim() });
          logLine('staff', `🤝 partenariat #${pad(p.id)} (${p.partner_name}) accepté par ${i.user.username} · annonce publiée + ping ${roleDef('notifPartenaire').name}`);
          return void (await i.editReply({ content: `✅ Accepté et annoncé dans <#${ch.id}>, avec le ping 🤝│ Notification Partenariat. Prochain contrôle : lundi prochain.` }));
        }
        if (sub === 'refuser') {
          await c.db.update('partnerships', { id: p.id }, { status: 'expired', note: `${p.note ?? ''}\nrefus : ${i.options.getString('raison', true)}`.trim() });
          await say2(c, `🚫 Partenariat **${p.partner_name}** refusé — ${truncate(i.options.getString('raison', true), 200)}. (Contact : <@${p.contact_id}>)`);
          return void (await i.editReply({ content: '🚫 Refusé, tracé, et la raison est dans le dossier.' }));
        }
        if (sub === 'lier') {
          const target = i.options.getMember('membre') as GuildMember | null;
          if (!target) return void (await i.editReply({ content: 'Membre introuvable.' }));
          if (!canManageRole(c.guild.members.me!, 'partenaire', c.s.idx)) return void (await i.editReply({ content: `❌ Edge ne peut pas poser ${roleDef('partenaire').name} : son rôle est trop bas dans la hiérarchie (/edge sante).` }));
          await target.roles.add(roleIds(c.s.idx, 'partenaire'), `Edge : représentant de ${p.partner_name}`);
          await c.db.update('partnerships', { id: p.id }, { contact_id: target.id });
          return void (await i.editReply({ content: `🤝 ${target.user.username} a maintenant ${roleDef('partenaire').name} comme contact de ${p.partner_name}.` }));
        }
        if (sub === 'rompre') {
          await c.db.update('partnerships', { id: p.id }, { status: 'expired', note: `${p.note ?? ''}\nrupture : ${i.options.getString('raison') ?? 'sans motif'}`.trim() });
          await unbind(c, p.contact_id);
          await say2(c, `✂️ Partenariat **${p.partner_name}** rompu (${truncate(i.options.getString('raison') ?? 'sans motif', 160)}). Rôle 🤝│ Partenaire retiré au contact.`);
          return void (await i.editReply({ content: '✂️ Rompu. Le dossier reste lisible, le rôle est retiré.' }));
        }
      },
    },
  ],
};

const icon = (s: PartnershipState): string => ({ pending: '🟡', active: '🟢', paused: '🟠', expired: '🔴' }[s] ?? '⚪');
const clean = (s: string): string => (s.replace(/https?:\/\/(?:discord\.gg|discord\.com\/invite|discord\.me)\//i, '').split(/[/?#]/)[0] ?? s).slice(0, 32);

async function audit(c: Ctx, p: P): Promise<string[]> {
  const out: string[] = [`🔎 Audit de **${p.partner_name}** (#${pad(p.id)})`];
  const code = p.invite_code;
  if (!code) return [...out, '· aucun lien enregistré — rien à vérifier.'];
  let info: { guildName: string; members: number; channel?: string };
  try {
    const inv = await c.client.fetchInvite(code);
    info = { guildName: inv.guild?.name ?? '?', members: inv.memberCount ?? 0, channel: inv.channel?.name ?? undefined };
  } catch {
    return [...out, `· ❌ lien \`${code}\` mort ou inexistant. Demande-leur un lien sans expiration (réglage « Ne jamais expirer »).`];
  }
  if (info.guildName !== p.partner_name) out.push(`⚠️ nom du serveur différent du dossier : « ${info.guildName} » (dossier : « ${p.partner_name} »)`);
  out.push(`· membres : ${info.members} ${info.members < MIN_MEMBERS ? `❌ sous le seuil de ${MIN_MEMBERS}` : '✅'}`);
  out.push(`· salon de l'invite : ${info.channel ?? '?'}`);
  const guild = info && c.client.guilds.cache.find((g) => g.name === info!.guildName);
  if (guild) {
    const ageDays = (Date.now() - guild.createdTimestamp) / 86_400_000;
    out.push(`· âge du serveur : ${Math.round(ageDays)} j ${ageDays < MIN_AGE_DAYS ? '❌ trop jeune' : '✅'}`);
    const found = await findOurInvite(guild, c);
    out.push(`· réciprocité auto : ${found ? `✅ trouvée (${found})` : '❌ aucune invitation vers nous vue chez eux'}`);
    await c.db.update('partnerships', { id: p.id }, { partner_guild_id: guild.id, member_count: info.members, reciprocal: Boolean(found), status: found ? 'active' : p.status });
    out.push(found ? `→ Edge est chez eux et le lien est là : dossier passé en actif.` : `→ Edge est chez eux mais pas de lien : refuse ou laisse en pause.`);
  } else {
    await c.db.update('partnerships', { id: p.id }, { member_count: info.members });
    out.push(`· Edge n'est pas dans ce serveur : la réciprocité ne peut pas être lue automatiquement.`);
    out.push(`→ fais confirmer par un humain : /partenariat reciprocite ${p.id} etat:oui`);
  }
  return out;
}

/** Le controle hebdo : lien vivant + (si possible) reciprocite lue chez eux. */
async function check(c: Ctx, p: P): Promise<boolean> {
  if (!p.invite_code) return false;
  let alive = false;
  try {
    const inv = await c.client.fetchInvite(p.invite_code);
    alive = Boolean(inv.guild);
    if (inv.guild) await c.db.update('partnerships', { id: p.id }, { partner_guild_id: inv.guild.id, member_count: inv.memberCount ?? p.member_count });
  } catch {
    alive = false;
  }
  if (!alive) return false;
  const guild = p.partner_guild_id ? c.client.guilds.cache.get(p.partner_guild_id) : c.client.guilds.cache.find((g) => g.name === p.partner_name);
  if (!guild) return p.reciprocal; // on ne peut pas lire chez eux : on garde la derniere parole du Manager
  return Boolean(await findOurInvite(guild, c));
}

async function findOurInvite(guild: import('discord.js').Guild, c: Ctx): Promise<string | null> {
  const vanity = c.guild.vanityURLCode;
  const needles = new Set([c.guild.id, c.guild.name.toLowerCase(), vanity?.toLowerCase()].filter(Boolean) as string[]);
  for (const ch of guild.channels.cache.values()) {
    if (!('invites' in ch)) continue;
    const list = await (ch as unknown as { invites: { fetch: () => Promise<import('discord.js').Collection<string, import('discord.js').Invite>> } }).invites.fetch().catch(() => null);
    for (const inv of list?.values() ?? []) {
      if (inv.guild && (inv.guild.id === c.guild.id || needles.has(inv.guild.name.toLowerCase()))) return `${ch.name} → discord.gg/${inv.code}`;
    }
    const msgs = 'messages' in ch ? await (ch as unknown as import('discord.js').TextChannel).messages.fetch({ limit: 25 }).catch(() => null) : null;
    for (const m of msgs?.values() ?? []) if (needles.has(m.content.toLowerCase())) return `lien posé dans #${ch.name}`;
  }
  return null;
}

async function unbind(c: Ctx, userId: string): Promise<void> {
  const m = await c.guild.members.fetch(userId).catch(() => null);
  if (!m) return;
  const id = c.s.roleId('partenaire');
  if (id && m.roles.cache.has(id)) await m.roles.remove(id, 'Edge : partenariat terminé').catch(() => void 0);
}
async function say2(c: Ctx, text: string): Promise<void> {
  try { await mustText(c, 'ticketLogs').send({ content: text.slice(0, 1990), allowedMentions: { parse: ['users'] } }); } catch { void 0; }
}
