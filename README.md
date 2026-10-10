# edge-bot

Bot Discord **Edge** : une seule commande de configuration, `/config`, qui ouvre un panneau
(menus + boutons) pour configurer les modules. Toutes les couleurs d'embed sont **violettes**.

## Fonctionnement de `/config`

1. `/config` ouvre un panneau privé (visible seulement par toi).
2. Tu choisis le **module** dans le menu déroulant (actuellement : **🎫 Ticket**).
3. Tu configures avec les boutons :
   - **Module / Image / GIF** : boutons ON (vert) / OFF (gris), un clic = bascule.
   - **📁 Catégorie** : catégorie où seront créés les tickets.
   - **📌 Publier le panneau** : choisis le salon où poster le panneau « Ouvrir un ticket ».
   - **🖼️ Importer image** / **🎞️ Importer GIF** : clique, puis envoie le fichier en pièce jointe
     dans le salon (2 min). Formats : image = PNG, JPG, WEBP, GIF ; GIF = GIF. Max 8 Mo.
     **🗑️ Retirer** supprime le fichier.
   - **✏️ Textes** : un bouton par texte. Clique, une fenêtre s'ouvre avec le texte actuel, modifie-le, valide.

### Textes modifiables (module Ticket)

Titre / description / bouton / footer du panneau, nom des salons, titre / description / footer
du salon ticket, bouton « fermer », et les messages (ticket créé, déjà ouvert, fermeture, désactivé).

Variables utilisables dans les textes :
- `{user}` : pseudo de l'utilisateur
- `{number}` : numéro du ticket
- `{channel}` : lien vers le salon du ticket (messages)

### Ce que font les images / GIF

- **Image** (ON) : affichée sur le panneau « Ouvrir un ticket ».
- **GIF** (ON) : affiché dans le salon du ticket, dans le message d'accueil.

## Installation

Prérequis : Node.js 18.17 ou plus récent.

### 1. Créer l'application Discord

Sur le [Discord Developer Portal](https://discord.com/developers/applications) :

1. **New Application** → donne un nom (ex. « Edge »).
2. **Bot** → **Reset Token** → copie le token.
3. **Bot** → section *Privileged Gateway Intents* → active **MESSAGE CONTENT INTENT**.
   (Indispensable pour recevoir les pièces jointes lors de l'import d'image / GIF.)
4. **General Information** → copie l'**Application ID** (c'est le `CLIENT_ID`).
5. **OAuth2 → URL Generator** : coche les scopes `bot` et `applications.commands`, puis les permissions
   *View Channels*, *Send Messages*, *Manage Channels*, *Embed Links*, *Attach Files*, *Read Message History*.
   Ouvre l'URL générée et invite le bot sur ton serveur.

### 2. Configurer le projet

```bash
npm install
cp .env.example .env   # puis remplis DISCORD_TOKEN, CLIENT_ID (et GUILD_ID pour tester)
npm run deploy         # enregistre la commande /config
npm start              # lance le bot
```

- `GUILD_ID` renseigné → la commande apparaît immédiatement sur ce serveur (recommandé pour tester).
- `GUILD_ID` vide → enregistrement global (peut mettre jusqu'à 1 h à apparaître).

Les réglages sont sauvegardés dans `data/store.json` et les fichiers importés dans `data/assets/`
(dossier ignoré par Git).

## Utiliser les tickets

1. Dans `/config` → Ticket → **📌 Publier le panneau** → choisis un salon.
2. Les membres cliquent sur le bouton du panneau : un salon privé est créé, visible par eux et par le bot.
3. Le bouton **Fermer le ticket** supprime le salon 5 secondes après.

> Les administrateurs du serveur voient tous les salons (comportement Discord normal).
> Pour donner accès à un rôle staff, il faut ajuster les permissions de la catégorie dans Discord.

## Déploiement sur Render

Le bot tourne comme **web service** Render (le serveur HTTP sert le health check `/health`).

### Mise en place

1. Pousse le code sur GitHub (branche `main` de préférence).
2. Sur [Render](https://dashboard.render.com) : **New → Blueprint** et choisis le dépôt `edge-bot`.
   Render lit `render.yaml` et crée le service `edge-bot`.
3. Renseigne les variables secrètes demandées :
   - `DISCORD_TOKEN` : token du bot
   - `CLIENT_ID` : Application ID
   - `GUILD_ID` (optionnel) : ID du serveur pour un enregistrement instantané de `/config`
4. Lance le déploiement. La commande de build est `npm ci && npm run deploy` (enregistre `/config`),
   et la commande de démarrage est `npm start`.

Ou sans Blueprint : **New → Web Service**, runtime Node, build `npm ci && npm run deploy`,
start `npm start`, health check path `/health`, puis les mêmes variables d'environnement.

### Anti-veille (auto-ping)

Le plan gratuit de Render met le service en veille après environ 15 min sans requête entrante,
et une connexion WebSocket Discord ne compte pas comme trafic. Le bot s'envoie donc lui-même une
requête `GET /health` sur son URL publique (`RENDER_EXTERNAL_URL`, fournie automatiquement par Render)
**toutes les 10 minutes**. Rien à configurer. Les logs affichent `[keepalive] … → 200`.

### Données (important)

Sans disque persistant, Render efface le système de fichiers à chaque redéploiement ou redémarrage :
les réglages (`store.json`) et les images/GIF importés seraient perdus.
Pour les conserver : ajoute un **Render Disk** (plan payant) et décommente la section `disk` /
`DATA_DIR` dans `render.yaml`.

## Structure

```
src/
  index.js              point d'entrée, routage des interactions
  server.js             serveur HTTP (/health) pour Render
  keepalive.js          auto-ping toutes les 10 min (anti-veille)
  config.js             commande /config et routage vers les modules
  deploy-commands.js    enregistrement de la commande auprès de Discord
  store.js              sauvegarde JSON (data/store.json)
  ui.js                 helpers d'embeds (violet), boutons, menus
  modules/registry.js   liste des modules affichés dans le menu
  modules/ticket.js     module Ticket (panneau, tickets, textes, images/GIF)
```

Ajouter un module : créer `src/modules/<id>.js` (avec `render`, `handleComponent`, `handleModal`),
l'ajouter à `MODULE_LIST` (`registry.js`) et à `MODULES` (`config.js`).
