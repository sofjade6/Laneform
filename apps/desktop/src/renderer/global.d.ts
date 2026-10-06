/** Surface exposée par le preload, commune à toutes les fenêtres. */
interface LaneformBridge {
  onUpdate(callback: (payload: unknown) => void): void;
  saveApiKey(key: string): Promise<{ ok: boolean; error?: string }>;
  configPath(): Promise<string>;
  closeSetup(): void;
  dashboardData(patch?: string): Promise<unknown>;
  buildDetail(patch: string, championId: number, role: string): Promise<unknown>;
  importAggregates(): Promise<{ ok: boolean; error?: string; matches?: number }>;
  exportAggregates(): Promise<{ ok: boolean; error?: string; matches?: number; path?: string }>;
  purgeAggregates(): Promise<{ ok: boolean; error?: string }>;
}

interface Window {
  laneform: LaneformBridge;
}
