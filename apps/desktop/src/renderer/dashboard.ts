export {}; // module

/**
 * Tableau de bord de la collecte.
 *
 * Trois formes seulement, choisies selon le travail de la donnée : des nombres
 * repères pour l'état de la collecte (une valeur unique, donc pas de
 * graphique), un tableau pour parcourir les champions, et des barres pour le
 * taux de présence des objets (une grandeur, série unique).
 */

interface RoleBreakdown {
  role: string;
  games: number;
  winRate: number | null;
}

interface DashboardChampion {
  championId: number;
  name: string;
  icon: string;
  games: number;
  winRate: number | null;
  lowSample: boolean;
  roles: RoleBreakdown[];
}

interface DashboardPayload {
  patch: string | null;
  availablePatches: string[];
  matches: number;
  observations: number;
  collector: {
    matchesCollected: number;
    running: boolean;
    paused: boolean;
    lastError: string | null;
  } | null;
  catalogReady: boolean;
  champions: DashboardChampion[];
}

interface OrderEntry {
  items: { name: string; icon: string }[];
  games: number;
  share: number;
  winRate: number | null;
}

interface OrderSection {
  samples: number;
  starters: OrderEntry[];
  firstItems: OrderEntry[];
  sequences: OrderEntry[];
}

interface LoadoutEntry {
  items: { name: string; icon: string }[];
  games: number;
  share: number;
  winRate: number | null;
}

interface LoadoutSection {
  spells: LoadoutEntry[];
  runes: LoadoutEntry[];
  /** Chaque rune choisie, individuellement. */
  perks: LoadoutEntry[];
}

interface MatchupEntry {
  opponentId: number;
  name: string;
  icon: string;
  games: number;
  winRate: number | null;
  goldDiff: { mean: number; margin: number; n: number } | null;
  items: { name: string; icon: string; share: number }[];
}

interface BuildDetail {
  championId: number;
  name: string;
  role: string;
  games: number;
  winRate: number | null;
  lowSample: boolean;
  items: { name: string; icon: string; pickRate: number; winRate: number | null; games: number }[];
  order: OrderSection | null;
  matchups: MatchupEntry[];
  loadout: LoadoutSection | null;
}

const ROLE_LABEL: Record<string, string> = {
  TOP: 'Haut',
  JUNGLE: 'Jungle',
  MIDDLE: 'Milieu',
  BOTTOM: 'Bas',
  UTILITY: 'Support',
};

const el = {
  patch: document.getElementById('patch') as HTMLSelectElement,
  patchLabel: document.getElementById('patch-label') as HTMLElement,
  import: document.getElementById('import') as HTMLButtonElement,
  export: document.getElementById('export') as HTMLButtonElement,
  purge: document.getElementById('purge') as HTMLButtonElement,
  privacy: document.getElementById('privacy') as HTMLElement,
  privacyToggle: document.getElementById('privacy-toggle') as HTMLButtonElement,
  privacyClose: document.getElementById('privacy-close') as HTMLButtonElement,
  tiles: document.getElementById('tiles') as HTMLElement,
  warning: document.getElementById('warning') as HTMLElement,
  rows: document.getElementById('rows') as HTMLElement,
  roles: document.getElementById('roles') as HTMLElement,
  detail: document.getElementById('detail') as HTMLElement,
  detailTitle: document.getElementById('detail-title') as HTMLElement,
  tooltip: document.getElementById('tooltip') as HTMLElement,
  order: document.getElementById('order') as HTMLElement,
  matchups: document.getElementById('matchups') as HTMLElement,
  loadout: document.getElementById('loadout') as HTMLElement,
  search: document.getElementById('search') as HTMLInputElement,
  count: document.getElementById('count') as HTMLElement,
};

const headers = Array.from(document.querySelectorAll<HTMLButtonElement>('.th'));
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
const panes = Array.from(document.querySelectorAll<HTMLElement>('.pane'));

/**
 * Onglet actif. Conservé entre deux rafraîchissements : changer de champion
 * ne doit pas ramener l'utilisateur sur le premier onglet.
 */
let activeTab = 'runes';

function showTab(name: string): void {
  activeTab = name;
  for (const tab of tabs) tab.classList.toggle('tab--active', tab.dataset['tab'] === name);
  for (const pane of panes) pane.hidden = pane.dataset['pane'] !== name;
}

for (const tab of tabs) {
  tab.addEventListener('click', () => showTab(tab.dataset['tab'] ?? 'runes'));
}

