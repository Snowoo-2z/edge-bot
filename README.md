# Edge — le bot du serveur 1558076024778919946

Bot Discord **français**, taillé pour ton serveur : structure (rôles, salons, permissions),
accueil, tickets, modération, partenariats, recrutement, animation. Rien ne part dans tous les sens —
`src/manifest.ts` est la seule endroit où existent les noms de rôles, de salons et les permissions.
Les modules ne connaissent que des **clés** (`'mod'`, `'annonces'`), jamais des identifiants snowflake.

> 30 salons, 11 rôles, 23 modules. Tout est vérifié par `npm run dry` **sans** se connecter à Discord.

---

## 1. Démarrer (5 minutes)

```bash
npm install
cp .env.example .env       # puis colle DISCORD_TOKEN et DATABASE_URL
npm run db:migrate         # applique migrations/*.sql sur Supabase
npm run dry                # simulation : Edge te dit s'il voit bien ton serveur
npm run build && npm start
```

Sans token, `npm run dev` refuse de démarrer et te dit pourquoi (c'est voulu : pas de crash muet).

### `.env`

| variable | à quoi elle sert |
| --- | --- |
| `DISCORD_TOKEN` | Jeton (Developer Portal → Bot → Token). **Jamais** commité : `.env` est dans `.gitignore`. |
| `GUILD_ID` | ID du serveur géré. Edge refuse tout ailleurs. Défaut : `1558076024778919946`. |
| `DATABASE_URL` | **URL de connexion Postgres** de Supabase (Project settings → Database → *Connection string*). **Pas** une clé `service_role`/`anon` : `pg` parle le protocole Postgres, pas le HTTP de l'API. Vide (ou mal formée) = Edge tourne en mémoire et le dit dans les logs. |
| `EDGE_DRY_RUN` | `true` = ne se connecte pas, simule la structure et rapporte. |
| `EDGE_REQUIRE_MESSAGE_CONTENT` | `true` (défaut) = exige l'intent Message Content (automod, XP). À `false`, ces modules se désactivent et le reste marche. |
| `EDGE_LOG_LEVEL` | `debug` / `info` / `warn` / `error`. |

### Supabase : la bonne chaîne, pas la clé

`DATABASE_URL` doit ressembler à **une des deux lignes suivantes** (les deux marchent, Edge
détecte le pooler tout seul) :

```
# 1) Connexion DIRECTE — sans pooler, ce que tu demandes
postgres://postgres:[MOT_DE_PASSE]@db.[REFERENCE].supabase.co:5432/postgres

# 2) Transaction pooler (port 6543) — si les IP de Render te jouent des tours
postgres://postgres.[REFERENCE]:[MOT_DE_PASSE]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
```

Le piège, c'est **quel mot de passe**. Celui de la **base** : dashboard Supabase →
*Project Settings → Database → Reset database password* → tu en choisis un → tu le colles dans
l'URL. La clé **`service_role`** (une longue chaîne qui commence par `eyJ…`) sert à l'API REST et
à `supabase-js` : pour `pg`, elle ne veut rien dire. Edge la reconnaît désormais et écrit
exactement ça dans les logs au lieu d'un « invalid connection » obscur — et il démarre quand même,
en mémoire, pour que tu puisses tester pendant que tu corriges.

Avec la connexion **directe** (5432), deux réglages d'un clic côté Supabase, sinon Render se fait
jeter : *Project Settings → Database → Network limits* → **« Allow IPv4 connections »** activé, et
**pas d'IP allowlist** restrictive (Render n'a pas d'IP fixe). Edge ouvre au plus 4 connexions ;
la limite gratuite est plus large que ça. Le port 6543, lui, marche avec l'allowlist fermée —
c'est la roue de secours, pas le choix par défaut.

Sans base du tout, Edge tourne aussi : tickets, points et giveaways fonctionnent, mais
**tout est oublié au redémarrage**. C'est utile pour la première heure, pas pour vivre dessus.

### Dans le Developer Portal

Coche **Server Members Intent**, **Message Content Intent**, **Guild Moderation**. L'intent Message Content
est privilégié : sans lui, `automod`, `levels`, `antiraid` et la modération de texte se coupent d'eux-mêmes,
les 19 autres modules tournent.

### L'invite

`npm run dry` n'affiche pas le lien ; la commande `/edge invite` le donne, et il demande
**exactement** les permissions du manifeste (pas d'Administrateur). Le rôle **Edge** doit être
**au-dessus de 💼│ Manager Partenariat et en dessous de ⚔️│ Modérateur** — c'est `/audit structure`
qui te le dit si tu t'es trompé de cran.

---

## 2. Ce qu'il fait

| module | commandes / comportement |
| --- | --- |
| `welcome` | `/bienvenue texte｜contenu｜test｜membre｜stats` — ping d'arrivée dans 👋│・Bienvenue + rôle 👤│ Membre, relance d'onboarding, rattrapage de rôles |
| `rules` | `/reglement statut｜texte｜contenu｜recharger｜aide` — panneau 📌, acceptation par bouton, 3 refus → alerte staff |
| `presentation` | `/presentation statut｜valider｜relancer｜manquantes` — formulaire, relecture staff, purge après 3 passages |
| `selfroles` | `/selfroles etat｜voir` + un seul multi-select pour 🎁/🤝 Notification |
| `tickets` | `/ticket voir｜fermer｜ajouter｜enlever｜liste` — 6 motifs, salon `t-0042-pseudo`, transcription HTML en archive puis suppression |
| `moderation` | `/mod avertir｜note｜historique｜dossier｜conseil｜purge｜sanction｜timeout｜untimeout｜kick｜ban｜unban｜pardon` — barème et points recalculés à chaque fois |
| `automod` | `/automod regles｜couper｜reactiver｜test｜stats` — invitations, webhooks, tokens, ping de masse, flood, doublons, zalgo → échelle 1/3/4/5/7 hits |
| `antiraid` | `/raid statut｜lock｜unlock｜seuil` — rafale de joins, verrouillage puis **restauration à l'identique** des surcharges |
| `reports` | `/signaler <membre> <motif> <lien>` — ticket privé + miroir 🚨, 3 signalements « sans fondement » → warn |
| `audit` | `/audit structure｜ping｜perms｜recent｜promesses` + job hebdo de dérive |
| `giveaway` | `/giveaway demarrer｜list｜finir｜annuler｜reroll｜gagnants｜anciennete` — participation par bouton, tirage pondéré |
| `polls` | `/sondage nouveau｜list｜finir` — utilise les **sondages natifs** Discord (comptage géré par Discord) |
| `boosts` | `/boosts statut` — rôle ✨│ Booster synchronisé, relances aux paliers 7/14/25 |
| `announcements` | `/annonce publier｜programme｜lister｜annuler` — aperçu puis confirmation, publication par Edge |
| `events` | `/event creer｜liste｜annuler｜inscrits` — événements planifiés Discord + boutons RSVP, rappel 15 min avant |
| `suggestions` | `/suggestion nouvelle｜statut｜top` — fils de discussion par suggestion, réactions 👍/👎 |
| `invites` | `/invites top｜voir｜resync` — attribution par écart de compteurs d'invitations |
| `partnership` | `/partenariat candidature｜auditer｜accepter｜refuser｜reciprocite｜lier｜rompre｜lister` |
| `recruitment` | `/recrutement poste｜lister｜candidater｜retirer` — formulaire, verdict en MP, relance à J+30 |
| `levels` | `/rang voir｜top｜reglages` — XP sans cooldown, comme demandé |
| `voice` | `/vocal top｜temp｜inactivite｜couper` — mute (pas kick) les absents, supprime les salons ⌛ restés vides |
| `botadmin` | `/edge module｜flag｜sante｜structure｜panneaux｜stats｜invite｜maintenance` |
| `help` | `/aide [module]` — le mode d'emploi de chaque module, directement dans Discord |

### Interrupteurs (`/edge flag <clé> [valeur : vrai｜faux]`, ou la table `flags` en base)

`antiraid.auto` (off par défaut — verrouiller un serveur tout seul est trop lourd pour être actif sans feu),
`rules.gate` (off), `levels.announce` (off), `invites.announce`, `invites.allowSelf`, `voice.kickIdle`,
`audit.post`, `bot.maintenance`, et `module:<clé>` pour éteindre un module entier sans redémarrer.

---

## 3. Vérifier, sans token

```bash
npm run typecheck   # 0 erreur
npm test            # 30 tests purs : barèmes, tirage pondéré, détecteurs, permissions, structure, db
npm run dry         # 8 scénarios de serveur (conforme, salon renommé, rôle oublié, fuite @everyone…)
```

`npm run dry` est le truc utile avant de poser le bot : il fabrique un faux serveur à partir du manifeste,
le passe dans le vrai resolveur et le vrai rapport d'écart, et te montre **quels modules se coupent** et
**pourquoi**. Un salon `💬│・Discussion` renommé en `💬│・Chat` ne casse que le module qui en a besoin.

## 4. Déployer gratuitement (le bot doit tourner 24 h/24)

Un bot Discord n'est **pas** un site web : il tient une connexion sortante en permanence,
et n'a **aucun** trafic entrant. Les plateformes qui dorment sans trafic entrant le
déconnectent donc en 15 minutes. C'est le seul vrai piège du sujet — et c'est pour ça
qu'Edge ouvre une sonde HTTP dès qu'on lui donne un `PORT` : `GET /health` répond 200 dès
la première seconde, `GET /ready` seulement quand Discord et la base sont bons.

**État du gratuit en octobre 2026** (vérifié sur les pages de prix, pas sur des blogs de 2024) :

| Plateforme | Vraiment gratuit ? | Verdict pour Edge |
| --- | --- | --- |
| **Northflank** (plan **Sandbox**) | **oui**, vérifié sur leur page de prix : « *Always-on-compute — no sleeping :)* », 2 services + 1 base + 2 cron gratuits | **Le successeur direct de Koyeb : c'est lui qu'il te faut.** CB demandée pour vérifier l'identité (0 € débité). Il build depuis le `Dockerfile` du repo : aucun fichier de config à écrire. |
| **Oracle Cloud — Always Free** | oui : VM ARM 2 OCPU / 12 Go à vie (rabaissée en juin 2026) | Le plus solide, et le seul gratuit qu'**aucun rachat ne peut te retirer**. CB + un peu de Linux. `sudo bash deploy/vps.sh`. |
| **Un Raspberry Pi ou un vieux PC portable** | oui, 0 €, et ça dort jamais si tu le laisses branché | `deploy/vps.sh` fait exactement ça. C'est l'option « je ne donne ma CB à personne ». |
| **Render** (free) | oui, **sans CB**, 512 Mo, 750 h/mois | Dort après 15 min sans trafic entrant — **mais Edge est déjà câblé pour ça** : autoping interne (Render lui donne son URL) + workflow GitHub toutes les 5 min. C'est l'option choisie ici, voir plus bas. |
| **Railway** | essai 5 $ (30 jours), puis 1 $/mois | 1 $/mois ne couvre pas un 24/7 : compte ~5 $/mois. Le déploiement le plus simple, si tu veux en finir en 5 minutes. |
| **Fly.io** | non : plus d'allocation gratuite (essai 2 h de VM), CB | ~2 $/mois. `fly.toml` fourni, avec `auto_stop_machines = "off"` (sans ça, il s'endort). |
| **Koyeb** | **non — fermé** | Racheté par Mistral le 17 février 2026 : le plan Starter gratuit est supprimé pour les nouveaux, entrée à 29 $/mois + CB (empreinte de 29 $). Les anciens comptes Starter gardent leurs conditions. |
| les « free bot hosting » (Pterodactyl, 128-256 Mo) | oui | Trop juste pour 23 modules, renouvellements maniaques, et surtout : **l'hébergeur lit ton token**. |

