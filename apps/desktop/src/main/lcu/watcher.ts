import { EventEmitter } from 'node:events';
import { readCredentials, type LcuCredentials } from './lockfile.ts';

export interface LcuWatcherEvents {
  connected: [LcuCredentials];
  disconnected: [];
}

/**
 * Surveille l'apparition, la disparition et le CHANGEMENT du lockfile.
 *
 * Polling (2 s) plutôt que `fs.watch` : le lockfile est écrit puis supprimé par
 * un process externe, et `fs.watch` sur un fichier qui disparaît cesse
 * d'émettre sans prévenir sous Windows. Le fichier fait quelques octets, le
 * coût du polling est nul.
 */
export class LcuWatcher extends EventEmitter<LcuWatcherEvents> {
  private timer: NodeJS.Timeout | null = null;
  private current: LcuCredentials | null = null;

  constructor(private readonly intervalMs = 2000) {
    super();
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Ne pas retenir la boucle d'événements : l'app doit pouvoir se fermer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get credentials(): LcuCredentials | null {
    return this.current;
  }

  private async tick(): Promise<void> {
    const next = await readCredentials();

    if (!next) {
      if (this.current) {
        this.current = null;
        this.emit('disconnected');
      }
      return;
    }

    // Un client relancé réutilise parfois le même pid mais jamais le même port
    // ni le même mot de passe : on compare ces deux-là.
    const changed =
      !this.current || this.current.port !== next.port || this.current.password !== next.password;

    if (changed) {
      if (this.current) this.emit('disconnected');
      this.current = next;
      this.emit('connected', next);
    }
  }
}
