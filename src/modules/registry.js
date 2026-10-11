// Liste des modules disponibles dans /config.
// Pour ajouter un module : créer src/modules/<id>.js puis l'ajouter ici.
const MODULE_LIST = [
  {
    id: 'ticket',
    label: 'Ticket',
    emoji: '🎫',
    description: 'Panneau de tickets, images/GIF et textes modifiables',
  },
  {
    id: 'embed',
    label: 'Créateur d’embed',
    emoji: '🧩',
    description: 'Construire un embed étape par étape, sauver des modèles, l’envoyer',
  },
  {
    id: 'welcome',
    label: 'Bienvenue',
    emoji: '👋',
    description: 'Carte de bienvenue envoyée à chaque arrivée',
  },
  {
    id: 'levels',
    label: 'Niveaux',
    emoji: '🏅',
    description: 'Niveaux vocaux et texte : thème, annonces de niveau',
  },
  {
    id: 'suggestions',
    label: 'Suggestions',
    emoji: '💡',
    description: 'Commande /suggestion avec votes pendant 3 jours',
  },
  {
    id: 'giveaways',
    label: 'Giveaways',
    emoji: '🎁',
    description: 'Commande /giveaway : rôles créateurs, tirage au sort automatique',
  },
  {
    id: 'links',
    label: 'Liens',
    emoji: '🔗',
    description: 'Blocage des liens et rôles autorisés',
  },
  {
    id: 'logs',
    label: 'Logs',
    emoji: '📜',
    description: 'Journal détaillé : messages, membres, vocal, salons, rôles, modération',
  },
  {
    id: 'ai',
    label: 'IA (Mistral)',
    emoji: '🤖',
    description: 'Réponses du bot avec Mistral : prompt, abréviations, nœuds par mots-clés',
  },
  {
    id: 'reaction_roles',
    label: 'Rôles par réaction',
    emoji: '🎭',
    description: 'Panneaux : réagir à un message donne un rôle, retirer la réaction le retire',
  },
  {
    id: 'security',
    label: 'Sécurité',
    emoji: '🛡️',
    description: 'Anti-raid (verrouillage) et anti-nuke (retrait des rôles puis bannissement)',
  },
  {
    id: 'backups',
    label: 'Sauvegardes',
    emoji: '💾',
    description: 'Sauvegarde quotidienne (création et restauration depuis le tableau de bord)',
  },
  {
    id: 'moderation',
    label: 'Modération',
    emoji: '🛡️',
    description: 'Commandes ban, timeout, warn, purge… avec rôles autorisés par commande',
  },
];

module.exports = { MODULE_LIST };
