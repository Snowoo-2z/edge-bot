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
cp .env.example .env       # puis colle DISCORD_TOKEN + les 2 valeurs Supabase
                             # le schéma se colle dans Supabase (voir § Supabase ci-dessous) ;
# npm run db:migrate ne sert que si tu tiens à la connexion directe par DATABASE_URL
npm run dry                # simulation : Edge te dit s'il voit bien ton serveur
npm run build && npm start
```

Sans token, `npm run dev` refuse de démarrer et te dit pourquoi (c'est voulu : pas de crash muet).

### Les variables d'environnement, une par une

**Il en faut 4.** Le reste est du réglage fin. Sur Render : *ton service → Environment → Add
Environment Variable* (saisis `Key` et `Value`, puis pour les deux premières clique le bouton
**« Tooggle as secret »** pour que la valeur soit masquée) → **Save** : Render relance un
déploiement tout seul, ~2 min.

#### 1 · Obligatoires

| variable | où trouver la valeur | si elle est fausse |
| --- | --- | --- |
| **`DISCORD_TOKEN`** | [discord.com/developers/applications](https://discord.com/developers/applications) → ton app → **Bot** (colonne de gauche) → *Reset Token* → *Copy*. **Affiché une seule fois.** | `DISCORD_TOKEN refusé` dans les logs, et rien d'autre ne démarre. Un token révoqué = le bot se déconnecte dans la minute. |
| **`SUPABASE_URL`** | L'URL de ton projet, celle de la barre d'adresse du dashboard : `https://**abcdefghijklmnop**.supabase.co` → ne garde que `https://<réf>.supabase.co`. Même valeur ailleurs : *Project Settings → Data API & Authentication* (ou *API*) → **Project URL** / **Default** tab. | Edge ignore la base et démarre en mémoire : il écrit « config Supabase incomplète » et tu perds tout au redémarrage. |
| **`SUPABASE_SERVICE_ROLE_KEY`** | *Project Settings → API Keys* → la ligne **`service_role`**, bouton *Reveal* puis *Copy* (sur les anciens projets : *Project Settings → API* → **Secret keys**). Elle commence par `eyJ…`. | 401/403 à la première écriture. Edge lit le **rôle dans le JWT** : si tu as pris la clé `anon`, il te le dit avant la première écriture au lieu d'essayer. |

`GUILD_ID` a une valeur par défaut (`1558076024778919946`) : ne la change que si tu changes de
serveur. Pour la relire : Discord (bureau) → *Paramètres → Avancé → Mode développeur* on → clic
droit sur le nom du serveur → **Copier l'identifiant du serveur**.

#### 2 · La base, options

| variable | défaut | à quoi elle sert |
| --- | --- | --- |
| `SUPABASE_SCHEMA` | `public` | Uniquement si ton projet PostgREST expose un autre schéma (projet auto-hébergé, multi-tenant). Envoie alors aussi l'en-tête `Accept-Profile`/`Content-Profile`. |
| `DATABASE_URL` | vide | **Alternative** à la voie API : une URL Postgres (`postgres://…`) pour `pg`. **Dès que `SUPABASE_URL` est rempli, cette variable est ignorée.** À laisser vide, sauf si tu veux `npm run db:migrate` automatique ou desagrée le pooler. |

#### 3 · Comportement du bot

| variable | défaut | effet |
| --- | --- | --- |
| `EDGE_REQUIRE_MESSAGE_CONTENT` | `true` | Demande l'intent *Message Content*. Si tu ne l'as **pas** activé dans le Developer Portal, passe-la à `false` : `automod`, `levels`, `antiraid` se coupent d'eux-mêmes et les 20 autres modules tournent (sinon Discord refuse la connexion). |
| `EDGE_DRY_RUN` | `false` | `true` = ne se connecte pas, simule la structure et rapporte l'écart (équivalent de `npm run dry`). Utile sur Render pour valider la base sans toucher au serveur. |
| `EDGE_LOG_LEVEL` | `info` | `debug` | `info` | `warn` | `error`. En `debug`, les logs Render deviennent bavards mais chaque décision de modération est tracée. |

