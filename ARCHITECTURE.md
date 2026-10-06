# Architecture — plateforme de stats League of Legends

> Document d'architecture. Cible : un site de stats joueur type dpm.lol / op.gg,
> construit sur l'API Riot Games officielle.
> **Non affilié à Riot Games.** Mention obligatoire en pied de page (Riot Developer Policy).

---

## 1. Périmètre

### Dans le scope (V1)
- Recherche d'un joueur par Riot ID (`GameName#TAG`)
- Page profil : rank Solo/Flex, LP, winrate, top champions, historique de parties
- Détail d'une partie : scoreboard, builds, runes, timeline graphée (gold/XP diff)
- Stats dérivées calculées maison : DPM, DTPM, KP%, CS/min, gold diff @14, vision/min
- Bouton « Mettre à jour » (refresh on-demand du profil)
- Live game (partie en cours) via Spectator

### Hors scope V1 (volontairement)
- Leaderboards globaux multi-régions
- Tier lists / stats champions agrégées sur la ladder entière
- Historique de rank long terme (impossible à rattraper rétroactivement — voir §12)

Raison : ces trois features imposent une ingestion massive continue, donc l'essentiel
du coût. On les ajoute en V2 une fois la production key obtenue.

---

## 2. Vue d'ensemble

```
                    ┌──────────────────────────────┐
   Navigateur  ───► │  Next.js (App Router)        │  SSR/ISR + RSC
                    │  Vercel ou container         │
                    └───────────┬──────────────────┘
                                │ HTTP interne (ou tRPC)
                    ┌───────────▼──────────────────┐
                    │  API  (Fastify, Node 24)     │
                    │  lecture DB + enqueue jobs   │
                    └──┬────────────┬──────────────┘
                       │            │
            ┌──────────▼──┐   ┌─────▼───────────────┐
            │  Redis      │   │  PostgreSQL 16      │
            │  cache +    │   │  source de vérité   │
            │  BullMQ     │   │  + partitions match │
            │  + rate lim │   └─────▲───────────────┘
            └──────┬──────┘         │
                   │ jobs           │ writes
            ┌──────▼─────────────────┴──────┐
            │  Workers d'ingestion (N pods) │
            │  ├─ summoner-refresh          │
            │  ├─ match-fetch               │
            │  ├─ timeline-parse            │
            │  └─ ladder-crawl (V2)         │
            └──────┬────────────────────────┘
                   │ via riot-client (rate-limité globalement)
            ┌──────▼────────────┐   ┌──────────────────┐
            │  Riot Games API   │   │ Data Dragon /    │
            │  (5 endpoints)    │   │ CommunityDragon  │
            └───────────────────┘   └──────────────────┘
```

**Principe directeur** : *un seul* composant parle à Riot (`riot-client`), et il
possède le rate limiter. Tout le reste passe par la file. Si l'API web appelait Riot
directement, un pic de trafic ferait sauter le quota partagé et pénaliserait
l'ingestion de fond.

---

## 3. Stack

| Couche | Choix | Pourquoi |
|---|---|---|
| Frontend | Next.js 15 (App Router) + TypeScript + Tailwind | SSR pour le SEO (vital : 90 % du trafic de ces sites vient de Google sur « pseudo lol stats »), RSC pour streamer le profil |
| API | Fastify + TypeScript | Léger, schémas JSON natifs, partage les types avec le front |
| Workers | Node 24 + BullMQ | Même langage/typage que l'API, retry + backoff + priorités intégrés |
| DB | PostgreSQL 16 | JSONB pour les payloads bruts, partitionnement natif, suffisant jusqu'à ~500M lignes |
| Analytique (V2) | ClickHouse | Les agrégats champion×patch×rank sont des scans colonnaires, Postgres s'effondre dessus |
| Cache / file / locks | Redis 7 | Trois usages, un seul composant |
| Assets | Data Dragon + CommunityDragon, miroirés sur un CDN | Licence libre d'usage, mais éviter de taper leur CDN à chaque requête |
| Monorepo | npm workspaces (`apps/`, `packages/`) | Pas besoin de pnpm/turbo au départ |

```
DPMlol/
├─ apps/
│  ├─ web/            # Next.js
│  ├─ api/            # Fastify
│  └─ workers/        # BullMQ consumers
├─ packages/
│  ├─ riot-client/    # SDK Riot + rate limiter  ◄── le composant critique
│  ├─ db/             # Drizzle schema + migrations
│  ├─ stats/          # calculs dérivés (pur, testable sans réseau)
│  └─ shared/         # types, constantes régions, enums
└─ infra/             # docker-compose, Dockerfiles, IaC
```

