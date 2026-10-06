import { EventEmitter } from 'node:events';
import type { Platform } from '@laneform/shared';
import {
  MemoryRateLimiter,
  parseRateLimits,
  RateLimitTimeoutError,
  RiotApiError,
  RiotClient,
  type RateLimiter,
} from '@laneform/riot-client';
import {
  aggregateMatch,
  collectionFloor,
  hasSeenMatch,
  needsBuildOrder,
  type ItemIndex,
} from '@laneform/stats';
import type { AggregateFile } from './store.ts';

/**
 * Collecteur de parties, en tâche de fond.
 *
 * Parcours en graphe : on part de la ladder Challenger, on lit les parties de
 * ces joueurs, et chaque partie révèle neuf autres joueurs qu'on met en file.
 * La couverture s'élargit d'elle-même sans liste à maintenir.
 */

export interface CrawlerProgress {
  matchesCollected: number;
  queued: number;
  running: boolean;
  paused: boolean;
  lastError: string | null;
}

export interface CrawlerOptions {
  apiKey: string;
  appLimits: string;
  platform: Platform;
  file: AggregateFile;
  excludedItemIds?: ReadonlySet<number>;
  /** Métadonnées d'objets : sans elles, l'ordre de build n'est pas classable. */
  items?: ItemIndex;
  /** Part du quota laissée à la collecte. Le reste est réservé à l'interactif. */
  budgetFraction?: number;
  limiter?: RateLimiter;
  /** Journalisation de diagnostic, active via LANEFORM_DEBUG. */
  debug?: (message: string) => void;
  /** Journalisation permanente : amorce et erreurs, utiles chez tout le monde. */
  log?: (message: string) => void;
}

const QUEUE_RANKED_SOLO = 420;
const MATCHES_PER_PLAYER = 10;
/**
 * Timelines visées par couple champion/rôle.
 *
 * Au-delà, on cesse d'en demander : l'ordre de construction est stable bien
 * avant ce volume, alors qu'une timeline coûte un appel de plus et une
 * vingtaine de fois la bande passante du détail de partie.
 */
const BUILD_ORDER_TARGET = 200;
const MAX_QUEUE = 20_000;
const MAX_VISITED = 200_000;
const FLUSH_INTERVAL_MS = 60_000;

export class Crawler extends EventEmitter<{ progress: [CrawlerProgress] }> {
  private readonly client: RiotClient;
  private readonly queue: string[] = [];
  private readonly visited = new Set<string>();
  private readonly file: AggregateFile;
  private readonly platform: Platform;
  private readonly excluded: ReadonlySet<number>;
  private readonly items: ItemIndex | null;
  private timelines = 0;
  private readonly debug: (message: string) => void;
  private readonly log: (message: string) => void;

  private running = false;
  private paused = false;
  private stopped = false;
  private collected = 0;
  private lastError: string | null = null;
  private lastFlush = 0;
  private lastBudgetLog = 0;

  constructor(options: CrawlerOptions) {
    super();
    this.file = options.file;
    this.platform = options.platform;
    this.excluded = options.excludedItemIds ?? new Set<number>();
    this.items = options.items ?? null;
    this.debug = options.debug ?? (() => {});
    this.log = options.log ?? (() => {});
    this.client = new RiotClient({
      apiKey: options.apiKey,
      limiter: options.limiter ?? new MemoryRateLimiter(),
      appLimits: parseRateLimits(options.appLimits),
      // Budget secondaire : la collecte ne peut jamais consommer tout le
      // quota, pour que les rangs restent disponibles en début de partie.
      secondaryBudget: { scope: 'bulk', fraction: options.budgetFraction ?? 0.5 },
      // Attente longue tolérée : rien ne presse pour du trafic de fond.
      maxWaitMs: 120_000,
    });
  }

  get progress(): CrawlerProgress {
    return {
      matchesCollected: this.collected,
      queued: this.queue.length,
      running: this.running,
      paused: this.paused,
      lastError: this.lastError,
    };
  }

  private emitProgress(): void {
    this.emit('progress', this.progress);
  }