let current: DashboardPayload | null = null;
let selected: { championId: number; role: string } | null = null;

type SortKey = 'name' | 'role' | 'games' | 'winRate';

/** Empreintes du dernier rendu : un rafraîchissement identique ne redessine rien. */
let lastDataSignature = '';
let lastDetailSignature = '';

let filter = '';
/**
 * Tri par défaut : le volume.
 *
 * C'est l'ordre qui dit ce que vaut la collecte, et il ne bouge pas quand les
 * taux de victoire évoluent — contrairement à un tri par pourcentage, où les
 * lignes sautent à chaque rafraîchissement.
 */
let sort: { key: SortKey; dir: 'asc' | 'desc' } = { key: 'games', dir: 'desc' };

/** Comparaison insensible à la casse ET aux accents : « Kaïsa » doit sortir sur « kai ». */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const pct = (ratio: number): string => `${(ratio * 100).toFixed(1).replace('.', ',')} %`;
const int = (n: number): string => n.toLocaleString('fr-FR');
const roleLabel = (role: string): string => ROLE_LABEL[role] ?? role;

function div(cls: string, text?: string): HTMLElement {
  const node = document.createElement('div');
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Icône accompagnée de son libellé.
 *
 * L'image est décorative : le nom reste écrit à côté. Si le fichier manque —
 * client jamais ouvert, icône indisponible — on retire l'image et la ligne
 * reste parfaitement lisible, plutôt que d'afficher un cadre cassé.
 */
const missingIcons = new Set<string>();

function labelWithIcon(src: string, text: string, cls: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `labelled ${cls}`;
  // Indispensable là où le libellé est masqué (séquences d'objets) : sans lui
  // l'icône seule n'est identifiable que par qui la connaît déjà.
  wrap.title = text;

  // Une icône déjà connue comme absente n'est pas recréée : elle échouerait
  // à nouveau et disparaîtrait, ce qui produisait un clignotement à chaque
  // rafraîchissement.
  if (!missingIcons.has(src)) {
    const img = document.createElement('img');
    img.className = 'icon';
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      missingIcons.add(src);
      img.remove();
    });
    wrap.append(img);
  }

  const label = document.createElement('span');
  label.className = 'labelled__text';
  label.textContent = text;

  wrap.append(label);
  return wrap;
}

function span(cls: string, text: string): HTMLElement {
  const node = document.createElement('span');
  node.className = cls;
  node.textContent = text;
  return node;
}

/**
 * Taux de victoire : le signe est écrit, la couleur ne fait que renforcer.
 * Un lecteur qui ne distingue pas les teintes lit la même information.
 */
function winRateCell(winRate: number | null): HTMLElement {
  if (winRate === null) return span('num wr wr--unknown', '—');
  const cls = winRate > 0.5 ? 'wr--above' : winRate < 0.5 ? 'wr--below' : 'wr--unknown';
  return span(`num wr ${cls}`, pct(winRate));
}

// --- Nombres repères -------------------------------------------------------

function tile(label: string, value: string, hint?: string): HTMLElement {
  const node = div('tile');
  node.append(div('tile__label', label), div('tile__value', value));
  if (hint) node.append(div('tile__hint', hint));
  return node;
}

/**
 * Tuile d'état : pastille colorée ET mot écrit.
 *
 * La pastille seule serait illisible pour qui ne distingue pas les teintes ;
 * elle ne fait que renforcer le texte.
 */
function stateTile(
  label: string,
  state: string,
  variant: 'live' | 'paused' | 'error' | 'idle',
  hint?: string,
): HTMLElement {
  const node = div('tile');
  node.append(div('tile__label', label));

  const line = div('tile__state');
  line.append(div(`dot dot--${variant}`), div('tile__value', state));
  node.append(line);

  if (hint) node.append(div('tile__hint', hint));
  return node;
}

function renderTiles(data: DashboardPayload): void {
  const c = data.collector;
  const state = !c ? 'inactive' : c.paused ? 'en pause' : c.running ? 'en cours' : 'arrêtée';
  const variant = c?.lastError
    ? 'error'
    : c?.paused
      ? 'paused'
      : c?.running
        ? 'live'
        : 'idle';

  el.tiles.replaceChildren(
    tile('Parties collectées', int(data.matches), data.patch ? `patch ${data.patch}` : 'aucun patch'),
    tile('Lignes joueur', int(data.observations), '10 par partie complète'),
    tile('Champions couverts', int(data.champions.length)),
    stateTile('Collecte', state, variant, c ? `${int(c.matchesCollected)} cette session` : undefined),
  );

  const messages: string[] = [];
  if (c?.lastError) messages.push(c.lastError);
  if (!data.catalogReady) {
    messages.push('Client League fermé : les noms restent numériques.');
  }
  el.warning.textContent = messages.join(' · ');
}

