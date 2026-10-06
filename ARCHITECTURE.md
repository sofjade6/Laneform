# Architecture — Laneform

> Application de bureau Windows pour League of Legends : overlay en jeu,
> draft helper, stats live, timers d'objectifs.
>
> **Non affilié à Riot Games.** Mention obligatoire dans l'app et sur la page
> de téléchargement (Riot Developer Policy).

---

## 1. Produit

Un seul `.exe` que l'utilisateur installe. L'app se lance avec Windows, détecte
le client League, et dessine un overlay par-dessus le jeu.

| Fonction | Source de données | Besoin d'un backend |
|---|---|---|
| Stats de la partie en cours | Live Client Data API (locale) | non |
| Timers jungle / Dragon / Baron | Live Client Data API (locale) | non |
| Draft helper au champion select | LCU (local) | non pour les picks, **oui** pour les recommandations |
| Ranks et historique des 9 joueurs | API Riot publique | **oui** |

Les deux premières lignes sont autonomes et constituent la V1 livrable. Les deux
suivantes dépendent d'un service distant — voir §6 et §7.

---

## 2. Vue d'ensemble

```
   Machine de l'utilisateur (Windows)
   ┌──────────────────────────────────────────────────┐
   │                                                  │
   │  Client League ──► lockfile ──┐                   │
   │  (LCU, port aléatoire)        │                   │
   │                               │                   │
   │  League en partie             │                   │
   │  (127.0.0.1:2999) ────────┐   │                   │
   │                           │   │                   │
   │        ┌──────────────────▼───▼────────────────┐  │
   │        │  Laneform.exe (Electron)              │  │
   │        │  ┌─────────────┐  ┌────────────────┐  │  │
   │        │  │ main process│  │ fenêtre overlay│  │  │
   │        │  │ connecteurs │─►│ transparente   │  │  │
   │        │  │ + état      │  │ click-through  │  │  │
   │        │  └──────┬──────┘  └────────────────┘  │  │
   │        │         │         ┌────────────────┐  │  │
   │        │         └────────►│ fenêtre app    │  │  │
   │        │                   │ (réglages,     │  │  │
   │        │                   │  historique)   │  │  │
   │        └─────────┬─────────┴────────────────┘  │  │
   └──────────────────┼──────────────────────────────┘
                      │ HTTPS
            ┌─────────▼──────────────┐
            │  API Laneform          │   ◄── détient la clé Riot
            │  Fastify + Redis       │       (jamais dans le .exe)
            │  rate limiter partagé  │
            └─────────┬──────────────┘
                      │
            ┌─────────▼──────────┐   ┌──────────────────┐
            │  API Riot publique │   │ Data Dragon      │
            └────────────────────┘   │ (assets, embarqués)│
                                     └──────────────────┘
```

**Règle structurante** : la clé API Riot ne quitte jamais le serveur. Une clé
embarquée dans un binaire distribué est extraite en quelques minutes — et une
clé extraite est une clé révoquée.

---

## 3. Sources de données

### 3.1 LCU — League Client Update (local, pas de clé)

Disponible dès que le client League est ouvert.

- **Découverte** : fichier `lockfile` dans le dossier d'installation
  (`C:\Riot Games\League of Legends\lockfile`), au format
  `nom:pid:port:password:protocole`. Le port et le mot de passe changent à
  **chaque lancement** du client : il faut surveiller le fichier, pas le lire une
  seule fois au démarrage.
- **Authentification** : Basic, utilisateur `riot`, mot de passe celui du lockfile.
- **Transport** : HTTPS sur `127.0.0.1:<port>`, **certificat auto-signé**. Riot
  publie son certificat racine ; on le vérifie contre celui-là plutôt que de
  désactiver la validation TLS globalement.
- **Événements** : WebSocket sur le même port. S'abonner à `OnJsonApiEvent`
  donne les transitions d'état sans polling — c'est ce qui rend le draft helper
  réactif.
