/** /aide : la seule chose a retenir pour tes membres et ton staff. */
import { SlashCommandBuilder } from 'discord.js';
import type { Ctx, EdgeModule } from '../core/module.js';
import { MODULES } from './index.js';
import { channelDef, CHANNEL_DEFS, ROLE_DEFS } from '../manifest.js';
import { roleMention } from '../core/send.js';

const DOCS: Record<string, { quoi: string; qui: string; ou: string; cmd: string }> = {
  welcome: { quoi: 'Message d’accueil (texte simple, pas d’embed), rôle 👤│ Membre donné tout seul, traçage des départs, alerte si compte créé il y a moins de 7 jours.', qui: 'automatique', ou: '👋│・Bienvenue', cmd: '/bienvenue stats · /bienvenue texte (admin)' },
  rules: { quoi: 'Panneau du règlement + bouton « J’ai lu et j’accepte ». Un flag optionnel peut bloquer le chat tant que ce n’est pas cliqué.', qui: 'tout le monde', ou: '📌│・Règlement', cmd: '/reglement statut · /reglement texte (staff)' },
  presentation: { quoi: 'Bouton « Se présenter », 4 champs, post propre, validation staff. Aucune commande à taper pour un membre.', qui: 'tout le monde', ou: '👋│・Présentations', cmd: '/presentation statut · /presentation relancer (staff)' },
  selfroles: { quoi: 'Un menu déroulant pour s’auto-ajouter les rôles de notification 🎁 et 🤝. C’est le seul ping qu’un membre peut déclencher.', qui: 'tout le monde', ou: '🎭│・Choisir-ses-rôles', cmd: '/selfroles etat (staff)' },
  tickets: { quoi: 'Un panneau, un menu de motif, Edge crée le salon privé dans 📁│↦ TICKETS, pinguе le bon rôle, puis transcript HTML archivé à la fermeture.', qui: 'tout le monde (ouverture) · Helper+ (gestion)', ou: '🎫│・Ouvrir-un-ticket', cmd: '/ticket liste · /ticket voir · /ticket fermer' },
  moderation: { quoi: 'Dossier numéroté, points de warn, MP poli à la cible, copie dans 🛡️│・Modération-logs, purge de salon. La barre de points conseille l’étape suivante, ne sanctionne jamais toute seule.', qui: '⚔️│ Modérateur (sanctions) · 🧰│ Helper+ (lecture/notes)', ou: '🛡️│・Modération-logs', cmd: '/mod avertir · /sanction timeout · clic droit « Historique des sanctions »' },
  automod: { quoi: 'Invitations étrangères, webhooks collés, jetons, flood, @everyone par un non-Admin, majuscules, zalgo. Frappe d’abord doucement (suppression), monte si ça recommence, ne bannit jamais seul.', qui: 'automatique', ou: '🛡️│・Modération-logs', cmd: '/automod regles · /automod test' },
  antiraid: { quoi: 'Fenetre de 60 s sur les arrivées ; au-dela du seuil, coupure d’ecriture dans les salons publics (overwrite de categorie) jusqu’a deblocage manuel.', qui: 'automatique · 🛡️│ Administrateur (deblocage)', ou: '🚨│・Signalements', cmd: '/raid statut · /raid unlock' },
  reports: { quoi: 'Clic droit sur un message ou un membre « 🚨 Signaler » → ca part en ticket prive, jamais en public.', qui: 'tout le monde', ou: '🚨│・Signalements', cmd: 'aucun a taper : menu contextuel' },
  audit: { quoi: 'Compare le serveur reel au manifeste d’Edge : salon renomme, categorie qui a bouge, 🔒 qui ne verrouille plus, role Edge trop haut ou trop bas, invariants de ping. Lecture seule : Edge rapporte, il repare pas.', qui: 'Modérateur+', ou: '📋│・Audit-staff', cmd: '/audit structure · /audit ping · /audit recent' },
  giveaway: { quoi: 'Concours avec bouton 🎉, conditions (roles, anciennete), ponderation (Booster x2, Animateur x1.5), tirage crypto, fin programmee qui survit a un redemarrage, reroll, MP aux gagnants, ping 🎁│ Notification Giveaway.', qui: '🎉│ Animateur+', ou: '🎁│・Giveaway', cmd: '/giveaway start · /giveaway list · /giveaway reroll' },
  polls: { quoi: 'Sondages natifs Discord (vrai sondage, pas des reactions bricol), duree, multi-choix, resultat epingle en clair.', qui: 'Helper+', ou: '📊│・Sondages', cmd: '/sondage nouveau' },
  levels: { quoi: 'XP a chaque message, sans cooldown, avec un seul garde-fou : le copier-coller repete ne compte pas. /rang fait une carte en texte, pas en image (moins de dependances, moins de pannes).', qui: 'automatique', ou: 'partout sauf les salons 🔒', cmd: '/rang · /rang top · /rang voir' },
  voice: { quoi: 'Minutes en vocal comptees par semaine, top, eviction des inactifs (on ne touche ni a 🎵│ Musique ni a 🌙│ Chill), salons temporaires pour les soirees.', qui: 'automatique', ou: '🔊│↦ VOCAUX', cmd: '/vocal top · /vocal temp' },
  events: { quoi: 'Evenement planifie (salon vocal), bouton Je participe / Peut-etre / Non, rappel 15 min avant. L’Animateur peut gerer ses propres evenements, le bot ne remplace pas Discord.', qui: '🎉│ Animateur+', ou: '🎮│・Gaming + 🔊│ Gaming', cmd: '/event creer · /event liste · /event annuler' },
  boosts: { quoi: 'Rôle ✨│ Booster donne et retire tout seul, message de merci dans ✨│・Boosts, compteur, paliers 7/14/25 qui proposent un event a l’Admin.', qui: 'automatique', ou: '✨│・Boosts', cmd: '/boosts statut' },
  announcements: { quoi: 'Composer d’annonce : modale, apercu, confirmation, puis publication dans 📣│・Annonces. Peut etre programme. Un Manager ne peut pas ecrire ici (salon verrouille) : c’est Edge qui poste pour lui.', qui: 'Modérateur+ · Manager (partenariat seulement)', ou: '📣│・Annonces', cmd: '/annonce publier · /annonce programme · /annonce lister' },
  suggestions: { quoi: 'Boite d’idees : titre, detail, vote 👍/👎, thread de discussion, statut pose par le staff (recu / a etudier / valide / refuse) et notification de l’auteur a chaque changement.', qui: 'tout le monde (proposer) · Helper+ (statut)', ou: '🗳️│・Suggestions', cmd: '/suggestion nouvelle · /suggestion statut' },
  invites: { quoi: 'Qui a ramene qui : tracking des invitations par salon, classement mensuel, anti auto-invite. Aucune permission supplementaire requise.', qui: 'tout le monde', ou: '💌│・Invitations', cmd: '/invites voir · /invites top · /invites tracker' },
  partnership: { quoi: 'Cycle partenariat : audit du serveur partenaire (membres, anciennete, invite recoupee avec les notres), acceptation, annonce avec ping 🤝│ Notification Partenariat, controle de reciprocite chaque lundi, role 🤝│ Partenaire pose puis retire.', qui: '💼│ Manager Partenariat+', ou: '📣│・Annonces + 🎫│・Tickets-logs', cmd: '/partenariat auditer · /partenariat accepter · /partenariat lister' },
  recruitment: { quoi: 'Offre de poste publiee dans 📖│・Recrutement Staff, candidatures en modale, 4 questions, puis decision staff. Edge ne donne JAMAIS un role de staff : il prepare le message pour un Admin.', qui: 'tout le monde (candidater) · Admin (decider)', ou: '📖│・Recrutement Staff', cmd: '/recrutement poste · /recrutement lister' },
  botadmin: { quoi: 'Couper ou rallumer un module a chaud, poser un flag, voir la sante (intents, permissions, BDD, ordonnanceur), relancer la resolution de structure, re-synchroniser un panneau, chiffrer les stats.', qui: '🛡️│ Administrateur · 👑│ Fondateur', ou: '💬│・Staff-chat', cmd: '/edge module · /edge flag · /edge sante · /edge stats' },
};