// --- Tableau des champions -------------------------------------------------

function compare(a: DashboardChampion, b: DashboardChampion, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name, 'fr');
    case 'role':
      return (a.roles[0]?.role ?? '').localeCompare(b.roles[0]?.role ?? '');
    case 'games':
      return a.games - b.games;
    case 'winRate': {
      // Les taux masqués (échantillon insuffisant) vont toujours en fin de
      // liste, quel que soit le sens : ce ne sont pas des « petits » taux.
      if (a.winRate === null && b.winRate === null) return a.games - b.games;
      if (a.winRate === null) return 1;
      if (b.winRate === null) return -1;
      return a.winRate - b.winRate;
    }
  }
}

function visibleChampions(data: DashboardPayload): DashboardChampion[] {
  const needle = fold(filter.trim());
  const rows = needle === '' ? [...data.champions] : data.champions.filter((c) => fold(c.name).includes(needle));

  rows.sort((a, b) => {
    const base = compare(a, b, sort.key);
    const ordered = sort.dir === 'asc' ? base : -base;
    // Départage stable par identifiant : sans cela des lignes à égalité
    // changent de place à chaque rafraîchissement.
    return ordered !== 0 ? ordered : a.championId - b.championId;
  });

  return rows;
}

function renderHeaders(): void {
  for (const header of headers) {
    const key = header.dataset['sort'] as SortKey;
    const active = key === sort.key;
    header.classList.toggle('th--active', active);
    header.setAttribute('aria-sort', active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

    const label = header.textContent?.replace(/[↑↓]\s*$/, '').trim() ?? '';
    header.replaceChildren(document.createTextNode(label));
    if (active) header.append(span('th__arrow', sort.dir === 'asc' ? '↑' : '↓'));
  }
}

function renderRows(data: DashboardPayload): void {
  const rows = visibleChampions(data);

  el.count.textContent =
    rows.length === data.champions.length
      ? `${int(data.champions.length)} champions`
      : `${int(rows.length)} / ${int(data.champions.length)} champions`;

  if (data.champions.length === 0) {
    el.rows.replaceChildren(
      div('empty', 'Aucune donnée pour ce patch. Laissez la collecte tourner.'),
    );
    return;
  }

  if (rows.length === 0) {
    el.rows.replaceChildren(div('empty', `Aucun champion ne correspond à « ${filter.trim()} ».`));
    return;
  }

  el.rows.replaceChildren(
    ...rows.map((champion) => {
      const top = champion.roles[0];
      const row = div('table__row');
      row.setAttribute('role', 'row');
      if (selected?.championId === champion.championId) row.classList.add('table__row--active');

      row.append(
        labelWithIcon(champion.icon, champion.name, ''),
        span('role', top ? roleLabel(top.role) : '—'),
        span('num', int(champion.games)),
        winRateCell(champion.winRate),
      );

      row.addEventListener('click', () => {
        selected = { championId: champion.championId, role: top?.role ?? '' };
        lastDetailSignature = '';
        renderRows(data);
        void loadDetail();
      });
      return row;
    }),
  );
}

// --- Détail : barres de taux de présence -----------------------------------

function showTooltip(event: MouseEvent, lines: string[]): void {
  el.tooltip.replaceChildren(
    ...lines.map((line) => {
      return div('tooltip__line', line);
    }),
  );
  el.tooltip.hidden = false;
  // Décalé du curseur pour ne pas masquer la barre survolée.
  el.tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 220)}px`;
  el.tooltip.style.top = `${event.clientY + 14}px`;
}

/** Une option d'ordre : les icônes en ligne, puis sa fréquence. */
function orderRow(entry: OrderEntry): HTMLElement {
  const row = div('order__row');

  const icons = div('order__items');
  entry.items.forEach((item, index) => {
    if (index > 0) icons.append(span('order__arrow', '›'));
    icons.append(labelWithIcon(item.icon, item.name, 'order__item'));
  });

  row.append(
    icons,
    span(
      'build__meta',
      entry.winRate === null
        ? pct(entry.share)
        : `${pct(entry.share)} · ${pct(entry.winRate)} v.`,
    ),
  );

  // Même infobulle que les barres : les noms complets dans l'ordre, puis la
  // fréquence. Une séquence de trois icônes est illisible sans ça.
  const lines = [
    entry.items.map((i) => i.name).join(' › '),
    `Fréquence : ${pct(entry.share)} (${int(entry.games)} parties)`,
    entry.winRate === null
      ? 'Victoires : échantillon insuffisant'
      : `Victoires : ${pct(entry.winRate)}`,
  ];
  row.addEventListener('mousemove', (event) => showTooltip(event, lines));
  row.addEventListener('mouseleave', () => {
    el.tooltip.hidden = true;
  });

  return row;
}

function renderOrderGroup(title: string, entries: OrderEntry[]): HTMLElement | null {
  if (entries.length === 0) return null;
  const group = div('order__group');
  group.append(div('order__title', title));
  for (const entry of entries) group.append(orderRow(entry));
  return group;
}

function renderOrder(order: OrderSection | null): void {
  el.order.replaceChildren();

  if (!order) {
    el.order.append(div('build__title', 'Ordre de build'));
    // Distinguer « pas encore analysé » de « aucun ordre » : les timelines
    // ne sont demandées que sur un échantillon, l'absence est normale au début.
    el.order.append(div('detail__empty', 'Aucune timeline analysée pour ce champion.'));
    return;
  }

  el.order.append(div('build__title', `Ordre de build · ${int(order.samples)} parties`));

  for (const group of [
    renderOrderGroup('Objets de départ', order.starters),
    renderOrderGroup('Premier objet', order.firstItems),
    renderOrderGroup('Trois suivants', order.sequences),
  ]) {
    if (group) el.order.append(group);
  }
}

/** Écart d'or signé : le signe est écrit, la couleur ne fait que renforcer. */
function goldCell(entry: MatchupEntry): HTMLElement {
  if (!entry.goldDiff) return span('build__meta', '—');
  const { mean, margin } = entry.goldDiff;
  const sign = mean >= 0 ? '+' : '−';
  const cls = mean > 0 ? 'wr--above' : mean < 0 ? 'wr--below' : 'wr--unknown';
  return span(`gold ${cls}`, `${sign}${Math.abs(Math.round(mean))} ±${Math.round(margin)}`);
}

function renderMatchups(matchups: MatchupEntry[]): void {
  el.matchups.replaceChildren();
  el.matchups.append(div('build__title', 'Matchups de lane · or à 14 min'));

  if (matchups.length === 0) {
    el.matchups.append(div('detail__empty', 'Aucun duel enregistré pour ce champion.'));
    return;
  }

  for (const entry of matchups) {
    const row = div('matchup');
    row.append(labelWithIcon(entry.icon, entry.name, 'matchup__name'));

    const items = div('matchup__items');
    for (const item of entry.items.slice(0, 4)) {
      items.append(labelWithIcon(item.icon, item.name, 'order__item'));
    }
    row.append(items, goldCell(entry), span('build__meta', int(entry.games)));

    const lines = [
      entry.name,
      entry.goldDiff
        ? `Or à 14 min : ${entry.goldDiff.mean >= 0 ? '+' : '−'}${Math.abs(Math.round(entry.goldDiff.mean))} ` +
          `±${Math.round(entry.goldDiff.margin)} sur ${int(entry.goldDiff.n)} duels`
        : 'Or à 14 min : pas assez de timelines analysées',
      `Duels joués : ${int(entry.games)}`,
      entry.winRate === null
        ? 'Victoires : échantillon insuffisant'
        : `Victoires : ${pct(entry.winRate)}`,
      entry.items.length > 0
        ? `Objets : ${entry.items.map((i) => `${i.name} ${pct(i.share)}`).join(', ')}`
        : 'Objets : pas assez de duels',
    ];
    row.addEventListener('mousemove', (event) => showTooltip(event, lines));
    row.addEventListener('mouseleave', () => {
      el.tooltip.hidden = true;
    });

    el.matchups.append(row);
  }
}

/** Sorts et runes : mêmes lignes à icônes que l'ordre de build. */
function loadoutRow(entry: LoadoutEntry): HTMLElement {
  const row = div('order__row');

  const icons = div('order__items');
  for (const item of entry.items) {
    icons.append(labelWithIcon(item.icon, item.name, 'order__item'));
  }

  row.append(
    icons,
    span(
      'build__meta',
      entry.winRate === null ? pct(entry.share) : `${pct(entry.share)} · ${pct(entry.winRate)} v.`,
    ),
  );

  const lines = [
    entry.items.map((i) => i.name).join(' · '),
    `Fréquence : ${pct(entry.share)} (${int(entry.games)} parties)`,
    entry.winRate === null
      ? 'Victoires : échantillon insuffisant'
      : `Victoires : ${pct(entry.winRate)}`,
  ];
  row.addEventListener('mousemove', (event) => showTooltip(event, lines));
  row.addEventListener('mouseleave', () => {
    el.tooltip.hidden = true;
  });

  return row;
}

function renderLoadout(loadout: LoadoutSection | null): void {
  el.loadout.replaceChildren();
  el.loadout.append(div('build__title', 'Sorts et runes'));

  if (
    !loadout ||
    (loadout.spells.length === 0 && loadout.runes.length === 0 && loadout.perks.length === 0)
  ) {
    el.loadout.append(div('detail__empty', 'Pas encore de données pour ce champion.'));
    return;
  }

  for (const [title, entries] of [
    ['Sorts d’invocateur', loadout.spells],
    ['Pages les plus jouées', loadout.runes],
    ['Toutes les runes choisies', loadout.perks],
  ] as const) {
    if (entries.length === 0) continue;
    const group = div('order__group');
    group.append(div('order__title', title));
    for (const entry of entries) group.append(loadoutRow(entry));
    el.loadout.append(group);
  }
}

function renderDetail(detail: BuildDetail | null): void {
  el.detail.replaceChildren();

  if (!detail) {
    el.detailTitle.textContent = 'Objets';
    el.detail.append(div('detail__empty', 'Sélectionnez un champion à gauche.'));
    renderOrder(null);
    renderMatchups([]);
    renderLoadout(null);
    return;
  }

  renderLoadout(detail.loadout);
  renderOrder(detail.order);
  renderMatchups(detail.matchups);

  el.detailTitle.textContent = `Objets · ${detail.name}`;

  const summary =
    detail.winRate === null
      ? `${int(detail.games)} parties · taux masqué (échantillon insuffisant)`
      : `${int(detail.games)} parties · ${pct(detail.winRate)} de victoires`;
  el.detail.append(div('detail__summary', summary));

  if (detail.items.length === 0) {
    el.detail.append(div('detail__empty', 'Aucun objet enregistré.'));
    return;
  }

  const bars = div('bars');
  for (const item of detail.items) {
    const row = div('bar-row');
    const head = div('bar-row__head');
    head.append(
      labelWithIcon(item.icon, item.name, 'bar-row__name'),
      // Étiquette directe : la barre donne l'ordre de grandeur, le chiffre la
      // valeur exacte. Pas besoin d'axe.
      span('bar-row__value', pct(item.pickRate)),
    );

    const track = div('bar-track');
    const fill = div('bar-fill');
    fill.style.width = `${Math.max(1, item.pickRate * 100)}%`;
    track.append(fill);

    row.append(head, track);
    row.addEventListener('mousemove', (event) =>
      showTooltip(event, [
        item.name,
        `Présence : ${pct(item.pickRate)} (${int(item.games)} parties)`,
        item.winRate === null
          ? 'Victoires : échantillon insuffisant'
          : `Victoires : ${pct(item.winRate)}`,
      ]),
    );
    row.addEventListener('mouseleave', () => {
      el.tooltip.hidden = true;
    });

    bars.append(row);
  }
  el.detail.append(bars);

  if (detail.lowSample) {
    el.detail.append(
      div('detail__empty', 'Collecte en cours : taux de victoire pas encore significatifs.'),
    );
  }
}

function renderRoles(): void {
  const champion = current?.champions.find((c) => c.championId === selected?.championId);
  if (!champion) {
    el.roles.replaceChildren();
    return;
  }

  el.roles.replaceChildren(
    ...champion.roles.map((r) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `role-btn${r.role === selected?.role ? ' role-btn--active' : ''}`;
      btn.textContent = `${roleLabel(r.role)} · ${int(r.games)}`;
      btn.addEventListener('click', () => {
        selected = { championId: champion.championId, role: r.role };
        lastDetailSignature = '';
        renderRoles();
        void loadDetail();
      });
      return btn;
    }),
  );
}

async function loadDetail(): Promise<void> {
  renderRoles();
  if (!current?.patch || !selected || selected.role === '') {
    renderDetail(null);
    return;
  }
  const detail = (await window.laneform.buildDetail(
    current.patch,
    selected.championId,
    selected.role,
  )) as BuildDetail | null;

  const signature = JSON.stringify(detail);
  if (signature === lastDetailSignature) return;
  lastDetailSignature = signature;

  renderDetail(detail);
}

// --- Chargement ------------------------------------------------------------

function renderPatches(data: DashboardPayload): void {
  // Un sélecteur à une seule entrée n'offre aucun choix : on le masque, le
  // patch reste indiqué sur la tuile « Parties collectées ».
  const useful = data.availablePatches.length > 1;
  el.patch.hidden = !useful;
  el.patchLabel.hidden = !useful;

  // Ne pas reconstruire pendant que l'utilisateur a le menu ouvert.
  if (document.activeElement === el.patch) return;
  el.patch.replaceChildren(
    ...data.availablePatches.map((patch) => {
      const option = document.createElement('option');
      option.value = patch;
      option.textContent = patch;
      option.selected = patch === data.patch;
      return option;
    }),
  );
}

async function refresh(patch?: string): Promise<void> {
  const data = (await window.laneform.dashboardData(patch)) as DashboardPayload | null;
  if (!data) return;
  current = data;

  // Le collecteur avance par à-coups : la plupart des rafraîchissements
  // ramènent exactement les mêmes chiffres, et tout reconstruire faisait
  // scintiller la page toutes les cinq secondes.
  const signature = JSON.stringify(data);
  if (signature !== lastDataSignature) {
    lastDataSignature = signature;
    renderPatches(data);
    renderTiles(data);
    renderRows(data);
  }

  await loadDetail();
}

el.search.addEventListener('input', () => {
  filter = el.search.value;
  // Rendu local : inutile de réinterroger le process principal, les données
  // affichées sont déjà en mémoire.
  if (current) renderRows(current);
});

for (const header of headers) {
  header.addEventListener('click', () => {
    const key = header.dataset['sort'] as SortKey;
    if (sort.key === key) {
      sort = { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
    } else {
      // Un nom se lit de A à Z, un chiffre du plus grand au plus petit.
      sort = { key, dir: key === 'name' || key === 'role' ? 'asc' : 'desc' };
    }
    renderHeaders();
    if (current) renderRows(current);
  });
}

function setPrivacy(open: boolean): void {
  el.privacy.hidden = !open;
}

el.privacyToggle.addEventListener('click', () => setPrivacy(true));
el.privacyClose.addEventListener('click', () => setPrivacy(false));
// Clic hors du panneau et touche Échap : les deux sorties qu'on attend d'une
// fenêtre modale.
el.privacy.addEventListener('click', (event) => {
  if (event.target === el.privacy) setPrivacy(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.privacy.hidden) setPrivacy(false);
});

el.purge.addEventListener('click', () => {
  el.purge.disabled = true;
  void window.laneform
    .purgeAggregates()
    .then((result) => {
      if (result.error) el.warning.textContent = result.error;
      else if (result.ok) {
        el.warning.textContent = '';
        selected = null;
        lastDataSignature = '';
        lastDetailSignature = '';
        return refresh();
      }
      return undefined;
    })
    .finally(() => {
      el.purge.disabled = false;
    });
});

el.export.addEventListener('click', () => {
  el.export.disabled = true;
  void window.laneform
    .exportAggregates()
    .then((result) => {
      // Un succès mérite un retour : sans message, rien ne distingue un
      // enregistrement réussi d'un clic sans effet.
      if (result.error) el.warning.textContent = result.error;
      else if (result.ok) {
        el.warning.textContent = `Collecte exportée : ${int(result.matches ?? 0)} parties.`;
      }
    })
    .finally(() => {
      el.export.disabled = false;
    });
});

el.import.addEventListener('click', () => {
  el.import.disabled = true;
  void window.laneform
    .importAggregates()
    .then((result) => {
      if (result.error) el.warning.textContent = result.error;
      // Annulation : aucun message, l'utilisateur sait ce qu'il vient de faire.
      if (result.ok) {
        el.warning.textContent = '';
        selected = null;
        lastDataSignature = '';
        lastDetailSignature = '';
        return refresh();
      }
      return undefined;
    })
    .finally(() => {
      el.import.disabled = false;
    });
});

el.patch.addEventListener('change', () => void refresh(el.patch.value));

renderHeaders();
void refresh();
// La collecte avance en continu : un rafraîchissement périodique évite de
// devoir rouvrir la fenêtre pour voir les compteurs bouger.
setInterval(() => void refresh(el.patch.value || undefined), 5000);
