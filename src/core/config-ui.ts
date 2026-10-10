/**
 * L'interface de personnalisation d'Edge : `/edge config`, son tableau de bord cliquable, et la
 * bascule on/off d'un module. Le code est ici plutôt que dans le module d'admin pour une raison :
 * botadmin doit rester une coquille vide qui se contente de déclarer la slash command.
 *
 * Trois principes :
 *  - on ne présente que ce qui est déclaré par les modules (`reglages`), donc la liste ne ment
 *    jamais sur ce qui est personnalisable ;
 *  - couper un module retire aussi ses slash commands (`resyncCommandes`), et rien n'est supprimé
 *    en base : rallumer restore les réglages et les données ;
 *  - toutes ces vues sont éphémères (elles suivent la visibilité de la commande qui les appelle).
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags,
  PermissionFlagsBits, StringSelectMenuBuilder, type ChatInputCommandInteraction,
  type EmbedBuilder, type MessageActionRowComponentBuilder, type MessageComponentInteraction, type StringSelectMenuInteraction,
} from 'discord.js';
import { MODULES } from '../modules/index.js';
import { buildDispatch, syncCommands } from './dispatch.js';
import { customId, type Ctx, type ComponentHandler, type EdgeModule } from './module.js';
import { formater, type SettingDef } from './settings.js';
import { embed } from './send.js';

/** Le module général, qui n'a pas de fichier : son nom dans les commandes et les vues. */
export const MODULE_GENERAL = 'general';
export const LABEL_GENERAL = '🎛️ Général (style & journaux)';

type Choix = { name: string; value: string };

/** general + les 23 modules — Discord plafonne un `addChoices` à 25 entrées, on est à 24. */
const choixModules = (modules: readonly EdgeModule[]): Choix[] => (
  [{ name: LABEL_GENERAL, value: MODULE_GENERAL } as Choix]
    .concat(modules.map((m) => ({ name: m.label.slice(0, 95), value: m.key })))
);

const labelDe = (modules: readonly EdgeModule[], key: string): string =>
  (key === MODULE_GENERAL ? LABEL_GENERAL : modules.find((m) => m.key === key)?.label ?? key).replace(/^🎛️ /, '');

/** Un module est actif s'il n'est pas en défaut structurel et si son flag est allumé. */
export async function modulesActifs(c: Ctx, modules: readonly EdgeModule[] = MODULES): Promise<EdgeModule[]> {
  const garde: EdgeModule[] = [];
  for (const m of modules) if (await c.on(m.key)) garde.push(m);
  return garde;
}

/**
 * Redéclare les slash commands d'après les modules actifs. C'est ce qui fait qu'« enlever un
 * module » se voit vraiment dans le `/` de Discord — et qu'il revient sans redémarrage.
 */
export async function resyncCommandes(c: Ctx, modules: readonly EdgeModule[] = MODULES): Promise<void> {
  const d = buildDispatch(c, await modulesActifs(c, modules));
  await syncCommands(c, d);
}

/* ------------------------------------------------------------------ validation des cibles */

/**
 * Un réglage de type salon/rôle pointe un ID : on vérifie qu'il existe et qu'Edge peut y écrire,
 * parce qu'un réglage muet est la meilleure recette pour un bot qui « ne répond plus ».
 */
export async function verifierCible(c: Ctx, def: SettingDef, valeur: unknown): Promise<string | null> {
  const id = String(valeur ?? '');
  if (!/^\d{15,21}$/.test(id)) return null;
  const moi = c.guild.members.me;
  if (def.type === 'salon') {
    const ch = await c.guild.channels.fetch(id).catch(() => null);
    if (!ch) return '⚠️ Salon introuvable, ou Edge n’y a pas accès. Il retombera sur son salon par défaut.';
    if (ch.type !== ChannelType.GuildText) return `⚠️ <#${ch.id}> n’est pas un salon texte : les messages resteront là où Edge peut écrire.`;
    const p = moi ? ch.permissionsFor(moi) : null;
    const manque = [
      !p?.has(PermissionFlagsBits.ViewChannel) && 'Voir le salon',
      !p?.has(PermissionFlagsBits.SendMessages) && 'Envoyer des messages',
    ].filter(Boolean) as string[];
    if (manque.length) {
      return `⚠️ Edge n’a pas **${manque.join(' + ')}** dans <#${ch.id}>. Autorise ces droits (rôle Edge, ou la commande /edge structure pour vérifier la hiérarchie), sinon rien n’y apparaîtra.`;
    }
    return `📣 C’est réglé : les messages partiront dans <#${ch.id}>.`;
  }
  if (def.type === 'role') {
    const r = c.guild.roles.cache.get(id) ?? await c.guild.roles.fetch(id).catch(() => null);
    return r ? `🏷️ Rôle **${r.name}** trouvé.` : '⚠️ Rôle introuvable : Edge ignorera ce réglage.';
  }
  return null;
}

