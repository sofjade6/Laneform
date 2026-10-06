import { BrowserWindow } from 'electron';
import { join } from 'node:path';

/**
 * Fenêtre de configuration.
 *
 * Distincte de l'overlay, qui est transparent, sans focus et traversé par les
 * clics : il ne peut par construction recevoir aucune saisie.
 */
export function createSetupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 540,
    height: 420,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Laneform — Configuration',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void win.loadFile(join(__dirname, 'setup.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}
