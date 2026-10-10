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
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ModalBuilder, MessageFlags, SlashCommandBuilder,
  PermissionFlagsBits, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type EmbedBuilder, type GuildMember,
  type MessageActionRowComponentBuilder, type MessageComponentInteraction, type StringSelectMenuInteraction,
  type ChannelSelectMenuInteraction, type RoleSelectMenuInteraction,
} from 'discord.js';
import { buildDispatch, syncCommands } from './dispatch.js';
import { atLeast } from './perms.js';
import { customId, type Ctx, type ComponentHandler, type EdgeModule } from './module.js';
import { formater, type SettingDef } from './settings.js';
import { decouperOption, valeurOption } from './ui.js';
import { embed } from './send.js';

/**
 * `/config` : la seule chose a retenir. Une commande, zero option, zero sous-commande — le tableau
 * de bord s'ouvre et tout le reste se choisit dans les menus. `/edge config` garde les memes vues
 * plus les voies clavier (regler a la ligne, exporter, importer) : utile pour coller un texte de
 * 1800 caracteres depuis un fichier, et rien d'autre.
 */
export function commandeConfig(): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setName('config')
    .setDescription('Régler Edge : choisis un module, puis un réglage. Tout se clique.');
}

/** Le module général, qui n'a pas de fichier : son nom dans les commandes et les vues. */
export const MODULE_GENERAL = 'general';
export const LABEL_GENERAL = '🎛️ Général (style & journaux)';

type Choix = { name: string; value: string };

/** general + les 23 modules — Discord plafonne un `addChoices` à 25 entrées, on est à 24. */
export const choixModules = (modules: readonly EdgeModule[]): Choix[] => (
  [{ name: LABEL_GENERAL, value: MODULE_GENERAL } as Choix]
    .concat(modules.map((m) => ({ name: m.label.slice(0, 95), value: m.key })))
);

const labelDe = (modules: readonly EdgeModule[], key: string): string =>
  (key === MODULE_GENERAL ? LABEL_GENERAL : modules.find((m) => m.key === key)?.label ?? key).replace(/^🎛️ /, '');

/** Un module est actif s'il n'est pas en défaut structurel et si son flag est allumé. */
export async function modulesActifs(c: Ctx, modules: readonly EdgeModule[]): Promise<EdgeModule[]> {
  const garde: EdgeModule[] = [];
  for (const m of modules) if (await c.on(m.key)) garde.push(m);
  return garde;
}

/**
 * Redéclare les slash commands d'après les modules actifs. C'est ce qui fait qu'« enlever un
 * module » se voit vraiment dans le `/` de Discord — et qu'il revient sans redémarrage.
 */
export async function resyncCommandes(c: Ctx, modules: readonly EdgeModule[]): Promise<void> {
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
    .setPlaceholder('1️⃣  Choisis le module à régler')
    .addOptions(choixModules(modules).map((o) => ({ label: o.name, value: valeurOption(o.value), default: o.value === valeur })));
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
    return {
      name: `${perso ? '🔧' : '▫️'} ${def.label}`,
      value: [
        `**${formater(def, e?.valeur)}**${perso ? '' : ' *(réglage d’usine)*'}`,
        def.aide ? `_${def.aide}_` : '',
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
      ? 'Le style et les journaux du bot : ce que tu règles ici vaut pour les 23 modules, sans les toucher.'
      : `Ses réglages sont lus à chaud (20 secondes max). ${on ? '✅ Activé' : '🔕 Coupé : ses commandes sont retirées du serveur, ses réglages sont conservés.'}`,
    defs.length
      ? '**2️⃣ Choisis le réglage dans le menu en bas de ce message** — Edge ouvre la bonne fenêtre : zone de texte pré-remplie, liste des salons du serveur, ou deux boutons oui/non.'
      : 'Aucun réglage exposé pour ce module : son comportement suit le manifeste.',
    !tout && tous.length > defs.length ? `_${tous.length - defs.length} réglage(s) avancé(s) masqué(s)._` : '',
  ].filter(Boolean).join('\n');

  const reglages = defs.length
    ? [new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId('botadmin', 'config-cle'))
        .setPlaceholder('2️⃣  Choisis le réglage à changer')
        .addOptions(defs.map((def) => ({
          label: def.label.slice(0, 95),
          // separateur « . » et pas « : » : Discord n'accepte que [a-z0-9._-] dans une
          // value d'option, et un menu mal forme fait echouer tout le message.
          value: valeurOption(`${module}.${def.cle}`),
          // jamis vide : discord.js rejette l'objet entier si une description est vide,
          // et un reglage laise au vide (mp_texte, pied_de_page) en produit une.
          description: (`${formater(def, etat[def.cle]?.valeur)}${def.avance ? ' · avancé' : ''}` || '—').slice(0, 95) || '—',
        })),
    ) as never)]
    : [];
  return {
    embeds: [embed({ title: `⚙️ ${labelDe(modules, module)}`, desc, fields: champs, footer: '/config · choisis 2 dans le menu en bas, rien n’est gravé dans le code' })],
    components: [boutons as never, ...reglages, ...selecteur(modules, module)],
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
        '**1️⃣ Choisis un module ci-dessous · 2️⃣ choisis le réglage · 3️⃣ Edge ouvre la bonne fenêtre.** Rien à taper, rien à retenir.',
        '🔕 couper un module retire ses commandes du serveur sans rien effacer · 🧹 remettre à zéro · 📤 exporter pour rejouer les mêmes réglages ailleurs.',
        'Une option fine absente de la liste se règle avec `/edge flag <clé> <vrai|faux>`.',
      ].join('\n'),
      fields: lignes.slice(0, 25),
    })],
    components: selecteur(modules) as never,
  };
}