### Northflank en 8 étapes (ma reco)

1. Developer Portal → ton app → **Bot** : coche `Server Members Intent`, `Message Content
   Intent`, `Guild Moderation Intent`, puis copie le **token**.
2. northflank.com → *Sign up with GitHub* → **Create new project** (le plan Sandbox est à 0 € ;
   ils demandent une CB pour vérifier l'identité, rien n'est débité).
3. Dans le projet → **Create service** → **Run service** → *Deploy from Git provider* →
   `Snowoo-2z/edge-bot`, branche `main`. Source type : **Docker** (le `Dockerfile` du repo est
   détecté, region de build au choix).
4. Plan de compute : prends **`nf-compute-20`** (0,2 vCPU / **512 Mo**). `nf-compute-10`
   (256 Mo) fait tourner Edge mais sans aucune marge — un giveaway à 300 participants ou
   un `/audit structure` complet peut le faire sortir de ses gonds. La sonde `/health`
   renvoie `ramMb` : c'est là que tu vois la vraie conso, en direct.
5. **Advanced → Environment variables** :
   ```
   DISCORD_TOKEN   = <ton token>
   DATABASE_URL    = <Supabase → Project Settings → Database → Connection string, directe 5432 : postgres://postgres:[MOT_DE_PASSE]@db.[REF].supabase.co:5432/postgres — le mot de passe de la BASE, pas une clé>
   GUILD_ID        = 1558076024778919946
   EDGE_REQUIRE_MESSAGE_CONTENT = true
   PORT            = 8080
   ```
   Chez Northflank le port n'est **pas** injecté automatiquement : c'est toi qui le fixes,
   et il doit correspondre à celui du `Dockerfile` (`EXPOSE 8080`).
