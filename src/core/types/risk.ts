/**
 * Risk type definitions.
 *
 * Capital preservation and risk control types.
 * NO execution internals. NO protocol parsing. Pure data shapes.
 */

/** Daily P&L tracking */
export interface DailyPnl {
  readonly date: string;
  readonly realizedPnlSol: bigint;
  readonly tradeCount: number;
  readonly winCount: number;
  readonly lossCount: number;
  readonly killSwitchTriggered: boolean;
}

/** Kill switch state — must match EmergencyKillSwitch.getState() */
export interface KillSwitchState {
  readonly killed: boolean;
  readonly reason: string | null;
  readonly killedAt: number;
  readonly killedBy: string | null;
}
