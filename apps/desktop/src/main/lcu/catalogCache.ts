import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameCatalog } from './gamedata.ts';

/**
 * Cache local du catalogue et de la plateforme.
 *
 * Sans lui, la collecte ne peut pas démarrer client fermé : la plateforme vient
 * du LCU, et surtout la liste des consommables aussi. Collecter sans cette
 * liste ferait entrer les potions dans les statistiques de build — une donnée
 * fausse qu'il faudrait ensuite jeter.
 *
 * Écrit une fois par session où le client est ouvert, relu à chaque démarrage.
 */

interface CachedCatalog {
  version: 1;
  platform: string | null;
  champions: [number, string][];
  /** [id, nom, consommable, iconPath, prix, construitVers, bottes] */
  items: [number, string, boolean, string?, number?, number[]?, boolean?][];
  excludedItemIds: number[];
  /** [id, nom, iconPath] pour sorts, runes et branches. */
  spells?: [number, string, string?][];
  perks?: [number, string, string?][];
  perkStyles?: [number, string, string?][];
}

export interface CachedClientState {
  catalog: GameCatalog | null;
  platform: string | null;
}

function readAssets(
  entries: [number, string, string?][] | undefined,
): Map<number, { id: number; name: string; iconPath?: string }> {
  // Absent d'un cache écrit avant l'ajout de ces catalogues : une table vide
  // fait retomber l'affichage sur les identifiants, sans rien casser.
  return new Map(
    (entries ?? []).map(([id, name, iconPath]) => [
      id,
      { id, name, ...(iconPath ? { iconPath } : {}) },
    ]),
  );
}

function writeAssets(
  table: Map<number, { id: number; name: string; iconPath?: string }>,
): [number, string, string?][] {
  // Tuple à deux éléments quand l'icône manque : un `undefined` explicite
  // n'est pas assignable à un emplacement optionnel, et alourdirait le JSON.
  return [...table.values()].map((a) =>
    a.iconPath ? ([a.id, a.name, a.iconPath] as [number, string, string]) : ([a.id, a.name] as [number, string]),
  );
}

function path(userDataDir: string): string {
  return join(userDataDir, 'client-cache.json');
}

export function loadClientCache(userDataDir: string): CachedClientState {
  try {
    const parsed = JSON.parse(readFileSync(path(userDataDir), 'utf8')) as CachedCatalog;
    if (parsed?.version !== 1) return { catalog: null, platform: null };

    const champions = new Map(parsed.champions.map(([id, name]) => [id, { id, name }]));
    const items = new Map(
      parsed.items.map(([id, name, consumable, iconPath, price, buildsInto, isBoots]) => [
        id,
        {
          id,
          name,
          consumable,
          // Un cache écrit avant l'ajout de ces champs les laisse absents. Les
          // valeurs neutres font que l'ordre de build ne produit RIEN, plutôt
          // que de produire une classification fausse. Il se remplira à la
          // prochaine ouverture du client.
          price: price ?? 0,
          buildsInto: buildsInto ?? [],
          isBoots: isBoots ?? false,
          ...(iconPath ? { iconPath } : {}),
        },
      ]),
    );

    return {
      // Un catalogue vide n'est pas un catalogue : on préfère `null`, que le
      // reste du code sait déjà traiter.
      catalog:
        champions.size > 0
          ? {
              champions,
              items,
              excludedItemIds: new Set(parsed.excludedItemIds),
              spells: readAssets(parsed.spells),
              perks: readAssets(parsed.perks),
              perkStyles: readAssets(parsed.perkStyles),
            }
          : null,
      platform: parsed.platform ?? null,
    };
  } catch {
    return { catalog: null, platform: null };
  }
}

export function saveClientCache(
  userDataDir: string,
  catalog: GameCatalog | null,
  platform: string | null,
): void {
  if (!catalog || catalog.champions.size === 0) return;

  const payload: CachedCatalog = {
    version: 1,
    platform,
    champions: [...catalog.champions.values()].map((c) => [c.id, c.name]),
    items: [...catalog.items.values()].map(
      (i) =>
        [i.id, i.name, i.consumable, i.iconPath, i.price, i.buildsInto, i.isBoots] as [
          number, string, boolean, string?, number?, number[]?, boolean?,
        ],
    ),
    excludedItemIds: [...catalog.excludedItemIds],
    spells: writeAssets(catalog.spells),
    perks: writeAssets(catalog.perks),
    perkStyles: writeAssets(catalog.perkStyles),
  };

  const target = path(userDataDir);
  const tmp = `${target}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, target);
  } catch {
    // Cache non critique : on réessaiera à la prochaine ouverture du client.
  }
}
