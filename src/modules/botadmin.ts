/** Le bot sur lui-meme : flags a chaud, sante, stats, invite, re-sync des panneaux. */
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { MODULES } from './index.js';
import { driftReport, resolveStructure } from '../core/structure.js';
import { BOT_PERMISSIONS, EDGE_ROLE_NAME, GUILD_ID, channelDef } from '../manifest.js';
import { bits } from '../core/perms.js';
import { inviteUrl } from '../core/client.js';
import { at, fmtDur } from '../core/ui.js';
import { ensurePanel } from '../core/panels.js';
import { fr } from '../core/copy.js';

export const botadmin: EdgeModule = {
  key: 'botadmin',
  label: 'Admin du bot',
  needs: { roles: ['admin'] },
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('edge')
        .setDescription('Piloter Edge (couper un module, voir la santé, resynchroniser)')
        .addSubcommand((s) => s.setName('module').setDescription('Activer / couper un module')
          .addStringOption((o) => o.setName('nom').setDescription('Lequel').setRequired(true).addChoices(...MODULES.map((m) => ({ name: m.label.slice(0, 100), value: m.key }))))
          .addStringOption((o) => o.setName('action').setDescription('Que faire').addChoices({ name: 'couper', value: 'off' }, { name: ' rallumer'.trim(), value: 'on' }, { name: 'état', value: 'etat' })))
        .addSubcommand((s) => s.setName('flag').setDescription('Lire / poser une option fine (rules.gate, antiraid.auto, log.tickets…)')
          .addStringOption((o) => o.setName('cle').setDescription('Nom exact du flag').setRequired(true))
          .addStringOption((o) => o.setName('valeur').setDescription('vrai / faux').addChoices({ name: 'vrai', value: 'true' }, { name: 'faux', value: 'false' })))
        .addSubcommand((s) => s.setName('sante').setDescription('Intents, permissions, BDD, ordonnanceur, structure'))
        .addSubcommand((s) => s.setName('structure').setDescription('Re-resoudre les noms et comparer au manifeste (apres un renommage)'))
        .addSubcommand((s) => s.setName('panneaux').setDescription('Re-publier les panneaux persistants'))
        .addSubcommand((s) => s.setName('stats').setDescription('Ce que le bot a fait, par module'))
        .addSubcommand((s) => s.setName('invite').setDescription('Le lien d’invitation avec les permissions exactes'))
        .addSubcommand((s) => s.setName('maintenance').setDescription('Couper toute ecriture du bot (reponses incluses)')
          .addStringOption((o) => o.setName('action').setDescription('On ou off').setRequired(true).addChoices({ name: 'activer', value: 'on' }, { name: 'couper', value: 'off' }))) as never,
      guard: { min: 'admin' },
      run: async (c: Ctx, i) => {
        const sub = i.options.getSubcommand();

        if (sub === 'module') {
          const key = i.options.getString('nom', true);
          const action = i.options.getString('action') ?? 'etat';
          if (action === 'etat') {
            const on = await c.db.flags.isOn(`module:${key}`, true);
            return void (await i.editReply({ content: `**${key}** : ${on ? '✅ activé' : '🔕 coupé'}${c.disabled.has(key) ? ` · désactivé d’office : ${c.disabled.get(key)}` : ''}` }));
          }
          await c.db.flags.set(`module:${key}`, action === 'on');
          await i.editReply({ content: action === 'on' ? `✅ \`${key}\` rallumé. Les listeners sont montés au prochain redémarrage ; les commandes, elles, répondent tout de suite.` : `🔕 \`${key}\` coupé : ses commandes répondent « module désactivé », ses salons ne reçoivent plus rien.` });
          if (action === 'on') await c.guild.commands.set(await rebuild(c)).catch(() => void 0);
          return;
        }

        if (sub === 'flag') {
          const key = i.options.getString('cle', true);
          const val = i.options.getString('valeur');
          if (val !== null) await c.db.flags.set(key, val === 'true');
          const now = await c.db.flags.isOn(key, false);
          return void (await i.editReply({ content: `🚩 \`${key}\` = ${now ? 'vrai' : 'faux'}${val !== null ? ' — enregistré' : ''}` }));
        }

        if (sub === 'structure') {
          const s2 = resolveStructure(c.guild);
          const d = driftReport(s2);
          c.s.roles = s2.roles; c.s.channels = s2.channels; c.s.categories = s2.categories;
          const bad = d.filter((x) => x.level !== 'info');
          return void (await i.editReply({ content: bad.length ? bad.slice(0, 15).map((x) => `[${x.level}] ${x.what}`).join('\n').slice(0, 1900) : '✅ Structure conforme au manifeste.' }));
        }

        if (sub === 'panneaux') {
          const done: string[] = [];
          for (const m of MODULES) {
            if (!m.panels || c.disabled.has(m.key)) continue;
            try { await m.panels(c); done.push(m.key); } catch (e) { done.push(`${m.key} ✗ ${(e as Error).message.slice(0, 40)}`); }
          }
          return void (await i.editReply({ content: `🧰 panneaux re-synchronisés : ${done.join(', ') || 'aucun'}` }));
        }

        if (sub === 'sante') {
          const bits0 = c.guild.members.me?.permissions.bitfield ?? 0n;
          const lacking = BOT_PERMISSIONS.filter((p) => (bits([p]) & bits0) !== bits([p]));
          const dbOk = await c.db.ping();
          const jobs = await c.db.all('scheduler_jobs', { where: { status: 'pending' } });
          const failed = await c.db.all('scheduler_jobs', { where: { status: 'failed' } });
          return void (await i.editReply({ content: [
            `🩺 **Santé d’Edge** · guilde \`${GUILD_ID}\``,
            `· session : ${at(new Date())} · uptime ${fmtDur(process.uptime() * 1000)}`,
            `· intents texte : ${c.content ? '✅ MessageContent (automod + XP actifs)' : '⚠️ MessageContent absent → automod/XP coupés (normal si tu ne l’as pas validé dans le Developer Portal)'}`,
            `· permissions : ${lacking.length ? `❌ manquent ${lacking.join(', ')}` : '✅ toutes celles attendues'}`,
            `· rôle « ${EDGE_ROLE_NAME} » position ${(c.guild.members.me?.roles.highest.position ?? '?')} / ${c.guild.roles.highest.position} (le plus haut du serveur)`,
            `· BDD : ${dbOk ? (c.db.isPersisted ? `✅ ${c.db.libelle} connecté` : '🟡 mémoire (non durable)') : `❌ ${c.db.libelle} injoignable — la partie stockage est coupée`}`,
            `· ordonnanceur : ${jobs.length} job(s) en attente${failed.length ? `, ${failed.length} en échec` : ''}`,
            `· modules : ${MODULES.length - c.disabled.size}/${MODULES.length} actifs${c.disabled.size ? ` — coupés : ${[...c.disabled.keys()].join(', ')}` : ''}`,
          ].join('\n') }));
        }

        if (sub === 'stats') {
          const rows = await c.db.all('bot_events', { where: {}, orderBy: 'id', desc: true, limit: 400 });
          const byKind = new Map<string, number>();
          for (const r of rows) byKind.set(String(r.kind), (byKind.get(String(r.kind)) ?? 0) + 1);
          const top = [...byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
          return void (await i.editReply({ content: top.length ? `📊 ${rows.length} évènement(s) récents\n${top.map(([k, n]) => `· ${k} : ${n}`).join('\n')}` : '📊 Rien d’enregistré pour l’instant.' }));
        }

        if (sub === 'invite') {
          return void (await i.editReply({ content: `🔗 Ajoute/replace Edge avec exactement ses droits :\n${inviteUrl(c.client.application.id)}\n\n⚠️ Ne donne pas « Administrateur » : la liste ci-dessus est granulaire et suffisante.\nPlace son rôle sous ${channelDef('annonces') ? '⚔️│ Modérateur' : ''} et au-dessus de 💼│ Manager Partenariat.` }));
        }

        const on = i.options.getString('action', true) === 'on';
        await c.db.flags.set('bot.maintenance', on);
        c.log.warn(`maintenance ${on ? 'activée' : 'levée'} par ${i.user.username}`);
        return void (await i.editReply({ content: on ? '🔧 Maintenance activée : Edge ne publie plus rien (sauf ses réponses éphémères).' : '✅ Maintenance levée.' }));
      },
    },
  ],
};

async function rebuild(c: Ctx): Promise<never[]> {
  const { buildDispatch, syncCommands } = await import('../core/dispatch.js');
  const d = buildDispatch(c, MODULES.filter((m) => !c.disabled.has(m.key)));
  await syncCommands(c, d);
  return [];
}
