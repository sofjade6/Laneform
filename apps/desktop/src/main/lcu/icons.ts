import { mkdirSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'undici';
import { basicAuthHeader, type LcuCredentials } from './lockfile.ts';
import { localAgent } from './client.ts';
import type { GameCatalog } from './gamedata.ts';

/**
 * Icônes des champions et des objets, récupérées dans le client League.
 *
 * On passe par le LCU plutôt que par un CDN : les images correspondent
 * exactement au patch installé, rien ne dépend du réseau, et aucune version
 * n'est à deviner. Une fois en cache, elles restent disponibles client fermé.
 *
 * Les fichiers sont nommés par identifiant, donc réutilisables tels quels par
 * l'interface sans table de correspondance.
 */

export function iconsDir(userDataDir: string): string {
  return join(userDataDir, 'icons');
}

async function download(
  creds: LcuCredentials,
  path: string,
  target: string,
): Promise<boolean> {
  try {
    const res = await request(`https://127.0.0.1:${creds.port}${path}`, {
      method: 'GET',
      dispatcher: localAgent,
      headers: { authorization: basicAuthHeader(creds.password) },
      headersTimeout: 5000,
      bodyTimeout: 10_000,
    });

    if (res.statusCode !== 200) {
      await res.body.dump();
      return false;
    }

    const buffer = Buffer.from(await res.body.arrayBuffer());
    // Une icône vide ou tronquée vaut moins qu'une icône absente : l'interface
    // sait retomber sur le texte, mais pas afficher un PNG corrompu.
    if (buffer.length < 100) return false;

    // Écriture atomique : un fichier à moitié écrit resterait en cache et
    // afficherait une image cassée indéfiniment.
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, buffer);
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

export interface IconSyncResult {
  downloaded: number;
  skipped: number;
  failed: number;
}

/**
 * Complète le cache d'icônes. Ne retélécharge jamais un fichier présent.
 *
 * Séquentiel et sans urgence : ce sont des requêtes locales, mais elles se
 * comptent en centaines et n'ont aucune raison de concurrencer l'affichage.
 */
export async function syncIcons(
  creds: LcuCredentials,
  catalog: GameCatalog,
  userDataDir: string,
  log: (message: string) => void,
): Promise<IconSyncResult> {
  const dir = iconsDir(userDataDir);
  mkdirSync(dir, { recursive: true });

  const result: IconSyncResult = { downloaded: 0, skipped: 0, failed: 0 };

  const jobs: { target: string; path: string }[] = [];

  for (const champion of catalog.champions.values()) {
    jobs.push({
      target: join(dir, `champion-${champion.id}.png`),
      path: `/lol-game-data/assets/v1/champion-icons/${champion.id}.png`,
    });
  }

  for (const item of catalog.items.values()) {
    if (!item.iconPath) continue;
    jobs.push({
      target: join(dir, `item-${item.id}.png`),
      // Le client sert ces chemins en minuscules.
      path: item.iconPath.toLowerCase(),
    });
  }

  const secondary: [string, Map<number, { id: number; iconPath?: string }>][] = [
    ['spell', catalog.spells],
    ['perk', catalog.perks],
    ['perkstyle', catalog.perkStyles],
  ];

  for (const [kind, table] of secondary) {
    for (const asset of table.values()) {
      if (!asset.iconPath) continue;
      jobs.push({
        target: join(dir, `${kind}-${asset.id}.png`),
        path: asset.iconPath.toLowerCase(),
      });
    }
  }

  for (const job of jobs) {
    if (existsSync(job.target)) {
      result.skipped += 1;
      continue;
    }
    if (await download(creds, job.path, job.target)) result.downloaded += 1;
    else result.failed += 1;
  }

  log(
    `icônes : ${result.downloaded} téléchargées, ${result.skipped} déjà en cache, ` +
      `${result.failed} indisponibles ` +
      `(catalogue : ${catalog.champions.size} champions, ${catalog.items.size} objets, ` +
      `${catalog.spells.size} sorts, ${catalog.perks.size} runes, ` +
      `${catalog.perkStyles.size} branches)`,
  );
  return result;
}