---

## 4. Sources de données Riot

### Endpoints utilisés

| Endpoint | Usage | Fraîcheur |
|---|---|---|
| `ACCOUNT-V1 /by-riot-id/{name}/{tag}` | Riot ID → PUUID | permanent (cache ∞) |
| `SUMMONER-V4 /by-puuid/{puuid}` | niveau, icône, `revisionDate` | 10 min |
| `LEAGUE-V4 /entries/by-puuid/{puuid}` | rank, LP, série | 10 min |
| `MATCH-V5 /by-puuid/{puuid}/ids` | liste des match IDs | 2 min |
| `MATCH-V5 /{matchId}` | détail d'une partie | immuable → cache ∞ |
| `MATCH-V5 /{matchId}/timeline` | frames 60 s + events | immuable → cache ∞ |
| `SPECTATOR-V5 /active-games/by-summoner/{puuid}` | live game | 30 s, jamais persisté |

**Point clé** : un match et sa timeline sont **immuables**. Une fois ingérés, ils ne
sont jamais refetchés. C'est ce qui rend le système viable : le coût d'une partie est
payé une seule fois, et il est amorti sur les 9 autres joueurs de la partie.

### Routing à deux niveaux (piège classique)

Depuis la migration Riot ID, deux espaces de routage coexistent :

- **Plateforme** (`euw1`, `na1`, `kr`, `br1`…) → `SUMMONER`, `LEAGUE`, `SPECTATOR`
- **Région/cluster** (`europe`, `americas`, `asia`, `sea`) → `ACCOUNT`, `MATCH`

`packages/shared` expose une table unique `PLATFORM_TO_REGION` et un type
`Platform` ; **aucun appel ne prend un string brut**, uniquement ces types. C'est la
source de bug n°1 de ce genre de projet.

### Rate limits