6. **Add exposed port** (ou *Ingress*) : port `8080`, visibilité **interne** suffit — le bot
   n'a besoin de personne côté entrant. Puis **Health check** : port `8080`, path `/health`,
   délai initial 45 s, intervalle 60 s.
7. **Deploy**. Si le dashboard dit « no capacity » dans la région gratuite, change de région
   (Paris/Francfort) et relance : c'est un souci de quota, pas de config.
8. Ouvre l'URL du service suivie de `/health` : `"pret": true` = les commandes arrivent.

### Render (gratuit, sans CB) — le chemin que j'ai câblé en priorité

Deux couches d'autoping, **aucun réglage à faire de ta part** pour la première :

1. **Interne** : Render injecte `RENDER_EXTERNAL_URL` (l'URL publique du service). Edge la
   détecte tout seul et se tape `…/health` **toutes les 4 minutes** → l'horloge d'inactivité
   de Render (15 min) ne va jamais au bout, et le service reste éveillé. Tu le vois dans les
   logs : `autoping toutes les 4 min → https://<service>.onrender.com/health`.
2. **Externe** (le filet) : un process *déjà* endormi a son minuteur gelé avec lui, donc
   lui-même ne peut pas le réveiller. C'est le rôle de
   **`deploy/autoping-github.yml`** (a copier dans `.github/workflows/edge-autoping.yml`) :
   GitHub, gratuitement, appelle `/health` toutes les 5 minutes et réveille le service apres
   un redemarrage, un crash ou un deploiement rate. Sans copie, le fichier dort : il ne casse
   rien. Pour l'installer :
   1) `mkdir -p .github/workflows && cp deploy/autoping-github.yml .github/workflows/edge-autoping.yml && git push`
      (ou via le site : *Add file → Create a new file*, chemin exact `.github/workflows/edge-autoping.yml`) ;
   2) *Settings → Secrets and variables → Actions → Variables repository* →
      **`EDGE_HEALTH_URL`** = `https://<ton-service>.onrender.com/health`.

