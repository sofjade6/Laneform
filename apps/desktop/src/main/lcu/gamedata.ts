import type { LcuClient } from './client.ts';

/**
 * Catalogues champions et items, lus dans le client League lui-même.
 *
 * Le client embarque déjà ces données pour sa propre interface : les lire là
 * évite de télécharger Data Dragon, d'avoir à suivre les versions de patch, et
 * garantit que nos noms correspondent exactement à ceux affichés en jeu.
 */

export interface ChampionInfo {
  id: number;
  name: string;
}

export interface ItemInfo {
  id: number;
  name: string;
  /** Potions et consommables : hors du build « cœur ». */
  consumable: boolean;
  /**
   * Chemin de l'icône tel que servi par le client, p.ex.
   * `/lol-game-data/assets/ASSETS/Items/Icons2D/1001_x.png`.
   * Absent sur certaines entrées : l'interface retombe alors sur le texte.
   */
  iconPath?: string;
  /** Coût cumulé, composants inclus. 0 si le client ne le renseigne pas. */
  price: number;
  /** Un objet dans lequel celui-ci se construit. Vide = objet terminé. */
  buildsInto: number[];
  isBoots: boolean;
}

/** Entrée simple d'un catalogue secondaire : sort, rune ou branche. */
export interface AssetInfo {
  id: number;
  name: string;
  iconPath?: string;
}

export interface GameCatalog {
  champions: Map<number, ChampionInfo>;
  items: Map<number, ItemInfo>;
  /** Consommables et babioles, à exclure des statistiques de build. */
  excludedItemIds: Set<number>;
  spells: Map<number, AssetInfo>;
  perks: Map<number, AssetInfo>;
  /** Branches de runes, dans une table distincte : leurs identifiants peuvent
   *  recouvrir ceux des runes elles-mêmes. */
  perkStyles: Map<number, AssetInfo>;
}

/** Les champs de ces fichiers ne sont pas documentés : on lit défensivement. */
function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v !== null) as Record<string, unknown>[]) : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Catalogue secondaire : liste d'objets `{id, name, iconPath}`.
 *
 * `perkstyles.json` enveloppe sa liste dans `{ styles: [...] }`, les autres
 * sont des tableaux nus — on accepte les deux formes.
 */
async function loadAssets(client: LcuClient, path: string): Promise<Map<number, AssetInfo>> {
  const raw = await client.get<unknown>(path).catch(() => null);
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>)['styles'])
      ? ((raw as Record<string, unknown>)['styles'] as unknown[])
      : [];

  const out = new Map<number, AssetInfo>();
  for (const entry of asRecordArray(list)) {
    const id = asNumber(entry['id']);
    const name = typeof entry['name'] === 'string' ? entry['name'] : null;
    if (id === null || id <= 0 || !name) continue;
    const iconPath = typeof entry['iconPath'] === 'string' ? entry['iconPath'] : undefined;
    out.set(id, { id, name, ...(iconPath ? { iconPath } : {}) });
  }
  return out;
}