#### 4 · Sonde de vie et autoping (ne rien régler sur Render)

| variable | défaut | effet |
| --- | --- | --- |
| `PORT` | **fourni par Render** (10000) | Edge y branche `/health`. **Ne le saisis surtout pas dans Render** : une valeur fixe et le routeur ne retrouve plus ton service → déploiement « en échec ». À mettre seulement si tu remontes un port à la main (Northflank : `PORT=8080`). |
| `EDGE_HEALTH` | `false` | Force la sonde sur 8080 **en local**, pour la tester sans hébergeur (`curl localhost:8080/health`). |
| `KEEPALIVE_URL` | déduit de `RENDER_EXTERNAL_URL` | Cible de l'autoping. Inutile sur Render. Sert sur un autre hébergeur, ou pour surveiller une supervision. |
| `EDGE_KEEPALIVE_MINUTES` | `4` | Période de l'autoping. 4 min = cinq fois plus court que le seuil d'inactivité de Render (15 min). Ne descends pas sous 1. |

Et **celles-là, tu ne les mets jamais** : la plateforme les injecte, Edge les lit tout seul —
`RENDER`, `RENDER_EXTERNAL_URL`, `FLY_APP_NAME`, `RAILWAY_ENVIRONMENT_NAME`,
`NORTHFLANK_APP_NAME`. Les définir à la main risque de faire croire à Edge qu'il est ailleurs.

Une cinquième variable existe, **côté GitHub et non côté bot** : `EDGE_HEALTH_URL`, en *variable de
dépôt* (Settings → Secrets and variables → **Actions** → *Variables repository*) = l'URL complète
`https://<service>.onrender.com/health`. Elle sert au filet externe `deploy/autoping-github.yml`.

#### Les trois pièges de saisie, dans l'ordre de fréquence

1. **des guillemets ou un espace en trop.** Render ne retire ni `"` ni l'espace final : la clé
   « `eyJx… ` » est invalide et 401. Colle la valeur brute, sans rien autour.
2. **le préfixe en trop.** `Authorization: Bearer …` est ajouté par Edge : ne colle **ni**
   `Bearer `, **ni** `apikey=` **ni** le chemin `/rest/v1` dans `SUPABASE_URL`.
3. **la clé masquée non révélée.** Le bouton *Copy* de Supabase copie des `••••` s'il n'y a pas
   eu de *Reveal* (et Render, une fois enregistré, ne montre plus une valeur `Secret`) : si tu
   doutes, *Reset* la clé et ressaisis-la, le coût est de re-coller deux lignes.

---

### Supabase : coller le SQL, coller la clé — pas de mot de passe de base

C'est la voie par défaut, et la plus courte. **Deux copier-coller** et c'est fini :

1. **Le schéma.** Ouvre le fichier [`supabase/schema.sql`](supabase/schema.sql) du dépôt,
   sélectionne *tout*, colle-le dans **Supabase → Project → SQL Editor → New query → Run**.
   Il crée les 23 tables, les index et 3 fonctions (`edge_schema_check`, `edge_prune_events`,
   `edge_counts`). Il est **idempotent** : rien n'est supprimé, tu peux le relancer après chaque
   mise à jour du dépôt. (Généré par `npm run db:sql` à partir de `migrations/*.sql` ; un test
   vérifie qu'il n'a pas dérivé.)
2. **Les deux variables.** Dans Render (ou `.env` en local) :
   `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY`. C'est tout.

Edge parle alors à **l'API HTTP** de Supabase (PostgREST, port 443) : pas besoin du mot de passe
de la base, pas besoin de pooler, pas besoin d'autoriser une IP — Render change d'IP sans
prévenir, c'est précisément ce qui casse les connexions Postgres directes. La clé `service_role`
sert ici : elle est faite pour un serveur de confiance, jamais pour un front. Si tu te trompes de
clé (la `anon`), Edge s'en aperçoit en lisant le JWT et te le dit avant le premier écrit.

Le contrat de données est le même que sur Postgres direct (`insert`, `all`, `update`, `count`,
`rpc`) ; les requêtes compliquées passent par les fonctions SQL ci-dessus, jamais par du SQL brut.
`/edge sante` et `/health` affichent le chemin utilisé : `API Supabase` ou `Postgres direct`.

