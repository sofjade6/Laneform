/**
 * Agrégats par champion, construits en avalant des parties une à une.
 *
 * Principe : on ne conserve JAMAIS les parties brutes, seulement des
 * compteurs. Une partie pèse ~100 Ko ; les compteurs de tout un patch tiennent
 * en quelques mégaoctets. C'est ce qui rend une collecte locale tenable.
 *
 * Tout est pur et synchrone : la persistance est la responsabilité de
 * l'appelant, ces fonctions ne font que transformer des structures.
 */

import { REMAKE_DURATION_SECONDS } from '@laneform/shared';
import type { MatchDto, TimelineDto } from '@laneform/riot-client';
import { durationSeconds } from './duration.ts';
import {
  buildForParticipant,
  extractPurchases,
  startersKey,
  type ItemIndex,
} from './buildOrder.ts';
import {
  allPerks,
  parseRuneKey,
  runeKey,
  runeSetup,
  spellPair,
  spellPairKey,
  type RuneSetup,
} from './loadout.ts';
import {
  finalItems,
  goldDiffAtMinute,
  laneOpponent,
  pushSeries,
  seriesStats,
  type Series,
  type SeriesStats,
} from './matchup.ts';

export interface Counter {
  games: number;
  wins: number;
}

export interface RoleStats extends Counter {
  /** itemId (en clé de chaîne, contrainte JSON) -> compteur. */
  items: Record<string, Counter>;
  /**
   * Ordre de construction. Optionnel : il demande la timeline, qui n'est
   * récupérée que sur un échantillon. Absent sur les agrégats antérieurs.
   */
  order?: BuildOrderStats;
  /** Duels de couloir, indexés par championId adverse. */
  matchups?: Record<string, MatchupStats>;
  /** Paires de sorts d'invocateur : « 4+14 » -> compteur. */
  spells?: Record<string, Counter>;
  /** Runes : « branche:runeClé:branchesecondaire » -> compteur. */
  runes?: Record<string, Counter>;
  /** Chaque rune prise individuellement : perkId -> compteur. */
  perkPicks?: Record<string, Counter>;
}

export interface MatchupStats {
  games: number;
  wins: number;
  /**
   * Écart d'or à 14 minutes. Alimenté seulement quand la timeline est
   * disponible, donc moins fourni que `games`.
   */
  gold: Series;
  /** Objets finaux construits dans ce duel : itemId -> compteur. */
  items: Record<string, Counter>;
}

export interface BuildOrderStats {
  /** Timelines analysées pour ce champion dans ce rôle. */
  samples: number;
  /** « 1055+2003 » -> compteur. */
  starters: Record<string, Counter>;
  /** Premier objet terminé : itemId -> compteur. */
  firstItem: Record<string, Counter>;
  /**
   * Les TROIS SUIVANTS, après le premier : « a>b>c » -> compteur.
   *
   * Volontairement disjoint de `firstItem`, qui est affiché à part : répéter
   * le premier objet dans la séquence n'apprend rien.
   */
  nextThree: Record<string, Counter>;
}

export interface ChampionStats {
  /** teamPosition -> statistiques. */
  roles: Record<string, RoleStats>;
}

export interface PatchAggregate {
  matches: number;
  /**
   * Date de création la plus ancienne observée sur ce patch (epoch ms).
   *
   * Converge vers la date de sortie du patch à mesure que la collecte avance,
   * et sert de plancher aux requêtes pour cesser de demander des parties
   * antérieures — elles seraient téléchargées puis jetées.
   */
  firstSeenAt?: number;
  /** championId (en clé de chaîne) -> statistiques. */
  champions: Record<string, ChampionStats>;
}

export interface AggregateStore {
  version: 1;
  patches: Record<string, PatchAggregate>;
  /** Parties déjà comptées, pour ne pas les compter deux fois. */
  seen: string[];
}

/** Au-delà, les identifiants les plus anciens sont oubliés (FIFO). */
const SEEN_CAPACITY = 60_000;

/**
 * Index de recherche sur `seen`, reconstruit à la demande.
 *
 * `seen` est un tableau parce qu'il doit se sérialiser en JSON et garder son
 * ordre d'insertion. Mais un `includes` sur 60 000 entrées, répété pour chaque
 * partie collectée, coûterait des milliards de comparaisons par jour : on
 * double donc la structure d'un Set, non persisté.
 */
const seenIndex = new WeakMap<AggregateStore, Set<string>>();

