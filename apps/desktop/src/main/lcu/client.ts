import { Agent, request } from 'undici';
import { basicAuthHeader, type LcuCredentials } from './lockfile.ts';

/**
 * Agent TLS réservé aux API locales de Riot.
 *
 * Le LCU et la Live Client Data API présentent un certificat auto-signé, qui
 * échoue donc la validation standard. Deux options :
 *   1. embarquer le certificat racine publié par Riot et le passer en `ca` ;
 *   2. désactiver la vérification.
 *
 * On prend (2), mais STRICTEMENT dans cet agent, utilisé uniquement pour des
 * requêtes vers 127.0.0.1. On ne touche jamais à NODE_TLS_REJECT_UNAUTHORIZED,
 * qui désactiverait TLS pour TOUT le process, y compris les appels au backend
 * Laneform. Le durcissement (option 1) est un TODO à faire avant distribution
 * publique : il faut récupérer le PEM officiel de Riot et le committer.
 */
export const localAgent = new Agent({ connect: { rejectUnauthorized: false } });

export class LcuClient {
  constructor(private readonly creds: LcuCredentials) {}

  private get origin(): string {
    return `https://127.0.0.1:${this.creds.port}`;
  }

  /** `null` sur 404 : le LCU renvoie 404 pour « pas d'état courant », cas nominal. */
  async get<T>(path: string): Promise<T | null> {
    const res = await request(`${this.origin}${path}`, {
      method: 'GET',
      dispatcher: localAgent,
      headers: { authorization: basicAuthHeader(this.creds.password), accept: 'application/json' },
      headersTimeout: 5000,
      bodyTimeout: 5000,
    });

    if (res.statusCode === 404) {
      await res.body.dump();
      return null;
    }
    const body = await res.body.text();
    if (res.statusCode >= 400) {
      throw new Error(`LCU ${res.statusCode} on ${path}: ${body.slice(0, 200)}`);
    }
    return body.length > 0 ? (JSON.parse(body) as T) : null;
  }

  currentSummoner() {
    return this.get<{ puuid: string; gameName: string; tagLine: string; summonerLevel: number }>(
      '/lol-summoner/v1/current-summoner',
    );
  }

  /** Phase du client : `None`, `Lobby`, `ChampSelect`, `InProgress`, `EndOfGame`… */
  gameflowPhase() {
    return this.get<string>('/lol-gameflow/v1/gameflow-phase');
  }

  champSelectSession() {
    return this.get<ChampSelectSession>('/lol-champ-select/v1/session');
  }

  /**
   * Plateforme du compte connecté, p.ex. « EUW1 ».
   *
   * La lire dans le client évite de la demander à l'utilisateur et d'avoir à
   * gérer son erreur de saisie : le client sait forcément sur quelle
   * plateforme il est connecté.
   */
  platformId() {
    return this.get<string>('/lol-platform-config/v1/namespaces/LoginDataPacket/platformId');
  }
}

export interface ChampSelectSession {
  /** Identifie la place du joueur local dans `myTeam`. */
  localPlayerCellId: number;
  myTeam: ChampSelectPlayer[];
  theirTeam: ChampSelectPlayer[];
  timer?: { phase: string; adjustedTimeLeftInPhase: number };
  actions?: { actorCellId: number; championId: number; type: string; completed: boolean }[][];
}

export interface ChampSelectPlayer {
  cellId: number;
  championId: number;
  assignedPosition: string;
  puuid?: string;
}
