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
    description: 'Niveaux vocaux : thème de la carte /level',
  },
];

module.exports = { MODULE_LIST };
