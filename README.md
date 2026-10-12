# edge-bot

Bot Discord **Edge** : une seule commande de configuration, `/config`, qui ouvre un panneau
(menus + boutons) pour configurer les modules. Toutes les couleurs d'embed sont **violettes**.

## Fonctionnement de `/config`

1. `/config` ouvre un panneau privé (visible seulement par toi).
2. Tu choisis le **module** dans le menu déroulant : **🎫 Ticket**, **🧩 Créateur d’embed**, **👋 Bienvenue**.
3. Tu configures avec les boutons :
   - **Module / Image / GIF** : boutons ON (vert) / OFF (gris), un clic = bascule.
   - **📁 Catégorie** : catégorie où seront créés les tickets.
   - **📌 Publier le panneau** : choisis le salon où poster le panneau « Ouvrir un ticket ».
   - **🖼️ Importer image** / **🎞️ Importer GIF** : clique, puis envoie le fichier en pièce jointe
     dans le salon (2 min). Formats : image = PNG, JPG, WEBP, GIF ; GIF = GIF. Max 8 Mo.
     **🗑️ Retirer** supprime le fichier.
   - **✏️ Textes** : un bouton par texte. Clique, une fenêtre s'ouvre avec le texte actuel, modifie-le, valide.

### Textes modifiables (module Ticket)

Dans **✏️ Textes**, le bouton **Mode** alterne entre deux façons de modifier :
- **Boutons** : une fenêtre par section (Panneau, Accueil, Messages), avec tous ses textes.
- **Sélecteur** : un menu déroulant avec les 13 textes, pour en modifier un seul à la fois.

Le choix est enregistré pour le serveur. Les textes déjà modifiés ne changent pas quand tu changes de mode.

Titre / description / bouton / footer du panneau, nom des salons, titre / description / footer
du salon ticket, bouton « fermer », et les messages (ticket créé, déjà ouvert, fermeture, désactivé).

Variables utilisables dans les textes :
- `{user}` : pseudo de l'utilisateur
- `{number}` : numéro du ticket
- `{channel}` : lien vers le salon du ticket (messages)

### Ce que font les images / GIF

- **Image** (ON) : affichée sur le panneau « Ouvrir un ticket ».
- **GIF** (ON) : affiché dans le salon du ticket, dans le message d'accueil.

## Créateur d'embed

Dans `/config` → **🧩 Créateur d’embed**, tu construis un embed pièce par pièce, avec un **aperçu en direct** dans le panneau.
Tous les embeds sont violets.

- **✏️ Titre + lien**, **📝 Description**, **👤 Auteur & pied** : une fenêtre par partie.
- **📎 Importer une image** / **📎 Importer une miniature** : clique, puis envoie l'image en pièce jointe dans le salon (2 min).
  Formats : PNG, JPG, WEBP, GIF. 8 Mo max. L'image est stockée dans Supabase.
- **🖼️ Images** (fenêtre) : tu peux aussi coller une URL `https://` à la place. Vider le champ retire l'image.
- **➕ Champ** / **🗑️ Champ** : ajoute un champ (nom, valeur, « en ligne » = `oui` pour côte à côte) ou supprime-en un. 25 max.
- **💾 Modèle** / **📂 Modèles** : sauvegarde le brouillon sous un nom, recharge-le ou supprime-le. 10 modèles max.
- **📤 Envoyer** : choisis le salon ; l'embed y est publié tel quel. Le bot a besoin de la permission
  *Envoyer des messages* et *Intégrer des liens* dans ce salon.
- **🧹 Vider** : efface le brouillon (les modèles sont conservés).

## Bienvenue

Dans `/config` → **👋 Bienvenue** : à chaque arrivée d'un membre, le bot envoie dans le salon choisi un message
suivi d'une **carte de bienvenue** (image PNG générée par le bot, 1000×400, avec l'avatar du membre).
L'image est envoyée seule, sans cadre d'embed (un embed la réduirait).

- **Module** : ON / OFF. **Avatar** : affiché ou masqué sur la carte.
- **Thème** : menu pour choisir le fond de la carte :
  - 💜 **Violet** (par défaut)
  - 🌑 **Violet foncé** : version plus sombre
  - 🎃 **Halloween** : noir, violet et orange, avec une lune (octobre)
  - 🎄 **Noël** : vert sapin, rouge et neige
  Le thème est choisi à la main : il ne change jamais tout seul à une date donnée.
- **📍 Salon** : choisis le salon d'arrivée.
- **✏️ Textes** : titre et sous-titre de l'image, message au-dessus de l'image.
- **👁️ Aperçu** : génère la carte avec ton compte, visible seulement par toi.

Variables utilisables dans les textes :
- `{user}` : pseudo sur l'image ; mention du membre dans le message
- `{server}` : nom du serveur
- `{count}` : numéro du membre (nombre de membres du serveur)

Par défaut : titre « Bienvenue {user} ! », sous-titre « Membre n°{count} · {server} ».

> **À activer dans le portail Discord** : *Bot* → *Privileged Gateway Intents* → **SERVER MEMBERS INTENT**.
> Sans lui, le bot refuse de se connecter (le module Bienvenue reçoit les arrivées grâce à cet intent).

Les polices (Inter, licence SIL OFL) sont incluses dans `assets/fonts/`. Aucun fichier n'est à installer.

## Giveaways