- **Endpoints utiles** : session de champion select, phase de jeu, invocateur courant.

### 3.2 Live Client Data API (local, pas de clé)

Disponible **uniquement pendant une partie**, sur `https://127.0.0.1:2999/liveclientdata/`.
Également en certificat auto-signé.

- `allgamedata` : tout l'état en un appel — joueurs, scores, événements, horloge.
- Polling à 1 Hz. Suffisant pour un overlay, et sans impact sur les performances
  du jeu. Inutile de descendre plus bas.
- Fournit les événements (kills, Dragon, Baron, tourelles) avec leur timestamp :
  c'est la base des timers d'objectifs, calculés côté app.

### 3.3 API Riot publique (distante, clé requise)

Uniquement pour enrichir : ranks, winrates et historique des 9 autres joueurs.
Passe par notre backend (§6). Volume très inférieur à celui d'un site de stats —
quelques appels par partie, pas un crawl permanent.

### 3.4 Assets

Data Dragon, **embarqué dans l'app** et mis à jour par patch, plutôt que chargé
en ligne : l'overlay doit s'afficher instantanément et fonctionner même si le
réseau est mauvais.

---

## 4. Application Electron

```
apps/desktop/
├─ src/main/           # process principal (Node)
│  ├─ lcu/             # lockfile watcher, client REST, WebSocket
│  ├─ live/            # client Live Client Data + polling
│  ├─ state/           # machine à états: idle → lobby → champ select → in-game
│  ├─ overlay/         # création et positionnement de la fenêtre overlay
│  └─ api/             # client du backend Laneform
├─ src/overlay/        # UI de l'overlay (React)
├─ src/app/            # UI de la fenêtre principale (React)
└─ src/preload/        # ponts IPC, contextIsolation activée
```

**Machine à états** au centre du process principal. Tout le reste réagit à ses
transitions : `ClientFermé → Lobby → ChampSelect → EnPartie → Fin`. Sans cet
état unique et explicite, la logique se disperse en conditions éparpillées entre
les connecteurs et devient intenable dès le troisième cas limite (reconnexion,
remake, client relancé en cours de partie).

### Fenêtre overlay

- `transparent: true`, `frame: false`, `alwaysOnTop` au niveau `screen-saver`,
  `skipTaskbar: true`
- `setIgnoreMouseEvents(true, { forward: true })` : les clics traversent vers le
  jeu. On repasse en interactif seulement quand l'utilisateur appelle l'overlay
  au raccourci clavier.
- Dimensionnée sur le moniteur où tourne League, pas sur le moniteur principal.
- **Le jeu doit être en Borderless ou Windowed.** En plein écran exclusif,
  Windows n'affiche aucun overlay — limite de l'OS, identique chez tous les
  concurrents. L'app doit détecter le cas et le dire à l'utilisateur, plutôt que
  de laisser croire à un bug.
- Mise à l'échelle DPI : lire le facteur du moniteur, sinon l'overlay est
  décalé sur les écrans 4K et les configurations multi-moniteurs hétérogènes.

---

## 5. Sécurité et conformité

**La ligne rouge** : on lit les API officielles de Riot et on dessine une fenêtre
séparée. On n'injecte rien dans le process du jeu, on ne lit pas sa mémoire, on
n'automatise aucune action de jeu. Vanguard est actif en permanence ; franchir
cette ligne ferait bannir les utilisateurs.

Ce qui en découle, à ne pas contourner :
- Aucune information que le joueur ne pourrait pas obtenir lui-même. Pas de
  position d'ennemis invisibles, pas de cooldowns adverses non affichés.
- Aucune automatisation : pas d'accept auto, pas de pick auto, pas de macro.
- Mention de non-affiliation visible dans l'app.

