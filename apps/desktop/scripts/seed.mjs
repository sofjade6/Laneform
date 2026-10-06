import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Copie la collecte de cette machine vers l'amorce embarquée dans l'installeur.
 * À relancer à chaque patch : les agrégats sont cloisonnés, une amorce d'un
 * patch antérieur est ignorée par l'application.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(homedir(), 'AppData', 'Roaming', 'Laneform', 'aggregates.json');
const target = join(root, 'seed', 'aggregates.json');

try {
  const size = statSync(source).size;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`amorce mise à jour (${(size / 1024 / 1024).toFixed(1)} Mo) -> ${target}`);
} catch (err) {
  console.error(`aucune collecte trouvée dans ${source}`);
  console.error('Lancez l’application quelques heures avant de générer une amorce.');
  process.exitCode = 1;
}