  /** Suspend sans perdre l'état : utilisé pendant que le joueur est en partie. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.file.flush();
    this.emitProgress();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emitProgress();
  }

  stop(): void {
    this.stopped = true;
    this.file.flush(true);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  private enqueue(puuid: string): void {
    if (this.visited.has(puuid) || this.queue.length >= MAX_QUEUE) return;
    this.visited.add(puuid);
    // Le Set ne sert qu'à éviter les doublons ; au-delà d'un certain volume on
    // accepte de revisiter plutôt que de laisser la mémoire croître sans fin.
    if (this.visited.size > MAX_VISITED) this.visited.clear();
    this.queue.push(puuid);
  }

  private async seed(): Promise<void> {
    const league = await this.client.challengerLeague(this.platform);
    const total = league.entries?.length ?? 0;
    const withPuuid = league.entries?.filter((e) => e.puuid).length ?? 0;
    this.log(`amorce : ${total} entrées Challenger, ${withPuuid} avec PUUID`);

    const seeds = (league.entries ?? []).map((e) => e.puuid).filter((p): p is string => !!p);
    // Mélange de Fisher-Yates : deux sessions successives n'attaquent pas la
    // ladder par le même bout, ce qui diversifie la collecte.
    for (let i = seeds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [seeds[i], seeds[j]] = [seeds[j]!, seeds[i]!];
    }
    for (const puuid of seeds) this.enqueue(puuid);
    if (this.queue.length === 0) {
      // Sans PUUID dans la réponse, le parcours ne peut pas démarrer. Mieux
      // vaut le dire que tourner indéfiniment à vide.
      this.lastError = 'Ladder Challenger sans PUUID exploitable';
    }
  }

  private async processPlayer(puuid: string): Promise<void> {
    // Plancher temporel : Riot attend des SECONDES, pas des millisecondes.
    // Sans ce filtre, les parties du patch précédent sont téléchargées puis
    // jetées — anodin en fin de patch, massif le lendemain d'une mise à jour.
    const floor = collectionFloor(this.file.store);
    const ids = await this.client.matchIdsByPuuid(this.platform, puuid, {
      queue: QUEUE_RANKED_SOLO,
      count: MATCHES_PER_PLAYER,
      ...(floor !== null ? { startTime: Math.floor(floor / 1000) } : {}),
    });
    // Filtrage AVANT téléchargement : au redémarrage, le parcours repart de la
    // même ladder et retombe sur les mêmes parties. Les refetcher coûtait un
    // appel et ~100 Ko chacune pour les jeter aussitôt.
    const fresh = ids.filter((id) => !hasSeenMatch(this.file.store, id));
    this.debug(
      `joueur ${puuid.slice(0, 8)}… : ${ids.length} parties, ${fresh.length} nouvelles`,
    );

    for (const matchId of fresh) {
      if (this.stopped || this.paused) return;

      const match = await this.client.matchById(this.platform, matchId);

      // La timeline n'est demandée que si elle apporte encore quelque chose.
      // Une fois les couples champion/rôle couverts, la collecte redevient
      // aussi légère qu'avant.
      let timeline;
      if (this.items && needsBuildOrder(this.file.store, match, BUILD_ORDER_TARGET)) {
        timeline = await this.client
          .matchTimelineById(this.platform, matchId)
          .catch(() => undefined);
        if (timeline) this.timelines += 1;
      }

      if (
        aggregateMatch(this.file.store, match, {
          excludedItemIds: this.excluded,
          ...(timeline && this.items ? { timeline, items: this.items } : {}),
        })
      ) {
        this.collected += 1;
        this.file.markDirty();
        if (this.collected === 1) this.log('première partie agrégée — la chaîne fonctionne');
      } else {
        // Remake, doublon, ou participants sans rôle : utile à distinguer d'un
        // échec réseau quand le compteur reste à zéro.
        this.debug(`partie ${matchId} ignorée par l'agrégation`);
      }

      // Chaque partie révèle neuf autres joueurs : c'est ce qui fait grossir
      // la file sans avoir à maintenir de liste.
      for (const other of match.metadata.participants) this.enqueue(other);

      if (Date.now() - this.lastFlush > FLUSH_INTERVAL_MS) {
        this.lastFlush = Date.now();
        this.file.flush();
        this.log(
          `collecte : ${this.collected} parties agrégées, ${this.timelines} timelines, ` +
            `${this.queue.length} en file`,
        );
        this.emitProgress();
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.paused) {
        await sleep(2000);
        continue;
      }

      try {
        if (this.queue.length === 0) await this.seed();
        const puuid = this.queue.shift();
        if (!puuid) {
          // Rien à faire : on réessaiera dans une minute plutôt que de
          // marteler l'amorce.
          await sleep(60_000);
          continue;
        }
        await this.processPlayer(puuid);
        this.lastError = null;
      } catch (err) {
        if (err instanceof RateLimitTimeoutError) {
          // Budget de fond épuisé : normal, mais à signaler — sinon une boucle
          // d'attente ressemble exactement à un collecteur bloqué.
          if (Date.now() - this.lastBudgetLog > 60_000) {
            this.lastBudgetLog = Date.now();
            this.log('budget de collecte épuisé, attente du renouvellement du quota');
          }
          await sleep(5000);
          continue;
        }
        if (err instanceof RiotApiError && (err.status === 401 || err.status === 403)) {
          this.lastError = 'Clé API invalide ou expirée : collecte arrêtée.';
          this.running = false;
          this.emitProgress();
          this.file.flush(true);
          return;
        }
        this.lastError = err instanceof Error ? err.message : String(err);
        this.log(`erreur de collecte : ${this.lastError}`);
        await sleep(5000);
      }
    }

    this.running = false;
    this.emitProgress();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
