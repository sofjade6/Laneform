import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { basicAuthHeader, type LcuCredentials } from './lockfile.ts';

/**
 * Message poussé par le LCU. Le protocole est un dérivé de WAMP : les trames
 * utiles arrivent sous la forme `[8, "OnJsonApiEvent", payload]`.
 */
export interface LcuEvent {
  uri: string;
  eventType: 'Create' | 'Update' | 'Delete';
  data: unknown;
}

const WAMP_SUBSCRIBE = 5;
const WAMP_EVENT = 8;

export interface LcuEventStreamEvents {
  event: [LcuEvent];
  open: [];
  close: [];
  error: [Error];
}

/**
 * Flux d'événements du client League.
 *
 * Préféré au polling : le champion select change à chaque pick et chaque ban,
 * et un sondage régulier arriverait toujours en retard sur l'affichage du jeu
 * — un draft helper qui réagit une seconde trop tard ne sert à rien.
 */
export class LcuEventStream extends EventEmitter<LcuEventStreamEvents> {
  private ws: WebSocket | null = null;
  private closedByUs = false;

  constructor(private readonly creds: LcuCredentials) {
    super();
  }

  connect(): void {
    this.closedByUs = false;
    const ws = new WebSocket(`wss://127.0.0.1:${this.creds.port}`, {
      headers: { authorization: basicAuthHeader(this.creds.password) },
      // Même certificat auto-signé que le REST, même justification : la cible
      // est 127.0.0.1 et la portée est limitée à cette socket.
      rejectUnauthorized: false,
    });
    this.ws = ws;

    ws.on('open', () => {
      // Sans cet abonnement explicite, la socket s'ouvre et ne reçoit rien.
      ws.send(JSON.stringify([WAMP_SUBSCRIBE, 'OnJsonApiEvent']));
      this.emit('open');
    });

    ws.on('message', (raw) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return; // Le LCU émet aussi des trames vides à l'ouverture.
      }
      if (!Array.isArray(frame) || frame[0] !== WAMP_EVENT) return;
      const payload = frame[2] as LcuEvent | undefined;
      if (payload?.uri) this.emit('event', payload);
    });

    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', () => {
      this.ws = null;
      if (!this.closedByUs) this.emit('close');
    });
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }
}
