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
| `DATABASE_URL` | Chaîne Postgres de Supabase (Project settings → Database → Connection string). Vide = Edge tourne sans stockage et coupe proprement les modules qui en ont besoin. |
| `EDGE_DRY_RUN` | `true` = ne se connecte pas, simule la structure et rapporte. |
| `EDGE_REQUIRE_MESSAGE_CONTENT` | `true` (défaut) = exige l'intent Message Content (automod, XP). À `false`, ces modules se désactivent et le reste marche. |
| `EDGE_LOG_LEVEL` | `debug` / `info` / `warn` / `error`. |

**Supabase** : prends la chaîne **session pooler** (port 5432) plutôt que transaction pooler (6543) —
le port 6543 casse les requêtes préparées. Le compte `postgres` / `service_role` est correct ici :
c'est un bot serveur-à-serveur, pas un front.

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

## 4. Ce que Edge ne fera pas (et pourquoi c'est mieux)

- **Pas de bannissement automatique sur un compteur.** L'automod s'arrête à `ban_suggest` ; le ban reste une décision humaine.
- **Pas de rôle staff accordé tout seul.** `/recrutement` prepare, notifie, relance à J+30 — c'est toi qui donnes le rôle.
- **Pas d'Administrateur.** Les permissions demandées sont exactement celles du manifeste ; `/audit perms` compare les deux.
- **Il ne recrée pas ton serveur.** Edge lit la structure, signale les écarts, et ne touche aux surcharges que si tu le lui demandes (`/raid unlock`, `/audit structure`).

## 5. Quatre détails à connaître

1. Les rôles `🎁│ Notification Giveaway` et `🤝│ Notification Partenariat` sont **non-mentionnables** par les membres (c'est bien). Pour qu'Edge puisse les ping, il a `MentionEveryone` + `ManageRoles`. Si un humain tente le ping à la main, Discord l'ignore — c'est normal, passe par les commandes.
2. `💼│ Manager Partenariat` n'a pas le droit d'écrire dans 📣│・Annonces (lecture seule pour tout le monde sauf staff). Edge publie donc **l'annonce de partenariat à sa place**, avec le ping 🤝.
3. Attribution des invitations : Edge ne peut créditer que les liens **qu'il voit** (invites créées après un `/invites resync`, non expirées). Un lien créé avant son arrivée est incomptable — d'où `/invites resync`.
4. Réciprocité d'un partenaire : Edge ne peut lire le serveur d'à côté **que s'il y est**. Sinon le contrôle hebdo marque « non vérifiable » et un Manager tranche avec `/partenariat reciprocite`.

## 6. Organisation du code

```
src/manifest.ts        rôles, salons, catégories, ACL attendues, permissions du bot : LA source de vérité
src/core/              client, dispatch (slash + composants + jobs), structure (resolveur + rapport d'écart),
                       permmodel (modèle pur des permissions), db, send, ui, copy (textes), logs, panels
src/logic/             barèmes, détecteurs, tirage pondéré — pur, testable, sans discord.js
src/modules/           23 modules, même forme : commandes / composants / listeners / jobs / sync
src/db/                Db (pg + mémoire), migrate
src/dryrun/            faux serveur + harnais de simulation (npm run dry)
migrations/            0001_init.sql — 20 tables
tests/run.ts           harnais de tests maison
```

Un module qui demande un salon absent n'explose pas : il se **désactive**, et `/edge sante` explique pourquoi.
