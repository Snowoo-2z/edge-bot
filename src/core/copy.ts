/** Tous les textes vus par les membres, au même endroit. */
export const fr = {
  noGuild: 'Edge ne tourne que sur le serveur 1558076024778919946.',
  notHere: '❌ Ici, c’est pas chez Edge.',
  noPerm: (min: string) => `❌ Il faut le rôle ${min} (ou un rôle au-dessus) pour faire ça.`,
  dbDown: '⚠️ Base de données injoignable : la partie qui nécessite du stockage est coupée. Le reste d’Edge fonctionne.',
  tooFast: (s: number) => `⌛ Doux, réessaie dans ${s}s.`,
  moduleOff: (k: string) => `🔌 Le module \`${k}\` est désactivé. Un admin peut le rallumer avec /edge module.`,
  missing: (what: string) => `🧩 Il manque ${what} sur le serveur : Edge désactive ce module plutot que de planter.`,
  confirmCancel: 'Annulé.',
  closed: 'Ticket fermé.',
} as const;
