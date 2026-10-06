import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
await mkdir(out, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

await Promise.all([
  // Process principal : CJS, car c'est ce qu'Electron charge le plus
  // simplement. `electron` est fourni par le runtime, jamais bundlé.
  build({
    ...common,
    entryPoints: [resolve(root, 'src/main/index.ts')],
    outfile: resolve(out, 'main.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  }),
  // Preload : CJS obligatoire, c'est la contrainte d'Electron.
  build({
    ...common,
    entryPoints: [resolve(root, 'src/preload/index.ts')],
    outfile: resolve(out, 'preload.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  }),
  // Renderer de l'overlay : navigateur, sans accès à Node (contextIsolation).
  build({
    ...common,
    entryPoints: [resolve(root, 'src/renderer/overlay.ts')],
    outfile: resolve(out, 'overlay.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  }),
  // Fenêtres de configuration et de tableau de bord : même contexte navigateur.
  ...['setup', 'dashboard'].map((name) =>
    build({
      ...common,
      entryPoints: [resolve(root, `src/renderer/${name}.ts`)],
      outfile: resolve(out, `${name}.js`),
      platform: 'browser',
      format: 'iife',
      target: 'chrome120',
    }),
  ),
]);

for (const asset of [
  'overlay.html', 'overlay.css',
  'setup.html', 'setup.css',
  'dashboard.html', 'dashboard.css',
]) {
  await cp(resolve(root, 'src/renderer', asset), resolve(out, asset));
}

// Icône de la zone de notification, chargée depuis dist au runtime.
await cp(resolve(root, 'assets/tray.png'), resolve(out, 'tray.png'));
console.log('build ok ->', out);