Deux niveaux cumulatifs, imposés par Riot :
- **App rate limit** : global à la clé. Dev key ≈ 20 req/s et 100 req/2 min.
  Production key ≈ 500 req/10 s et 30 000 req/10 min (valeurs à confirmer sur le
  portail dev, elles ont évolué et dépendent de l'approbation).
- **Method rate limit** : par endpoint *et par plateforme*, limites distinctes.

Conséquence structurelle : `riot-client` doit maintenir **un bucket par
(endpoint × plateforme) + un bucket global**, et ces buckets sont **partagés entre
tous les workers** → ils vivent dans Redis, pas en mémoire.

---

## 5. `packages/riot-client` — le composant critique

Responsabilités, dans l'ordre d'exécution d'un appel :

1. **Acquisition de jeton** — script Lua atomique dans Redis (sliding window sur
   `ratelimit:{app}` et `ratelimit:{method}:{platform}`). Si refusé, le job est
   re-planifié avec le délai exact restant, il n'y a pas de spin.
2. **Priorité** — deux files : `interactive` (refresh déclenché par un visiteur) et
   `bulk` (crawl de fond). L'interactive passe devant, le bulk consomme le quota
   résiduel. Sans ça, un crawler affame les utilisateurs réels.
3. **Appel HTTP** — `undici` avec pool keep-alive.
4. **Lecture des headers de réponse** — `X-App-Rate-Limit-Count` et
   `X-Method-Rate-Limit-Count` font autorité : on **resynchronise les buckets Redis
   dessus** à chaque réponse. Le compteur local dérive toujours (plusieurs pods,
   latence) ; Riot a la vérité.
5. **Gestion d'erreurs** :
   - `429` → respecter `Retry-After` **à la seconde près**, et ouvrir un circuit
     breaker global : plus aucun appel sortant pendant la fenêtre. Un 429 encaissé en
     boucle est le motif de révocation de clé le plus fréquent.
   - `503`/`5xx` → backoff exponentiel + jitter, 5 tentatives.
   - `404` → résultat légitime (joueur inexistant, pas de live game), mis en cache
     négatif 5 min, jamais retenté.
6. **Rotation de clé** — la clé vit dans une variable d'env, rechargée à chaud.
   Indispensable avec une dev key qui expire toutes les 24 h.

Ce package n'a **aucune dépendance à la DB** : il est testable avec un serveur HTTP
mocké, et c'est lui qui doit avoir la meilleure couverture de tests du repo.

---

## 6. Pipeline d'ingestion

### Flux « profil consulté » (chemin chaud)

```
GET /summoner/euw1/Nom-TAG
  │
  ├─ Postgres: profil connu ?
  │    non ─► job summoner-refresh (priorité interactive, bloquant ~1,5 s)
  │           ACCOUNT-V1 → SUMMONER-V4 → LEAGUE-V4 → upsert
  │
  ├─ rendu immédiat du profil + des matchs déjà en base
  │
  └─ en tâche de fond: MATCH-V5 /ids (20 derniers)
       └─ diff avec la base → N jobs match-fetch
            └─ chaque job: match + timeline → parse → insert
                 └─ push SSE/WebSocket → le front insère la ligne sans reload
```

Le profil s'affiche **avant** que les matchs manquants soient ingérés. Une page qui
attend 20 fetchs Riot met 10 s et perd l'utilisateur.

### Déduplication

Une partie concerne 10 joueurs. Si 3 d'entre eux sont consultés, on la fetch 1 fois.
Garde-fou : `SETNX match:lock:{matchId}` en Redis (TTL 60 s) avant l'enqueue, et
`INSERT ... ON CONFLICT DO NOTHING` côté Postgres. Les deux, parce que le lock peut
expirer pendant un retry.

### Anti-abus du bouton « Mettre à jour »

- Cooldown de 120 s par PUUID (clé Redis), affiché dans l'UI
- Rate limit par IP : 10 refresh/min
- Si `summoner.revisionDate` n'a pas bougé depuis le dernier refresh, on sait qu'aucune
  partie n'a été jouée → on **n'appelle même pas** `MATCH-V5`. Économie massive de quota.

### Crawl de fond (V2, pour les agrégats)

Expansion en graphe : partir des joueurs Challenger/GM (`LEAGUE-V4`), ingérer leurs
matchs, extraire les 9 autres PUUID, les mettre en file. Converge vers une couverture
large de la ladder en quelques jours. Ne s'active **que** sur la file `bulk`, avec un
quota plafonné (ex. 60 % du budget) pour ne jamais dégrader le chemin interactif.

---

## 7. Modèle de données

### Postgres — tables principales

```sql
-- Identité (le PUUID est stable, le Riot ID change)
account        (puuid PK, game_name, tag_line, platform, last_seen_at)
                UNIQUE (lower(game_name), lower(tag_line), platform)

summoner       (puuid PK → account, summoner_level, profile_icon_id,
                revision_date, last_refreshed_at)

league_entry   (puuid, queue_type, tier, rank, league_points, wins, losses,
                updated_at)                       PK (puuid, queue_type)

-- Historique de rank : un snapshot par changement détecté. Alimente la courbe LP.
league_history (puuid, queue_type, captured_at, tier, rank, league_points)

-- Matchs : PARTITIONNÉ PAR MOIS sur game_creation
match          (match_id PK, platform, queue_id, game_version, game_creation,
                game_duration, winning_team)

match_participant (match_id, puuid, champion_id, team_id, position, win,
                   kills, deaths, assists, gold_earned, cs,
                   damage_to_champions, damage_taken, vision_score,
                   items int[7], runes jsonb, summoner_spells int[2],
                   -- colonnes dérivées, calculées à l'insert (voir §8)
                   dpm, dtpm, kill_participation, cs_per_min,
                   gold_diff_at_14, cs_diff_at_14, vision_per_min)
                   PK (match_id, puuid)

-- Timeline brute compressée, pour recalculer sans refetch Riot
match_timeline (match_id PK, payload bytea)  -- JSON zstd, ~150 Ko au lieu de 2 Mo
```

**Index** : `match_participant (puuid, match_id DESC)` est l'index qui porte
l'historique de profil — c'est la requête la plus fréquente du site.

**Partitionnement** : `match` et `match_participant` partitionnés par mois. Permet de
détacher/archiver les saisons passées sans `DELETE` massif.

**Pourquoi garder la timeline brute** : quand on ajoutera une métrique (ex. « jungle
proximity »), on la recalcule sur l'existant au lieu de re-fetcher des millions de
timelines qu'on n'a plus le droit de redemander à ce rythme. 150 Ko × 1 M matchs =
150 Go — acceptable, et stockable sur S3/R2 plutôt qu'en DB si ça devient gênant.

### ClickHouse (V2)

Table `participant_flat` dénormalisée, alimentée par CDC depuis Postgres.
Clé de tri `(patch, queue_id, champion_id, tier)`. Sert les tier lists et les
« stats champion », qui sont des `GROUP BY` sur des dizaines de millions de lignes.

---

## 8. `packages/stats` — calculs dérivés

Fonctions **pures** `(MatchDto, TimelineDto) → DerivedStats`, zéro I/O. Exécutées une
fois à l'ingestion, résultat persisté en colonnes.

| Métrique | Calcul |
|---|---|
| DPM | `damageToChampions / (gameDuration / 60)` |
| DTPM | `damageTaken / (gameDuration / 60)` |
| KP% | `(kills + assists) / Σ kills de l'équipe` |
| CS/min | `(minionsKilled + neutralMinionsKilled) / minutes` |
| Gold diff @14 | `frame[14].gold(moi) − frame[14].gold(adversaire même rôle)` |
| CS diff @14 | idem sur `minionsKilled` |
| Vision/min | `visionScore / minutes` |

Précisions d'implémentation :
- Les frames de timeline sont espacées de **60 s** → `frame[14]` ≈ 14:00, pas 15:00.
  Choisir 14 et pas 15 pour rester avant le premier plongeon de tempo de jeu, et
  **documenter la convention** : les sites concurrents utilisent @15, les chiffres ne
  seront pas comparables.
- Le « laner adverse » se détermine par `teamPosition` ; si Riot renvoie `""`
  (parties anciennes ou remakes), la métrique vaut `NULL`, jamais 0.
- Filtrer les **remakes** (`gameDuration < 300`) de toutes les moyennes.
- `gameDuration` est en secondes, mais **en millisecondes** pour les parties d'avant
  le patch 11.20. Vérifier `gameEndTimestamp` pour trancher. Piège classique qui
  produit des DPM × 1000.

Ce package doit tourner sur des fixtures JSON commitées (3–4 matchs réels anonymisés),
en tests unitaires, sans réseau.

---

## 9. Stratégie de cache

| Donnée | Où | TTL |
|---|---|---|
| Riot ID → PUUID | Redis | 30 j |
| Profil + rank rendu | Redis (JSON) | 120 s |
| Détail de match | Postgres uniquement (immuable) | — |
| Live game | Redis | 30 s |
| Page profil HTML | Next.js ISR + `stale-while-revalidate` | 60 s / swr 300 s |
| Assets Data Dragon | CDN, versionnés par patch | 1 an, immutable |
| 404 joueur | Redis (cache négatif) | 5 min |

Le cache négatif n'est pas un détail : les bots SEO tapent en masse des pseudos
inexistants, et sans lui chaque 404 consomme un appel Riot.

---

## 10. API (`apps/api`)

```
GET  /v1/summoner/:platform/:gameName/:tagLine     profil + rank
GET  /v1/summoner/:puuid/matches?cursor=&queue=    historique paginé (keyset)
POST /v1/summoner/:puuid/refresh                   enqueue (202 + jobId)
GET  /v1/match/:matchId                            détail + timeline agrégée
GET  /v1/spectator/:platform/:puuid                live game
GET  /v1/stream/:puuid                             SSE: progression d'ingestion
```

- Pagination **keyset** sur `(game_creation DESC, match_id)`, jamais `OFFSET` :
  l'offset s'effondre au-delà de quelques milliers de lignes.
- `POST /refresh` ne bloque pas : il renvoie `202` + un `jobId`, le front suit via SSE.
- Validation d'entrée stricte (Zod) : `platform` dans une enum fermée, `gameName`
  longueur 3–16, `tagLine` 3–5. Ces champs partent dans des URLs vers Riot.

---

## 11. Frontend (`apps/web`)

Routes :
```
/                              recherche
/[platform]/[riotId]           profil        ← page SEO principale
/[platform]/[riotId]/champions stats par champion
/match/[matchId]               détail de partie
/live/[platform]/[riotId]      partie en cours
```

- **Profil en RSC + streaming** : en-tête (nom, rank) rendu serveur immédiatement,
  liste de matchs en `<Suspense>`. Perçu instantané malgré l'ingestion en cours.
- **ISR** sur la page profil : un visiteur sur un pseudo populaire sert du cache ;
  revalidation en arrière-plan.
- **SEO** : `generateMetadata` dynamique (« Nom#TAG — Stats LoL EUW »), JSON-LD, et
  surtout `noindex` sur les profils sans aucune partie, sinon Google indexe des
  millions de pages vides et dégrade tout le domaine.
- Graphes : Recharts (gold diff, LP history). Timeline de partie en SVG custom.
- Dark-first, `prefers-color-scheme` respecté.

---

## 12. Ce qui ne se rattrape pas

**L'historique.** La courbe de LP, l'évolution de rank, les stats « depuis le début de
la saison » se construisent en snapshotant la ladder en continu. Un site lancé
aujourd'hui a zéro historique et ne peut pas l'acheter : Riot n'expose aucun endpoint
rétroactif.

Conséquence sur la roadmap : **démarrer `league_history` et le crawl ladder le plus
tôt possible**, même avant d'avoir une UI pour l'afficher. Chaque semaine de retard est
une semaine d'historique définitivement perdue. C'est le seul composant où « on verra
plus tard » a un coût irréversible.

---

## 13. Infrastructure

### Développement
`docker-compose` : Postgres 16, Redis 7, Adminer.
`apps/*` tournent en local hors container (HMR).
**Prérequis manquant sur cette machine : Docker.** À installer (Docker Desktop +
intégration WSL2) avant de scaffolder.

### Production (V1, cible ~5 k visiteurs/jour)
- Web : Vercel, ou container derrière Cloudflare
- API + workers : 2 petits containers (Fly.io / Scaleway / Hetzner)
- Postgres managé : 2 vCPU / 8 Go, 100 Go SSD
- Redis managé : 1 Go
- CDN : Cloudflare (assets + cache HTML)

Ordre de grandeur : **80–150 €/mois**. Le poste qui dérape en V2 est le stockage des
timelines et le CPU du crawler, pas le trafic web.

### Scaling
Les workers sont sans état → scale horizontal libre. Le facteur limitant n'est jamais
le CPU, c'est **le quota Riot**. Ajouter des workers au-delà du quota n'accélère rien.

---

## 14. Observabilité

Métriques à exposer dès le jour 1 (Prometheus + Grafana, ou OpenTelemetry) :
- `riot_api_requests_total{endpoint,platform,status}`
- `riot_rate_limit_remaining{bucket}` ← **l'alerte la plus importante du système**
- `riot_429_total` → alerte immédiate, un 429 récurrent menace la clé
- `ingest_queue_depth{queue}` et âge du plus vieux job
- p95 de `GET /v1/summoner/...`

Logs structurés (pino) avec un `requestId` propagé API → job → appel Riot.

---

## 15. Sécurité et conformité

- Clé API **uniquement** côté serveur, jamais dans un bundle client, jamais commitée.
- Pas de PII : on stocke des PUUID et des Riot ID publics, rien d'autre. Pas de compte
  utilisateur en V1 → périmètre RGPD quasi nul. Prévoir malgré tout un endpoint de
  suppression sur demande.
- Conformité Riot Developer Policy :
  - mention « non affilié à Riot Games » visible
  - monétisation encadrée : la règle n'est pas « aucun paywall » (les
    concurrents vendent du Premium), mais un ensemble de contraintes sur ce
    qui peut être vendu. **À relire directement dans la Riot Developer
    Policy à jour avant toute décision commerciale** — ne pas se fier à ce
    résumé.
  - nom/logo sans confusion possible avec Riot ou avec un site existant
  - respect strict des rate limits (c'est le critère de révocation n°1)
- Le design et l'identité visuelle doivent être **originaux** : reprendre les
  fonctionnalités d'un concurrent est légitime, copier son UI ou sa marque ne l'est pas.

---

## 16. Roadmap

| Phase | Contenu | Sortie |
|---|---|---|
| 0 | Monorepo, docker-compose, schéma Drizzle, CI | squelette qui démarre |
| 1 | `riot-client` + rate limiter Redis + tests | le composant critique, validé |
| 2 | Workers `summoner-refresh` / `match-fetch` + `packages/stats` | ingestion fonctionnelle en CLI |
| 3 | API Fastify + page profil Next.js | **site en ligne** (prérequis à la demande de prod key) |
| 4 | Détail de partie, timeline graphée, live game | V1 complète |
| 5 | **Demande de production key** + `league_history` + crawl ladder | passage à l'échelle |
| 6 | ClickHouse, tier lists, leaderboards | V2 |

La phase 3 est le jalon réel : Riot n'accorde une production key qu'à un site
déjà déployé et fonctionnel. Tout ce qui précède tourne sous dev key, donc sur un
périmètre volontairement réduit (une plateforme, quelques joueurs de test).