/* ------------------------------------------------------------------ /edge config */

/** Toute la logique de la sous-commande, pour que botadmin reste déclaratif. */
export async function configCommande(c: Ctx, i: ChatInputCommandInteraction, modules: readonly EdgeModule[]): Promise<void> {
  const module = i.options.getString('module') ?? '';
  // Aucune option obligatoire : `/edge config` seul ouvre le tableau, `/edge config tickets`
  // ouvre le module. Les gens ne retiennent pas les syntaxes, ils retiennent les menus.
  const action = i.options.getString('action') ?? (module ? 'voir' : 'tableau');
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

/** administrateur+ ou fondateur : le modele du manifeste, pas une permission brute. */
export function habilitation(c: Ctx, i: MessageComponentInteraction | (MessageComponentInteraction & { member?: unknown })): boolean {
  const m = i.member as GuildMember | null;
  return !!m && atLeast(m, 'admin', c.s.idx);
}

/** Les composants du tableau de bord, montés dans botadmin — verrouillés à l'usage. */
export function configComposants(c: Ctx, modules: readonly EdgeModule[]): Record<string, ComponentHandler> {
  const nus = composantsNus(c, modules);
  const verrouille: Record<string, ComponentHandler> = {};
  for (const [nom, h] of Object.entries(nus)) {
    verrouille[nom] = async (ctx2, i, args) => {
      if (!habilitation(c, i)) {
        await i.reply({
          content: '🔒 Seuls **🛡️│ Administrateur** et le fondateur règlent Edge. Ce que tu peux changer toi, membre, se fait sur le serveur (rôles, tickets, signalements).',
          flags: MessageFlags.Ephemeral,
        } as never);
        return;
      }
      await h(ctx2, i, args);
    };
  }
  return verrouille;
}

function composantsNus(c: Ctx, modules: readonly EdgeModule[]): Record<string, ComponentHandler> {
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

    // Le clic sur « ✏️ un réglage » : on n'ouvre pas une zone de texte à l'aveugle, on ouvre le
    // bon controle selon le type. C'est la difference entre « configurable » et « intuitif ».
    'config-cle': async (_c, i: StringSelectMenuInteraction) => {
      const [module, cle] = decouperOption(i.values[0] ?? '');
      if (!module || !cle) return;
      const def = c.cfg.def(module, cle);
      if (!def) return void (await i.reply({ content: 'Réglage introuvable (module renommé ?).', flags: MessageFlags.Ephemeral }));
      if (def.type === 'booleen') return void (await i.update(await vueEditeur(c, modules, def, 'bascule') as never));
      if (def.type === 'salon' || def.type === 'role' || def.type === 'choix') {
        return void (await i.update(await vueEditeur(c, modules, def, 'liste') as never));
      }
      const modal = new ModalBuilder()
        .setCustomId(customId('botadmin', 'config-modal', module, cle))
        .setTitle(def.label.slice(0, 45));
      const champ = new TextInputBuilder()
        .setCustomId('valeur')
        .setLabel(def.label.slice(0, 45))
        .setStyle(def.type === 'texte' || def.type === 'liste' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setPlaceholder((def.aide ?? 'nouvelle valeur').slice(0, 100))
        .setRequired(true);
      const taille = def.type === 'texte' ? Math.min(4000, def.maxLen ?? 1800) : Math.min(4000, Math.max(60, def.maxLen ?? 200));
      champ.setMaxLength(taille);
      const courant = String((await c.cfg.valeur(module, cle)) ?? '');
      if (courant && courant.length <= taille) champ.setValue(courant);
      modal.addComponents(new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(champ as never) as never);
      await i.showModal(modal as never);
    },
    'config-modal': async (_c, i) => {
      if (!i.isModalSubmit()) return;
      // customId = edge:botadmin:config-modal:<module>:<cle> — les deux premiers morceaux sont
      // le prefixe et le module proprietaire, ce qui nous interesse commence au troisieme.
      const [, , , module, cle] = i.customId.split(':');
      if (!module || !cle) return void (await i.reply({ content: '🚫 modale périmée : rouvre le réglage depuis ⚙️.', flags: MessageFlags.Ephemeral }));
      await appliquer(c, modules, i, module, cle, i.fields.getTextInputValue('valeur'));
    },
    'config-bool': async (_c, i: MessageComponentInteraction, a) => {
      await appliquer(c, modules, i, a[0]!, a[1]!, a[2] === '1' ? 'oui' : 'non');
    },
    'config-salon': async (_c, i: ChannelSelectMenuInteraction, a) => {
      await appliquer(c, modules, i, a[0]!, a[1]!, i.values[0] ?? '');
    },
    'config-role': async (_c, i: RoleSelectMenuInteraction, a) => {
      await appliquer(c, modules, i, a[0]!, a[1]!, i.values[0] ?? '');
    },
    'config-choix': async (_c, i: StringSelectMenuInteraction, a) => {
      await appliquer(c, modules, i, a[0]!, a[1]!, i.values[0] ?? '');
    },
    'config-cle-defaut': async (_c, i: MessageComponentInteraction, a) => {
      const [module, cle] = a;
      const ok = await c.cfg.oublier(module!, cle!);
      await i.update({ ...(await vueModule(c, modules, module!, false)), content: ok ? `↩️ \`${cle}\` est revenu à son défaut.` : '🚫 rien à oublier.', flags: MessageFlags.Ephemeral } as never);
    },
    'config-cle-retour': async (_c, i: MessageComponentInteraction, a) => {
      await i.update({ ...(await vueModule(c, modules, a[0]!, false)), flags: MessageFlags.Ephemeral } as never);
    },
  };
}

/** L'ecran d'un seul reglage : valeur courante, ce que ca change, et le controle qui va bien. */
async function vueEditeur(c: Ctx, modules: readonly EdgeModule[], def: SettingDef, genre: 'bascule' | 'liste'): Promise<Vue> {
  const courant = await c.cfg.valeur(def.module, def.cle);
  const champs = [
    { name: 'Valeur actuelle', value: `**${formater(def, courant)}**${JSON.stringify(courant) === JSON.stringify(def.defaut) ? ' *(défaut)*' : ''}` },
    { name: 'Ce que ça change', value: def.aide ?? '—' },
    { name: 'Format accepté', value: formatAttendu(def) },
  ];
  const rangee: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (genre === 'bascule') {
    rangee.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(
      new ButtonBuilder().setCustomId(customId('botadmin', 'config-bool', def.module, def.cle, '1')).setStyle(ButtonStyle.Success).setEmoji('✅').setLabel('Oui'),
      new ButtonBuilder().setCustomId(customId('botadmin', 'config-bool', def.module, def.cle, '0')).setStyle(ButtonStyle.Secondary).setEmoji('🚫').setLabel('Non'),
    ) as never);
  } else if (def.type === 'salon') {
    rangee.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(customId('botadmin', 'config-salon', def.module, def.cle))
        .setPlaceholder('Choisir le salon…')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1).setMaxValues(1),
    ) as never);
  } else if (def.type === 'role') {
    rangee.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(customId('botadmin', 'config-role', def.module, def.cle))
        .setPlaceholder('Choisir le rôle…')
        .setMinValues(1).setMaxValues(1),
    ) as never);
  } else if (def.type === 'choix') {
    rangee.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId('botadmin', 'config-choix', def.module, def.cle))
        .setPlaceholder('Choisir une option…')
        .addOptions((def.choix ?? []).map((x) => ({ label: x.nom.slice(0, 90), value: valeurOption(x.valeur) }))),
    ) as never);
  }
  rangee.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(
    new ButtonBuilder().setCustomId(customId('botadmin', 'config-cle-defaut', def.module, def.cle)).setStyle(ButtonStyle.Secondary).setEmoji('🧹').setLabel('Revenir au défaut'),
    new ButtonBuilder().setCustomId(customId('botadmin', 'config-cle-retour', def.module)).setStyle(ButtonStyle.Secondary).setEmoji('⬅️').setLabel('Tous les réglages du module'),
  ) as never);
  return {
    embeds: [embed({ title: `✏️ ${def.label} · \`${def.cle}\``, fields: champs, footer: `type ${def.type}${genre === 'bascule' ? ' · un clic suffit' : ''}` })],
    components: rangee as never,
  };
}