Dans `/config` → **🎁 Giveaways** : active le module, choisis les **rôles autorisés à créer un giveaway**
et, si tu veux, le salon par défaut.

- Commande **`/giveaway prix duree [gagnants] [salon]`** :
  - `prix` : ce qui est à gagner (200 caractères max) ;
  - `duree` : `30m`, `2h`, `3j`, `1j 12h` (de 1 minute à 30 jours) ;
  - `gagnants` : de 1 à 20 (1 par défaut) ;
  - `salon` : facultatif. Sinon : le salon par défaut configuré, ou le salon où la commande est tapée.
- Qui peut créer : les membres ayant un rôle autorisé, et les membres « Gérer le serveur » (admins).
- Le message propose un bouton **🎉 Participer** avec le nombre de participants. Un second clic annule la participation.
- À la fin, le bot tire les gagnants au sort parmi les participants (sans doublon), désactive le bouton et annonce les gagnants dans le salon.
- Les giveaways sont enregistrés dans Supabase (table `edge_giveaways`, section 5 de `supabase/schema.sql`) : ils restent actifs après un redémarrage.

## Suggestions

Dans `/config` → **💡 Suggestions** : active le module et choisis le salon de publication.

- Les membres utilisent **`/suggestion`** : une fenêtre demande le texte de la suggestion.
- Le bot publie la suggestion dans le salon avec deux boutons **👍 Pour** et **👎 Contre** (compteurs en direct).
- Un membre ne vote qu'une fois. Cliquer de nouveau sur le même bouton retire son vote ; cliquer sur l'autre change son vote.
- Les votes sont ouverts **3 jours**. Ensuite les boutons se désactivent et le résultat s'affiche (majorité pour, contre ou égalité).
- Les suggestions sont enregistrées dans Supabase (table `edge_suggestions`, section 4 de `supabase/schema.sql`) : elles restent actives après un redémarrage.

## Liens

Dans `/config` → **🔗 Liens** : active le blocage, choisis les **rôles autorisés à poster des liens**
et modifie l'avertissement si besoin.

- Un message contenant un lien (`https://…`, `www.…`, `discord.gg/…`, `exemple.com`…) est **supprimé**.
- Le membre reçoit dans le salon : « Avertissement, vous n’êtes pas autorisé à poster des liens sur ce serveur Discord. »
- Les membres ayant un rôle autorisé peuvent poster des liens. Les bots ne sont pas concernés.
- Les **salons libres** (bouton **Salons libres**) : tu peux en choisir un ou plusieurs, salons texte ou forums. Tout le monde peut y poster des liens. Dans un forum, tous les posts sont concernés.
- Le bot doit avoir la permission **Gérer les messages** dans le salon.
- Le contrôle s'applique aussi aux messages modifiés pour ajouter un lien.

## Niveaux (vocal et texte)

Le temps passé en salon vocal et les messages écrits rapportent de l'XP. **AFK, micro coupé et casque coupé comptent aussi en vocal.**

