# Politique de confidentialité — Laneform

Dernière mise à jour : 6 octobre 2026

Laneform n'est pas affilié à Riot Games. League of Legends est une marque
déposée de Riot Games, Inc.

## En résumé

Laneform ne crée aucun compte, ne mesure pas votre usage, et n'envoie aucune
donnée à ses auteurs. Tout ce que l'application produit reste sur votre
ordinateur.

## Ce qui reste sur votre machine

Tout est écrit dans `%APPDATA%\Laneform\` et n'en sort jamais :

| Fichier | Contenu |
|---|---|
| `.env` | Votre clé API Riot, et l'adresse du service de rangs si vous en utilisez un |
| `aggregates.json` | Des compteurs de statistiques, et la liste des identifiants de parties déjà comptées |
| `client-cache.json` | Les noms des champions, objets, sorts et runes, copiés depuis votre client League |
| `icons/` | Les icônes correspondantes, copiées depuis votre client League |
| `laneform.log` | Un journal technique de démarrage et de collecte |

**Les parties collectées ne sont pas conservées.** Elles sont téléchargées,
réduites à des compteurs, puis jetées. `aggregates.json` ne contient ni nom de
joueur, ni identifiant de compte : seulement des nombres, et des identifiants
de parties servant à ne pas compter deux fois la même.

**Votre historique personnel** est lu directement dans votre client League,
pour vous proposer vos propres builds. Il ne quitte pas votre machine.

**Le journal** consigne des événements techniques. Si vous activez le mode
diagnostic (`LANEFORM_DEBUG`), il contient en plus les huit premiers
caractères d'identifiants de joueurs rencontrés pendant la collecte. Ce mode
est désactivé par défaut.

## Ce qui sort de votre machine

**Vers l'API de Riot Games.** Laneform interroge l'API officielle pour obtenir
les rangs des joueurs de votre partie et les statistiques publiques de
parties classées. Ces requêtes sont soumises à la politique de
confidentialité de Riot Games.

**Vers le service de rangs**, si vous en avez configuré un. L'application lui
transmet votre région et les Riot ID — les pseudonymes publics affichés en
jeu — des joueurs de votre partie, afin qu'il récupère leurs rangs. Ce service
ne conserve pas ces identifiants : les rangs obtenus sont gardés dix minutes
en cache, puis oubliés. Ses journaux ne contiennent que des codes d'erreur,
jamais de pseudonyme.

Si vous utilisez une instance hébergée par un tiers, l'hébergeur applique sa
propre politique de journalisation.

**Et rien d'autre.** Pas de télémétrie, pas de statistiques d'usage, pas de
rapport d'erreur automatique.

## Ce que Laneform ne fait pas

L'application lit uniquement les interfaces officielles mises à disposition
par Riot Games : l'API du client League, l'API de données de partie en cours,
et l'API publique. Elle n'interagit jamais avec le processus du jeu, ne lit
pas sa mémoire, n'automatise aucune action, et n'affiche aucune information
qu'un joueur ne pourrait obtenir lui-même.

## Supprimer vos données

Fermez l'application, puis supprimez le dossier `%APPDATA%\Laneform\`. Tout
disparaît, y compris votre clé.

Pour n'effacer que les statistiques collectées, utilisez le bouton
« Purger… » du tableau de bord.

## Contact

Les questions relatives à cette politique peuvent être posées via le dépôt du
projet.