/** Dire a l'humain QUOI taper avant qu'il ne devine, parce qu'une validation muette est une punition. */
function formatAttendu(def: SettingDef): string {
  const bornes = def.min !== undefined || def.max !== undefined
    ? ` · entre ${def.min ?? '−'} et ${def.max ?? '∞'}` : '';
  switch (def.type) {
    case 'nombre': return `un nombre entier ou à virgule${bornes}`;
    case 'pourcentage': return `un pourcentage, 0 à 100`;
    case 'duree': return `une durée lisible : 30s, 5m, 2h, 1j, 1h30`;
    case 'couleur': return `un hexa (#1ABC9C) ou un nom : ${NOMS_COULEURS_LISTE}`;
    case 'liste': return `des mots séparés par des virgules · ${def.max ?? 25} au maximum`;
    case 'texte': return `plusieurs lignes, ${def.maxLen ?? 1800} caractères max — les placeholders marchent`;
    case 'chaine': return `une ligne, ${def.maxLen ?? 180} caractères max`;
    case 'emoticone': return `un ou plusieurs emojis`;
    case 'salon': return `le salon dans la liste ci-dessous (Edge vérifie qu’il a le droit d’y écrire)`;
    case 'role': return `le rôle dans la liste ci-dessous`;
    case 'choix': return (def.choix ?? []).map((x) => x.nom).join(' / ');
    case 'booleen': return 'un bouton oui / non';
    default: return 'texte libre';
  }
}