function seenSet(store: AggregateStore): Set<string> {
  let set = seenIndex.get(store);
  if (!set || set.size !== store.seen.length) {
    set = new Set(store.seen);
    seenIndex.set(store, set);
  }
  return set;
}

/**
 * Écarte les relevés d'ordre inexploitables.
 *
 * Des échantillons comptés sans aucun objet terminé viennent forcément d'une
 * analyse faite avec un catalogue incomplet. Les laisser bloquerait le quota
 * de timelines à jamais ; on les remet à zéro pour que la collecte reprenne.
 */
export function repairBuildOrder(store: AggregateStore): number {
  let repaired = 0;
  for (const bucket of Object.values(store.patches)) {
    for (const champion of Object.values(bucket.champions)) {
      for (const stats of Object.values(champion.roles)) {
        const order = stats.order;
        if (!order) continue;

        // `firstThree` est l'ancien format : il comptait les trois premiers
        // objets, premier inclus. Le conserver mélangerait deux sémantiques
        // dans le même compteur.
        const legacy = 'firstThree' in (order as unknown as Record<string, unknown>);
        const unusable = order.samples > 0 && Object.keys(order.firstItem).length === 0;

        if (legacy || unusable) {
          delete stats.order;
          repaired += 1;
        }
      }
    }
  }
  return repaired;
}

export function emptyStore(): AggregateStore {
  return { version: 1, patches: {}, seen: [] };
}

/**
 * Clé de patch : « 14.1.586.1234 » -> « 14.1 ».
 *
 * Cloisonner par patch n'est pas une coquetterie : après un rééquilibrage, les
 * builds de la veille induisent en erreur. Mélanger les patchs produirait des
 * chiffres lissés qui ne décrivent aucune version réelle du jeu.
 */
export function patchKey(gameVersion: string): string {
  const parts = gameVersion.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : gameVersion;
}

function counter(): Counter {
  return { games: 0, wins: 0 };
}

export interface AggregateOptions {
  /** Consommables et babioles : hors des builds. */
  excludedItemIds?: ReadonlySet<number>;
  /**
   * Timeline de la partie. Fournie seulement sur l'échantillon pour lequel le
   * collecteur accepte le surcoût : elle seule porte l'ordre des achats.
   */
  timeline?: TimelineDto;
  /** Métadonnées d'objets, indispensables pour classer composants et finis. */
  items?: ItemIndex;
}

function bump(bucket: Record<string, Counter>, key: string, win: boolean): void {
  const entry = (bucket[key] ??= counter());
  entry.games += 1;
  if (win) entry.wins += 1;
}

/** participantId de la timeline, indexé par puuid. */
function participantIds(timeline: TimelineDto): Map<string, number> {
  const map = new Map<string, number>();
  const declared = timeline.info.participants;
  if (declared) {
    for (const p of declared) map.set(p.puuid, p.participantId);
    return map;
  }
  // Repli : l'ordre de `metadata.participants` correspond aux id 1..10.
  timeline.metadata.participants.forEach((puuid, i) => map.set(puuid, i + 1));
  return map;
}

/**
 * Compte une partie. Renvoie `false` si elle a été ignorée (déjà vue, remake,
 * données inexploitables) — utile pour afficher une progression honnête.
 *
 * Mute `store` : agréger des dizaines de milliers de parties en recopiant la
 * structure à chaque fois coûterait plus cher que la collecte elle-même.
 */
