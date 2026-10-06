import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { iconsDir } from '../lcu/icons.ts';

/**
 * Protocole `laneform-icon://` pour afficher les icônes en cache.
 *
 * Un protocole dédié plutôt que des URL `file://` : les fenêtres sont chargées
 * depuis le disque, et Electron restreint de plus en plus le chargement de
 * sous-ressources `file://` depuis une page `file://`. Celui-ci est explicite
 * et ne donne accès qu'au dossier d'icônes.
 */

export const ICON_SCHEME = 'laneform-icon';

/** À appeler AVANT `app.whenReady()`, c'est une contrainte d'Electron. */
export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ICON_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false },
    },
  ]);
}

/** `laneform-icon://champion/266` -> `<userData>/icons/champion-266.png`. */
export type IconKind = 'champion' | 'item' | 'spell' | 'perk' | 'perkstyle';

const KINDS: readonly string[] = ['champion', 'item', 'spell', 'perk', 'perkstyle'];

export function iconUrl(kind: IconKind, id: number): string {
  return `${ICON_SCHEME}://${kind}/${id}`;
}

export function handleIconProtocol(userDataDir: string): void {
  const dir = iconsDir(userDataDir);

  protocol.handle(ICON_SCHEME, async (requested) => {
    const url = new URL(requested.url);
    const kind = url.hostname;
    const id = url.pathname.replace(/^\//, '');

    // Liste blanche stricte sur les deux segments : rien d'autre ne peut
    // désigner un fichier, donc aucune remontée de chemin n'est possible.
    if (!KINDS.includes(kind) || !/^\d+$/.test(id)) {
      return new Response('invalid icon reference', { status: 400 });
    }

    const file = join(dir, `${kind}-${id}.png`);
    if (!existsSync(file)) return new Response('not found', { status: 404 });

    return net.fetch(pathToFileURL(file).toString());
  });
}
