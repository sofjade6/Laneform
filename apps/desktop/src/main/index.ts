import { app, BrowserWindow, dialog, globalShortcut, ipcMain, type Tray } from 'electron';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { Platform } from '@laneform/shared';
import {
  allObjectiveTimers,
  computeLiveStats,
  emptyStore,
  knownPatches,
  type PastGame,
} from '@laneform/stats';
import { LcuWatcher } from './lcu/watcher.ts';
import { LcuClient } from './lcu/client.ts';
import { LcuEventStream } from './lcu/events.ts';
import { loadCatalog, mergeCatalog, type GameCatalog } from './lcu/gamedata.ts';
import { loadClientCache, saveClientCache } from './lcu/catalogCache.ts';
import { detectPlatform, normalizePlatform } from './lcu/platform.ts';
import { fetchPersonalHistory } from './lcu/matchHistory.ts';
import { LivePoller } from './live/poller.ts';
import { mapLcuPhase, StateMachine } from './state/machine.ts';
import { buildChampSelectPayload } from './champselect/tracker.ts';
import { createOverlayWindow } from './overlay/window.ts';
import { envPath, loadConfig, looksLikeApiKey, saveEnv } from './config.ts';
import { createSetupWindow } from './setup/window.ts';
import { createDashboardWindow } from './dashboard/window.ts';
import { createTray } from './tray.ts';
import { installCrashHandlers, log, logError } from './logger.ts';
import { syncIcons } from './lcu/icons.ts';
import { handleIconProtocol, registerIconScheme } from './icons/protocol.ts';
import { buildDashboardPayload, buildDetail } from './dashboard/data.ts';
import { CHECK_MESSAGE, validateApiKey } from './setup/validate.ts';
import { AggregateFile } from './collector/store.ts';
import { Crawler, type CrawlerProgress } from './collector/crawler.ts';
import { formatRank, RankService, type RiotId } from './ranks/service.ts';
import { MemoryRateLimiter } from '@laneform/riot-client';
import type { OverlayPayload, PlayerRow } from './ipc/payload.ts';

/**
 * Nom d'application fixé explicitement.
 *
 * Sans cela, `app.getName()` vaut `@laneform/desktop` (le `name` du
 * package.json) en développement et `Laneform` une fois empaquetée — donc deux
 * dossiers de données distincts. La clé saisie dans l'un reste invisible pour
 * l'autre, et la collecte repart de zéro à chaque changement de mode.
 */
app.setName('Laneform');
installCrashHandlers();
// Doit précéder `whenReady` : Electron n'accepte plus d'enregistrer un schéma
// privilégié une fois l'application prête.
registerIconScheme();

const TOGGLE_SHORTCUT = 'Control+Shift+O';
/** Rouvre la configuration, p.ex. pour remplacer une clé expirée. */
const SETTINGS_SHORTCUT = 'Control+Shift+K';
/** Ouvre le tableau de bord de la collecte. */
const DASHBOARD_SHORTCUT = 'Control+Shift+D';
const CHAMP_SELECT_URI = '/lol-champ-select/v1/session';

let overlay: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let dashboardWindow: BrowserWindow | null = null;
/** Référence conservée : un Tray collecté disparaît de la zone de notification. */
let tray: Tray | null = null;
let eventStream: LcuEventStream | null = null;
let client: LcuClient | null = null;

const machine = new StateMachine();
const watcher = new LcuWatcher();
const poller = new LivePoller();

let lastGame: OverlayPayload['game'] = null;
let champSelect: OverlayPayload['champSelect'] = null;

/**
 * Catalogue et historique sont chargés une fois par connexion au client, puis
 * réutilisés. L'historique ne change qu'entre deux parties, et le catalogue
 * qu'entre deux patchs : les relire à chaque sélection ajouterait de la
 * latence au moment précis où l'affichage doit être immédiat.
 */
let catalog: GameCatalog | null = null;
let history: PastGame[] = [];