En chiffres : instance free = **0,1 CPU / 512 Mo**, et Edge au repos en occupe **~87 Mo**
(`/health` → `ramMb`) ; 750 h/mois de temps d'instance, un service 24/7 en consomme 744.
Ça passe, sans marge : **ne crée pas un second service gratuit sur le même compte.**

Pas-à-pas :

1. Developer Portal → ton app → **Bot** : coche `Server Members Intent`, `Message Content
   Intent`, `Guild Moderation Intent` → copie le **token**.
2. Render → **New + → Web Service** → connecte `Snowoo-2z/edge-bot` (branche `main`).
3. **Runtime : Node** (ou **Docker** si tu préfères l'image — les deux marchent, le repo a
   les deux configs). Render lit `render.yaml` tout seul : région **`frankfurt`** (seules
   valeurs possibles : `oregon`, `ohio`, `virginia`, `frankfurt`, `singapore`), plan
   **`free`** (0,1 CPU / 512 Mo), build `npm ci && npm run build`, start
   `node dist/index.js`, health check `/health`.
4. **Environment variables** (les deux `sync: false` du blueprint te seront demandés) :
   ```
   DISCORD_TOKEN   = <ton token>
   DATABASE_URL    = <Supabase → Project Settings → Database → Connection string, directe 5432 : postgres://postgres:[MOT_DE_PASSE]@db.[REF].supabase.co:5432/postgres — le mot de passe de la BASE, pas une clé>
   GUILD_ID        = 1558076024778919946
   EDGE_REQUIRE_MESSAGE_CONTENT = true
   ```
   **Ne touche pas à `PORT`** : Render le fournit (défaut 10000) et Edge écoute dessus.