const NOMS_COULEURS_LISTE = 'rouge, orange, jaune, vert, bleu, turquoise, violet, rose, gris, blanc, noir, blurple, or';

/** Le chemin d'ecriture commun des quatre controles : valider, noter, montrer la valeur prise. */
async function appliquer(
  c: Ctx, modules: readonly EdgeModule[], i: MessageComponentInteraction, module: string, cle: string, brut: string,
): Promise<void> {
  const r = await c.cfg.regler(module, cle, brut);
  if (!r.ok) {
    return;
  }
  const avis = await verifierCible(c, r.def, r.valeur);
  const note = `✅ \`${module}.${cle}\` = **${formater(r.def, r.valeur).replace(/\n/g, ' ').slice(0, 180)}**${avis ? `\n${avis}` : ''}`;
  const estModale = typeof (i as unknown as { isModalSubmit?: () => boolean }).isModalSubmit === 'function'
    && (i as unknown as { isModalSubmit: () => boolean }).isModalSubmit();
  if (estModale) {
    // Apres une modale, le message d'origine n'est plus éditable : on répond, avec la vue à jour
    // en dessous pour que le nouvel état soit visible sans retaper la commande.
    await i.reply({ ...await vueModule(c, modules, module, false), content: note, flags: MessageFlags.Ephemeral } as never);
    return;
  }
  await i.update({
    ...(await vueModule(c, modules, module, false)),
    content: note,
    flags: MessageFlags.Ephemeral,
  } as never);
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