Côté Electron : `contextIsolation: true`, `nodeIntegration: false`, tout passe
par un preload explicite. Une fenêtre qui affiche des données distantes avec
Node activé est une porte ouverte.

---

## 6. Backend (`apps/api`)

Mince et sans état métier. Il existe pour une seule raison : **détenir la clé
Riot**. Il réutilise tel quel le travail déjà fait en `@laneform/riot-client`.

```
POST /v1/lookup       { platform, puuids[] }  -> ranks + winrates récents
GET  /v1/health
```

- Rate limiter Redis partagé entre instances — déjà implémenté et testé.
- Cache agressif : un rank est valable 10 minutes. Dans une partie, les 10
  joueurs sont demandés en un seul appel groupé.
- Pas d'authentification utilisateur en V1, mais un rate limit par IP, sinon
  l'endpoint devient un proxy Riot public gratuit.
- Postgres **optionnel** en V1 : Redis seul suffit pour du cache. On n'ajoute
  Postgres que si on veut conserver un historique côté serveur.

---

## 7. Le point dur : les recommandations du draft helper

Afficher les picks en direct est trivial (le LCU les donne). **Recommander** un
build, des runes ou un counter-pick demande des statistiques agrégées sur des
millions de parties — exactement le pipeline d'ingestion coûteux qu'on vient
d'éliminer du périmètre.

Trois options, par coût croissant :

1. **Builds personnels** — proposer au joueur ses propres builds les plus
   performants sur ce champion, depuis son historique. Aucune agrégation
   nécessaire, et c'est une proposition de valeur honnête et différenciante.
   **Recommandé pour la V1.**
2. **Agrégation modeste** — ingérer les parties de haut elo d'une seule région
   pour produire des recommandations correctes. Réintroduit une partie du
   pipeline, mais à une échelle maîtrisable.
3. **Tier list complète** — le pipeline décrit dans la version précédente de ce
   document. À ne considérer que si le produit décolle.

Ne pas sous-estimer ce point : c'est le seul endroit où le projet peut
rebasculer vers la complexité de départ.

---

## 8. Distribution

- Packaging : `electron-builder`, cible NSIS, un installeur `.exe` unique.
- Mises à jour automatiques via `electron-updater`.
- **Signature de code** : sans certificat, Windows SmartScreen affiche un
  avertissement dissuasif à chaque installation. Un certificat OV coûte quelques
  centaines d'euros par an, et la réputation SmartScreen met des semaines à se
  construire même signé. À budgéter avant la première distribution publique, pas
  après.

---

## 9. Ce qui a été supprimé

Par rapport à la cible « site de stats » initiale, disparaissent entièrement :
crawler de ladder, ingestion massive, partitionnement Postgres, stockage des
timelines, ClickHouse, SEO, rendu serveur, et l'historique de rank irrattrapable.

Ce qui survit : `@laneform/riot-client` et son rate limiter (pour le backend),
`@laneform/stats` (les calculs dérivés restent utiles sur les parties live),
`@laneform/shared`. Aucune base de données n'est nécessaire : les statistiques
sont des compteurs dans un fichier JSON local.

---

## 10. Roadmap

| Phase | Contenu | Sortie |
|---|---|---|
| 0 ✅ | Monorepo, riot-client, rate limiter, stats | fait |
| 1 ✅ | Connecteur LCU : lockfile, auth, WebSocket, machine à états | détection fiable du client |
| 2 ✅ | Connecteur Live Client Data + fenêtre overlay transparente | **premier overlay visible en jeu** |
| 3 ✅ | Stats de partie + timers d'objectifs | V1 autonome, distribuable |
| 4 | Backend mince + ranks des 9 joueurs | nécessite la production key |
| 5 | Draft helper + builds personnels | fonctionnalité différenciante |
| 6 | Signature, installeur, auto-update | distribution publique |

La phase 2 est le premier jalon motivant : c'est le moment où quelque chose
s'affiche réellement par-dessus le jeu.
