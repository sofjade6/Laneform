import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';

/**
 * Fenêtre de l'overlay.
 *
 * Contraintes Windows à connaître :
 *  - le jeu doit tourner en Borderless ou Windowed. En plein écran exclusif,
 *    Windows n'affiche AUCUNE fenêtre par-dessus, quelle que soit l'app. Tous
 *    les overlays du marché ont cette limite ; il faut la dire à l'utilisateur
 *    plutôt que de le laisser croire à un bug.
 *  - `setIgnoreMouseEvents` laisse les clics traverser vers le jeu. Sans ça
 *    l'overlay vole les clics et rend la partie injouable.
 */
export function createOverlayWindow(): BrowserWindow {
  // TODO: cibler le moniteur où tourne League plutôt que le principal. Le
  // déterminer demande une API native Windows (position de la fenêtre du jeu) ;
  // en attendant, l'écran principal couvre la configuration la plus répandue.
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      // Non négociable : l'overlay affichera un jour des données venues du
      // réseau. Avec nodeIntegration, ce serait une exécution de code arbitraire.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 'screen-saver' est le niveau le plus haut : en dessous, la fenêtre du jeu
  // repasse devant dès qu'elle reprend le focus.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // `forward: true` laisse malgré tout l'overlay recevoir les événements de
  // survol, nécessaires si on veut plus tard des zones interactives.
  win.setIgnoreMouseEvents(true, { forward: true });

  void win.loadFile(join(__dirname, 'overlay.html'));
  win.once('ready-to-show', () => win.showInactive());

  return win;
}
