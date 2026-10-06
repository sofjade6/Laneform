# Laneform

Plateforme de statistiques League of Legends, construite sur l'API Riot Games officielle.

> Laneform n'est pas affilié à Riot Games. League of Legends est une marque déposée de Riot Games, Inc.

L'architecture complète est dans [ARCHITECTURE.md](./ARCHITECTURE.md).

## Prérequis

- Node >= 22 (développé sous Node 24)
- Docker + docker compose
- Une clé API Riot : https://developer.riotgames.com/

## Démarrage

```bash
cp .env.example .env     # puis renseigner RIOT_API_KEY
npm install
npm run infra:up         # Postgres + Redis
npm run db:migrate
npm test
```

La clé de développement expire toutes les 24 h : il faut la régénérer sur le
portail Riot et mettre `.env` à jour.

## Paquets

| Paquet | Rôle |
|---|---|
| `@laneform/shared` | Types transverses : plateformes, routage régional, files de jeu |
| `@laneform/riot-client` | **Unique** point de sortie vers l'API Riot + rate limiter Redis |
| `@laneform/stats` | Calculs dérivés (DPM, KP %, écarts de lane). Fonctions pures |
| `@laneform/db` | Schéma Drizzle et migrations Postgres |

## Règles non négociables

1. **Rien d'autre que `@laneform/riot-client` n'appelle riotgames.com.** Le rate
   limiter n'a de sens que s'il voit la totalité du trafic sortant.
2. **Les matchs sont immuables.** Une partie ingérée n'est jamais refetchée.
3. **Jamais de `NULL` remplacé par `0`** dans les métriques dérivées : une valeur
   non mesurable qui devient 0 fausse toutes les moyennes agrégées.
4. **Un 429 est un incident.** Des 429 répétés font révoquer la clé de production.

## Tests

Les tests du rate limiter ont besoin d'un vrai Redis (le script Lua est
précisément ce qu'un mock ne peut pas valider). Sans `REDIS_URL`, ils sont
ignorés — pensez à `npm run infra:up` avant de les lancer.

```bash
npm test
REDIS_URL=redis://localhost:6379 npm test   # inclut les tests du limiter
```
