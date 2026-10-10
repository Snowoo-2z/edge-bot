/**
 * `/aide` : la seule chose à retenir pour tes membres et ton staff — et la porte d'entrée de la
 * personnalisation. Deux règles de conception, parce que cette commande a déjà cassé en prod :
 *  - le texte part dans un **embed** (4096) et jamais dans un `content` (2000) : le `/aide`
 *    complet faisait 2900 caractères et Discord répondait `Invalid Form Body` ;
 *  - on ne fait pas taper de nom de module : le menu déroulant les liste, et le bouton ⚙️ ouvre
 *    directement les réglages du module choisi.
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, StringSelectMenuBuilder,
  type MessageActionRowComponentBuilder, type StringSelectMenuInteraction,
} from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { MODULES } from './index.js';
import { channelDef, CHANNEL_DEFS, ROLE_DEFS } from '../manifest.js';
import { roleMention } from '../core/send.js';
import { embed } from '../core/send.js';
import { habilitation, vueModule } from '../core/config-ui.js';
import { formater } from '../core/settings.js';
import { decouper } from '../core/safe-reply.js';
import { valeurOption } from '../core/ui.js';

export const LIMITE_EMBED = 3800;

export type Fiche = { quoi: string; qui: string; ou: string; cmd: string };

export const DOCS: Record<string, Fiche> = {
  welcome: { quoi: 'Message d’accueil (texte simple, pas d’embed), rôle 👤│ Membre donné tout seul, traçage des départs, alerte si compte créé il y a moins de 7 jours.', qui: 'automatique', ou: '👋│・Bienvenue', cmd: '/bienvenue stats · /bienvenue texte (admin)' },
  rules: { quoi: 'Panneau du règlement + bouton « J’ai lu et j’accepte ». Un flag optionnel peut bloquer le chat tant que ce n’est pas cliqué.', qui: 'tout le monde', ou: '📌│・Règlement', cmd: '/reglement statut · /reglement texte (staff)' },
  presentation: { quoi: 'Bouton « Se présenter », 4 champs, post propre, validation staff. Aucune commande à taper pour un membre.', qui: 'tout le monde', ou: '👋│・Présentations', cmd: '/presentation statut · /presentation relancer (staff)' },
  selfroles: { quoi: 'Un menu déroulant pour s’auto-ajouter les rôles de notification 🎁 et 🤝. C’est le seul ping qu’un membre peut déclencher.', qui: 'tout le monde', ou: '🎭│・Choisir-ses-rôles', cmd: '/selfroles etat (staff)' },
  tickets: { quoi: 'Un panneau, un menu de motif, Edge crée le salon privé dans 📁│↦ TICKETS, pinguе le bon rôle, puis transcript HTML archivé à la fermeture.', qui: 'tout le monde (ouverture) · Helper+ (gestion)', ou: '🎫│・Ouvrir-un-ticket', cmd: '/ticket liste · /ticket voir · /ticket fermer' },
  moderation: { quoi: 'Dossier numéroté, points de warn, MP poli à la cible, copie dans 🛡️│・Modération-logs, purge de salon. La barre de points conseille l’étape suivante, ne sanctionne jamais toute seule.', qui: '⚔️│ Modérateur (sanctions) · 🧰│ Helper+ (lecture/notes)', ou: '🛡️│・Modération-logs', cmd: '/mod avertir · /sanction timeout · clic droit « Historique des sanctions »' },
  automod: { quoi: 'Invitations étrangères, webhooks collés, jetons, flood, @everyone par un non-Admin, majuscules, zalgo. Frappe d’abord doucement (suppression), monte si ça recommence, ne bannit jamais seul.', qui: 'automatique', ou: '🛡️│・Modération-logs', cmd: '/automod regles · /automod test' },
  antiraid: { quoi: 'Fenêtre de 60 s sur les arrivées ; au-delà du seuil, coupure d’écriture dans les salons publics (overwrite de catégorie) jusqu’au déblocage manuel.', qui: 'automatique · 🛡️│ Administrateur (déblocage)', ou: '🚨│・Signalements', cmd: '/raid statut · /raid unlock' },
  reports: { quoi: 'Clic droit sur un message ou un membre « 🚨 Signaler » → ça part en ticket privé, jamais en public.', qui: 'tout le monde', ou: '🚨│・Signalements', cmd: 'aucun à taper : menu contextuel' },
  audit: { quoi: 'Compare le serveur réel au manifeste d’Edge : salon renommé, catégorie qui a bougé, 🔒 qui ne verrouille plus, rôle Edge trop haut ou trop bas, invariants de ping. Lecture seule : Edge rapporte, il répare pas.', qui: 'Modérateur+', ou: '📋│・Audit-staff', cmd: '/audit structure · /audit ping · /audit recent' },
  giveaway: { quoi: 'Concours avec bouton 🎉, conditions (rôles, ancienneté), pondération (Booster x2, Animateur x1.5), tirage crypto, fin programmée qui survit à un redémarrage, reroll, MP aux gagnants, ping 🎁│ Notification Giveaway.', qui: '🎉│ Animateur+', ou: '🎁│・Giveaway', cmd: '/giveaway start · /giveaway list · /giveaway reroll' },
  polls: { quoi: 'Sondages natifs Discord (vrai sondage, pas des réactions bricolées), durée, multi-choix, résultat épinglé en clair.', qui: 'Helper+', ou: '📊│・Sondages', cmd: '/sondage nouveau' },
  levels: { quoi: 'XP à chaque message, sans cooldown, avec un seul garde-fou : le copier-coller répété ne compte pas. /rang fait une carte en texte, pas en image (moins de dépendances, moins de pannes).', qui: 'automatique', ou: 'partout sauf les salons 🔒', cmd: '/rang · /rang top · /rang voir' },
  voice: { quoi: 'Minutes en vocal comptées par semaine, top, éviction des inactifs (on ne touche ni à 🎵│ Musique ni à 🌙│ Chill), salons temporaires pour les soirées.', qui: 'automatique', ou: '🔊│↦ VOCAUX', cmd: '/vocal top · /vocal temp' },
  events: { quoi: 'Événement planifié (salon vocal), bouton Je participe / Peut-être / Non, rappel 15 min avant. L’Animateur peut gérer ses propres événements, le bot ne remplace pas Discord.', qui: '🎉│ Animateur+', ou: '🎮│・Gaming + 🔊│ Gaming', cmd: '/event creer · /event liste · /event annuler' },
  boosts: { quoi: 'Rôle ✨│ Booster donné et retiré tout seul, message de merci dans ✨│・Boosts, compteur, paliers 7/14/25 qui proposent un event à l’Admin.', qui: 'automatique', ou: '✨│・Boosts', cmd: '/boosts statut' },
  announcements: { quoi: 'Composer d’annonce : modale, aperçu, confirmation, puis publication dans 📣│・Annonces. Peut être programmé. Un Manager ne peut pas écrire ici (salon verrouillé) : c’est Edge qui poste pour lui.', qui: 'Modérateur+ · Manager (partenariat seulement)', ou: '📣│・Annonces', cmd: '/annonce publier · /annonce programme · /annonce lister' },
  suggestions: { quoi: 'Boîte à idées : titre, détail, vote 👍/👎, fil de discussion, statut posé par le staff (reçu / à étudier / validé / refusé) et notification de l’auteur à chaque changement.', qui: 'tout le monde (proposer) · Helper+ (statut)', ou: '🗳️│・Suggestions', cmd: '/suggestion nouvelle · /suggestion statut' },
  invites: { quoi: 'Qui a ramené qui : suivi des invitations par salon, classement mensuel, anti auto-invite. Aucune permission supplémentaire requise.', qui: 'tout le monde', ou: '💌│・Invitations', cmd: '/invites voir · /invites top · /invites tracker' },
  partnership: { quoi: 'Cycle partenariat : audit du serveur partenaire (membres, ancienneté, invite recoupée avec les nôtres), acceptation, annonce avec ping 🤝│ Notification Partenariat, contrôle de réciprocité chaque lundi, rôle 🤝│ Partenaire posé puis retiré.', qui: '💼│ Manager Partenariat+', ou: '📣│・Annonces + 🎫│・Tickets-logs', cmd: '/partenariat auditer · /partenariat accepter · /partenariat lister' },
  recruitment: { quoi: 'Offre de poste publiée dans 📖│・Recrutement Staff, candidatures en modale, 4 questions, puis décision staff. Edge ne donne JAMAIS un rôle de staff : il prépare le message pour un Admin.', qui: 'tout le monde (candidater) · Admin (décider)', ou: '📖│・Recrutement Staff', cmd: '/recrutement poste · /recrutement lister' },
  help: { quoi: 'La fiche de chaque module : ce qu’il fait, qui s’en sert, dans quel salon, et le bouton ⚙️ qui ouvre ses réglages. C’est la commande à coller dans 📌│・Informations pour les nouveaux.', qui: 'tout le monde', ou: 'partout (réponse éphémère, ça ne pollue pas)', cmd: '/aide · /aide <module>' },
  botadmin: { quoi: 'Couper ou rallumer un module à chaud, régler n’importe quel texte/salon/couleur depuis /config, voir la santé (intents, permissions, BDD, ordonnanceur), relancer la résolution de structure, re-synchroniser un panneau, chiffrer les stats.', qui: '🛡️│ Administrateur · 👑│ Fondateur', ou: '💬│・Staff-chat', cmd: '/config · /edge module · /edge sante · /edge stats' },
};

/** Une ligne par module, courte : c'est l'aperçu, pas la fiche. */
export function lignesApercu(c: Ctx, modules: readonly { key: string; label: string }[] = MODULES): string[] {
  return modules.map((m) => {
    const off = c.disabled.get(m.key);
    const reglable = c.cfg.defs(m.key).length;
    return `${off ? '⚠️' : '•'} **${m.label}** — ${(DOCS[m.key]?.quoi ?? 'aucune fiche').split('. ')[0]}.${off ? ` *(coupé : ${off})*` : ''}${reglable ? ` _(${reglable} réglage(s))_` : ''}`;
  });
}