let ranks: RankService | null = null;
/**
 * Un seul limiteur pour toute l'application.
 *
 * Le collecteur et l'affichage des rangs partagent la même clé : avec deux
 * limiteurs séparés, chacun s'autorisait le quota entier et la réserve de
 * 50 % ne protégeait rien.
 */
const sharedLimiter = new MemoryRateLimiter();
let aggregates: AggregateFile | null = null;
let crawler: Crawler | null = null;
let crawlerProgress: CrawlerProgress | null = null;
let platform: Platform | null = null;
/** Rangs de la partie en cours, indexés par Riot ID. Vidés à chaque partie. */
let gameRanks = new Map<string, string | null>();
let rankLookupDone = false;

/**
 * Riot ID d'un joueur tel que l'expose la Live Client Data API.
 *
 * `riotIdGameName` est absent des versions anciennes et de certains modes :
 * on retombe alors sur `summonerName`, qui peut déjà contenir `Nom#TAG`.
 */
function riotIdOf(player: {
  riotIdGameName?: string;
  riotIdTagLine?: string;
  summonerName: string;
}): RiotId | null {
  if (player.riotIdGameName && player.riotIdTagLine) {
    return { gameName: player.riotIdGameName, tagLine: player.riotIdTagLine };
  }
  const hash = player.summonerName.indexOf('#');
  if (hash > 0) {
    return {
      gameName: player.summonerName.slice(0, hash),
      tagLine: player.summonerName.slice(hash + 1),
    };
  }
  return null;
}

/**
 * Les noms d'événements de la Live Client Data API ne sont pas documentés
 * publiquement et changent avec les objectifs ajoutés par Riot. Plutôt que de
 * deviner, on les relève sur une vraie partie :
 *
 *   $env:LANEFORM_DEBUG_EVENTS="1"; npm run desktop:dev
 */
const DEBUG_EVENTS = process.env.LANEFORM_DEBUG_EVENTS === '1';
/** Diagnostic général : pourquoi tel panneau ne s'affiche pas. */
const DEBUG = process.env.LANEFORM_DEBUG === '1' || DEBUG_EVENTS;
const seenEventNames = new Set<string>();

function debug(message: string): void {
  if (DEBUG) log(message);
}

/**
 * Relevé du CS brut renvoyé par l'API, toutes les 15 s.
 *
 * La Live Client Data API n'expose qu'un seul champ de CS (`creepScore`), sans
 * distinguer sbires et monstres neutres. Pour savoir s'il inclut la jungle, il
 * n'y a qu'un moyen : comparer cette valeur au tableau des scores en jeu.
 */
let lastCsLogAt = -1;

function logCreepScores(
  players: readonly { championName: string; scores: { creepScore: number } }[],
  gameTime: number,
): void {
  if (!DEBUG) return;
  const bucket = Math.floor(gameTime / 15);
  if (bucket === lastCsLogAt) return;
  lastCsLogAt = bucket;
  const line = players.map((p) => `${p.championName}=${p.scores.creepScore}`).join(' ');
  console.log(`[laneform] CS brut @${Math.floor(gameTime)}s : ${line}`);
}

function logUnknownEvents(events: readonly { EventName: string; EventTime: number }[]): void {
  if (!DEBUG_EVENTS) return;
  for (const e of events) {
    if (seenEventNames.has(e.EventName)) continue;
    seenEventNames.add(e.EventName);
    log(`événement: ${e.EventName} @ ${e.EventTime.toFixed(1)}s`);
  }
}

function push(): void {
  if (!overlay || overlay.isDestroyed()) return;
  const payload: OverlayPayload = {
    state: machine.current,
    game: lastGame,
    champSelect,
    collector: crawlerProgress
      ? {
          matchesCollected: crawlerProgress.matchesCollected,
          paused: crawlerProgress.paused,
          running: crawlerProgress.running,
          lastError: crawlerProgress.lastError,
        }
      : null,
  };
  overlay.webContents.send('laneform:update', payload);
}

