import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chargement de la configuration, sans dépendance.
 *
 * Un `.env` suffit et évite d'ajouter dotenv pour une dizaine de lignes. Les
 * chemins sont essayés dans l'ordre : variable d'environnement, puis dossier
 * de travail (développement), puis dossier de données utilisateur (app
 * installée, où il n'y a pas de dépôt à côté de l'exécutable).
 */
function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // Les guillemets éventuels font partie de la syntaxe, pas de la valeur.
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

export interface AppConfig {
  riotApiKey: string | null;
  /**
   * Backend Laneform. Renseigné, les rangs passent par lui et la clé locale
   * devient inutile pour cette fonction — c'est le mode destiné à une
   * distribution publique, où la clé ne peut pas vivre sur le poste.
   */
  apiUrl: string | null;
  appRateLimits: string;
  /** Force la plateforme quand la détection via le client échoue. */
  platformOverride: string | null;
}

export function loadConfig(userDataDir: string): AppConfig {
  const candidates = [
    join(process.cwd(), '.env'),
    join(process.cwd(), '..', '..', '.env'),
    join(userDataDir, '.env'),
  ];

  let fromFile: Record<string, string> = {};
  for (const path of candidates) {
    try {
      fromFile = parseEnvFile(readFileSync(path, 'utf8'));
      break;
    } catch {
      // Fichier absent : on passe au suivant.
    }
  }

  const read = (key: string): string | null => process.env[key] ?? fromFile[key] ?? null;

  const apiUrl = read('LANEFORM_API_URL');

  return {
    riotApiKey: read('RIOT_API_KEY'),
    // Barre oblique finale retirée une fois pour toutes : la concaténation
    // des chemins produirait sinon des doubles slashs.
    apiUrl: apiUrl ? apiUrl.replace(/\/+$/, '') : null,
    appRateLimits: read('RIOT_APP_RATE_LIMITS') ?? '20:1,100:120',
    platformOverride: read('LANEFORM_PLATFORM'),
  };
}

/**
 * Réécrit un `.env` en ne touchant qu'aux clés fournies.
 *
 * Les lignes inconnues, les commentaires et l'ordre sont conservés : le
 * fichier peut contenir des réglages que l'application ne connaît pas encore,
 * et les écraser serait une mauvaise surprise.
 */
export function mergeEnv(existing: string, updates: Record<string, string>): string {
  const remaining = { ...updates };
  const lines = existing.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in remaining)) return line;
    const value = remaining[key]!;
    delete remaining[key];
    return `${key}=${value}`;
  });

  // Les lignes vides finales se retirent AVANT l'ajout, sinon elles se
  // retrouvent coincées au milieu du fichier, entre l'ancien contenu et les
  // nouvelles clés.
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();

  for (const [key, value] of Object.entries(remaining)) lines.push(`${key}=${value}`);

  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export function envPath(userDataDir: string): string {
  return join(userDataDir, '.env');
}

export function saveEnv(userDataDir: string, updates: Record<string, string>): void {
  const path = envPath(userDataDir);
  let existing = '';
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    // Premier enregistrement : on part d'un fichier vide.
  }
  writeFileSync(path, mergeEnv(existing, updates), 'utf8');
}

/**
 * Contrôle de forme, avant l'appel réseau.
 *
 * Volontairement permissif : il attrape le copier-coller raté (espaces,
 * guillemets, champ vide) sans présumer du format exact des clés de Riot, qui
 * pourrait changer. La validation qui fait foi reste l'appel à l'API.
 */
export function looksLikeApiKey(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 20 && !/\s/.test(trimmed);
}

export { parseEnvFile };
