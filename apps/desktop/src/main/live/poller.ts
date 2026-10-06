import { EventEmitter } from 'node:events';
import { fetchLiveGameData, type LiveGameData } from './client.ts';

export interface LivePollerEvents {
  data: [LiveGameData];
  started: [];
  ended: [];
}

/**
 * Sonde la partie en cours à 1 Hz.
 *
 * 1 Hz est un choix délibéré : l'horloge de jeu et les timers d'objectifs se
 * comptent en secondes, et descendre plus bas ne ferait qu'ajouter du travail
 * sur la machine du joueur pendant qu'il joue — le seul moment où il ne faut
 * surtout pas en consommer.
 */
export class LivePoller extends EventEmitter<LivePollerEvents> {
  private timer: NodeJS.Timeout | null = null;
  private inGame = false;

  constructor(private readonly intervalMs = 1000) {
    super();
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.inGame = false;
  }

  private async tick(): Promise<void> {
    const data = await fetchLiveGameData();

    if (!data) {
      if (this.inGame) {
        this.inGame = false;
        this.emit('ended');
      }
      return;
    }

    if (!this.inGame) {
      this.inGame = true;
      this.emit('started');
    }
    this.emit('data', data);
  }
}
