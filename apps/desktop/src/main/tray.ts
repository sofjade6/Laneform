import { app, Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';

/**
 * Icône de zone de notification.
 *
 * Seul point de sortie de l'application : l'overlay est sans cadre, non
 * focusable et absent de la barre des tâches, donc rien d'autre ne permet de
 * la fermer autrement qu'avec le Gestionnaire des tâches.
 */

export interface TrayActions {
  toggleOverlay(): void;
  openDashboard(): void;
  openSetup(): void;
  toggleCollector(): void;
  isOverlayVisible(): boolean;
  isCollectorPaused(): boolean;
  hasCollector(): boolean;
}

export function createTray(actions: TrayActions): Tray {
  const icon = nativeImage.createFromPath(join(__dirname, 'tray.png'));
  const tray = new Tray(icon);
  tray.setToolTip('Laneform');

  function refresh(): void {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: actions.isOverlayVisible() ? 'Masquer l’overlay' : 'Afficher l’overlay',
          click: () => {
            actions.toggleOverlay();
            refresh();
          },
        },
        { label: 'Tableau de bord', click: actions.openDashboard },
        { label: 'Clé API…', click: actions.openSetup },
        { type: 'separator' },
        {
          label: actions.isCollectorPaused() ? 'Reprendre la collecte' : 'Suspendre la collecte',
          enabled: actions.hasCollector(),
          click: () => {
            actions.toggleCollector();
            refresh();
          },
        },
        { type: 'separator' },
        // `app.quit()` et non `destroy()` : les agrégats doivent être écrits
        // avant la fermeture, ce que fait le gestionnaire `will-quit`.
        { label: 'Quitter Laneform', click: () => app.quit() },
      ]),
    );
  }

  refresh();
  tray.on('click', actions.openDashboard);
  return tray;
}