export async function loadCatalog(client: LcuClient): Promise<GameCatalog> {
  const champions = new Map<number, ChampionInfo>();
  const items = new Map<number, ItemInfo>();
  const excludedItemIds = new Set<number>();

  const championRaw = await client
    .get<unknown>('/lol-game-data/assets/v1/champion-summary.json')
    .catch(() => null);

  for (const entry of asRecordArray(championRaw)) {
    const id = asNumber(entry['id']);
    const name = typeof entry['name'] === 'string' ? entry['name'] : null;
    // L'entrée -1 du catalogue est le marqueur « aucun champion ».
    if (id !== null && id > 0 && name) champions.set(id, { id, name });
  }

  const itemRaw = await client.get<unknown>('/lol-game-data/assets/v1/items.json').catch(() => null);

  for (const entry of asRecordArray(itemRaw)) {
    const id = asNumber(entry['id']);
    const name = typeof entry['name'] === 'string' ? entry['name'] : null;
    if (id === null || id <= 0 || !name) continue;

    // `consumed` marque les objets qui disparaissent à l'usage. Une babiole de
    // vision n'est pas « consumed » mais ne fait pas partie d'un build non
    // plus : on l'écarte via son emplacement, repéré par la catégorie.
    const consumable = entry['consumed'] === true;
    const isTrinket = Array.isArray(entry['categories'])
      ? (entry['categories'] as unknown[]).includes('Trinket')
      : false;

    const iconPath = typeof entry['iconPath'] === 'string' ? entry['iconPath'] : undefined;

    // Champs non documentés : lus défensivement, un renommage côté Riot doit
    // dégrader la classification, pas faire échouer le chargement.
    const priceInfo = entry['priceTotal'] ?? entry['price'];
    const price = typeof priceInfo === 'number' ? priceInfo : 0;
    const buildsInto = Array.isArray(entry['to'])
      ? (entry['to'] as unknown[]).filter((v): v is number => typeof v === 'number')
      : [];
    const isBoots = Array.isArray(entry['categories'])
      ? (entry['categories'] as unknown[]).includes('Boots')
      : false;

    items.set(id, {
      id,
      name,
      consumable,
      price,
      buildsInto,
      isBoots,
      ...(iconPath ? { iconPath } : {}),
    });
    if (consumable || isTrinket) excludedItemIds.add(id);
  }

  const [spells, perks, perkStyles] = await Promise.all([
    loadAssets(client, '/lol-game-data/assets/v1/summoner-spells.json'),
    loadAssets(client, '/lol-game-data/assets/v1/perks.json'),
    loadAssets(client, '/lol-game-data/assets/v1/perkstyles.json'),
  ]);

  return { champions, items, excludedItemIds, spells, perks, perkStyles };
}

/**
 * Fusionne un catalogue fraîchement lu avec celui du cache, table par table.
 *
 * Le client répond parfois partiellement : les champions arrivent, les runes
 * non. Un remplacement global ferait alors perdre des tables valides, et le
 * cache réécrit propagerait la perte. On ne retient donc une table neuve que
 * si elle a du contenu.
 */
export function mergeCatalog(
  cached: GameCatalog | null,
  loaded: GameCatalog | null,
): GameCatalog | null {
  if (!loaded) return cached;
  if (!cached) return loaded.champions.size > 0 ? loaded : null;

  const itemsLoaded = loaded.items.size > 0;
  return {
    champions: loaded.champions.size > 0 ? loaded.champions : cached.champions,
    items: itemsLoaded ? loaded.items : cached.items,
    // Les exclusions sont dérivées des objets : les deux vont de pair.
    excludedItemIds: itemsLoaded ? loaded.excludedItemIds : cached.excludedItemIds,
    spells: loaded.spells.size > 0 ? loaded.spells : cached.spells,
    perks: loaded.perks.size > 0 ? loaded.perks : cached.perks,
    perkStyles: loaded.perkStyles.size > 0 ? loaded.perkStyles : cached.perkStyles,
  };
}

export function championName(catalog: GameCatalog | null, championId: number): string {
  if (championId <= 0) return 'Aucun';
  return catalog?.champions.get(championId)?.name ?? `#${championId}`;
}

export function itemName(catalog: GameCatalog | null, itemId: number): string {
  return catalog?.items.get(itemId)?.name ?? `#${itemId}`;
}

export function spellName(catalog: GameCatalog | null, id: number): string {
  return catalog?.spells.get(id)?.name ?? `#${id}`;
}

export function perkName(catalog: GameCatalog | null, id: number): string {
  return catalog?.perks.get(id)?.name ?? `#${id}`;
}

export function perkStyleName(catalog: GameCatalog | null, id: number): string {
  return catalog?.perkStyles.get(id)?.name ?? `#${id}`;
}