- **20 XP toutes les 30 secondes** passées en vocal. Le temps vocal total est enregistré (affiché en heures et minutes).
- **5 XP par message** écrit, sans limite de fréquence.
- **Carte `/level`** : niveau, barre de progression, XP actuelle / XP du niveau suivant, rang et temps vocal.
- **Classement** : rang, pseudo, niveau et temps vocal (sans montant d'XP).
- Les règles de gain ne sont pas affichées dans Discord.
- **Niveau** = racine(XP / 100) : le niveau N demande 100 × N² XP au total.
- Les bots ne gagnent pas d'XP.

Commandes (disponibles pour tout le monde) :
- **`/level`** : carte PNG avec ton niveau, ta barre de progression, ton rang et ton temps vocal.
  Tu peux aussi afficher celui d'un membre : `/level membre:@quelqu'un`.
- **`/leaderboard type:XP`** : image PNG du top 10 du classement XP (rang, pseudo, niveau, temps vocal), dans le thème des niveaux.
  Sans option, `/leaderboard` affiche le classement en Edge Dollar (voir Économie).

Thème de la carte : `/config` → **🏅 Niveaux**. Le thème par défaut est le **violet foncé**
(les mêmes thèmes que la carte de bienvenue sont disponibles).

**Annonces de niveau** (même module) : active le bouton **Annonces**, choisis le salon avec **Salon**,
et modifie le message avec **Message**. Par défaut : `Bravo à {user} qui passe {level}`.
Le message est envoyé en texte seul (sans image). `{user}` est mentionné, `{level}` est le niveau atteint.

> **Base de données** : exécute `supabase/schema.sql` dans le SQL Editor de Supabase (la section 3 crée la table
> `edge_levels`). Sans elle, le bot démarre mais l'XP n'est pas sauvegardé (un message l'indique dans les logs).
> Intent : `GuildVoiceStates` (non privilégié, rien à activer dans le portail).

## Logs (journal détaillé)

`/config` → **Logs**. Activer le module, puis choisir le salon par défaut et, si besoin, un salon par catégorie.

| Catégorie | Événements |
|---|---|
| Messages | message modifié (ancien et nouveau contenu), message supprimé (et auteur de la suppression si le journal d'audit le permet), suppression en masse |
| Membres | arrivée, départ, pseudo modifié, rôles ajoutés ou retirés |
| Vocal | connexion, déconnexion, déplacement |
| Salons | création, suppression, renommage |
| Rôles | création, suppression, modification (nom, couleur, permissions) |
| Modération | ban, débannissement, expulsion, timeout appliqué ou retiré, et toutes les commandes de modération |

- Les événements proches sont regroupés dans un même message (10 maximum).
- Les messages ou salons des logs ne sont jamais journalisés (pas de boucle).
- Les **salons ignorés** ne sont pas journalisés (messages et vocal).
- Le journal est aussi consultable dans le tableau de bord, filtrable par catégorie. Il est conservé **30 jours**.
- Les événements déclenchés par le bot lui-même (commandes de modération) ne sont journalisés qu'une fois.

## Modération (commandes)

`/config` → **Modération**. Commandes : `/ban`, `/unban`, `/kick`, `/timeout`, `/untimeout`, `/warn`,
`/warnings`, `/unwarn`, `/purge`, `/slowmode`.

- **Rôles par commande** : pour chaque commande, choisis les rôles autorisés. Sans rôle choisi, la commande
  utilise la permission Discord correspondante (ex. « Bannir des membres »).
- Les administrateurs et le propriétaire peuvent toujours utiliser les commandes.
- Protections : impossible de sanctionner soi-même, le propriétaire, le bot, ou un membre de rang égal ou
  supérieur au sien. Le rôle du bot doit aussi être au-dessus de la cible.
- Durées : `10m`, `2h`, `1j`, `1j 12h` (timeout de 1 minute à 28 jours). Raison : 400 caractères maximum.
- Un **MP** est envoyé au membre avant la sanction (texte modifiable, variables `{action}`, `{server}`,
  `{reason}`, `{duration}`). Texte vide = aucun MP. Les MP fermés n'empêchent pas la sanction.
- Avertissements : enregistrés dans Supabase (table `edge_warnings`), listés par `/warnings`, retirés par `/unwarn`
  ou depuis le tableau de bord.
- `/purge` supprime au plus 100 messages récents (les messages de plus de 14 jours ne peuvent pas être supprimés en masse).

**Permissions Discord à donner au bot** : Bannir des membres, Expulser des membres, Exclure temporairement des
membres (timeout), Gérer les messages, Gérer les salons (mode lent), Voir le journal d'audit (auteurs des actions
dans les logs), Envoyer des messages et Intégrer des liens (journal), Voir les salons.
Intents à activer dans le portail : **Server Members** et **Message Content** (déjà requis) ; l'intent
« Guild Moderation » est non privilégié et ne nécessite rien d'autre.

## Rôles par réaction

`/config` → **Rôles par réaction**, ou la page **Rôles réaction** du tableau de bord (créer, modifier, ajouter ou retirer
un rôle, publier, supprimer). Un panneau est un message du bot (embed violet) avec une réaction par rôle.

- Réagir à la réaction d'un rôle donne le rôle ; **retirer sa réaction retire le rôle**.
- Limites : 10 panneaux par serveur, 20 rôles par panneau.
- Un rôle au-dessus de celui du bot ne peut pas être attribué (le bot l'indique dans la configuration).
- Si un message de panneau est supprimé à la main, « Publier » le recrée.
- Permissions : Voir le salon, Envoyer des messages, Ajouter des réactions, Gérer les rôles.
- Intent : **Guild Message Reactions** (non privilégié).

## Sécurité (anti-raid, anti-nuke)

`/config` → **Sécurité**, ou la page **Sécurité** du tableau de bord (mêmes réglages).

- **Anti-raid** : si trop de comptes arrivent dans une fenêtre de temps (par défaut 10 arrivées en 10 s), le
  niveau de vérification du serveur passe à « élevé ». Le déverrouillage est **manuel** (« Lever le verrouillage »
  dans `/config` ou dans le tableau de bord). Un verrouillage n'est jamais restauré depuis une sauvegarde.
- **Anti-nuke** : si un membre non autorisé supprime ou crée trop de salons, supprime trop de rôles, ou bannit /
  expulse trop de membres dans la fenêtre (seuils réglables), le bot **retire ses rôles à risque, puis le bannit**.
  Les rôles non modifiables par le bot sont laissés en place.
- **Exemptés** : le propriétaire, le bot, et la liste blanche (membres et rôles de confiance). Les administrateurs
  ne sont pas exemptés automatiquement.
- **Alertes** : envoyées dans le salon d'alerte choisi, ou en MP au propriétaire s'il n'y en a pas. Les actions sont
  aussi journalisées (catégorie Modération).
- Permissions : Bannir des membres, Gérer les rôles, Gérer les salons, Gérer le serveur (verrouillage), Voir le journal d'audit.
- Intents : **Server Members** (privilégié, déjà requis) et **Guild Moderation**.

## Sauvegardes

Module **Sauvegardes** dans `/config` (activation de la sauvegarde quotidienne) ; **création et restauration se font
uniquement depuis le tableau de bord**.

- Contenu : rôles, salons (types texte, annonces, vocal, catégories) et permissions, configurations de tous les modules,
  messages publiés par le bot (30 au plus par salon).
- Une sauvegarde automatique est faite chaque jour et par serveur. Les **7 plus récentes** sont conservées.
- **Restauration non destructive** : rien n'est supprimé. Les rôles et salons absents sont recréés ; un rôle ou salon
  existant de même nom (et type) est réutilisé ; un message identique déjà présent n'est pas republié. Les configurations
  et les panneaux de rôles sont remis à jour avec les nouveaux identifiants.
- Restauration protégée : double confirmation (boîte de confirmation puis saisie du nom exact du serveur). Une
  **sauvegarde de sécurité** est créée juste avant ; si elle échoue, la restauration est annulée.
- Données : table Supabase `edge_backups`. Le contenu est **compressé** (JSON → gzip → base64, colonne `data_z`), ce qui
  réduit la place en base d'environ 5 à 12 fois (mesure sur un instantané de test). Les sauvegardes plus anciennes
  (colonne `data`, non compressée) restent restaurables. Voir `supabase/schema.sql`, sections 8 et 9.

## Commande /server

`/server` affiche les informations du serveur : nombre de membres, date de création, propriétaire, salons, rôles,
emojis, boosts, niveau de vérification et identifiant. Réponse visible par tous.

## IA (Mistral)

Module **IA** : le bot répond avec **Ministral 14B** (`ministral-14b-2512`, la version 14B de Mistral ; Mistral Nemo 12B
est en fin de vie) ou Ministral 8B. Tout se règle sur le tableau de bord, page **IA (Mistral)**.

- **Activation** : le bot répond quand on le **mentionne**, et regarde **tous** les messages des salons de réponse libre.
  Dans ces salons, il peut choisir de **ne pas parler** (voir « Silence » plus bas). Cooldown par membre (10 s par défaut) ; plafond de sécurité de 20 réponses par minute et par serveur.
- **Prompt système** : le rôle et les règles du bot (2 000 caractères maximum).
- **Abréviations** : liste `abréviation = signification` (100 maximum), ajoutable ligne par ligne ou en lot. Elles sont
  transmises au modèle pour qu'il comprenne le langage du serveur.
- **Contexte** : chaque réponse reçoit la date et l'heure (heure de Paris), le nom du serveur, celui du salon et le nom de
  la personne qui écrit. Il lit aussi les **15 derniers messages du salon** (avant le message traité, du plus ancien au plus
  récent, 300 caractères par ligne, 4 000 au total ; les plus récents sont gardés). Ces messages sont joints au message
  « user » avec la mention qu'il ne s'agit pas d'instructions : ils n'entrent jamais dans le prompt système. Si la lecture
  du salon échoue, le bot répond quand même, sans ce contexte. Rien à régler.
- **Silence** : dans un salon de réponse libre (jamais sur mention, où le bot répond toujours), le modèle peut appeler
  l'outil `stay_silent` avec une raison, par exemple s'il voit une discussion déjà en cours entre membres. Rien n'est alors
  envoyé. Le bot n'écrit aucun message dans le salon de logs, pour éviter le spam.
  - **Règles modifiables** : section « Règles de silence » du tableau de bord. L'interrupteur « Le bot peut se taire »
    désactive le silence (il répond alors à chaque message des salons libres). Le texte des règles (600 caractères maximum)
    est remplacé par celui de la zone ; vide, c'est le texte par défaut qui s'applique. « Rétablir le texte par défaut »
    vide la zone. La phrase qui demande d'appeler `stay_silent` est toujours ajoutée, pour que le mécanisme fonctionne.
- **Journal des décisions** : chaque réponse ou silence est enregistré (salon, membre, décision, raison, extrait du message).
  Il s'affiche sur le tableau de bord, section « Décisions récentes » (100 dernières, bouton Actualiser). Conservé **30 jours**,
  purgé automatiquement chaque heure. Stocké dans Supabase (table `edge_ai_decisions`, section 11 de `supabase/schema.sql`).
- **Graphe de réponse** : éditeur façon Unreal Engine.
  - **Déplacer la vue** : glisser sur le fond vide (clic gauche), clic droit, clic milieu, ou Espace maintenu + glisser ;
    molette pour zoomer ; `F` pour cadrer.
  - **Sélectionner** : clic sur un nœud (un clic sur le fond vide désélectionne) ; `Maj` + clic pour ajouter ou retirer ;
    `Maj` + glisser sur le fond dessine un rectangle de sélection ; `Ctrl+A` tout sélectionner. Glisser un nœud
    sélectionné déplace tout le groupe.
  - **Ajouter** : clic droit sur le fond, puis taper dans la recherche (« prix » trouve le nœud qui contient « prix » et le
    centre ; `Entrée` prend le premier résultat ; `Échap` ferme).
  - **Copier / coller** : `Ctrl+C`, `Ctrl+V` (collé à la souris), `Ctrl+D` (dupliqué, les fils entre les copies sont recréés).
  - **Annuler / rétablir** : `Ctrl+Z`, `Ctrl+Y` ou `Ctrl+Maj+Z`. Les déplacements d'un groupe et les frappes dans un même
    champ forment un seul pas.
  - Les broches sont grandes et la zone de prise déborde autour : on peut relier un fil sans viser exactement.
  - **Événements** (vrais ou faux pour chaque message) : *Mot-clé* (mots entiers, sans accents ni majuscules, 20 par nœud,
    50 caractères chacun), *Salon* (10 salons textuels au plus), *Bot mentionné*, *Le membre a un rôle* (au moins un des
    rôles choisis, 25 maximum), *Le message mentionne un rôle* (ping d'un des rôles choisis).
  - **Logique** : *ET* et *OU* acceptent de 2 à 6 entrées (réglage dans le panneau de détails ; les fils des entrées retirées
    sont supprimés), *NON*. Une entrée non branchée vaut faux. Une entrée ne reçoit qu'un seul fil ; les boucles sont refusées.
  - **Actions** : *Ajouter une consigne* (500 caractères) : ajoutée au prompt seulement si son entrée « si vrai » est vraie.
    *L'IA peut donner un rôle* : si son entrée est vraie, l'IA peut attribuer ces rôles (10 maximum) quand la personne le
    demande. Une consigne ou une action non branchée n'est **jamais** appliquée (l'éditeur l'indique).
  - Ordre d'application : de haut en bas, puis de gauche à droite. 60 nœuds et 150 fils au maximum.
  Le prompt complet (prompt + abréviations + toutes les consignes possibles) ne peut pas dépasser 12 000 caractères.
- **Donner un rôle** : l'outil `give_role` n'existe que si un nœud *L'IA peut donner un rôle* est actif pour le message. L'IA ne
  peut donner que les rôles de ce nœud, et seulement à la personne qui écrit, sans doublon. Refusés : `@everyone`, les rôles
  gérés par une intégration, les rôles **administrateur**, les rôles au-dessus de celui du bot, et tout rôle si le bot n'a
  pas « Gérer les rôles ». Le nom du rôle est confirmé par le bot ; l'IA ne doit pas promettre un rôle sans confirmation.
- **Mémoire des membres** (désactivée par défaut) : si elle est activée, la personne peut demander de retenir une information
  (« retiens que je préfère le thé ») ou d'oublier (« oublie ce que tu sais de moi »). Chaque personne a sa propre mémoire,
  de 5 à 50 notes (20 par défaut) de 200 caractères au maximum, mentions et `@everyone` neutralisés. Les notes sont
  stockées dans Supabase (table `edge_ai_memories`, section 10 de `supabase/schema.sql`) et se modifient ou s'effacent
  sur le tableau de bord, section « Mémoire des membres ».
- **Historique court** : les 3 derniers échanges (6 messages) d'un membre dans un salon sont gardés **en mémoire vive
  seulement**, pendant 30 minutes ; ils ne sont jamais écrits sur le disque ni dans Supabase. Un redémarrage les efface.
- **Outils** : au plus 2 tours d'outils par message ; ensuite le modèle doit répondre par du texte. « Tester avec Mistral » **simule** les outils :
  il affiche les actions demandées, sans rien enregistrer ni attribuer.
- **Stockage compact** : le graphe est enregistré sous la forme `{ n: [{ i, t, x, y, d }], w: [[nodeOut, pinOut, nodeIn, pinIn]] }`
  (`i` identifiant, `t` type, `x`/`y` position, `d` données, omis si vide). Le moteur est partagé par le navigateur et le
  serveur : `src/dashboard/public/ai-graph.js`.
- **Tester** : « Voir le prompt final » montre le prompt exact sans appel réseau ; « Tester avec Mistral » fait un appel réel
  (consomme des tokens). Les tests utilisent la version enregistrée : attends le statut « ✓ Enregistré » avant de tester.
- **Sauvegarde automatique** : chaque modification est enregistrée environ 1,2 s après la dernière action. Le statut en haut
  de la page indique « Enregistrement… », « ✓ Enregistré à HH:MM » ou « ⚠ Non enregistré (raison) ». Les modifications restent
  affichées en cas d'erreur et sont renvoyées à la modification suivante. Le navigateur demande confirmation si on ferme la page
  avant l'envoi. Une abréviation à moitié saisie n'est pas envoyée tant qu'elle est incomplète.
- **Plein écran** : bouton « Plein écran » dans la barre de l'éditeur ; `Échap` pour quitter (sauf si le menu d'ajout est ouvert).
- **Confidentialité** : le texte du membre part dans le message « user » ; il n'entre jamais dans le prompt système.
  La clé `MISTRAL_API_KEY` n'est jamais écrite dans le dépôt, ni affichée, ni journalisée.
- **Base de données** : la mémoire des membres demande la section 10 de `supabase/schema.sql` (table `edge_ai_memories`), et
  le journal des décisions la section 11 (table `edge_ai_decisions`). Les deux sections sont à exécuter une fois.
- `/config` → **IA (Mistral)** : activation rapide uniquement.

## Économie (Edge Dollar, $)

Monnaie virtuelle du serveur : l'**Edge Dollar**, symbole `$` (affiché après le montant : `250 $`). Aucune conversion en
argent réel.

- **`/play`** : panneau **public** (visible de tous) qui présente l'économie et la **banque du serveur**. Le bouton
  *Ouvrir mon compte* affiche, en privé, le tableau de bord du membre. Le premier `/play` ouvre la banque avec son
  montant initial (300 000 `$` par défaut). Sans compte, une courte animation donne le **solde de départ**, tiré au
  hasard entre 100 et 500 `$` (une seule fois par membre).
- **Tableau de bord** : solde « sur soi », rang, série, banque du serveur, et les boutons *Récompense quotidienne*,
  *Emprunter* / *Rembourser*, *Entreprises*. Le montant mis à l'abri en banque y apparaît aussi.
- **Récompense quotidienne** : bouton bleu *Récompense quotidienne* tant qu'elle est disponible ; une fois prise, il
  devient rouge *Récompense quotidienne déjà récupérée*. Montant de base 100 `$`, un passage toutes les 22 h ; la série
  continue si l'on revient dans les 48 h, avec +10 `$` par jour de série, plafonné à 100 `$` de bonus.
- **`/daily`** : même récompense, en commande (réponse privée).
- **Banque du serveur et emprunts** : un membre peut emprunter à la banque du serveur, dans la limite de **10 000 `$`**
  par emprunt, avec **10 % d'intérêts** fixes et un délai de **7 jours**. Un seul emprunt ouvert à la fois. Un emprunt de
  10 000 `$` coûte 11 000 `$` à rembourser ; le remboursement peut être partiel. Un emprunt en retard est seulement
  signalé. La banque ne peut prêter que ce qu'elle a en réserve.
- **`/rob @membre`** : tenter de voler l'argent **« sur soi »** d'un membre (jamais l'argent à la banque).
  - Une tentative toutes les **3 h** par voleur.
  - **Réussite** : le voleur prend entre **1 %** et **20 %** du solde de la victime. La chance de base est de **50 %**
    pour une victime qui a 1 000 `$` ; elle monte avec la fortune de la victime (+5 points à chaque multiplication par
    10, borné à ±20 points) et reste entre **5 % et 90 %**.
  - **Échec** : le voleur verse entre **50 et 100 `$`** à la victime (limité à son solde).
  - Le résultat est public dans le salon. Le délai, la chance, la part volée et l'amende se règlent sur le tableau de bord.
- **Entreprises** (bouton *Entreprises* du tableau de bord) : chaque membre peut créer **une** entreprise. Pour l'instant,
  le seul type est la **banque** ; un casino est prévu plus tard (le type est ajouté dans `economy-companies.js` et dans
  la base).
  - **Banque** : le patron crée des **abonnements** (5 au maximum), chacun avec un prix par jour et un **stockage**
    maximum par abonné. La banque a aussi un **montant maximum** qu'elle peut stocker pour l'ensemble de ses abonnés.
  - **Membres** : un abonnement, puis *Déposer* et *Retirer* dans le coffre. Un seul abonnement à la fois ; on ne peut
    pas déposer dans une autre banque tant qu'on a de l'argent dans celle-ci. *Résilier* arrête les prélèvements, mais
    l'argent reste protégé à la banque.
  - **Prélèvement quotidien** (minuit, heure de Paris) : le prix du jour est pris **sur le coffre** du membre et versé à
    la **trésorerie** de la banque. Si le coffre ne suffit plus, l'abonnement est résilié (l'argent reste à la banque).
  - **Frais du serveur** : chaque jour, le serveur prélève **0,1 %** du total stocké dans chaque banque, sur la
    trésorerie de la banque, et ces frais vont à la banque du serveur.
  - **Patron** : *Gérer mon entreprise* permet d'ajouter et de supprimer des abonnements, de changer la capacité
    maximale et de retirer la trésorerie vers son solde.
- **`/profile`** : carte PNG privée (avatar, solde, rang sur le serveur, série et prochaine récompense). Aucun montant d'XP.
- **`/leaderboard`** : classement du serveur en Edge Dollar, en PNG (top 10, du plus riche au moins riche). Le classement
  XP reste disponible avec `/leaderboard type:XP`.
- **Réglages** : nom et symbole de la monnaie, solde de départ (min/max), montants quotidiens, banque (montant initial),
  emprunts (maximum, intérêts, délai), vols (délai, chance de base, part maximum, amende) et frais des banques, sur le
  tableau de bord (page **Économie**). L'activation se fait dans `/config` → **Économie**.
- **Données** : soldes, journal, banque, emprunts, entreprises, abonnements et coffres dans Supabase (sections 12, 13 et
  14 de `supabase/schema.sql`). Chaque mouvement passe par une fonction SQL qui verrouille les lignes concernées : un
  double clic ne double jamais une récompense, un emprunt ni un vol ; l'argent total du serveur reste constant (le vol, le
  dépôt et le prélèvement ne font que déplacer l'argent).
- **Après une mise à jour** : exécuter les sections 12, 13 puis 14 de `supabase/schema.sql` dans Supabase, puis relancer
  `deploy-commands.js` (nouvelle commande `/rob`).

## Tests

`npm test` lance les tests automatisés (`tests/`, `node:test`) : module IA, validation, routes du tableau de bord,
client Mistral (stubbé), moteur de graphe, compression des sauvegardes. Aucun appel à Discord, Supabase ou Mistral n'est fait.

## Tableau de bord web (propriétaire uniquement)

Une interface web permet de gérer le bot depuis un navigateur : mêmes réglages que `/config`, plus les
aperçus, les listes (classement, suggestions, giveaways) et les envois (panneau de tickets, embed).

- **Adresse** : `https://<ton-service>.onrender.com/dashboard`
- **Accès** : mot de passe unique défini dans la variable `DASHBOARD_PASSWORD` (Render → Environment).
  Au moins 12 caractères, idéalement une phrase longue et aléatoire. Sans cette variable, le tableau de bord est désactivé.
- **Sécurité** : session de 12 h dans un cookie `HttpOnly` / `Secure` / `SameSite=Strict` ; 5 mots de passe faux
  depuis une même IP bloquent cette IP 15 min ; les requêtes qui modifient des données exigent un en-tête
  personnalisé et la même origine ; aucune clé ni aucun token n'est affiché.
- **Limite** : les sessions sont en mémoire. Après un redémarrage du service, il faut se reconnecter.
- **Pages** : Accueil, Bienvenue, Niveaux (aperçus et classement), Suggestions, Giveaways (liste, fin manuelle),
  Liens, Logs (réglages par catégorie et journal consultable), Modération (rôles par commande, MP, avertissements),
  Tickets (réglages, images/GIF, types, textes, publication du panneau), Créateur d'embed (brouillon,
  modèles, image importée, envoi), Sécurité et Rôles réaction (réglages et panneaux éditables), Sauvegardes (création,
  restauration avec double confirmation, activation quotidienne).