export function aggregateMatch(
  store: AggregateStore,
  match: MatchDto,
  options: AggregateOptions = {},
): boolean {
  const matchId = match.metadata?.matchId;
  if (!matchId) return false;
  const seen = seenSet(store);
  if (seen.has(matchId)) return false;

  // Les remakes n'ont ni build complet ni issue signifiante.
  if (durationSeconds(match) < REMAKE_DURATION_SECONDS) return false;

  const excluded = options.excludedItemIds ?? new Set<number>();
  const purchases = options.timeline ? extractPurchases(options.timeline) : null;
  const idByPuuid = options.timeline ? participantIds(options.timeline) : null;
  const patch = patchKey(match.info.gameVersion);
  const bucket = (store.patches[patch] ??= { matches: 0, champions: {} });

  const created = match.info.gameCreation;
  if (typeof created === 'number' && created > 0) {
    bucket.firstSeenAt = Math.min(bucket.firstSeenAt ?? created, created);
  }

  let counted = false;

  for (const participant of match.info.participants) {
    const role = participant.teamPosition;
    // Sans rôle, impossible de rattacher la statistique : les parties
    // anciennes et certains modes ne le renseignent pas.
    if (!role) continue;

    const champion = (bucket.champions[String(participant.championId)] ??= { roles: {} });
    const stats = (champion.roles[role] ??= { games: 0, wins: 0, items: {} });

    stats.games += 1;
    if (participant.win) stats.wins += 1;
    counted = true;

    const items = [0, 1, 2, 3, 4, 5, 6]
      .map((slot) => participant[`item${slot}`])
      .filter((id): id is number => typeof id === 'number' && id > 0 && !excluded.has(id));

    // Dédoublonné : deux exemplaires du même objet ne font pas deux parties.
    for (const itemId of new Set(items)) {
      bump(stats.items, String(itemId), participant.win);
    }

    // Sorts et runes : aucun besoin de timeline, donc comptés sur toutes les
    // parties collectées — ces deux séries sont les mieux fournies.
    const spells = spellPair(participant);
    if (spells) {
      bump((stats.spells ??= {}), spellPairKey(spells), participant.win);
    }

    const runes = runeSetup(participant);
    if (runes) {
      bump((stats.runes ??= {}), runeKey(runes), participant.win);
    }

    for (const perkId of allPerks(participant)) {
      bump((stats.perkPicks ??= {}), String(perkId), participant.win);
    }

    // Duel de couloir. Les objets viennent de l'inventaire final, donc
    // disponibles sur TOUTES les parties ; seul l'écart d'or exige la
    // timeline. Les deux séries n'ont pas le même effectif, à dessein.
    const opponent = laneOpponent(match.info.participants, participant);
    if (opponent) {
      const matchups = (stats.matchups ??= {});
      const duel = (matchups[String(opponent.championId)] ??= {
        games: 0,
        wins: 0,
        gold: { n: 0, sum: 0, squares: 0 },
        items: {},
      });

      duel.games += 1;
      if (participant.win) duel.wins += 1;
      for (const itemId of finalItems(participant, excluded)) {
        bump(duel.items, String(itemId), participant.win);
      }

      if (options.timeline) {
        const diff = goldDiffAtMinute(options.timeline, participant.puuid, opponent.puuid);
        if (diff !== null) pushSeries(duel.gold, diff);
      }
    }

    if (purchases && options.items) {
      const participantId = idByPuuid?.get(participant.puuid);
      if (participantId !== undefined) {
        const build = buildForParticipant(purchases, participantId, options.items);
        const order = (stats.order ??= {
          samples: 0,
          starters: {},
          firstItem: {},
          nextThree: {},
        });
        // On ne compte un échantillon QUE s'il a produit un objet terminé.
        //
        // Sinon un catalogue incomplet — prix manquants, donc rien de
        // classable — remplit le quota avec des analyses inutilisables, et le
        // collecteur cesse de demander des timelines pour ce couple sans
        // jamais avoir rien obtenu. C'est exactement ce qui s'est produit.
        if (build.completed[0] === undefined) continue;

        order.samples += 1;
        bump(order.firstItem, String(build.completed[0]), participant.win);

        // Un départ vide signifie « non observé » (achat hors fenêtre, données
        // manquantes) : l'enregistrer créerait une option fantôme en tête de
        // classement.
        if (build.starters.length > 0) {
          bump(order.starters, startersKey(build.starters), participant.win);
        }
        // Il faut quatre objets terminés pour avoir trois suivants complets.
        // Les parties plus courtes ne contribuent pas à cette section : mieux
        // vaut moins d'échantillons que des séquences de longueurs mélangées,
        // qui fragmenteraient les compteurs.
        if (build.completed.length >= 4) {
          bump(order.nextThree, build.completed.slice(1, 4).join('>'), participant.win);
        }
      }
    }
  }

  if (!counted) return false;

  bucket.matches += 1;
  store.seen.push(matchId);
  seen.add(matchId);
  if (store.seen.length > SEEN_CAPACITY) {
    const dropped = store.seen.splice(0, store.seen.length - SEEN_CAPACITY);
    for (const id of dropped) seen.delete(id);
  }
  return true;
}

/**
 * Cette partie a-t-elle déjà été comptée ?
 *
 * Permet de l'écarter AVANT de la télécharger : un détail de partie pèse une
 * centaine de kilo-octets et coûte un appel d'API, dépensés pour rien si on ne
 * découvre qu'ensuite qu'elle est connue.
 */