<details><summary>Alternative : la connexion Postgres directe (<code>DATABASE_URL</code>)</summary>

```
postgres://postgres:[MOT_DE_PASSE]@db.[REFERENCE].supabase.co:5432/postgres          # directe
postgres://postgres.[REF]:[MOT_DE_PASSE]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres  # transaction pooler
```

Le mot de passe est celui de la **base** (Project Settings → Database → *Reset database
password*), pas une clé d'API. En direct, active **« Allow IPv4 connections »** et ne mets **aucune
allowlist d'IP** (Render n'a pas d'IP fixe). `npm run db:migrate` applique alors les migrations
tout seul au démarrage. Edge vérifie la *forme* de la variable et refuse une clé `eyJ…` collée là
par erreur, en disant quoi faire, au lieu d'un « invalid connection » obscur.

</details>

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
| `botadmin` | `/edge module｜config｜flag｜sante｜structure｜panneaux｜stats｜invite｜maintenance` — `/edge config` est la console de personnalisation |
| `help` | `/aide [module]` — le mode d'emploi de chaque module, directement dans Discord |

### Personnaliser (`/edge config`)

**Rien à retenir, tout à cliquer.** `/edge config`, tout court, ouvre le tableau de bord :

1. premier menu → le module (ou ⚙️ *Général* pour le style et les journaux) ;
2. second menu → **✏️ le réglage à changer**, avec sa valeur actuelle dans la description ;
3. Edge ouvre **le contrôle qui va avec le type** : zone de texte pré-remplie pour un message ou un
   salon de bienvenue, **liste des salons du serveur** pour déplacer un journal, **liste des rôles**
   pour une exemption, deux boutons **✅ oui / 🚫 non** pour un interrupteur, menu d'options pour un choix.

Les boutons au-dessus font le reste : 🔕 couper / ✅ rallumer le module, 🧹 réinitialiser ses réglages,
📤 exporter. Couper un module **retire aussi sa slash command** du serveur ; rien n'est supprimé en base,
ses tickets, ses niveaux et ses réglages t'attendent si tu le rallumes. Et depuis `/aide`, chaque fiche
de module a son bouton ⚙️ : plus besoin de savoir que la config s'appelle `/edge config`.

Le clavier reste disponible — et c'est même le seul chemin pour un texte de 1800 caractères collé
depuis un fichier :

```
/edge config tableau                                  ← le menu, à la souris
/edge config voir welcome                             ← la liste des réglages d'un module
/edge config regler welcome message Bienvenue {membre}, sur {serveur} !
/edge config regler general salon_moderation <#id-du-salon>
/edge config regler welcome delai 15                  ← 15 s avant de saluer l'arrivant
/edge config oublier welcome delai                    ← revenir au défaut
/edge config reinitialiser tickets                    ← tout remettre à zéro pour un module
/edge config exporter welcome                         ← un JSON à recoller sur un autre serveur
/edge config importer welcome {"message":"Bienvenue !"}
```

Ce qui est exposé aujourd'hui :

| Groupe | Réglages |
| --- | --- |
| `general` | couleur des embeds, pied de page, autoriser ou non les pings de rôles, **le salon de chacun des 4 journaux**, et les 4 bascules d'écriture |
| `welcome` | message de bienvenue (mêmes `{placeholders}` que `/bienvenue texte`), salon d'accueil, délai avant le message, message privé d'accueil |
| `tickets`, `selfroles` | le texte du panneau au-dessus du menu — republication immédiate dans le salon |
| `antiraid`, `rules`, `levels`, `invites`, `voice`, `audit` | leurs interrupteurs (les flags historiques), listés ici au lieu d'être à deviner |

Un réglage **non listé n'existe pas**, et c'est `npm test` qui l'impose : chaque réglage déclaré doit être

réellement lu par son module, chaque flag lu par un module doit être déclaré, et un défaut affiché dans
`/edge config` doit être le comportement d'usine — sinon « oublier » changerait le comportement au lieu de
l'annuler. Donc rien de décoratif d'un côté, rien de clandestin de l'autre.