export const helpModule: EdgeModule = {
  key: 'help',
  label: 'Aide & modes d’emploi',
  commands: () => [
    {
      data: new SlashCommandBuilder().setName('aide')
        .setDescription('Ce que fait Edge sur ce serveur, module par module')
        .addStringOption((o) => o.setName('module').setDescription('Un seul module en detail').addChoices(
          ...MODULES.map((m) => ({ name: m.label.slice(0, 100), value: m.key })),
        )) as never,
      run: async (c: Ctx, i) => {
        const one = i.options.getString('module');
        if (one) {
          const m = MODULES.find((x) => x.key === one);
          const d = DOCS[one];
          const off = c.disabled.get(one);
          return void (await i.editReply({ content: [
            `**${m?.label ?? one}** — ${off ? `⚠️ désactivé : ${off}` : '✅ actif'}`,
            d?.quoi ?? '(pas de fiche pour ce module)',
            d ? `👉 Qui : ${d.qui}` : '',
            d ? `📍 Où : ${d.ou}` : '',
            d ? `⌨️ Commandes : ${d.cmd}` : '',
          ].join('\n'), flags: 64 as never }));
        }
        const lines = MODULES.map((m) => {
          const off = c.disabled.get(m.key);
          return `${off ? '⚠️' : '•'} **${m.label}** — ${(DOCS[m.key]?.quoi ?? '').split('. ')[0]}.${off ? ` (coupé : ${off})` : ''}`;
        });
        return void (await i.editReply({ content: [
          `🧭 **Edge — ${MODULES.length} modules sur ${c.guild.name}**`,
          '',
          ...lines,
          '',
          `📌 30 salons attendus, ${CHANNEL_DEFS.filter((x) => x.locked).length} en lecture seule, ${ROLE_DEFS.length} rôles connus.`,
          `Un doute sur un salon ? ${roleMention(c, 'admin')}.`,
        ].join('\n').slice(0, 4000), flags: 64 as never }));
      },
    },
  ],
};

export const moduleDocs = DOCS;
export const channelsOfNote = (keys: string[]): string => keys.map((k) => channelDef(k as never).name).join(', ');
