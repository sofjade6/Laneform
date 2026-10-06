import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Identifiants d'accès au LCU, lus dans le `lockfile` que le client League
 * dépose à sa racine pendant qu'il tourne.
 *
 * Port ET mot de passe changent à CHAQUE lancement du client. Les lire une
 * seule fois au démarrage de l'app donne une connexion qui marche jusqu'au
 * premier redémarrage de League, puis échoue silencieusement. D'où le watcher
 * ci-dessous plutôt qu'une lecture unique.
 */
export interface LcuCredentials {
  readonly processName: string;
  readonly pid: number;
  readonly port: number;
  readonly password: string;
  readonly protocol: string;
}

/**
 * Format du lockfile : `nom:pid:port:password:protocole`, sur une seule ligne.
 * Fonction pure, testable sans client League installé.
 */
export function parseLockfile(contents: string): LcuCredentials | null {
  const parts = contents.trim().split(':');
  if (parts.length < 5) return null;

  const [processName, pidRaw, portRaw, password, protocol] = parts as [
    string, string, string, string, string,
  ];
  const pid = Number(pidRaw);
  const port = Number(portRaw);

  // Un lockfile en cours d'écriture peut être lu tronqué : on refuse plutôt
  // que de produire des identifiants à moitié valides.
  if (!Number.isInteger(pid) || !Number.isInteger(port) || port <= 0) return null;
  if (password.length === 0) return null;

  return { processName, pid, port, password, protocol };
}

/** En-tête Basic attendu par le LCU : utilisateur fixe `riot`, mot de passe du lockfile. */
export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`riot:${password}`).toString('base64')}`;
}

const DEFAULT_PATHS = [
  'C:\\Riot Games\\League of Legends\\lockfile',
  'C:\\Program Files\\Riot Games\\League of Legends\\lockfile',
  join(homedir(), 'AppData', 'Local', 'Riot Games', 'League of Legends', 'lockfile'),
];

/**
 * Chemins candidats du lockfile.
 *
 * `LANEFORM_LOCKFILE` permet de pointer une installation non standard (second
 * disque, install portable). Sans cette échappatoire, les utilisateurs dont
 * League n'est pas sur C: n'ont aucun recours.
 */
export function lockfileCandidates(): string[] {
  const override = process.env.LANEFORM_LOCKFILE;
  return override ? [override, ...DEFAULT_PATHS] : DEFAULT_PATHS;
}

export async function readCredentials(): Promise<LcuCredentials | null> {
  for (const path of lockfileCandidates()) {
    try {
      const parsed = parseLockfile(await readFile(path, 'utf8'));
      if (parsed) return parsed;
    } catch {
      // Fichier absent = client fermé. Cas nominal, pas une erreur.
    }
  }
  return null;
}