/**
 * Patch de référence pour les statistiques globales : le plus récent présent
 * dans les agrégats. Inutile d'interroger le jeu — seul un patch réellement
 * collecté peut fournir des chiffres.
 */
function currentPatch(): string | null {
  if (!aggregates) return null;
  return knownPatches(aggregates.store)[0] ?? null;
}

async function refreshChampSelect(): Promise<void> {
  if (!client) {
    debug('champ select ignoré : pas de connexion au client');
    return;
  }
  const session = await client.champSelectSession().catch(() => null);
  if (!session) {
    // 404 = pas de sélection en cours. Normal hors draft, anormal pendant.
    debug('champ select : aucune session renvoyée par le LCU');
    champSelect = null;
  } else {
    const patch = currentPatch();
    champSelect = buildChampSelectPayload(
      session,
      catalog,
      history,
      aggregates && patch ? { store: aggregates.store, patch } : null,
    );
    debug(
      `champ select : ${session.myTeam?.length ?? 0} alliés, ` +
        `champion=${champSelect.myChampion ?? 'non verrouillé'}, ` +
        `historique=${history.length} parties`,
    );
  }
  push();
}

if (!app.requestSingleInstanceLock()) {
  // Chemin autrefois muet : l'application sortait avec le code 0 sans rien
  // écrire, ce qui est indiscernable d'un démarrage normal suivi d'un arrêt.
  // Un verrou périmé (laissé par un arrêt forcé) suffit à l'emprunter.
  log('une autre instance détient déjà le verrou — arrêt');
  app.quit();
} else {
  void app.whenReady().then(() => {
    log(`démarrage — données dans ${app.getPath('userData')}`);
    handleIconProtocol(app.getPath('userData'));
    const config = loadConfig(app.getPath('userData'));
    log(`clé API ${config.riotApiKey ? 'présente' : 'absente'}`);
    // Empaquetée, l'amorce est dans les ressources ; en développement, dans
    // le dossier du paquet.
    const seedPath = app.isPackaged
      ? join(process.resourcesPath, 'seed', 'aggregates.json')
      : join(app.getAppPath(), 'seed', 'aggregates.json');
    aggregates = AggregateFile.load(app.getPath('userData'), seedPath);
    let apiKey = config.riotApiKey;

    /** Démarre la collecte dès que clé, plateforme et agrégats sont réunis. */
    function startCrawler(): void {
      if (crawler) return;
      if (!apiKey || !platform || !aggregates) {
        // Diagnostic explicite : « rien ne se passe » est le symptôme le plus
        // difficile à élucider sans savoir laquelle des trois conditions manque.
        log(
          `collecte en attente — clé:${apiKey ? 'ok' : 'absente'} ` +
            `plateforme:${platform ?? 'inconnue'} agrégats:${aggregates ? 'ok' : 'absents'}`,
        );
        return;
      }
      crawler = new Crawler({
        apiKey,
        appLimits: config.appRateLimits,
        platform,
        file: aggregates,
        excludedItemIds: catalog?.excludedItemIds ?? new Set<number>(),
        // Le catalogue sert aussi à distinguer composants et objets terminés.
        ...(catalog ? { items: catalog.items } : {}),
        // La moitié du quota au plus : l'autre moitié reste disponible pour
        // les rangs, qui doivent arriver vite en début de partie.
        budgetFraction: 0.5,
        limiter: sharedLimiter,
        debug,
        log,
      });
      crawler.on('progress', (p) => {
        crawlerProgress = p;
        push();
      });
      crawler.start();
      log(`collecteur démarré (plateforme ${platform})`);
    }

    /** Prend en compte une clé saisie sans redémarrer l'application. */
    function applyApiKey(key: string): void {
      apiKey = key;
      ranks = new RankService(key, config.appRateLimits, sharedLimiter, config.apiUrl);
      machine.update({ notice: null });
      startCrawler();
    }

    // Les rangs fonctionnent dès qu'on a l'un OU l'autre : un backend (qui
    // détient la clé) ou une clé locale. Le collecteur, lui, exige toujours
    // une clé — c'est ce qui permet à des utilisateurs sans clé de consulter
    // sans collecter.
    if (apiKey || config.apiUrl) {
      ranks = new RankService(apiKey, config.appRateLimits, sharedLimiter, config.apiUrl);
      log(config.apiUrl ? `rangs via le backend ${config.apiUrl}` : 'rangs en direct');
    }

    // Reprise du cache : permet de lancer l'application le matin et de laisser
    // la collecte tourner toute la journée, client League fermé.
    const cached = loadClientCache(app.getPath('userData'));
    if (cached.catalog) catalog = cached.catalog;
    const cachedPlatform = normalizePlatform(config.platformOverride ?? cached.platform);
    if (cachedPlatform) platform = cachedPlatform;
    log(
      `cache client : catalogue=${catalog?.champions.size ?? 0} champions, ` +
        `plateforme=${platform ?? 'inconnue'}`,
    );
    startCrawler();

    ipcMain.handle('laneform:config-path', () => envPath(app.getPath('userData')));

    ipcMain.handle('laneform:save-api-key', async (_event, raw: unknown) => {
      const key = typeof raw === 'string' ? raw.trim() : '';
      if (!looksLikeApiKey(key)) {
        return {
          ok: false,
          error: 'Cette valeur ne ressemble pas à une clé : vérifiez le copier-coller.',
        };
      }

      // On valide AVANT d'écrire : enregistrer une clé morte produirait un
      // overlay silencieusement cassé, sans rien pour le diagnostiquer.
      const check = await validateApiKey(key);
      if (!check.ok) return { ok: false, error: CHECK_MESSAGE[check.reason] };

      try {
        saveEnv(app.getPath('userData'), { RIOT_API_KEY: key });
      } catch {
        return {
          ok: false,
          error: 'Clé valide, mais impossible d’écrire le fichier de configuration.',
        };
      }

      applyApiKey(key);
      return { ok: true };
    });

    ipcMain.on('laneform:close-setup', () => {
      setupWindow?.close();
      setupWindow = null;
    });

    ipcMain.handle('laneform:dashboard-data', (_event, patch: unknown) => {
      if (!aggregates) return null;
      return buildDashboardPayload(
        aggregates.store,
        catalog,
        crawlerProgress
          ? {
              matchesCollected: crawlerProgress.matchesCollected,
              running: crawlerProgress.running,
              paused: crawlerProgress.paused,
              lastError: crawlerProgress.lastError,
            }
          : null,
        typeof patch === 'string' ? patch : undefined,
      );
    });

    ipcMain.handle('laneform:build-detail', (_event, raw: unknown) => {
      if (!aggregates || typeof raw !== 'object' || raw === null) return null;
      const { patch, championId, role } = raw as {
        patch?: unknown;
        championId?: unknown;
        role?: unknown;
      };
      if (typeof patch !== 'string' || typeof championId !== 'number' || typeof role !== 'string') {
        return null;
      }
      return buildDetail(aggregates.store, catalog, patch, championId, role);
    });

    /** Nombre de parties d'un agrégat, pour la demande de confirmation. */
    function countMatches(store: { patches: Record<string, { matches: number }> }): number {
      return Object.values(store.patches).reduce((total, p) => total + p.matches, 0);
    }

    ipcMain.handle('laneform:purge-aggregates', async () => {
      if (!aggregates) return { ok: false, error: 'Collecte locale indisponible.' };
      const before = countMatches(aggregates.store);

      const confirm = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Annuler', 'Tout effacer'],
        defaultId: 0,
        cancelId: 0,
        title: 'Purger la collecte ?',
        message: `Les ${before} parties collectées seront définitivement effacées.`,
        detail:
          'La collecte repartira de zéro. Les icônes et le catalogue du client ' +
          'sont conservés. Pensez à exporter d’abord si vous voulez garder une copie.',
      });
      if (confirm.response !== 1) return { ok: false };

      aggregates.replaceWith(emptyStore());
      log(`collecte purgée (${before} parties effacées)`);
      push();
      return { ok: true };
    });

    ipcMain.handle('laneform:export-aggregates', async () => {
      if (!aggregates) return { ok: false, error: 'Collecte locale indisponible.' };

      const matches = countMatches(aggregates.store);
      if (matches === 0) {
        return { ok: false, error: 'Rien à exporter : la collecte est vide.' };
      }

      const patch = knownPatches(aggregates.store)[0] ?? 'inconnu';
      const day = new Date().toISOString().slice(0, 10);

      const picked = await dialog.showSaveDialog({
        title: 'Exporter la collecte',
        defaultPath: `laneform-${patch}-${day}.json`,
        filters: [{ name: 'Collecte Laneform', extensions: ['json'] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false };

      try {
        // On sérialise l'état en mémoire, pas le fichier sur disque : celui-ci
        // peut avoir jusqu'à une minute de retard sur la collecte en cours.
        writeFileSync(picked.filePath, JSON.stringify(aggregates.store), 'utf8');
      } catch {
        return { ok: false, error: 'Écriture impossible à cet emplacement.' };
      }

      log(`collecte exportée vers ${picked.filePath} : ${matches} parties`);
      return { ok: true, matches, path: picked.filePath };
    });

    ipcMain.handle('laneform:import-aggregates', async () => {
      const picked = await dialog.showOpenDialog({
        title: 'Importer une collecte Laneform',
        filters: [{ name: 'Collecte Laneform', extensions: ['json'] }],
        properties: ['openFile'],
      });
      const file = picked.filePaths[0];
      if (picked.canceled || !file) return { ok: false };

      const incoming = AggregateFile.readFile(file);
      if (!incoming) {
        return { ok: false, error: 'Fichier illisible ou format non reconnu.' };
      }
      if (!aggregates) return { ok: false, error: 'Collecte locale indisponible.' };

      const before = countMatches(aggregates.store);
      const after = countMatches(incoming);

      // Remplacement destructif : on le dit avant, avec les deux volumes, pour
      // que le choix soit éclairé.
      const confirm = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Annuler', 'Remplacer'],
        defaultId: 0,
        cancelId: 0,
        title: 'Remplacer la collecte locale ?',
        message: `Votre collecte actuelle (${before} parties) sera remplacée par celle du fichier (${after} parties).`,
        detail:
          'Les deux collectes ne peuvent pas être additionnées : elles partagent ' +
          'probablement des parties, qui seraient alors comptées deux fois.',
      });
      if (confirm.response !== 1) return { ok: false };

      aggregates.replaceWith(incoming);
      log(`collecte importée depuis ${file} : ${after} parties`);
      push();
      return { ok: true, matches: after };
    });

    function openDashboard(): void {
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.focus();
        return;
      }
      dashboardWindow = createDashboardWindow();
      dashboardWindow.on('closed', () => {
        dashboardWindow = null;
      });
    }

    function openSetup(): void {
      if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.focus();
        return;
      }
      setupWindow = createSetupWindow();
      setupWindow.on('closed', () => {
        setupWindow = null;
      });
    }

    // Aucune clé ET aucun backend : rien ne fonctionnerait côté rangs. Avec un
    // backend configuré, on ne réclame rien — la clé n'est utile qu'à ceux qui
    // veulent collecter.
    if (!apiKey && !config.apiUrl) openSetup();

    overlay = createOverlayWindow();
    overlay.webContents.on('did-finish-load', push);
    machine.on('change', push);

    // --- LCU ---------------------------------------------------------------
    watcher.on('connected', (creds) => {
      const lcu = new LcuClient(creds);
      client = lcu;

      void (async () => {
        const summoner = await lcu.currentSummoner().catch(() => null);
        machine.update({
          phase: mapLcuPhase(await lcu.gameflowPhase().catch(() => null)),
          summoner: summoner ? { gameName: summoner.gameName, tagLine: summoner.tagLine } : null,
          notice: null,
        });

        // En arrière-plan : l'overlay doit s'afficher sans attendre.
        const detected =
          normalizePlatform(config.platformOverride) ?? (await detectPlatform(lcu, log));
        if (detected) {
          platform = detected;
          log(`plateforme détectée : ${detected}`);
        } else {
          log('plateforme non détectée : définir LANEFORM_PLATFORM=euw1 dans .env');
        }

        // Le client dépose son lockfile AVANT d'être prêt à répondre : un
        // appel trop tôt renvoie des catalogues vides. On ne remplace donc le
        // catalogue en mémoire que si le nouveau a réellement du contenu —
        // sinon on garde celui du cache, qui reste valable.
        // Fusion table par table : le client dépose son lockfile avant d'être
        // prêt, et répond parfois partiellement. Ce qui revient vide garde la
        // valeur du cache au lieu de l'écraser.
        const loaded = await loadCatalog(lcu).catch(() => null);
        catalog = mergeCatalog(catalog, loaded);
        log(
          `catalogue : ${catalog?.champions.size ?? 0} champions, ${catalog?.items.size ?? 0} objets, ` +
            `${catalog?.spells.size ?? 0} sorts, ${catalog?.perks.size ?? 0} runes, ` +
            `${catalog?.perkStyles.size ?? 0} branches`,
        );
        debug(
          `catalogue : ${catalog?.champions.size ?? 0} champions, ` +
            `${catalog?.items.size ?? 0} objets, plateforme=${platform ?? 'inconnue'}`,
        );

        startCrawler();

        saveClientCache(app.getPath('userData'), catalog, platform);

        // En arrière-plan : quelques centaines de requêtes locales, sans
        // urgence, et qui ne doivent pas retarder l'affichage.
        if (catalog && catalog.champions.size > 0) {
          void syncIcons(creds, catalog, app.getPath('userData'), log).catch((err) =>
            logError('synchronisation des icônes', err),
          );
        }

        history = await fetchPersonalHistory(lcu).catch(() => []);
        // Zéro partie ici alors que le joueur en a jouées = le format de
        // l'endpoint d'historique a changé, c'est le point le plus fragile.
        debug(`historique personnel : ${history.length} parties chargées`);
        if (machine.current.phase === 'CHAMP_SELECT') void refreshChampSelect();
      })();

      eventStream?.close();
      eventStream = new LcuEventStream(creds);

      eventStream.on('event', (evt) => {
        if (evt.uri === '/lol-gameflow/v1/gameflow-phase') {
          const phase = mapLcuPhase(evt.data as string);
          machine.update({ phase });
          // Quitter la sélection doit effacer le panneau, sinon il reste
          // affiché par-dessus la partie.
          if (phase !== 'CHAMP_SELECT' && champSelect) {
            champSelect = null;
            push();
          }
          return;
        }

        if (evt.uri === CHAMP_SELECT_URI) {
          if (evt.eventType === 'Delete') {
            champSelect = null;
            push();
          } else {
            void refreshChampSelect();
          }
        }
      });

      eventStream.on('error', () => {});
      eventStream.connect();
    });

    watcher.on('disconnected', () => {
      eventStream?.close();
      eventStream = null;
      client = null;
      catalog = null;
      history = [];
      champSelect = null;
      machine.update({ phase: 'CLIENT_CLOSED', summoner: null, notice: null });
    });

    watcher.start();

    // --- Partie en cours ---------------------------------------------------
    poller.on('started', () => {
      champSelect = null;
      gameRanks = new Map();
      rankLookupDone = false;
      // Ni trafic réseau ni travail de fond pendant que le joueur joue.
      crawler?.pause();
      // Pas d'avertissement sur le mode d'affichage : en plein écran exclusif
      // l'overlay est invisible, donc le message aussi. Il n'apparaissait que
      // pour les joueurs qui n'en avaient pas besoin.
      machine.update({ phase: 'IN_GAME', notice: null });
    });

    poller.on('ended', () => {
      lastGame = null;
      crawler?.resume();
      // Une partie vient de finir : l'historique a changé, il sera rechargé
      // à la prochaine sélection.
      if (client) {
        void fetchPersonalHistory(client)
          .then((h) => { history = h; })
          .catch(() => {});
      }
      push();
    });

    poller.on('data', (data) => {
      logUnknownEvents(data.events.Events);
      logCreepScores(data.allPlayers, data.gameData.gameTime);

      // Une seule résolution par partie : les rangs ne bougent pas en cours de
      // route, et dix joueurs coûtent jusqu'à vingt appels à l'API.
      if (!rankLookupDone && ranks && platform && data.allPlayers.length > 0) {
        rankLookupDone = true;
        const ids = data.allPlayers.map(riotIdOf).filter((id): id is RiotId => id !== null);
        void ranks
          .ranksFor(platform, ids)
          .then((resolved) => {
            for (const [key, info] of resolved) gameRanks.set(key, formatRank(info));
            const status = ranks?.status;
            if (status?.invalidKey) {
              machine.update({ notice: 'Clé API Riot invalide ou expirée : rangs indisponibles.' });
            } else if (status?.backendError) {
              machine.update({ notice: `Backend : ${status.backendError}` });
            }
            push();
          })
          .catch(() => {});
      }

      const stats = computeLiveStats(data.allPlayers, data.gameData.gameTime);
      const players: PlayerRow[] = stats.map((s, i) => {
        const raw = data.allPlayers[i];
        const id = raw ? riotIdOf(raw) : null;
        return { ...s, rank: id ? (gameRanks.get(RankService.key(id)) ?? null) : null };
      });

      lastGame = {
        gameTime: data.gameData.gameTime,
        gameMode: data.gameData.gameMode,
        players,
        objectives: allObjectiveTimers(data.events.Events, data.gameData.gameTime),
      };
      push();
    });

    poller.start();

    // --- Raccourci ---------------------------------------------------------
    globalShortcut.register(SETTINGS_SHORTCUT, openSetup);
    globalShortcut.register(DASHBOARD_SHORTCUT, openDashboard);

    // Ouvert par défaut : l'overlay est invisible hors partie, donc sans cette
    // fenêtre lancer l'application ne produit aucun retour visible. `--no-dashboard`
    // reste disponible pour un démarrage silencieux (lancement automatique).
    if (!process.argv.includes('--no-dashboard')) openDashboard();

    // Relancer l'exécutable alors qu'une instance tourne doit ramener le
    // tableau de bord au premier plan, pas sembler ne rien faire.
    app.on('second-instance', openDashboard);

    function toggleOverlay(): void {
      if (!overlay || overlay.isDestroyed()) return;
      if (overlay.isVisible()) overlay.hide();
      else overlay.showInactive(); // showInactive : ne jamais voler le focus au jeu.
    }

    globalShortcut.register(TOGGLE_SHORTCUT, toggleOverlay);

    try {
      tray = createTray({
        toggleOverlay,
        openDashboard,
        openSetup,
        toggleCollector: () => {
          if (!crawler) return;
          if (crawler.progress.paused) crawler.resume();
          else crawler.pause();
        },
        isOverlayVisible: () => overlay?.isVisible() ?? false,
        isCollectorPaused: () => crawler?.progress.paused ?? false,
        hasCollector: () => crawler !== null,
      });
    } catch (err) {
      logError('création de l’icône de notification', err);
    }
  });

  app.on('will-quit', () => {
    tray?.destroy();
    crawler?.stop();
    aggregates?.flush(true);
    globalShortcut.unregisterAll();
    watcher.stop();
    poller.stop();
    eventStream?.close();
  });

  app.on('window-all-closed', () => {});
}
