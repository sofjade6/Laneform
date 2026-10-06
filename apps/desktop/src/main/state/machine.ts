import { EventEmitter } from 'node:events';

/**
 * États possibles de l'application.
 *
 * Un état unique et explicite, plutôt que des booléens dispersés dans les
 * connecteurs. Les cas limites (client relancé pendant une partie, remake,
 * reconnexion, spectateur) deviennent sinon ingérables dès le troisième ajout.
 */
export type AppPhase =
  | 'CLIENT_CLOSED'   // aucun lockfile : League n'est pas lancé
  | 'IDLE'            // client ouvert, hors file et hors partie
  | 'LOBBY'
  | 'CHAMP_SELECT'
  | 'IN_GAME'
  | 'POST_GAME';

export interface AppState {
  phase: AppPhase;
  summoner: { gameName: string; tagLine: string } | null;
  /** Dernier message d'information destiné à l'utilisateur. */
  notice: string | null;
}

/**
 * Correspondance entre les phases du LCU et les nôtres.
 *
 * On ne reprend pas les noms de Riot tels quels : ils comportent des états
 * transitoires (`WaitingForStats`, `Reconnect`, `TerminatedInError`) dont
 * l'overlay n'a rien à faire. Tout ce qui n'est pas listé retombe sur IDLE,
 * ce qui garantit un comportement défini même si Riot ajoute une phase.
 */
const LCU_PHASE_MAP: Record<string, AppPhase> = {
  None: 'IDLE',
  Lobby: 'LOBBY',
  Matchmaking: 'LOBBY',
  ReadyCheck: 'LOBBY',
  ChampSelect: 'CHAMP_SELECT',
  GameStart: 'IN_GAME',
  InProgress: 'IN_GAME',
  Reconnect: 'IN_GAME',
  WaitingForStats: 'POST_GAME',
  PreEndOfGame: 'POST_GAME',
  EndOfGame: 'POST_GAME',
};

export function mapLcuPhase(lcuPhase: string | null): AppPhase {
  if (!lcuPhase) return 'IDLE';
  return LCU_PHASE_MAP[lcuPhase] ?? 'IDLE';
}

export interface StateMachineEvents {
  change: [AppState];
}

export class StateMachine extends EventEmitter<StateMachineEvents> {
  private state: AppState = { phase: 'CLIENT_CLOSED', summoner: null, notice: null };

  get current(): AppState {
    return this.state;
  }

  /**
   * Fusionne une mise à jour et n'émet QUE si quelque chose a changé.
   *
   * Le poller tourne à 1 Hz : sans ce filtre, l'overlay se redessinerait une
   * fois par seconde sans raison, pendant que le joueur joue.
   */
  update(patch: Partial<AppState>): void {
    const next: AppState = { ...this.state, ...patch };
    if (
      next.phase === this.state.phase &&
      next.notice === this.state.notice &&
      next.summoner?.gameName === this.state.summoner?.gameName &&
      next.summoner?.tagLine === this.state.summoner?.tagLine
    ) {
      return;
    }
    this.state = next;
    this.emit('change', next);
  }
}