5. **Create Web Service** → attends ~2 min → ouvre `https://<service>.onrender.com/health`.
   `"pret": true` = les commandes `/edge` `/aide` `/ticket` répondent dans Discord.
6. Si au bout d'un moment le bot semble muet : `curl https://<service>.onrender.com/ready`
   et regarde les logs. Un `503` avec `"raison"` te dit exactement quoi (base injoignable,
   serveur pas visible, Discord coupé) — ce n'est presque jamais l'endormissement, maintenant.

Deux choses qui font gagner des heures :

- **Le health check ne peut pas te trahir** : Edge ouvre son port *avant* de se connecter à
  Discord, donc `/health` répond 200 dès que le conteneur démarre, même si Discord est en
  panne ou si tu n'as pas encore invité le bot. Pas de déploiement marqué « échoué » pour
  rien, pas de redémarrages en boucle, donc pas de commandes slash qui sautent.
- **Ne mets pas `PORT` dans les variables** : Render le fournit (défaut 10000) et Edge écoute
  dessus automatiquement. Le mettre à la main avec une valeur bidon est la panne n°1 de ce
  type de déploiement.

### VPS gratuit (Oracle) ou machine à la maison

```bash
git clone https://github.com/Snowoo-2z/edge-bot /tmp/edge && cd /tmp/edge
sudo bash deploy/vps.sh          # node 22 + utilisateur dédié + systemd, et c'est tout
nano /etc/edge-bot.env           # DISCORD_TOKEN + DATABASE_URL
sudo bash deploy/vps.sh          # relance : cette fois il démarre
journalctl -u edge-bot -f        # les logs en direct
```

Ou en Docker, n'importe où :

```bash
docker compose up -d --build
# ou sans fichier :
docker build -t edge-bot . && docker run -d --name edge --restart unless-stopped --env-file .env edge-bot
curl localhost:8080/health
```

### Edge ne meurt pas si Discord tousse

Une coupure Discord, un serveur pas encore invité, une base qui met 3 s à répondre : ce n'est
pas fatal. Le processus **reste vivant**, `GET /health` répond 200 avec la raison honnête
(`"raison": "Discord injoignable : …"`), `GET /ready` répond 503 tant que ce n'est pas prêt,
et Edge réessaie avec un retard qui grandit (5 s → 15 s → 30 s → 1 min → 2 min → 5 min).
Une plateforme qui voit `/health` en vie ne redémarre pas le service, donc **les commandes
slash ne sautent pas** et le bot se rattrape tout seul dès que Discord revient — y compris
si tu l'invites pendant qu'il attend.

`/health` rend aussi la mémoire (`ramMb`) : sur un plan gratuit à 512 Mo, un kill silencieux
pour dépassement de RAM est l'accident le plus probable, et il se lit là.