- **Compatibilité** : l'interface s'adapte aux téléphones, tablettes, portables et grands écrans. Elle fonctionne
  dans les navigateurs récents (Chrome, Edge, Firefox, Safari). Sur petit écran, la navigation passe en haut de page.
- **Création d'un giveaway** : toujours avec `/giveaway` dans Discord (le tableau de bord gère la liste et la fin anticipée).

Le code est dans `src/dashboard/` (serveur, validation, API) et `src/dashboard/public/` (interface, sans dépendance).

## Installation

Prérequis : Node.js 18.17 ou plus récent.

### 1. Créer l'application Discord

Sur le [Discord Developer Portal](https://discord.com/developers/applications) :

1. **New Application** → donne un nom (ex. « Edge »).
2. **Bot** → **Reset Token** → copie le token.
3. **Bot** → section *Privileged Gateway Intents* → active **MESSAGE CONTENT INTENT**
   (pièces jointes lors de l'import d'image / GIF) et **SERVER MEMBERS INTENT** (arrivée des membres, module Bienvenue).
4. **General Information** → copie l'**Application ID** (c'est le `CLIENT_ID`).
5. **OAuth2 → URL Generator** : coche les scopes `bot` et `applications.commands`, puis les permissions
   *View Channels*, *Send Messages*, *Manage Channels*, *Embed Links*, *Attach Files*, *Read Message History*.
   Ouvre l'URL générée et invite le bot sur ton serveur.