/** L'aperçu, découpé en descriptions d'embed qui passent (un embed = 4096, on prend de la marge). */
export function pagesApercu(c: Ctx, modules: readonly { key: string; label: string }[] = MODULES): string[] {
  const chapeau = `🧭 **Edge — ${modules.length} modules sur ${c.guild.name}**`;
  const queue = `📌 ${CHANNEL_DEFS.length} salons attendus, ${CHANNEL_DEFS.filter((x) => x.locked).length} en lecture seule, ${ROLE_DEFS.length} rôles connus.\nPour changer un texte, un salon ou une couleur : ${'**'}/config${'**'} (un menu pour le module, un menu pour le réglage, rien à taper).`;
  const texte = [chapeau, '', ...lignesApercu(c, modules), '', queue].join('\n');
  return decouper(texte, LIMITE_EMBED);
}

function selecteurModules(): unknown[] {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('edge:help:module')
    .setPlaceholder('Un module en détail…')
    .addOptions(MODULES.map((m) => ({ label: m.label.slice(0, 90), value: valeurOption(m.key), description: (DOCS[m.key]?.quoi ?? '—').slice(0, 95) })));
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(menu as never) as never];
}

/** La fiche d'un module, plus ses réglages courants : c'est de là qu'on entre dans /config. */
async function vueFiche(c: Ctx, key: string): Promise<{ embeds: unknown[]; components: unknown[] }> {
  const m = MODULES.find((x) => x.key === key);
  const d = DOCS[key];
  const off = c.disabled.get(key);
  const defs = c.cfg.defs(key);
  const etat = await c.cfg.tout(key);
  const champs = [
    { name: '🔎 Ce qu’il fait', value: d?.quoi ?? '(pas de fiche pour ce module)' },
    { name: '👉 Qui peut s’en servir', value: d?.qui ?? '—' },
    { name: '📍 Où', value: d?.ou ?? '—' },
    { name: '⌨️ Commandes', value: d?.cmd ?? '—' },
  ];
  if (defs.length) {
    champs.push({
      name: `⚙️ Réglages (${defs.length})`,
      value: defs.slice(0, 24).map((def) => `\`${def.cle}\` · ${formater(def, etat[def.cle]?.valeur)}`).join('\n') || '—',
    });
  }
  const boutons = new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(
    ...(defs.length ? [new ButtonBuilder().setCustomId(`edge:help:regler:${key}`).setStyle(ButtonStyle.Primary).setEmoji('⚙️').setLabel('Régler ce module')] : []),
    new ButtonBuilder().setCustomId('edge:help:apercu').setStyle(ButtonStyle.Secondary).setEmoji('🧭').setLabel('Tous les modules'),
  );
  return {
    embeds: [embed({
      title: `${off ? '⚠️' : '✅'} ${m?.label ?? key}`,
      desc: off ? `**Désactivé** — ${off}\n\nRallume-le avec \`/edge module ${key} action:on\` ou le bouton 🔕/✅ du module.` : undefined,
      fields: champs,
      footer: `/aide ${key} · fiche lue dans le manifeste, pas dans ma tête · ⚙️ = les réglages`,
    })],
    components: [boutons as never, ...selecteurModules()],
  };
}

