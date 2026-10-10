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
   - **Health Check Path** : `/health`
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

- **Affichage** : bouton « Affichage » pour choisir **Boutons** (un bouton par type) ou **Menu déroulant**
  (un menu avec tous les types) sur le panneau.
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
supabase/schema.sql     tables et bucket à créer dans Supabase
  store.js              stockage Supabase (réglages + bucket d'images)
  ui.js                 helpers d'embeds (violet), boutons, menus
  modules/registry.js   liste des modules affichés dans le menu
  modules/ticket.js     module Ticket (panneau, tickets, textes, images/GIF)
```

Ajouter un module : créer `src/modules/<id>.js` (avec `render`, `handleComponent`, `handleModal`),
l'ajouter à `MODULE_LIST` (`registry.js`) et à `MODULES` (`config.js`).
