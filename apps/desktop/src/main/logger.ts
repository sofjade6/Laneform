import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Journal sur fichier.
 *
 * Indispensable : une application Electron graphique sous Windows n'a pas de
 * sortie console exploitable. Tout ce qui passait par `console.log` était
 * perdu, y compris les erreurs de démarrage — on ne pouvait donc pas
 * diagnostiquer une app qui se ferme toute seule.
 */

let resolved: string | null = null;

function logPath(): string {
  if (!resolved) {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    resolved = join(dir, 'laneform.log');
  }
  return resolved;
}

export function log(message: string): void {
  try {
    appendFileSync(logPath(), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Journaliser ne doit jamais faire échouer ce qu'on journalisait.
  }
}

export function logError(context: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log(`ERREUR ${context} : ${detail}`);
}

/** Capture les erreurs qui, sinon, feraient disparaître l'application en silence. */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => logError('exception non capturée', err));
  process.on('unhandledRejection', (err) => logError('promesse rejetée', err));
}
