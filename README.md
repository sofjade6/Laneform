# Laneform

Overlay de bureau pour League of Legends : statistiques de partie en direct,
aide au draft, et statistiques de builds que l'application construit
elle-même.

> **Laneform n'est pas affilié à Riot Games.** League of Legends et Riot Games
> sont des marques déposées de Riot Games, Inc.

---

## Installation

Téléchargez `Laneform Setup` depuis la page
[Releases](https://github.com/sofjade6/Laneform/releases), puis lancez
l'installeur. Windows 10 ou 11, 64 bits.

L'installeur n'est pas signé : Windows SmartScreen affiche un avertissement.
Cliquez sur « Informations complémentaires », puis « Exécuter quand même ».

Rien d'autre à configurer. Pas de compte, pas d'inscription.

## Ce que fait l'application

**Pendant la partie**, un overlay affiche l'horloge, les timers de Dragon, de
Nashor et des larves, les statistiques des dix joueurs — niveau, KDA, CS —
et leur rang.

**Pendant la sélection des champions**, un panneau affiche les deux équipes,
vos propres builds les plus performants sur le champion choisi, ceux joués en
haut elo, et l'écart d'or attendu face à chaque adversaire.

**Le tableau de bord**, ouvert au lancement ou par `Ctrl+Shift+D`, permet de
parcourir les champions collectés : objets, ordre de construction, sorts
d'invocateur, runes, et duels de lane.

### Raccourcis

| Raccourci | Effet |
|---|---|
| `Ctrl+Shift+O` | Afficher ou masquer l'overlay |
| `Ctrl+Shift+D` | Ouvrir le tableau de bord |
| `Ctrl+Shift+K` | Configurer la clé API |

Pour quitter : clic droit sur l'icône Laneform dans la zone de notification.

### L'overlay reste invisible en plein écran exclusif

C'est une limite de Windows, commune à tous les overlays. Passez League en
mode **Sans bordure** ou **Fenêtré** dans les options vidéo.

## Collecter vos propres statistiques

L'application est livrée avec un jeu de statistiques déjà constitué. Pour la
laisser en collecter davantage, il faut une clé API Riot personnelle,
gratuite, demandée sur [developer.riotgames.com](https://developer.riotgames.com).
Saisissez-la via `Ctrl+Shift+K`.

Sans clé, tout le reste fonctionne : overlay, timers, draft, builds
personnels, et les statistiques fournies avec l'application.

La collecte tourne en arrière-plan, se met en pause dès que vous entrez en
partie, et ne consomme qu'une fraction de votre quota. Elle ne conserve aucune
partie : seulement des compteurs.

## Confidentialité

Laneform ne crée aucun compte, ne mesure pas votre usage et n'envoie aucune
donnée à ses auteurs. Tout reste dans `%APPDATA%\Laneform\`.

Le détail figure dans [PRIVACY.md](./PRIVACY.md).

## Ce que l'application ne fait pas

Laneform lit **uniquement** les interfaces officielles mises à disposition par
Riot Games : l'API du client League, l'API de données de partie en cours, et
l'API publique.

Elle n'interagit jamais avec le processus du jeu, ne lit pas sa mémoire,
n'automatise aucune action, et n'affiche aucune information qu'un joueur ne
pourrait obtenir lui-même.

Le code est public : ces affirmations sont vérifiables.

---

## Développement

```bash
npm install
npm test                      # 175 tests
npm run typecheck             # application, overlay, Worker
npm run desktop:dev           # lance l'application
npm run -w @laneform/desktop dist   # produit l'installeur
```

Node >= 22. Aucune base de données ni conteneur n'est nécessaire : les
statistiques sont des compteurs dans un fichier JSON local.

### Organisation

| Dossier | Rôle |
|---|---|
| `apps/desktop` | Application Electron : overlay, tableau de bord, collecteur |
| `apps/api` | Worker Cloudflare : détient la clé API, sert les rangs |
| `packages/shared` | Types transverses, routage plateforme / région |
| `packages/riot-client` | Unique point de sortie vers l'API Riot, limiteur de débit |
| `packages/stats` | Calculs purs : métriques, ordre de build, runes, duels |

L'architecture détaillée est dans [ARCHITECTURE.md](./ARCHITECTURE.md).

### Règles non négociables

1. **Rien d'autre que `@laneform/riot-client` n'appelle riotgames.com.** Le
   limiteur de débit n'a de sens que s'il voit la totalité du trafic sortant.
2. **Les parties sont immuables.** Une partie agrégée n'est jamais
   retéléchargée.
3. **Jamais de `null` remplacé par `0`** dans les métriques : une valeur non
   mesurable qui devient zéro fausse toutes les moyennes.
4. **Un 429 est un incident.** Des 429 répétés font révoquer une clé.

### Tests

Les tests du limiteur Redis demandent un vrai Redis — un script Lua est
précisément ce qu'un bouchon ne peut pas valider. Sans `REDIS_URL`, ils sont
ignorés.

```bash
npm test
REDIS_URL=redis://localhost:6379 npm test
```

### Backend

```bash
cd apps/api
npx wrangler secret put RIOT_API_KEY
npx wrangler deploy
```

Son unique rôle est de détenir la clé API, qui ne peut pas vivre dans un
exécutable distribué. L'application fonctionne sans lui, en appelant Riot
directement avec une clé locale — c'est le mode destiné à un usage personnel.