### Ce que Edge fait déjà tout seul quand il est posé

- **Migrations** : `boot()` applique `migrations/*.sql` au démarrage — pas d'étape SQL à la main.
- **Redémarrages** : SIGTERM est écouté (l'ordonnanceur et la sonde se ferment proprement) ;
  les jobs à venir vivent dans `scheduler_jobs`, donc un `kill` en plein giveaway ne perd rien.
- **Commandes slash** : laissées en place, resynchronisées si le manifeste a changé.
- **Base injoignable** : les modules stockés se coupent, le reste tourne, `/health` l'écrit noir sur blanc.

### Le token, sérieusement

Le token ne vit que dans les variables d'environnement de la plateforme (et dans `.env`,
ignoré par Git). Quiconque le lit peut faire **tout ce que le rôle Edge permet** : bannir,
supprimer des salons, changer les permissions. S'il a été collé quelque part, dans un
ticket, un canal, un historique de commit → Developer Portal → **Reset Token**, puis
`systemctl restart edge-bot` (ou « Redeploy » chez l'hébergeur).

## 5. Ce que Edge ne fera pas (et pourquoi c'est mieux)

- **Pas de bannissement automatique sur un compteur.** L'automod s'arrête à `ban_suggest` ; le ban reste une décision humaine.
- **Pas de rôle staff accordé tout seul.** `/recrutement` prepare, notifie, relance à J+30 — c'est toi qui donnes le rôle.
- **Pas d'Administrateur.** Les permissions demandées sont exactement celles du manifeste ; `/audit perms` compare les deux.
- **Il ne recrée pas ton serveur.** Edge lit la structure, signale les écarts, et ne touche aux surcharges que si tu le lui demandes (`/raid unlock`, `/audit structure`).

## 6. Quatre détails à connaître

1. Les rôles `🎁│ Notification Giveaway` et `🤝│ Notification Partenariat` sont **non-mentionnables** par les membres (c'est bien). Pour qu'Edge puisse les ping, il a `MentionEveryone` + `ManageRoles`. Si un humain tente le ping à la main, Discord l'ignore — c'est normal, passe par les commandes.
2. `💼│ Manager Partenariat` n'a pas le droit d'écrire dans 📣│・Annonces (lecture seule pour tout le monde sauf staff). Edge publie donc **l'annonce de partenariat à sa place**, avec le ping 🤝.
3. Attribution des invitations : Edge ne peut créditer que les liens **qu'il voit** (invites créées après un `/invites resync`, non expirées). Un lien créé avant son arrivée est incomptable — d'où `/invites resync`.
4. Réciprocité d'un partenaire : Edge ne peut lire le serveur d'à côté **que s'il y est**. Sinon le contrôle hebdo marque « non vérifiable » et un Manager tranche avec `/partenariat reciprocite`.

## 7. Organisation du code

```
src/manifest.ts        rôles, salons, catégories, ACL attendues, permissions du bot : LA source de vérité
src/core/              client, dispatch (slash + composants + jobs), structure (resolveur + rapport d'écart),
                       permmodel (modèle pur des permissions), db, send, ui, copy (textes), logs, panels
src/logic/             barèmes, détecteurs, tirage pondéré — pur, testable, sans discord.js
src/modules/           23 modules, même forme : commandes / composants / listeners / jobs / sync
src/db/                Db (pg + mémoire), migrate
src/dryrun/            faux serveur + harnais de simulation (npm run dry)
Dockerfile             image node:22-alpine non-root, pour Northflank/Fly/Railway/Render/compose
deploy/                unit systemd + installeur VPS (Ubuntu 24.04, Oracle Always Free, RPi)
render.yaml fly.toml railway.json docker-compose.yml   un fichier de config par hébergeur
migrations/            0001_init.sql — 20 tables
tests/run.ts           harnais de tests maison
```

Un module qui demande un salon absent n'explose pas : il se **désactive**, et `/edge sante` explique pourquoi.