/* ------------------------------------------------------------------ les vues */

type Rangee = ActionRowBuilder<MessageActionRowComponentBuilder>;
interface Vue { embeds: EmbedBuilder[]; components: Rangee[] }

function selecteur(modules: readonly EdgeModule[], valeur?: string): Rangee[] {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId('botadmin', 'config-module'))
    .setPlaceholder('Changer de module…')
    .addOptions(choixModules(modules).map((o) => ({ label: o.name, value: o.value, default: o.value === valeur })));
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(menu as never)];
}

/** Une ligne par réglage déclaré : valeur courante, ce que ça change, la commande pour le changer. */
export async function vueModule(c: Ctx, modules: readonly EdgeModule[], module: string, tout = false): Promise<Vue> {
  const tous = c.cfg.defs(module);
  const defs = tout ? tous : tous.filter((d) => !d.avance);
  const etat = await c.cfg.tout(module);
  const on = module === MODULE_GENERAL ? true : await c.db.flags.isOn(`module:${module}`, true);

  const champs = defs.map((def) => {
    const e = etat[def.cle];
    const perso = !!e && !e.parDefaut;
    const cible = typeof e?.valeur === 'string' && /^<#\d{15,21}>$/.test(e.valeur) ? e.valeur : null;
    return {
      name: `${perso ? '🔧' : '▫️'} ${def.label} · \`${def.cle}\``,
      value: [
        `**${cible ?? formater(def, e?.valeur)}**${perso ? '' : ' *(défaut)*'}`,
        def.aide ? `_${def.aide}_` : '',
        `\`/edge config regler ${module} ${def.cle} <valeur>\``,
      ].filter(Boolean).join('\n'),
    };
  });

  const boutons = new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(
    ...(module === MODULE_GENERAL ? [] : [
      new ButtonBuilder()
        .setCustomId(customId('botadmin', on ? 'config-off' : 'config-on', module))
        .setStyle(on ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setEmoji(on ? '🔕' : '✅')
        .setLabel(on ? 'Couper ce module' : 'Rallumer ce module'),
      new ButtonBuilder()
        .setCustomId(customId('botadmin', 'config-reset', module))
        .setStyle(ButtonStyle.Secondary).setEmoji('🧹').setLabel('Réinitialiser ses réglages'),
    ]),
    new ButtonBuilder()
      .setCustomId(customId('botadmin', 'config-export', module))
      .setStyle(ButtonStyle.Secondary).setEmoji('📤').setLabel('Exporter'),
    new ButtonBuilder()
      .setCustomId(customId('botadmin', tout ? 'config-simple' : 'config-tout', module))
      .setStyle(ButtonStyle.Secondary).setEmoji(tout ? '🙈' : '🔍')
      .setLabel(tout ? 'Cacher les avancés' : `Voir les avancés${tous.length - defs.length ? ` (${tous.length - defs.length})` : ''}`),
    new ButtonBuilder()
      .setCustomId(customId('botadmin', 'config-retour'))
      .setStyle(ButtonStyle.Secondary).setEmoji('⬅️').setLabel('Tous les modules'),
  );

  const desc = [
    module === MODULE_GENERAL
      ? 'Le style et les journaux du bot. Ce que tu règles ici s’applique aux modules existants **et** à ceux viendront, sans les toucher.'
      : `Le module lit ses réglages à chaud (20 secondes max). ${on ? '✅ Activé' : '🔕 Coupé : ses commandes sont retirées du serveur, ses réglages sont conservés.'}`,
    defs.length ? '' : 'Aucun réglage exposé pour ce module : son comportement suit le manifeste.',
    !tout && tous.length > defs.length ? `_${tous.length - defs.length} réglage(s) avancé(s) masqué(s)._` : '',
  ].filter(Boolean).join('\n');

  return {
    embeds: [embed({ title: `⚙️ ${labelDe(modules, module)}`, desc, fields: champs, footer: '/edge config · rien n’est gravé dans le code' })],
    components: [boutons as never, ...selecteur(modules, module)],
  };
}

/** Le menu principal : un coup d'œil sur les 24 groupes, leur état, et ce qui a été personnalisé. */
export async function vueTableau(c: Ctx, modules: readonly EdgeModule[], tout = false): Promise<Vue> {
  const lignes: { name: string; value: string; inline: boolean }[] = [];
  for (const m of [{ key: MODULE_GENERAL, label: LABEL_GENERAL }, ...modules]) {
    const defs = c.cfg.defs(m.key);
    const on = m.key === MODULE_GENERAL ? true : await c.db.flags.isOn(`module:${m.key}`, true);
    let perso = 0;
    for (const def of defs) {
      if (JSON.stringify(await c.cfg.valeur(m.key, def.cle)) !== JSON.stringify(def.defaut)) perso++;
    }
    lignes.push({
      name: `${on ? '✅' : '🔕'} ${m.label}`.slice(0, 250),
      value: defs.length ? `${defs.length} réglage(s)${perso ? ` · ${perso} perso` : ''}` : '—',
      inline: true,
    });
  }
  return {
    embeds: [embed({
      title: '🎛️ Personnaliser Edge',
      desc: [
        'Choisis un module dans le menu : tu verras tout ce qui s’y change, et tu pourras le couper, le réinitialiser ou l’exporter sans retaper une commande.',
        'Rien n’efface tes données : couper un module retire ses slash commands et ses messages, pas les tickets ni les niveaux déjà écrits.',
        'Les options fines qui ne sont pas là se touchent quand même : `/edge flag <clé> <vrai|faux>`.',
      ].join('\n'),
      fields: lignes.slice(0, 25),
    })],
    components: selecteur(modules) as never,
  };
}

/* ------------------------------------------------------------------ /edge config */

/** Toute la logique de la sous-commande, pour que botadmin reste déclaratif. */
export async function configCommande(c: Ctx, i: ChatInputCommandInteraction, modules: readonly EdgeModule[] = MODULES): Promise<void> {
  const action = i.options.getString('action', true);
  const module = i.options.getString('module') ?? '';
  const cle = i.options.getString('cle');
  const valeur = i.options.getString('valeur');
  const tout = i.options.getBoolean('tout') ?? false;

  if (action === 'tableau' || (action === 'voir' && !module)) {
    await i.editReply(module ? await vueModule(c, modules, module, tout) : await vueTableau(c, modules, tout));
    return;
  }
  if (!module) {
    await i.editReply({ content: 'Dis-moi sur quel module : `/edge config voir welcome`, `/edge config regler tickets message "<texte>"`.' });
    return;
  }
  if (action === 'voir') { await i.editReply(await vueModule(c, modules, module, tout)); return; }

  if (action === 'regler') {
    if (!cle || valeur === null) { await i.editReply({ content: 'Il me faut la clé et la valeur : `/edge config regler <module> <clé> <valeur>`.' }); return; }
    const r = await c.cfg.regler(module, cle, valeur);
    if (!r.ok) { await i.editReply({ content: `🚫 ${r.raison}\n\nLes réglages de \`${module}\` : \`${c.cfg.defs(module).map((d) => d.cle).join('`, `')}\`.` }); return; }
    const avis = await verifierCible(c, r.def, r.valeur);
    await i.editReply({
      embeds: [embed({
        title: `✅ ${module} · ${r.def.cle}`,
        desc: `\`\`\`${formater(r.def, r.valeur).replace(/^```/g, '')}\`\`\`${avis ? `\n${avis}` : ''}`,
        color: 0x57f287,
        footer: r.def.base === 'flags' ? 'C’est le flag historique, donc /edge flag voit la même valeur.' : undefined,
      })],
    });
    return;
  }

  if (action === 'oublier') {
    if (!cle) { await i.editReply({ content: 'Il me faut la clé à oublier.' }); return; }
    const ok = await c.cfg.oublier(module, cle);
    await i.editReply({ content: ok ? `↩️ \`${module}.${cle}\` est revenu à son défaut.` : `🚫 pas de réglage \`${cle}\` côté \`${module}\`.` });
    return;
  }

  if (action === 'reinitialiser') {
    const n = await c.cfg.reinitialiser(module);
    await i.editReply({ content: n ? `♻️ ${n} réglage(s) de \`${module}\` remis à zéro. Les données du module (tickets, niveaux, sanctions) ne sont pas touchées.` : `\`${module}\` n’avait rien de personnalisé.` });
    return;
  }

  if (action === 'exporter') {
    await i.editReply({ content: await exporter(c, module) });
    return;
  }

  if (action === 'importer') {
    if (valeur === null) { await i.editReply({ content: 'Colle le JSON dans l’option « valeur » : `/edge config importer welcome <json>`.' }); return; }
    let objet: Record<string, unknown>;
    try {
      objet = JSON.parse(valeur.replace(/```/g, '').trim());
    } catch {
      await i.editReply({ content: '🚫 JSON illisible — recopie la sortie de `/edge config exporter`.' });
      return;
    }
    const r = await c.cfg.importer(module, objet);
    const refus = r.refuses.length ? `\n🚫 refusé : ${r.refuses.map(([k, w]) => `\`${k}\` — ${w}`).join('\n')}` : '';
    await i.editReply({ content: `${r.poses.length ? `✅ importé : ${r.poses.map((k) => `\`${k}\``).join(', ')}` : 'Rien à importer.'}${refus}` });
    return;
  }

  await i.editReply({ content: 'Action inconnue — les réponses valides sont dans le menu de la commande.' });
}