Autres garanties : les valeurs sont lues à chaud (cache de 20 s, invalidé dès qu'on règle), validées à la
saisie avec une raison explicite (« minimum 1 », « mentionne le salon », « réponds par oui ou non »), et un
salon réglé sur un ID où Edge n'a pas le droit d'écrire te le dit tout de suite au lieu de se taire. Les
réglages `flags` écrivent dans la même table que `/edge flag` : les deux chemins restent d'accord.

Pour un réglage que tu veux et qui n'est pas là, c'est dix lignes dans le module (une déclaration
`reglages: [{ cle, type, label, aide, defaut }]` et une lecture `await c.reglages('x').num('y')`) — la
commande, le menu, la modale, la validation, l'export et le test anti-réglage-décoratif suivent tout seuls.

### Le bug qui a tué `/aide`, et son filet

`/aide` listait ses 23 modules dans un `content` de 2900 caractères. Discord limite un contenu à
**2000** et répond `Invalid Form Body: content[BASE_TYPE_MAX_LENGTH]` — la commande entière échoue, sans
indice. Deux corrections, dans cet ordre :

- le texte de `/aide` vit désormais dans des **embeds** (4096) paginés par `decouper()` ;
- et surtout, `src/core/safe-reply.ts` bride **toutes** les réponses au point d'entrée du routeur :
  un `content` trop long est coupé aux fins de ligne et le reste part en message de suite. Aucun module
  n'a à y penser, et le bug ne peut plus se reproduire quand une liste s'allonge (classements, journaux,
  rapports d'audit). Un test `npm test` fabrique un payload de 5000 caractères et vérifie qu'il sort en
  plusieurs messages au lieu d'échouer.

Le même `Invalid Form Body` guette les menus : une `value` d'option doit rester dans `[a-z0-9._-]`.
`valeurOption()` lave toutes les values construites par Edge (testé), parce qu'un deux-points de trop
dans `module:clé` fait rejeter le message entier.

### Interrupteurs (`/edge flag <clé> [valeur : vrai｜faux]`, ou la table `flags` en base)

`antiraid.auto` (off par défaut — verrouiller un serveur tout seul est trop lourd pour être actif sans feu),
`rules.gate` (off), `levels.announce` (off), `invites.announce`, `invites.allowSelf`, `voice.kickIdle`,
`audit.post`, `bot.maintenance`, `log:<genre>` pour chaque journal, et `module:<clé>` pour éteindre un module
entier sans redémarrer. Sauf `bot.maintenance`, tous sont aussi visibles et réglables dans `/edge config`.

---

## 3. Vérifier, sans token

```bash
npm run typecheck   # 0 erreur
npm test            # 58 tests purs : barèmes, tirage pondéré, détecteurs, permissions, structure, registre
                    #   db (les 3 moteurs : mémoire, pg, API Supabase), sonde HTTP, autoping
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
| **Render** (free) | oui, **sans CB**, 512 Mo, 750 h/mois | Dort après 15 min sans trafic entrant — **mais Edge est déjà câblé pour ça** : autoping interne (Render lui donne son URL) + workflow GitHub toutes les 5 min. **→ Ton chemin, celui que le repo cable : voir § Render plus bas.** |
| **Northflank** (plan **Sandbox**) | **oui**, vérifié sur leur page de prix : « *Always-on-compute — no sleeping :)* », 2 services + 1 base + 2 cron gratuits | Le plan gratuit le plus généreux et le plus stable (successeur de Koyeb) ; **Render reste le choix retenu ici**, celui pour lequel le repo est câblé. CB demandée pour vérifier l'identité (0 € débité). Il build depuis le `Dockerfile` du repo : aucun fichier de config à écrire. |
| **Oracle Cloud — Always Free** | oui : VM ARM 2 OCPU / 12 Go à vie (rabaissée en juin 2026) | Le plus solide, et le seul gratuit qu'**aucun rachat ne peut te retirer**. CB + un peu de Linux. `sudo bash deploy/vps.sh`. |
| **Un Raspberry Pi ou un vieux PC portable** | oui, 0 €, et ça dort jamais si tu le laisses branché | `deploy/vps.sh` fait exactement ça. C'est l'option « je ne donne ma CB à personne ». |
| **Railway** | essai 5 $ (30 jours), puis 1 $/mois | 1 $/mois ne couvre pas un 24/7 : compte ~5 $/mois. Le déploiement le plus simple, si tu veux en finir en 5 minutes. |
| **Fly.io** | non : plus d'allocation gratuite (essai 2 h de VM), CB | ~2 $/mois. `fly.toml` fourni, avec `auto_stop_machines = "off"` (sans ça, il s'endort). |
| **Koyeb** | **non — fermé** | Racheté par Mistral le 17 février 2026 : le plan Starter gratuit est supprimé pour les nouveaux, entrée à 29 $/mois + CB (empreinte de 29 $). Les anciens comptes Starter gardent leurs conditions. |
| les « free bot hosting » (Pterodactyl, 128-256 Mo) | oui | Trop juste pour 23 modules, renouvellements maniaques, et surtout : **l'hébergeur lit ton token**. |

### Render (gratuit, sans CB) — le chemin retenu, câblé dans le repo

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

1. **La base, d'abord** (une minute) : Supabase → *New project* (plan free, région
   `eu-central-1`) → **SQL Editor** → *New query* → colle le contenu de
   [`supabase/schema.sql`](../blob/main/supabase/schema.sql) → **Run**. Vas-y, c'est écrit
   « idempotent » : rien n'est détruit, tu peux relancer à chaque mise à jour. Récupère au
   passage l'**URL du projet** (`https://<ref>.supabase.co`) et la **clé `service_role`**
   (*Project Settings → API → Secret keys*). Ni mot de passe de base, ni pooler, ni IP à
   autoriser : Edge parle à l'API HTTP.
2. Developer Portal → ton app → **Bot** : coche `Server Members Intent`, `Message Content
   Intent`, `Guild Moderation Intent` → copie le **token**.
3. Render → **New + → Web Service** → connecte `Snowoo-2z/edge-bot` (branche `main`).
4. **Runtime : Node** (ou **Docker** si tu préfères l'image — les deux marchent, le repo a
   les deux configs). Render lit `render.yaml` tout seul : région **`frankfurt`** (seules
   valeurs possibles : `oregon`, `ohio`, `virginia`, `frankfurt`, `singapore`), plan
   **`free`** (0,1 CPU / 512 Mo), build `npm ci && npm run build`, start
   `node dist/index.js`, health check `/health`.
5. **Environment variables** (les `sync: false` du blueprint te seront demandés) :
   ```
   DISCORD_TOKEN               = <ton token>
   SUPABASE_URL                = https://<reference>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY   = <clé service_role>
   GUILD_ID                    = 1558076024778919946
   EDGE_REQUIRE_MESSAGE_CONTENT = true
   ```
   C'est tout : la base est couverte par les deux `SUPABASE_`. **Ne touche pas à `PORT`** —
   Render le fournit (défaut 10000) et Edge y branche la sonde tout seul. Et ne remets pas de
   `DATABASE_URL` : elle est ignorée dès que `SUPABASE_URL` est là, mais une valeur bancale y
   ferait chercher tout le monde.
6. **Create Web Service** → attends ~2 min → ouvre `https://<service>.onrender.com/health`.
   `"pret": true` et `"baseMode": "API Supabase"` = les commandes `/edge` `/aide` `/ticket`
   répondent dans Discord et que les données sont écrites.
7. Si au bout d'un moment le bot semble muet : `curl https://<service>.onrender.com/ready`
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

### Northflank en 8 étapes (l'autre gratuit solide, si Render t'ennuie)

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
   SUPABASE_URL                  = https://<reference>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY   = <clé service_role>   (et rien d'autre à configurer pour la base)
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

### VPS gratuit (Oracle) ou machine à la maison

```bash
git clone https://github.com/Snowoo-2z/edge-bot /tmp/edge && cd /tmp/edge
sudo bash deploy/vps.sh          # node 22 + utilisateur dédié + systemd, et c'est tout
nano /etc/edge-bot.env           # DISCORD_TOKEN + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
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