export function hasSeenMatch(store: AggregateStore, matchId: string): boolean {
  return seenSet(store).has(matchId);
}

/**
 * Cette partie apporterait-elle encore de l'ordre de build utile ?
 *
 * Vrai tant qu'au moins un de ses participants joue un couple champion/rôle
 * sous le quota d'échantillons. C'est ce qui borne le coût : la timeline pèse
 * une vingtaine de fois le détail d'une partie, et l'ordre de construction
 * converge bien avant les taux de victoire.
 */
export function needsBuildOrder(
  store: AggregateStore,
  match: MatchDto,
  target: number,
): boolean {
  const bucket = store.patches[patchKey(match.info.gameVersion)];
  if (!bucket) return true;

  for (const participant of match.info.participants) {
    const role = participant.teamPosition;
    if (!role) continue;
    const stats = bucket.champions[String(participant.championId)]?.roles[role];
    if ((stats?.order?.samples ?? 0) < target) return true;
  }
  return false;
}

export interface ItemStat {
  itemId: number;
  games: number;
  /** Fraction des parties du champion dans ce rôle où l'objet est présent. */
  pickRate: number;
  /** `null` sous le seuil d'échantillon. */
  winRate: number | null;
}

export interface ChampionSummary {
  games: number;
  /** `null` sous le seuil d'échantillon. */
  winRate: number | null;
  items: ItemStat[];
  lowSample: boolean;
}

export interface SummaryOptions {
  minGames?: number;
  maxItems?: number;
}

const DEFAULT_MIN_GAMES = 50;
const DEFAULT_MAX_ITEMS = 6;

/**
 * Résumé exploitable par l'overlay pour un champion dans un rôle.
 *
 * Renvoie `null` si le champion n'a jamais été vu : l'UI doit pouvoir dire
 * « pas encore de données » plutôt que d'afficher des zéros.
 */
export function championSummary(
  store: AggregateStore,
  patch: string,
  championId: number,
  role: string,
  options: SummaryOptions = {},
): ChampionSummary | null {
  const minGames = options.minGames ?? DEFAULT_MIN_GAMES;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

  const stats = store.patches[patch]?.champions[String(championId)]?.roles[role];
  if (!stats || stats.games === 0) return null;

  const lowSample = stats.games < minGames;

  const items: ItemStat[] = Object.entries(stats.items)
    .map(([id, c]) => ({
      itemId: Number(id),
      games: c.games,
      pickRate: c.games / stats.games,
      // Le seuil s'applique aussi à l'objet : un objet vu 3 fois sur 500
      // parties n'a pas de taux de victoire exploitable.
      winRate: c.games >= minGames ? c.wins / c.games : null,
    }))
    .sort((a, b) => b.games - a.games || a.itemId - b.itemId)
    .slice(0, maxItems);

  return {
    games: stats.games,
    winRate: lowSample ? null : stats.wins / stats.games,
    items,
    lowSample,
  };
}

export interface OrderOption {
  /** Objets concernés, dans l'ordre. Un seul pour « premier objet ». */
  itemIds: number[];
  games: number;
  /** Part des échantillons où ce choix apparaît. */
  share: number;
  /** `null` sous le seuil : un taux sur 4 observations n'informe pas. */
  winRate: number | null;
}

export interface BuildOrderSummary {
  samples: number;
  starters: OrderOption[];
  firstItems: OrderOption[];
  sequences: OrderOption[];
}

function topOptions(
  bucket: Record<string, Counter>,
  samples: number,
  separator: string,
  minGames: number,
  limit: number,
): OrderOption[] {
  return Object.entries(bucket)
    .map(([key, c]) => ({
      itemIds: key.split(separator).map(Number).filter((n) => Number.isFinite(n)),
      games: c.games,
      share: samples > 0 ? c.games / samples : 0,
      winRate: c.games >= minGames ? c.wins / c.games : null,
    }))
    // Fréquence d'abord : sur un échantillon modeste, « souvent joué » est un
    // signal plus solide qu'un taux de victoire.
    .sort((a, b) => b.games - a.games)
    .slice(0, limit);
}

/**
 * Ordre de construction observé pour un champion dans un rôle.
 *
 * `null` tant qu'aucune timeline n'a été analysée : l'interface doit pouvoir
 * dire « pas encore collecté » plutôt que d'afficher des listes vides.
 */
