export {}; // rend le fichier module, requis par `declare global`

/**
 * Renderer de l'overlay. Aucun accès à Node : tout arrive par le pont preload.
 *
 * Volontairement sans framework. L'overlay affiche quelques dizaines de lignes
 * qui changent une fois par seconde par-dessus un jeu ; embarquer un runtime de
 * rendu coûterait de la mémoire sur la machine du joueur pendant sa partie,
 * pour un gain nul à cette échelle.
 */

interface ObjectiveTimer {
  kind: 'DRAGON' | 'BARON' | 'VOID_GRUBS';
  status: 'PENDING' | 'AVAILABLE' | 'RESPAWNING' | 'GONE';
  secondsUntilNext: number;
}

interface PlayerStats {
  championName: string;
  team: 'ORDER' | 'CHAOS';
  kda: number | null;
  creepScore: number;
  csPerMin: number;
  level: number;
  isDead: boolean;
  respawnTimer: number;
  /** Déjà formaté côté principal. `null` tant que la résolution n'a pas abouti. */
  rank: string | null;
}

interface ChampSelect {
  myChampion: string | null;
  myChampionIcon: string | null;
  allies: { champion: string; icon: string | null; position: string; isMe: boolean }[];
  enemies: { champion: string; icon: string | null }[];
  build: {
    games: number;
    wins: number;
    winRate: number | null;
    lowSample: boolean;
    coreItems: { name: string; icon: string; games: number; winRate: number | null }[];
    bestGameItems: string[] | null;
  } | null;
  matchups: {
    champion: string;
    icon: string;
    games: number;
    goldDiff: { mean: number; margin: number; n: number } | null;
    items: { name: string; icon: string; share: number }[];
  }[];
  globalBuild: {
    games: number;
    winRate: number | null;
    lowSample: boolean;
    patch: string;
    items: { name: string; icon: string; pickRate: number; winRate: number | null }[];
  } | null;
}

interface Collector {
  matchesCollected: number;
  paused: boolean;
  running: boolean;
  lastError: string | null;
}

interface Payload {
  state: { phase: string; summoner: { gameName: string } | null; notice: string | null };
  game: {
    gameTime: number;
    gameMode: string;
    players: PlayerStats[];
    objectives: ObjectiveTimer[];
  } | null;
  champSelect: ChampSelect | null;
  collector: Collector | null;
}

const OBJECTIVE_LABEL: Record<ObjectiveTimer['kind'], string> = {
  DRAGON: 'Dragon',
  BARON: 'Nashor',
  VOID_GRUBS: 'Larves',
};

