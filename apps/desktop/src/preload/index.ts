import { contextBridge, ipcRenderer } from 'electron';

/**
 * Surface exposée aux fenêtres. Chaque canal est explicite : aucun accès
 * générique à l'IPC, et rien qui permette d'exécuter du code côté système.
 */
const api = {
  /** Overlay : flux d'état en lecture seule. */
  onUpdate(callback: (payload: unknown) => void): void {
    ipcRenderer.on('laneform:update', (_event, payload) => callback(payload));
  },

  /** Configuration : valide puis enregistre la clé. */
  saveApiKey(key: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('laneform:save-api-key', key);
  },

  /** Chemin du fichier de configuration, affiché à titre informatif. */
  configPath(): Promise<string> {
    return ipcRenderer.invoke('laneform:config-path');
  },

  closeSetup(): void {
    ipcRenderer.send('laneform:close-setup');
  },

  /** Tableau de bord : état de la collecte et agrégats. */
  dashboardData(patch?: string): Promise<unknown> {
    return ipcRenderer.invoke('laneform:dashboard-data', patch);
  },

  buildDetail(patch: string, championId: number, role: string): Promise<unknown> {
    return ipcRenderer.invoke('laneform:build-detail', { patch, championId, role });
  },

  /** Remplace la collecte locale par un fichier choisi par l'utilisateur. */
  importAggregates(): Promise<{ ok: boolean; error?: string; matches?: number }> {
    return ipcRenderer.invoke('laneform:import-aggregates');
  },

  /** Efface définitivement la collecte locale. */
  purgeAggregates(): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('laneform:purge-aggregates');
  },

  /** Enregistre la collecte locale dans un fichier à partager. */
  exportAggregates(): Promise<{ ok: boolean; error?: string; matches?: number; path?: string }> {
    return ipcRenderer.invoke('laneform:export-aggregates');
  },
};

contextBridge.exposeInMainWorld('laneform', api);

export type LaneformApi = typeof api;