export function buildOrderSummary(
  store: AggregateStore,
  patch: string,
  championId: number,
  role: string,
  options: { minGames?: number; limit?: number } = {},
): BuildOrderSummary | null {
  const order = store.patches[patch]?.champions[String(championId)]?.roles[role]?.order;
  if (!order || order.samples === 0) return null;

  const minGames = options.minGames ?? 20;
  const limit = options.limit ?? 3;

  return {
    samples: order.samples,
    starters: topOptions(order.starters, order.samples, '+', minGames, limit),
    firstItems: topOptions(order.firstItem, order.samples, '+', minGames, limit),
    sequences: topOptions(order.nextThree, order.samples, '>', minGames, limit),
  };
}

/**
 * Marge sous le plancher de collecte.
 *
 * Sans elle, le plancher se figerait sur la plus ancienne partie déjà vue :
 * plus rien d'antérieur ne serait demandé, donc le minimum ne pourrait plus
 * descendre vers la vraie date de sortie du patch.
 */
export const FLOOR_MARGIN_MS = 48 * 60 * 60 * 1000;

/**
 * Nombre de parties avant d'appliquer le plancher.
 *
 * Juste après un patch, la première partie rencontrée peut dater de
 * plusieurs jours après la sortie ; s'y accrocher tout de suite amputerait le
 * début du patch. On attend que le minimum ait eu le temps de converger.
 */
export const FLOOR_MIN_MATCHES = 200;

/**
 * Date à partir de laquelle il vaut la peine de demander des parties, en
 * epoch ms. `null` tant que la collecte est trop jeune pour en décider.
 */
export function collectionFloor(
  store: AggregateStore,
  minMatches = FLOOR_MIN_MATCHES,
  marginMs = FLOOR_MARGIN_MS,
): number | null {
  const current = knownPatches(store)[0];
  if (!current) return null;

  const bucket = store.patches[current];
  if (!bucket || bucket.matches < minMatches || bucket.firstSeenAt === undefined) return null;

  return Math.max(0, bucket.firstSeenAt - marginMs);
}

export interface LoadoutOption<T> {
  value: T;
  games: number;
  /** Part des parties du champion dans ce rôle. */
  share: number;
  /** `null` sous le seuil. */
  winRate: number | null;
}

export interface LoadoutSummary {
  games: number;
  spells: LoadoutOption<[number, number]>[];
  runes: LoadoutOption<RuneSetup>[];
  /** Chaque rune choisie, de la plus fréquente à la moins fréquente. */
  perks: LoadoutOption<number>[];
}

const LOADOUT_MIN_GAMES = 30;

/**
 * Sorts et runes les plus joués. `null` si le couple n'a jamais été vu.
 *
 * Classement par fréquence : sur ces choix, « ce que jouent les gens » est le
 * signal recherché, et il est bien plus stable qu'un taux de victoire.
 */
export function loadoutSummary(
  store: AggregateStore,
  patch: string,
  championId: number,
  role: string,
  options: { minGames?: number; limit?: number; perkLimit?: number } = {},
): LoadoutSummary | null {
  const stats = store.patches[patch]?.champions[String(championId)]?.roles[role];
  if (!stats || stats.games === 0) return null;

  const minGames = options.minGames ?? LOADOUT_MIN_GAMES;
  const limit = options.limit ?? 3;

  const rank = <T>(
    bucket: Record<string, Counter> | undefined,
    parse: (key: string) => T | null,
  ): LoadoutOption<T>[] =>
    Object.entries(bucket ?? {})
      .map(([key, c]) => ({
        value: parse(key),
        games: c.games,
        share: c.games / stats.games,
        winRate: c.games >= minGames ? c.wins / c.games : null,
      }))
      .filter((o): o is LoadoutOption<T> => o.value !== null)
      .sort((a, b) => b.games - a.games)
      .slice(0, Math.max(limit, options.perkLimit ?? 14));

  return {
    games: stats.games,
    spells: rank<[number, number]>(stats.spells, (key) => {
      const parts = key.split('+').map(Number);
      return parts.length === 2 && parts.every((n) => Number.isFinite(n) && n > 0)
        ? [parts[0]!, parts[1]!]
        : null;
    }).slice(0, limit),
    runes: rank<RuneSetup>(stats.runes, parseRuneKey).slice(0, limit),
    // Plafond plus haut : une page compte neuf runes, en afficher trois
    // n'aurait aucun sens.
    perks: rank<number>(stats.perkPicks, (key) => {
      const id = Number(key);
      return Number.isFinite(id) && id > 0 ? id : null;
    }).slice(0, options.perkLimit ?? 14),
  };
}

