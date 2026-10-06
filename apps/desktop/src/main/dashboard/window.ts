import { BrowserWindow } from 'electron';
import { join } from 'node:path';

/**
 * Fenêtre du tableau de bord : consultation de la collecte, hors partie.
 *
 * Redimensionnable, contrairement à la configuration : on y parcourt des
 * listes qui gagnent à la place disponible.
 */
export function createDashboardWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    title: 'Laneform — Collecte',
    autoHideMenuBar: true,
    backgroundColor: '#11131a',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void win.loadFile(join(__dirname, 'dashboard.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}