### 2. Créer la base Supabase

1. Dans ton projet Supabase : **SQL Editor → New query**, colle le contenu de `supabase/schema.sql`, puis **Run**.
   Ça crée la table `edge_module_configs` et le bucket de stockage `edge-assets`.
2. Récupère l'**URL du projet** (Project Settings → API → *Project URL*, de la forme `https://xxxx.supabase.co`)
   et la **clé service_role** (Project Settings → API → *service_role*).

> La clé `service_role` contourne toutes les règles de sécurité de Supabase. Ne la mets **que** dans les
> variables d'environnement de Render. Ne la commite jamais dans Git et ne la partage pas dans un chat.
> Si elle a été exposée, régénère-la dans Supabase (Project Settings → API).

### 3. Lancer en local (optionnel)

Node.js ne lit pas de fichier `.env` : exporte les variables dans ton terminal.

```bash
npm install
export DISCORD_TOKEN=...  CLIENT_ID=...  GUILD_ID=...
export SUPABASE_URL=https://xxxx.supabase.co  SUPABASE_SERVICE_ROLE_KEY=...
npm run deploy   # enregistre /config
npm start
```

## Déploiement sur Render (Web Service)

1. Sur [Render](https://dashboard.render.com) : **New → Web Service** et choisis le dépôt `Snowoo-2z/edge-bot`
   (et la branche à déployer).
2. Paramètres :
   - **Runtime** : Node
   - **Build Command** : `npm ci && npm run deploy`
   - **Start Command** : `npm start`
   - **Health Check Path** : `/health` (répond 200 seulement quand le bot est connecté à Discord ; sinon 503, et Render garde l'ancienne version en marche pendant le déploiement)
3. **Environment** : ajoute les variables suivantes (Render les chiffre pour les valeurs secrètes) :

   | Variable | Obligatoire | Valeur |
   |---|---|---|
   | `DISCORD_TOKEN` | oui | token du bot Discord |
   | `CLIENT_ID` (ou `DISCORD_CLIENT_ID`) | oui | Application ID de Discord |
   | `GUILD_ID` | non | ID du serveur (commande `/config` immédiate) |
   | `SUPABASE_URL` | oui | URL du projet Supabase |
   | `SUPABASE_SERVICE_ROLE_KEY` | oui | clé service_role Supabase |
   | `DASHBOARD_PASSWORD` | non | mot de passe du tableau de bord web (12 caractères minimum ; sans cette variable, `/dashboard` est désactivé) |
   | `MISTRAL_API_KEY` | non | clé API Mistral pour le module IA (sans elle : pas de réponse IA, le test du tableau de bord renvoie 503) |
   | `NODE_VERSION` | non | `22` |

4. **Create Web Service**. Le service écoute sur le port fourni par Render (`PORT`).

### Dépannage

- **« L'application ne répond plus » après `/config`** : le bot n'est pas connecté à Discord.
  Dans les logs Render, cherche `[discord] Intent privilégié refusé`. Dans le portail développeur
  (*Bot* → *Privileged Gateway Intents*), active **MESSAGE CONTENT INTENT** et **SERVER MEMBERS INTENT**,
  puis relance le service (*Manual Deploy* ou *Restart*).
- **`[discord] Toujours pas connecté 60 s`** : vérifie `DISCORD_TOKEN` (copie-le à nouveau si besoin).
- **`Démarrage impossible`** : le message indique la variable ou le service en cause (Supabase, etc.).

### Anti-veille (auto-ping)

Le plan gratuit de Render met le service en veille après environ 15 min sans requête entrante,
et une connexion WebSocket Discord ne compte pas comme trafic. Le bot s'envoie donc lui-même une
requête `GET /health` sur son URL publique (`RENDER_EXTERNAL_URL`, fournie automatiquement par Render)
**toutes les 10 minutes**. Rien à configurer. Les logs affichent `[keepalive] … → 200`.

### Données

Les réglages et les images/GIF sont stockés dans Supabase, pas sur le disque du service :
ils survivent aux redéploiements et redémarrages.

## Utiliser les tickets

### Plusieurs types de ticket (catégories)

Dans **Ticket → 🗂️ Types de ticket**, tu peux ajouter jusqu'à 25 types (ex. Support, Plainte, Partenariat),
chacun avec un nom, un emoji optionnel et une description optionnelle.

- **Ordre** : ouvre un type, puis utilise **⬆️ Monter** / **⬇️ Descendre**. L'ordre est le même dans la liste, dans le menu et sur le panneau.
- **Affichage** : bouton « Affichage » pour choisir **Boutons** (un bouton par type) ou **Menu déroulant**
  (un menu avec tous les types) sur le panneau.
- **Rôle à ping** : pour chaque type, le bouton **🔔 Rôle à ping** permet de choisir un rôle. À chaque ouverture
  de ticket de ce type, ce rôle est mentionné dans le salon. Le rôle doit être *mentionnable* (Paramètres du rôle) ou le bot
  doit avoir la permission *Mentionner @everyone, @here et tous les rôles*.
- **Sans type**, le panneau garde un seul bouton « Ouvrir un ticket ».
- Dans les textes du ticket, la variable `{type}` contient le nom du type choisi (ex. `ticket-{type}-{user}`).

1. Dans `/config` → Ticket → **📌 Publier le panneau** → choisis un salon.
2. Les membres cliquent sur le bouton du panneau : un salon privé est créé, visible par eux et par le bot.
3. Le bouton **Fermer le ticket** supprime le salon 5 secondes après.

> Les administrateurs du serveur voient tous les salons (comportement Discord normal).
> Pour donner accès à un rôle staff, il faut ajuster les permissions de la catégorie dans Discord.

## Structure

```
src/
  index.js              point d'entrée, routage des interactions
  server.js             serveur HTTP (/health) pour Render
  dashboard/index.js    tableau de bord web : accès (/dashboard), fichiers de l'interface
  dashboard/auth.js     mot de passe, sessions, blocage après échecs
  dashboard/api.js      routes JSON du tableau de bord (réglages, listes, envois, aperçus PNG)
  dashboard/validate.js validation des données (salons, rôles, textes, embed) selon les limites Discord
  dashboard/public/     interface (HTML, CSS, JavaScript sans dépendance)
  keepalive.js          auto-ping toutes les 10 min (anti-veille)
  config.js             commande /config et routage vers les modules
  deploy-commands.js    enregistrement de la commande auprès de Discord
  store.js              stockage Supabase (réglages + bucket d'images)
  ui.js                 helpers d'embeds (violet), boutons, menus
  welcome-image.js      génération de la carte de bienvenue (PNG)
  level-card.js         carte de niveau /level (PNG)
  leaderboard-card.js   carte du classement XP (/leaderboard type:XP, PNG)
  economy-card.js       cartes /profile et /leaderboard de l'économie (PNG)
  economy-money.js       montants de l'économie (affichage, saisie), partagés
  leveling.js           XP vocal et texte, niveaux, annonces, classement, sauvegarde Supabase
  modules/suggestions.js  commande /suggestion, votes de 3 jours, fermeture automatique
  modules/links.js      blocage des liens, rôles autorisés, avertissement
  modules/giveaways.js  commande /giveaway, participation, tirage au sort
  modules/economy.js    module Économie (monnaie, /play, /daily, emprunts, prélèvement des banques)
  modules/economy-companies.js  entreprises (banques) : création, abonnements, coffres, trésorerie
  modules/economy-rob.js        commande /rob (vol, chance, amende)
  xp-rules.js           valeurs de gain d'XP (vocal, texte)
  modules/registry.js   liste des modules affichés dans le menu
  modules/ticket.js     module Ticket (panneau, tickets, textes, images/GIF)
  modules/embed.js      module Créateur d'embed (brouillon, modèles, envoi)
  modules/welcome.js    module Bienvenue (réglages, aperçu, arrivées)
  modules/levels.js     module Niveaux (thème de la carte /level)
  modules/logs.js       module Logs (réglages, envoi groupé, écriture Supabase)
  log-events.js         écouteurs Discord alimentant le journal
  modules/moderation.js module Modération (rôles par commande, actions, avertissements)
  modules/reaction-roles.js module Rôles par réaction (panneaux, ajout et retrait de rôles)
  modules/security.js   module Sécurité (anti-raid, anti-nuke, liste blanche, alertes)
  backup.js             sauvegardes : capture, restauration non destructive, quotidienne, rétention 7
  server-info.js        commande /server
  audit.js              lecture du journal d'audit (logs et sécurité)
  moderation-commands.js définition des commandes /ban… /slowmode
  duration.js           lecture des durées (« 10m », « 1j 12h »)
assets/fonts/           polices Inter (carte de bienvenue)
supabase/schema.sql     tables et bucket à créer dans Supabase
```

Ajouter un module : créer `src/modules/<id>.js` (avec `render`, `handleComponent`, `handleModal`),
l'ajouter à `MODULE_LIST` (`registry.js`) et à `MODULES` (`config.js`).