export const helpModule: EdgeModule = {
  key: 'help',
  label: 'Aide & modes d’emploi',
  components: () => ({
    'module': async (c: Ctx, i: StringSelectMenuInteraction) => {
      const key = i.values[0];
      if (!key) return;
      await i.update(await vueFiche(c, key) as never);
    },
    'apercu': async (c: Ctx, i) => {
      await i.update({ embeds: pagesApercu(c).map((p) => embed({ desc: p })), components: selecteurModules() } as never);
    },
    // Le pont vers la config : pas besoin de savoir que ça s'appelle /config.
    'regler': async (c: Ctx, i, args) => {
      const key = args[0]!;
      if (!habilitation(c, i as never)) {
        return void (await i.reply({
          content: `🔒 \`${key}\` se règle côté staff — demande-le à un Admin. La fiche du module, elle, est pour tout le monde : tape /aide ${key}.`,
          flags: 64 as never,
        }));
      }
      await i.update(await vueModule(c, MODULES, key, false) as never);
    },
  }),
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('aide')
        .setDescription('Ce que fait Edge sur ce serveur, module par module — et comment le régler')
        .addStringOption((o) => o.setName('module').setDescription('Un seul module en détail').addChoices(
          ...MODULES.map((m) => ({ name: m.label.slice(0, 100), value: m.key })),
        )) as never,
      run: async (c: Ctx, i) => {
        const key = i.options.getString('module');
        if (key) return void (await i.editReply(await vueFiche(c, key) as never));
        return void (await i.editReply({
          embeds: pagesApercu(c).map((p) => embed({ desc: p })),
          components: selecteurModules() as never,
        }));
      },
    },
  ],
};

export const moduleDocs = DOCS;
export const channelsOfNote = (keys: string[]): string => keys.map((k) => channelDef(k as never).name).join(', ');
