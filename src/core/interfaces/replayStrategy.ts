/**
 * Replay Strategy interface contract.
 *
 * Separate from IStrategy because the replay system needs a different API:
 *   - evaluateEntry(signal) for backtesting entry decisions
 *   - evaluateExit(position) for backtesting exit decisions
 *
 * The live IStrategy uses onSignal(mint) which triggers the full pipeline.
 * The replay IReplayStrategy needs granular control for step-by-step simulation.
 */

import type { Signal } from '../types/signal.js';
import type { Position } from '../types/position.js';
import type { ExitReason } from '../types/strategy.js';

/** Entry evaluation result for replay. */
export interface ReplayEntryResult {
  readonly allowed: boolean;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly firstFailure: string | null;
}

/** Exit evaluation result for replay. */
export interface ReplayExitResult {
  readonly decision: 'SELL' | 'HOLD';
  readonly exitReason: ExitReason | null;
}

/** Strategy contract for replay/backtesting. */
export interface IReplayStrategy {
  /** Evaluate whether to enter a position based on a signal. */
  evaluateEntry(signal: Signal): Promise<ReplayEntryResult>;

  /** Evaluate whether to exit an active position. */
  evaluateExit(position: Position): Promise<ReplayExitResult>;
}