const PHASE_LABEL: Record<string, string> = {
  CLIENT_CLOSED: 'En attente du client League…',
  IDLE: 'Client connecté',
  LOBBY: 'En lobby',
  CHAMP_SELECT: 'Sélection des champions',
  IN_GAME: 'Partie en cours',
  POST_GAME: 'Fin de partie',
};

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)} %`;
}

function div(className: string, text?: string): HTMLElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Vignette décorative précédant un libellé.
 *
 * Le nom reste écrit : une icône manquante — client jamais ouvert, fichier
 * indisponible — est simplement retirée, et la ligne reste lisible. En pleine
 * sélection, un cadre cassé serait pire que pas d'image du tout.
 */
const missingIcons = new Set<string>();

function withIcon(src: string | null, text: string, className: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `iconned ${className}`;

  // Une icône déjà absente n'est pas recréée : l'overlay se redessine chaque
  // seconde, elle clignoterait.
  if (src && !missingIcons.has(src)) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = src;
    img.alt = '';
    img.addEventListener('error', () => {
      missingIcons.add(src);
      img.remove();
    });
    wrap.append(img);
  }

  const label = document.createElement('span');
  label.className = 'iconned__text';
  label.textContent = text;
  wrap.append(label);
  return wrap;
}

function span(className: string, text: string): HTMLElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

const el = {
  game: document.getElementById('game') as HTMLElement,
  draft: document.getElementById('draft') as HTMLElement,
  status: document.getElementById('status') as HTMLElement,
  clock: document.getElementById('clock') as HTMLElement,
  objectives: document.getElementById('objectives') as HTMLElement,
  players: document.getElementById('players') as HTMLElement,
  notice: document.getElementById('notice') as HTMLElement,
  draftChampion: document.getElementById('draft-champion') as HTMLElement,
  draftTeams: document.getElementById('draft-teams') as HTMLElement,
  draftBuild: document.getElementById('draft-build') as HTMLElement,
  draftGlobal: document.getElementById('draft-global') as HTMLElement,
  draftMatchups: document.getElementById('draft-matchups') as HTMLElement,
  draftCollector: document.getElementById('draft-collector') as HTMLElement,
};

// --- Partie en cours -------------------------------------------------------

/**
 * Un décompte « PENDING » et un décompte « RESPAWNING » s'affichent pareil :
 * dans les deux cas le joueur veut savoir dans combien de temps, pas pourquoi.
 */
function objectiveText(o: ObjectiveTimer): string {
  switch (o.status) {
    case 'AVAILABLE':
      return 'disponible';
    case 'GONE':
      return '—';
    default:
      return clock(o.secondsUntilNext);
  }
}

function renderObjectives(objectives: ObjectiveTimer[]): void {
  el.objectives.replaceChildren(
    ...objectives.map((o) => {
      const node = div(
        o.status === 'AVAILABLE'
          ? 'objective objective--ready'
          : o.status === 'GONE'
            ? 'objective objective--gone'
            : 'objective',
      );
      node.append(span('objective__label', OBJECTIVE_LABEL[o.kind]), span('', objectiveText(o)));
      return node;
    }),
  );
}

function renderPlayers(players: PlayerStats[]): void {
  el.players.replaceChildren(
    ...players.map((p) => {
      const row = div(`player player--${p.team.toLowerCase()}${p.isDead ? ' player--dead' : ''}`);
      row.append(
        span('player__name', p.championName),
        // « … » plutôt que vide : la résolution des rangs est asynchrone, et
        // une colonne vide se lit comme « non classé », ce qui serait faux.
        span('player__rank', p.rank ?? '…'),
        span('player__sub', `N${p.level}`),
        // 0 mort : un ratio infini n'a pas de sens, on affiche l'étiquette usuelle.
        span('', p.kda === null ? 'Parfait' : `${p.kda.toFixed(1)} KDA`),
        // Le CS absolu bouge à chaque sbire, le CS/min est une moyenne depuis
        // le début de partie et évolue donc très lentement. Afficher les deux.
        span(
          'player__sub',
          p.isDead ? `↻ ${clock(p.respawnTimer)}` : `${p.creepScore} CS · ${p.csPerMin.toFixed(1)}/m`,
        ),
      );
      return row;
    }),
  );
}

// --- Sélection des champions ----------------------------------------------

function renderTeams(cs: ChampSelect): void {
  const allies = div('team');
  allies.append(div('team__title', 'Votre équipe'));
  for (const a of cs.allies) {
    const row = div(`team__row${a.isMe ? ' team__row--me' : ''}`);
    row.append(withIcon(a.icon, a.champion, ''));
    if (a.position) row.append(span('team__pos', a.position));
    allies.append(row);
  }

  const enemies = div('team');
  enemies.append(div('team__title', 'Adversaires'));
  for (const e of cs.enemies) {
    const row = div('team__row');
    row.append(withIcon(e.icon, e.champion, ''));
    enemies.append(row);
  }

  el.draftTeams.replaceChildren(allies, enemies);
}

function renderBuild(cs: ChampSelect): void {
  const build = cs.build;
  el.draftBuild.replaceChildren();

  if (!build) {
    el.draftBuild.append(div('build__empty', 'Verrouillez un champion pour voir vos builds.'));
    return;
  }

  el.draftBuild.append(div('build__title', 'Vos parties sur ce champion'));

  if (build.games === 0) {
    el.draftBuild.append(div('build__empty', 'Aucune partie récente sur ce champion.'));
    return;
  }

  const summary =
    build.winRate === null
      ? `${build.games} partie${build.games > 1 ? 's' : ''} · ${build.wins} v.`
      : `${build.games} parties · ${percent(build.winRate)} de victoires`;
  el.draftBuild.append(div('build__summary', summary));

  for (const item of build.coreItems) {
    const row = div('build__row');
    row.append(
      withIcon(item.icon, item.name, ''),
      span(
        'build__meta',
        item.winRate === null ? `${item.games}×` : `${item.games}× · ${percent(item.winRate)}`,
      ),
    );
    el.draftBuild.append(row);
  }

  // L'avertissement vient APRÈS les chiffres : il qualifie ce qu'on vient de
  // lire. Le placer avant le ferait ignorer.
  if (build.lowSample) {
    el.draftBuild.append(
      div('build__warning', 'Échantillon trop faible : taux de victoire non significatifs.'),
    );
  }
}

/** Statistiques issues du collecteur local : ce que joue l'ensemble du haut elo. */
/**
 * Duels face aux champions adverses déjà verrouillés.
 *
 * L'écart d'or à 14 minutes plutôt qu'un taux de victoire : il converge bien
 * plus vite et répond à la question du draft — est-ce que je perds ma lane ?
 */
function renderMatchups(cs: ChampSelect): void {
  el.draftMatchups.replaceChildren();
  if (!cs.myChampion) return;

  el.draftMatchups.append(div('build__title', 'Face à · or à 14 min'));

  if (cs.matchups.length === 0) {
    el.draftMatchups.append(div('build__empty', 'Pas encore de duels collectés.'));
    return;
  }

  for (const m of cs.matchups) {
    const row = div('build__row');
    row.append(withIcon(m.icon, m.champion, ''));

    if (m.goldDiff) {
      const sign = m.goldDiff.mean >= 0 ? '+' : '−';
      const cls = m.goldDiff.mean > 0 ? 'gold--above' : m.goldDiff.mean < 0 ? 'gold--below' : '';
      row.append(
        span(`build__meta gold ${cls}`, `${sign}${Math.abs(Math.round(m.goldDiff.mean))} or`),
      );
    } else {
      // Duel connu mais pas assez de timelines : le dire, plutôt que de
      // laisser croire à un duel équilibré.
      row.append(span('build__meta', `${m.games} duels`));
    }

    el.draftMatchups.append(row);

    // Objets du duel le mieux documenté : au draft, c'est l'information
    // directement actionnable.
    if (m.items.length > 0) {
      const items = div('matchup__items');
      for (const item of m.items.slice(0, 4)) items.append(withIcon(item.icon, item.name, ''));
      el.draftMatchups.append(items);
    }
  }
}

function renderGlobalBuild(cs: ChampSelect): void {
  el.draftGlobal.replaceChildren();
  const g = cs.globalBuild;

  if (!cs.myChampion) return;

  if (!g) {
    el.draftGlobal.append(div('build__title', 'Builds courants'));
    // Distinguer « pas encore collecté » de « aucun build » : au démarrage le
    // collecteur n'a rien, et un panneau muet se lirait comme un bug.
    el.draftGlobal.append(div('build__empty', 'Pas encore de données pour ce champion.'));
    return;
  }

  el.draftGlobal.append(div('build__title', `Builds courants · patch ${g.patch}`));

  const summary =
    g.winRate === null
      ? `${g.games} parties collectées`
      : `${g.games} parties · ${percent(g.winRate)} de victoires`;
  el.draftGlobal.append(div('build__summary', summary));

  for (const item of g.items) {
    const row = div('build__row');
    row.append(
      withIcon(item.icon, item.name, ''),
      span(
        'build__meta',
        item.winRate === null
          ? `${percent(item.pickRate)}`
          : `${percent(item.pickRate)} · ${percent(item.winRate)} v.`,
      ),
    );
    el.draftGlobal.append(row);
  }

  if (g.lowSample) {
    el.draftGlobal.append(
      div('build__warning', 'Collecte en cours : taux de victoire pas encore significatifs.'),
    );
  }
}

function renderCollector(collector: Collector | null): void {
  if (!collector) {
    el.draftCollector.textContent = '';
    return;
  }
  el.draftCollector.className = collector.lastError ? 'collector collector--error' : 'collector';
  if (collector.lastError) {
    el.draftCollector.textContent = collector.lastError;
    return;
  }
  const state = collector.paused ? 'en pause' : collector.running ? 'en cours' : 'arrêtée';
  el.draftCollector.textContent = `Collecte ${state} · ${collector.matchesCollected} parties`;
}

// --- Rendu principal -------------------------------------------------------

function showOnly(target: 'game' | 'draft' | 'status'): void {
  el.game.hidden = target !== 'game';
  el.draft.hidden = target !== 'draft';
  el.status.hidden = target !== 'status';
}

function render(payload: Payload): void {
  const { state, game, champSelect } = payload;

  // La partie en cours prime sur tout le reste : c'est le moment où le joueur
  // a le moins de temps pour chercher l'information.
  if (game) {
    showOnly('game');
    el.clock.textContent = clock(game.gameTime);
    el.notice.textContent = state.notice ?? '';
    renderObjectives(game.objectives);
    renderPlayers(game.players);
    return;
  }

  if (champSelect) {
    showOnly('draft');
    el.draftChampion.textContent = champSelect.myChampion ?? '';
    renderTeams(champSelect);
    renderMatchups(champSelect);
    renderGlobalBuild(champSelect);
    renderBuild(champSelect);
    renderCollector(payload.collector);
    return;
  }

  showOnly('status');
  el.status.textContent = PHASE_LABEL[state.phase] ?? state.phase;
}

window.laneform.onUpdate((payload) => render(payload as Payload));