/** Le JSON d'un module, prêt à recoller sur un autre serveur. */
export async function exporter(c: Ctx, module: string): Promise<string> {
  const brut = await c.cfg.exporter(module);
  const avecDefs = Object.keys(brut).length === 0
    ? Object.fromEntries(c.cfg.defs(module).map((d) => [d.cle, d.defaut]))
    : brut;
  const json = JSON.stringify(avecDefs, null, 2).replace(/```/g, '');
  return `📤 \`${module}\` — recolle ça sur l’autre serveur avec \`/edge config importer ${module} <json>\` :\n\`\`\`json\n${json.slice(0, 1600)}\n\`\`\``;
}

/** Les composants du tableau de bord, montés dans botadmin (donc réservés au staff). */
export function configComposants(c: Ctx, modules: readonly EdgeModule[] = MODULES): Record<string, ComponentHandler> {
  const maj = async (i: MessageComponentInteraction, vue: Vue, content?: string): Promise<void> => {
    await i.update({ ...vue, ...(content ? { content } : {}), allowedMentions: { parse: [] } } as never);
  };
  return {
    'config-module': async (_c, i: StringSelectMenuInteraction) => {
      const module = i.values[0];
      if (!module) return;
      await maj(i, await vueModule(c, modules, module, false));
    },
    'config-tout': async (_c, i: MessageComponentInteraction, a) => void (await maj(i, await vueModule(c, modules, a[0]!, true))),
    'config-simple': async (_c, i: MessageComponentInteraction, a) => void (await maj(i, await vueModule(c, modules, a[0]!, false))),
    'config-retour': async (_c, i: MessageComponentInteraction) => void (await maj(i, await vueTableau(c, modules))),
    'config-reset': async (_c, i: MessageComponentInteraction, a) => {
      const n = await c.cfg.reinitialiser(a[0]!);
      await maj(i, await vueModule(c, modules, a[0]!, false), n ? `♻️ ${n} réglage(s) remis à zéro.` : 'Rien à remettre à zéro.');
    },
    'config-export': async (_c, i: MessageComponentInteraction, a) => {
      await i.update({ content: await exporter(c, a[0]!), flags: MessageFlags.Ephemeral } as never);
    },
    'config-on': async (_c, i: MessageComponentInteraction, a) => void (await basculer(c, modules, i, a[0]!, true)),
    'config-off': async (_c, i: MessageComponentInteraction, a) => void (await basculer(c, modules, i, a[0]!, false)),
  };
}

/** Couper / rallumer depuis le tableau de bord : même chemin que `/edge module`, y compris la resync. */
async function basculer(c: Ctx, modules: readonly EdgeModule[], i: MessageComponentInteraction, module: string, on: boolean): Promise<void> {
  await c.db.flags.set(`module:${module}`, on);
  await resyncCommandes(c, modules);
  c.cfg.invalider(module);
  const note = on
    ? `✅ \`${module}\` rallumé : ses slash commands sont de retour. Ses listeners et jobs sont remontés si le bot redémarre — les salons et les réglages, eux, sont déjà là.`
    : `🔕 \`${module}\` coupé : plus de slash command, plus de message. Ses réglages et ses données restent en base, prêts à resservir.`;
  await maj2(c, modules, i, module, note);
  c.log.info(`module ${module} ${on ? 'activé' : 'désactivé'} depuis le tableau de bord par ${i.user.username}`);
}

async function maj2(c: Ctx, modules: readonly EdgeModule[], i: MessageComponentInteraction, module: string, content: string): Promise<void> {
  await i.update({ ...(await vueModule(c, modules, module, false)), content, allowedMentions: { parse: [] } } as never);
}