export interface MatchupItem {
  itemId: number;
  games: number;
  /** Part des duels où l'objet est présent en fin de partie. */
  share: number;
}

export interface MatchupOption {
  opponentId: number;
  games: number;
  /** `null` sous le seuil : voir le commentaire de `MATCHUP_WINRATE_MIN`. */
  winRate: number | null;
  /** Écart d'or à 14 min, moyenne et marge à 95 %. `null` sous le seuil. */
  goldDiff: SeriesStats | null;
  items: MatchupItem[];
}

/**
 * Seuils de publication.
 *
 * Le taux de victoire est volontairement très exigeant : sur 100 duels sa
 * marge dépasse ±9 points, de quoi lire un avantage là où il n'y en a pas.
 * Une moyenne d'écart d'or, elle, est exploitable bien plus tôt — c'est tout
 * l'intérêt d'une variable continue.
 */
export const MATCHUP_GOLD_MIN = 50;
export const MATCHUP_WINRATE_MIN = 300;
export const MATCHUP_ITEM_MIN = 30;

/**
 * Duels observés pour un champion dans un rôle, du plus fréquent au moins
 * fréquent. `null` si aucun duel n'a encore été enregistré.
 */
export function matchupSummary(
  store: AggregateStore,
  patch: string,
  championId: number,
  role: string,
  options: { limit?: number; maxItems?: number } = {},
): MatchupOption[] | null {
  const matchups = store.patches[patch]?.champions[String(championId)]?.roles[role]?.matchups;
  if (!matchups) return null;

  const limit = options.limit ?? 12;
  const maxItems = options.maxItems ?? 5;

  const rows = Object.entries(matchups).map(([id, duel]) => ({
    opponentId: Number(id),
    games: duel.games,
    winRate: duel.games >= MATCHUP_WINRATE_MIN ? duel.wins / duel.games : null,
    goldDiff: seriesStats(duel.gold, MATCHUP_GOLD_MIN),
    items:
      duel.games >= MATCHUP_ITEM_MIN
        ? Object.entries(duel.items)
            .map(([itemId, c]) => ({
              itemId: Number(itemId),
              games: c.games,
              share: c.games / duel.games,
            }))
            .sort((a, b) => b.games - a.games)
            .slice(0, maxItems)
        : [],
  }));

  rows.sort((a, b) => b.games - a.games || a.opponentId - b.opponentId);
  return rows.slice(0, limit);
}

/** Patchs présents, du plus récent au plus ancien (ordre numérique). */
export function knownPatches(store: AggregateStore): string[] {
  return Object.keys(store.patches).sort((a, b) => {
    const [aMaj = 0, aMin = 0] = a.split('.').map(Number);
    const [bMaj = 0, bMin = 0] = b.split('.').map(Number);
    return bMaj - aMaj || bMin - aMin;
  });
}

/**
 * Oublie les patchs les plus anciens.
 *
 * Sans ça le fichier grossit indéfiniment avec des données que plus personne
 * ne consultera : on ne lit jamais les builds d'il y a six mois.
 */
export function prunePatches(store: AggregateStore, keep = 2): void {
  const ordered = knownPatches(store);
  for (const patch of ordered.slice(keep)) {
    delete store.patches[patch];
  }
}

/**
 * Seuil à partir duquel le patch courant se suffit à lui-même.
 *
 * En dessous, le patch précédent est conservé : sans lui, les premières heures
 * suivant une mise à jour afficheraient une collecte vide, alors que les
 * builds de la veille restent largement pertinents.
 */
export const PATCH_HANDOVER_MATCHES = 500;

/**
 * Ne conserve que le patch courant, dès qu'il est exploitable.
 *
 * Le précédent sert uniquement de filet pendant la transition. Renvoie les
 * patchs supprimés, pour journalisation.
 */
export function pruneStalePatches(
  store: AggregateStore,
  minMatches = PATCH_HANDOVER_MATCHES,
): string[] {
  const ordered = knownPatches(store);
  const current = ordered[0];
  if (!current) return [];

  const mature = (store.patches[current]?.matches ?? 0) >= minMatches;
  // Patch courant encore maigre : on garde le précédent, et uniquement lui.
  const keep = mature ? 1 : 2;

  const dropped = ordered.slice(keep);
  for (const patch of dropped) delete store.patches[patch];
  return dropped;
}
