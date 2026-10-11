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
- **`/leaderboard`** : image PNG du top 10 du serveur (rang, pseudo, niveau, temps vocal), dans le thème des niveaux.

Thème de la carte : `/config` → **🏅 Niveaux**. Le thème par défaut est le **violet foncé**
(les mêmes thèmes que la carte de bienvenue sont disponibles).

**Annonces de niveau** (même module) : active le bouton **Annonces**, choisis le salon avec **Salon**,
et modifie le message avec **Message**. Par défaut : `Bravo à {user} qui passe {level}`.
Le message est envoyé en texte seul (sans image). `{user}` est mentionné, `{level}` est le niveau atteint.

> **Base de données** : exécute `supabase/schema.sql` dans le SQL Editor de Supabase (la section 3 crée la table
> `edge_levels`). Sans elle, le bot démarre mais l'XP n'est pas sauvegardé (un message l'indique dans les logs).
> Intent : `GuildVoiceStates` (non privilégié, rien à activer dans le portail).

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
  keepalive.js          auto-ping toutes les 10 min (anti-veille)
  config.js             commande /config et routage vers les modules
  deploy-commands.js    enregistrement de la commande auprès de Discord
  store.js              stockage Supabase (réglages + bucket d'images)
  ui.js                 helpers d'embeds (violet), boutons, menus
  welcome-image.js      génération de la carte de bienvenue (PNG)
  level-card.js         carte de niveau /level (PNG)
  leaderboard-card.js   carte du classement /leaderboard (PNG)
  leveling.js           XP vocal et texte, niveaux, annonces, classement, sauvegarde Supabase
  modules/suggestions.js  commande /suggestion, votes de 3 jours, fermeture automatique
  modules/links.js      blocage des liens, rôles autorisés, avertissement
  modules/giveaways.js  commande /giveaway, participation, tirage au sort
  xp-rules.js           valeurs de gain d'XP (vocal, texte)
  modules/registry.js   liste des modules affichés dans le menu
  modules/ticket.js     module Ticket (panneau, tickets, textes, images/GIF)
  modules/embed.js      module Créateur d'embed (brouillon, modèles, envoi)
  modules/welcome.js    module Bienvenue (réglages, aperçu, arrivées)
  modules/levels.js     module Niveaux (thème de la carte /level)
assets/fonts/           polices Inter (carte de bienvenue)
supabase/schema.sql     tables et bucket à créer dans Supabase
```

Ajouter un module : créer `src/modules/<id>.js` (avec `render`, `handleComponent`, `handleModal`),
l'ajouter à `MODULE_LIST` (`registry.js`) et à `MODULES` (`config.js`).
